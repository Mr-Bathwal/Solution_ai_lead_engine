import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { TEST_SECRET, freshDb, startMongo } from './helpers/mongod.js';
import { loadConfig } from '../src/config.js';
import { buildOutreach } from '../src/outreach/index.js';
import { JOB_DRAFT, JOB_SEND, planOutreach } from '../src/outreach/sequence.js';
import { decideApproval } from '../src/admin/approvals.js';
import { newText, parseMessage, decodeWords } from '../src/inbound/parse.js';
import { classifyByRules, classifyReply } from '../src/inbound/classify.js';
import { ImapClient, readNew, parseInternalDate } from '../src/inbound/imap.js';
import { decideInbound, processInbound, readMailboxes } from '../src/inbound/process.js';
import { evalReplies } from '../src/eval/replies.js';
import { evalQc } from '../src/eval/qc.js';
const ANY_MX = { resolveMx: async () => [{ exchange: 'mx.test', priority: 10 }] };   // the fixtures' domains are invented: every one "receives mail"

/**
 * Phase 4, reading the mailboxes: the parser (MIME, encoded words, delivery and abuse reports,
 * automatic replies), the reply classifier and its test set, the read-only IMAP client against a
 * fake server, what the engine does with each kind of email, and new-need messages.
 */

const CID = 'U62099UP2026PTC300001';
const NOW = '2026-11-20T06:00:00Z';                 // Friday 11:30 IST, day 24 of the warm-up
const REVIEWER = { email: 'reviewer@solutionai.in', role: 'reviewer' };
let mongo;
let client;
let db;
let now;
let outbox;
const clock = () => new Date(now);
const at = (iso) => { now = Date.parse(iso); };
const quiet = { info() {}, warn() {}, error() {} };

const attr = (value, source = 'mca_monthly') => ({ value, source, seen_at: new Date('2026-11-01T00:00:00Z') });
const company = () => ({
  _id: CID, kind: 'company', state: 'UP', name: 'VEZRAS TECHNOLOGIES PRIVATE LIMITED', ids: { cin: CID, uplc: [] }, cohort: '2026-10',
  sources: ['mca_monthly'], first_seen_at: new Date('2026-11-01T00:00:00Z'), updated_at: new Date('2026-11-01T00:00:00Z'), schema_version: 2, former_names: [],
  attrs: { incorporation_date: attr('2026-10-14'), company_type: attr('Private Limited Company'), district: attr('Lucknow', 'startinup'),
    registered_email: attr('info@vezras.in', 'infyner') },
});
const deadlines = [
  { id: 'first_board_meeting', title: 'Hold the first board meeting', form: 'Minutes (no MCA form)', due: '2026-11-13', status: 'was_due', law: 'Companies Act 2013 s.173(1)' },
  { id: 'inc_20a', title: 'File the declaration for commencement of business', form: 'INC-20A', due: '2027-03-12', status: 'upcoming', law: 'Companies Act 2013 s.10A' },
];
const leadDoc = () => ({
  company_id: CID, stage: 'shortlisted', holdout: false, eligible: true, cohort: '2026-10', shortlist: { month: '2026-11', rank: 1 },
  needs: { rules_confirmed: true, rules_version: 't', deadlines, schemes: [{ scheme_id: 'udyam_registration', name: 'Udyam (MSME) registration', verdict: 'eligible', missing: [] }] },
  created_at: new Date('2026-11-01T00:00:00Z'), updated_at: new Date('2026-11-01T00:00:00Z'),
});

function setup(envOver = {}, opts = {}) {
  const cfg = loadConfig({
    CONTACT_KEY_SECRET: TEST_SECRET, PUBLIC_BASE_URL: 'https://pages.example.in', PAGE_SECRET: 'p'.repeat(40), OUTBOX_DIR: outbox,
    MAILBOX_1_ADDRESS: 'gourav@outreach.example.in', MAILBOX_1_NAME: 'Gourav B', MAILBOX_1_SMTP_PASSWORD: 'app-pass-1',
    MAILBOX_2_ADDRESS: 'sujas@outreach.example.in', MAILBOX_2_NAME: 'Sujas C', ...envOver,
  });
  return { cfg, o: buildOutreach(cfg, db, { clock, log: quiet, dns: ANY_MX, ...opts }) };
}

/** Plans, drafts, approves and sends the first email (outbox); returns the sent message. */
async function sendFirst(o) {
  await planOutreach(o, { month: '2026-11' });
  const job = await o.queue.claim('t', { types: [JOB_DRAFT] });
  await o.handlers[JOB_DRAFT](job);
  await o.queue.complete(job, null);
  const msg = await db.collection('messages').findOne({ company_id: CID, kind: 'first_touch' });
  assert.equal((await decideApproval(db, { id: String(msg._id), decision: 'approve', user: REVIEWER, cfg: o.cfg, org: o.org, queue: o.queue, clock })).ok, true);
  const send = await o.queue.claim('t', { types: [JOB_SEND] });
  const r = await o.handlers[JOB_SEND](send);
  assert.equal(r.status, 'sent', JSON.stringify(r));
  await o.queue.complete(send, r);
  return db.collection('messages').findOne({ _id: msg._id });
}

const mail = ({ from = 'Rahul <info@vezras.in>', to = 'gourav@outreach.example.in', subject = 'Re: Vezras Technologies Private Limited: your next filing dates',
  inReplyTo = null, id = '<reply-1@vezras.in>', body = 'Hello', headers = [] } = {}) => [
  `From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Message-ID: ${id}`, ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []),
  'Date: Fri, 20 Nov 2026 12:00:00 +0530', 'MIME-Version: 1.0', ...headers, 'Content-Type: text/plain; charset=utf-8', '', body, ''].join('\r\n');

let dsnN = 0;
const dsn = ({ recipient = 'info@vezras.in', status = '5.1.1', original = '<x@y>', id = `<dsn-${(dsnN += 1)}@mx.zoho.in>` } = {}) => [
  'From: Mail Delivery System <MAILER-DAEMON@mx.zoho.in>', 'To: gourav@outreach.example.in', 'Subject: Undelivered Mail Returned to Sender',
  `Message-ID: ${id}`, 'MIME-Version: 1.0', 'Content-Type: multipart/report; report-type=delivery-status; boundary="BOUND"', '',
  '--BOUND', 'Content-Type: text/plain', '', 'This is the mail system at host mx.zoho.in. Your message could not be delivered.', '',
  '--BOUND', 'Content-Type: message/delivery-status', '', 'Reporting-MTA: dns; mx.zoho.in', '', `Final-Recipient: rfc822; ${recipient}`, 'Action: failed',
  `Status: ${status}`, `Diagnostic-Code: smtp; 550 ${status} User unknown`, '',
  '--BOUND', 'Content-Type: text/rfc822-headers', '', 'From: Gourav B <gourav@outreach.example.in>', `To: ${recipient}`, 'Subject: x', `Message-ID: ${original}`, '',
  '--BOUND--', ''].join('\r\n');

before(async () => { mongo = await startMongo(); });
after(async () => { await client?.close(); await mongo.stop(); try { rmSync(outbox, { recursive: true, force: true }); } catch { /* temp */ } });
beforeEach(async () => {
  await client?.close();
  ({ client, db } = await freshDb(mongo.uri));
  outbox = mkdtempSync(path.join(os.tmpdir(), 'lead-engine-outbox-'));
  at(NOW);
  await db.collection('companies').insertOne(company());
  await db.collection('leads').insertOne(leadDoc());
});

describe('reading an email', () => {
  test('encoded words, quoted-printable Hindi, multipart text, and the new part of a reply', () => {
    assert.equal(decodeWords('=?UTF-8?B?4KSo4KSu4KS44KWN4KSk4KWH?= =?UTF-8?Q?_ji?='), 'नमस्ते ji');
    const raw = ['From: =?UTF-8?Q?R=C4=81hul?= <INFO@Vezras.in>', 'To: g@x.in', 'Subject: =?UTF-8?B?UmU6IHRlc3Q=?=', 'Message-ID: <A@B>', 'In-Reply-To: <Orig@X.IN>',
      'MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary=zz', '', '--zz', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '',
      '=E0=A4=B9=E0=A4=BE=E0=A4=81, call me.', '', 'On Fri, 20 Nov 2026 at 11:30, Gourav B <g@x.in> wrote:', '> Hello Vezras team,', '', '--zz',
      'Content-Type: text/html; charset=utf-8', '', '<p>ignored</p>', '--zz--', ''].join('\r\n');
    const m = parseMessage(raw);
    assert.deepEqual(m.from, { name: 'Rāhul', address: 'info@vezras.in' });
    assert.equal(m.subject, 'Re: test');
    assert.equal(m.inReplyTo, '<orig@x.in>', 'ids are compared in lower case');
    assert.equal(newText(m.text), 'हाँ, call me.', 'the quoted history is left out');
    assert.equal(m.auto.yes, false);
    assert.equal(m.report, null);
  });

  test('a delivery report, an abuse report and an automatic reply are told apart', () => {
    const b = parseMessage(dsn({ original: '<abc@outreach.example.in>' }));
    assert.equal(b.report.kind, 'delivery');
    assert.deepEqual(b.report.recipients[0], { recipient: 'info@vezras.in', action: 'failed', status: '5.1.1', diagnostic: 'smtp; 550 5.1.1 User unknown' });
    assert.equal(b.report.originalMessageId, '<abc@outreach.example.in>');
    const plain = parseMessage(mail({ from: 'MAILER-DAEMON@gmail.com', subject: 'Delivery Status Notification (Failure)', body: "Your message wasn't delivered to info@vezras.in because the address couldn't be found. 550 5.1.1" }));
    assert.equal(plain.looksLikeBounce, true, 'a bounce without a report is recognised from its sender, subject and status');
    assert.equal(plain.report.recipients[0].status, '5.1.1');
    const arf = parseMessage(['From: fbl@isp.in', 'To: g@x.in', 'Subject: abuse', 'MIME-Version: 1.0', 'Content-Type: multipart/report; report-type=feedback-report; boundary=q', '',
      '--q', 'Content-Type: message/feedback-report', '', 'Feedback-Type: abuse', '', '--q--', ''].join('\r\n'));
    assert.equal(arf.report.kind, 'feedback');
    const ooo = parseMessage(mail({ subject: 'Automatic reply: your next filing dates', headers: ['Auto-Submitted: auto-replied'], body: 'I am out of office until Monday.' }));
    assert.equal(ooo.auto.yes, true);
    assert.equal(parseMessage(Buffer.from('not an email at all')).subject, '', 'nonsense never throws');
  });

  test('the classifier: opt-outs first, the subject-only unsubscribe, and Hindi and Hinglish', () => {
    const c = (text, subject = 'Re: x') => classifyByRules({ subject, text });
    assert.equal(c('', 'unsubscribe').label, 'unsubscribe', 'what the List-Unsubscribe mailto sends');
    assert.equal(c('Not interested, please remove me').label, 'unsubscribe');
    assert.equal(c('Interested! What are your charges?').label, 'interested');
    assert.equal(c('Please don\'t stop, very useful. Can you also remind us about ADT-1?').label, 'interested', '"don\'t stop" is not an opt-out');
    assert.equal(c('मेरा नाम सूची से हटा दें').label, 'unsubscribe');
    assert.equal(c('Abhi nahi, baad mein').label, 'not_now');
    assert.equal(c('I am the CA who incorporated it for my client').label, 'wrong_person');
    assert.equal(c('Thanks').label, 'unclear');
    assert.equal(c('What are your charges? Please call me after 3 pm.').label, 'interested', 'a time of day is not a date to come back after');
    assert.equal(c('We would like to talk, but only after the 15th').label, 'not_now');
    assert.ok(c('Unsubscribe').confidence >= 0.8);
  });

  test('the reply test set: no wrong suppression, and the tuned rules still pass', async () => {
    const r = await evalReplies();
    assert.ok(r.summary.cases >= 161);
    assert.equal(r.summary.wrong_suppressions, 0, 'nobody who wanted to hear from us is silenced');
    assert.ok(r.summary.accuracy >= 0.97, JSON.stringify(r.mistakes));
  });

  test('the AI is asked only when the rules are unsure, and an opt-out wins a disagreement', async () => {
    const calls = [];
    const llm = { configured: true, chat: async (req) => { calls.push(req); return { content: JSON.stringify({ label: 'interested', confidence: 0.9, reason: 'asks' }), model: 'small-1' }; } };
    const sure = await classifyReply({ subject: 'Re: x', text: 'Unsubscribe me' }, { llm });
    assert.equal(sure.label, 'unsubscribe');
    assert.equal(calls.length, 0, 'the rules were sure');
    const unsure = await classifyReply({ subject: 'Re: x', text: 'Hmm. My number is 98765 43210, write to a@b.in' }, { llm });
    assert.equal(unsure.label, 'interested');
    assert.equal(unsure.by, 'ai');
    assert.doesNotMatch(calls[0].messages[1].content, /98765|a@b\.in/, 'numbers and addresses never reach the model');
    const disagree = await classifyReply({ subject: 'Re: x', text: 'Remove this address. How did you even get it?' }, { llm, aiBelow: 0.8 });
    assert.equal(disagree.label, 'unsubscribe', 'the safer label for the founder');
    assert.ok(disagree.confidence <= 0.7);
  });

  test('the quality-check test set: every fault caught, no clean draft refused', () => {
    const r = evalQc(setup().cfg, { companies: 10 });
    assert.equal(r.summary.false_positives, 0, JSON.stringify(r.summary.false_positive_checks));
    assert.equal(r.summary.missed, 0, JSON.stringify(r.misses.slice(0, 3)));
    assert.equal(r.summary.fault_types, 20);
  });
});

describe('the IMAP client', () => {
  /** A fake IMAP server holding `messages` ({ uid, raw }); records every command it gets. */
  async function fakeImap(messages, { uidvalidity = 7 } = {}) {
    const commands = [];
    const srv = net.createServer((sock) => {
      sock.on('error', () => {});
      sock.write('* OK IMAP4rev1 ready\r\n');
      let buf = '';
      sock.on('data', (d) => {
        buf += d.toString('latin1');
        let i;
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const [tag, ...rest] = line.split(' ');
          const cmd = rest.join(' ');
          commands.push(cmd);
          if (/^LOGIN /.test(cmd)) sock.write(cmd.includes('"wrong"') ? `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n` : `${tag} OK LOGIN completed\r\n`);
          else if (/^EXAMINE/.test(cmd)) sock.write(`* ${messages.length} EXISTS\r\n* OK [UIDVALIDITY ${uidvalidity}] UIDs valid\r\n* OK [UIDNEXT 99] next\r\n${tag} OK [READ-ONLY] EXAMINE completed\r\n`);
          else if (/^UID SEARCH/.test(cmd)) {
            const from = Number(/UID (\d+):\*/.exec(cmd)?.[1] ?? 0);
            const uids = messages.map((m) => m.uid).filter((u) => u >= from);
            if (!uids.length && messages.length) uids.push(messages.at(-1).uid);     // what "n:*" really does
            sock.write(`* SEARCH ${uids.join(' ')}\r\n${tag} OK SEARCH completed\r\n`);
          } else if (/^UID FETCH/.test(cmd)) {
            const uid = Number(/^UID FETCH (\d+)/.exec(cmd)[1]);
            const m = messages.find((x) => x.uid === uid);
            const raw = Buffer.from(m.raw, 'utf8');
            sock.write(Buffer.concat([Buffer.from(`* 1 FETCH (UID ${uid} INTERNALDATE "20-Nov-2026 12:00:00 +0530" RFC822.SIZE ${raw.length} BODY[]<0> {${raw.length}}\r\n`, 'latin1'), raw,
              Buffer.from(`)\r\n${tag} OK FETCH completed\r\n`, 'latin1')]));
          } else if (/^LOGOUT/.test(cmd)) {
            sock.end(`* BYE\r\n${tag} OK LOGOUT completed\r\n`);
          } else sock.write(`${tag} BAD unknown\r\n`);
        }
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    return { srv, port: srv.address().port, commands };
  }

  test('reads new messages read-only, by UID, literals and Hindi intact', async () => {
    const hindi = mail({ body: 'धन्यवाद, अभी नहीं।' });
    const { srv, port, commands } = await fakeImap([{ uid: 10, raw: mail() }, { uid: 11, raw: hindi }]);
    try {
      const opts = { host: '127.0.0.1', port, user: 'g@x.in', pass: 'p"q\\r', insecurePlain: true, timeoutMs: 3000 };
      const first = await readNew(opts, { since: new Date('2026-11-18T00:00:00Z') });
      assert.equal(first.uidvalidity, 7);
      assert.deepEqual(first.messages.map((m) => m.uid), [10, 11]);
      assert.match(parseMessage(first.messages[1].raw).text, /धन्यवाद/);
      assert.equal(first.messages[0].internalDate.toISOString(), '2026-11-20T06:30:00.000Z');
      const again = await readNew(opts, { uidvalidity: 7, afterUid: 11 });
      assert.deepEqual(again.messages, [], '"12:*" returns the newest message, which is filtered out');
      assert.ok(commands.some((c) => c === 'LOGIN "g@x.in" "p\\"q\\\\r"'), 'quotes and backslashes are escaped');
      assert.ok(commands.every((c) => !/^(SELECT|STORE|EXPUNGE|COPY|MOVE)\b/.test(c)), 'never a command that changes the mailbox');
      assert.ok(commands.filter((c) => c.startsWith('UID FETCH')).every((c) => c.includes('BODY.PEEK[]')), 'the \\Seen flag is never set');
      await assert.rejects(readNew({ ...opts, pass: 'wrong' }, {}), /Invalid credentials/);
    } finally {
      srv.close();
    }
    assert.equal(parseInternalDate('02-Nov-2026 10:15:00 +0530').toISOString(), '2026-11-02T04:45:00.000Z');
    await assert.rejects(new ImapClient({ host: '' }).connect(), /no IMAP host/);
  });
});

describe('what the engine does with each email', () => {
  const read = (o, raw, uid) => processInbound(o, { mailbox: 'mailbox-1', uid, uidvalidity: 7, internalDate: clock(), raw });

  test('a reply ends cold outreach, waits for a person, and is recorded once', async () => {
    const { o } = setup();
    const sent = await sendFirst(o);
    at('2026-11-23T06:00:00Z');
    const r = await read(o, mail({ inReplyTo: sent.send.message_id, body: 'Yes we are interested, please call me tomorrow.\r\n\r\nOn Fri, Gourav B wrote:\r\n> Hello' }), 21);
    assert.deepEqual([r.status, r.kind, r.label], ['needs_person', 'reply', 'interested']);
    const doc = await db.collection('inbound').findOne({ uid: 21 });
    assert.equal(doc.matched.how, 'in_reply_to');
    assert.equal(doc.text, 'Yes we are interested, please call me tomorrow.', 'only the new part is kept');
    assert.equal((await db.collection('leads').findOne({ company_id: CID })).stage, 'engaged');
    assert.equal(await db.collection('activities').countDocuments({ type: 'replied', company_id: CID }), 1);
    at('2026-11-30T06:00:00Z');
    const follow = await o.budget.check({ lead: await db.collection('leads').findOne({ company_id: CID }), kind: 'follow_up', mailbox: sent.mailbox });
    assert.equal(follow.code, 'replied', 'the follow-up never goes');
    const again = await read(o, mail({ inReplyTo: sent.send.message_id }), 21);
    assert.equal(again.duplicate, true);
    assert.equal(await db.collection('activities').countDocuments({ type: 'replied' }), 1);
  });

  test('a hard bounce suppresses the address and marks the message; a soft one only counts', async () => {
    const { o } = setup();
    const sent = await sendFirst(o);
    const r = await read(o, dsn({ original: sent.send.message_id }), 30);
    assert.deepEqual([r.status, r.kind], ['done', 'bounce']);
    assert.equal((await db.collection('messages').findOne({ _id: sent._id })).status, 'bounced');
    assert.equal((await o.suppression.check({ email: 'info@vezras.in' }))[0].reason, 'hard_bounce');
    const act = await db.collection('activities').findOne({ type: 'bounced' });
    assert.deepEqual([act.data.bounce, act.data.mailbox, act.data.status], ['hard', sent.mailbox, '5.1.1']);
    assert.equal((await o.budget.mailboxHealth(sent.mailbox, clock())).bounced, 1, 'it counts against the mailbox at once');
    await read(o, dsn({ original: sent.send.message_id, status: '4.2.2' }), 31);
    assert.equal(await db.collection('activities').countDocuments({ type: 'bounced', 'data.bounce': 'soft' }), 1);
  });

  test('a clear opt-out suppresses at once; mail the engine did not send is ignored and not kept', async () => {
    const { o } = setup();
    const sent = await sendFirst(o);
    const r = await read(o, mail({ inReplyTo: sent.send.message_id, body: 'Please remove me from your list. Not interested.' }), 40);
    assert.deepEqual([r.status, r.label], ['done', 'unsubscribe']);
    assert.ok((await o.suppression.check({ email: 'info@vezras.in' })).some((h) => h.reason === 'unsubscribe'));
    assert.equal((await db.collection('leads').findOne({ company_id: CID })).stage, 'closed');
    const warm = await read(o, mail({ from: 'warmup@mailwarm.example', subject: 'Quick hello', body: 'Lorem ipsum', id: '<w@m>' }), 41);
    assert.deepEqual([warm.status, warm.kind], ['ignored', 'other']);
    assert.equal((await db.collection('inbound').findOne({ uid: 41 })).text, null, 'nothing about our outreach: its text is not kept');
    const strayBounce = await read(o, dsn({ recipient: 'someone@else.in', original: '<warmup@x>' }), 42);
    assert.equal(strayBounce.status, 'done');
    assert.equal(await db.collection('activities').countDocuments({ type: 'bounced' }), 0, 'a bounce for warm-up mail never counts against the mailbox');
  });

  test('an out-of-office does not stop the follow-up', async () => {
    const { o } = setup();
    const sent = await sendFirst(o);
    const r = await read(o, mail({ inReplyTo: sent.send.message_id, subject: 'Out of Office: your next filing dates', headers: ['Auto-Submitted: auto-replied'], body: 'Away till Monday.' }), 50);
    assert.deepEqual([r.kind, r.status], ['auto_reply', 'done']);
    assert.equal(await db.collection('activities').countDocuments({ type: 'replied' }), 0);
  });

  test('a person relabels and deals with a reply; the decision is audited', async () => {
    const { o } = setup();
    const sent = await sendFirst(o);
    await read(o, mail({ inReplyTo: sent.send.message_id, body: 'Hmm' }), 60);
    const doc = await db.collection('inbound').findOne({ uid: 60 });
    assert.equal(doc.label, 'unclear');
    await decideInbound(db, { id: doc._id, label: 'wrong_person', handled: true, note: 'their CA', user: REVIEWER, suppression: o.suppression, queue: o.queue, clock });
    const after1 = await db.collection('inbound').findOne({ _id: doc._id });
    assert.deepEqual([after1.status, after1.label, after1.classification.by, after1.classification.previous.label], ['handled', 'wrong_person', 'person', 'unclear']);
    assert.ok((await o.suppression.check({ email: 'info@vezras.in' })).some((h) => h.reason === 'wrong_contact'));
    assert.equal(await db.collection('activities').countDocuments({ type: 'handed_over' }), 1);
    assert.equal(await db.collection('audit_log').countDocuments({ action: 'inbound_decision' }), 1);
    await assert.rejects(decideInbound(db, { id: doc._id, label: 'spam', user: REVIEWER, suppression: o.suppression, queue: o.queue, clock }), /label must be/);
  });

  test('readMailboxes reads each configured mailbox from where it stopped', async () => {
    const { o } = setup({ MAILBOX_1_IMAP_PASSWORD: 'imap-1' });
    const sent = await sendFirst(o);
    const seen = [];
    const fake = async (box, args) => {
      seen.push({ id: box.id, ...args });
      return { uidvalidity: 7, messages: args.afterUid ? [] : [{ uid: 5, internalDate: clock(), raw: Buffer.from(mail({ inReplyTo: sent.send.message_id, body: 'What are your fees?' })) }] };
    };
    const r1 = await readMailboxes(o, { readNewFn: fake, log: quiet });
    assert.equal(r1['mailbox-1'].reply, 1);
    assert.equal(r1['mailbox-1'].needs_person, 1);
    assert.match(r1['mailbox-2'].skipped, /no address or IMAP password/, 'a mailbox without a password is skipped, not guessed');
    assert.equal(seen[0].afterUid, null);
    assert.ok(seen[0].since >= new Date('2026-11-17T18:30:00Z'), 'the first read starts at inbound.start_date');
    const r2 = await readMailboxes(o, { readNewFn: fake, log: quiet });
    assert.deepEqual([seen[1].uidvalidity, seen[1].afterUid, r2['mailbox-1'].read], [7, 5, 0], 'the second read starts after the last UID');
    const broken = await readMailboxes(o, { readNewFn: async () => { throw new Error('connection refused'); }, log: quiet });
    assert.equal(broken['mailbox-1'].error, 'connection refused', 'one mailbox failing never stops the others');
  });
});

describe('new-need messages', () => {
  test('a deadline no message mentioned starts to apply: one message about it, once, 30 days after the last', async () => {
    const { o } = setup();
    const sent = await sendFirst(o);
    // a new firm deadline appears after the first email (say the rules gained ADT-1 for this company)
    const adt = { id: 'adt_1', title: 'Tell the registrar about the auditor', form: 'ADT-1', due: '2027-02-15', status: 'upcoming', law: 'Companies Act 2013 s.139(1)' };
    await db.collection('leads').updateOne({ company_id: CID }, { $set: { stage: 'contacted', 'needs.deadlines': [...deadlines.map((d) => (d.id === 'first_board_meeting' ? { ...d, status: 'past' } : d)), adt] } });
    at('2026-12-02T06:00:00Z');
    let plan = await planOutreach(o, { month: '2026-11' });
    assert.equal(plan.new_need_queued, 0, 'not within 30 days of the last message');
    assert.equal(plan.new_need_not_allowed, 1);
    assert.equal(plan.follow_up_queued, 1);
    await o.queue.cancel(`draft:${CID}:follow_up`, 'this test is about the new need');
    at('2026-12-21T06:00:00Z');                           // Monday, 31 days after the first email
    plan = await planOutreach(o, { month: '2026-11' });
    assert.equal(plan.new_need_queued, 1);
    const job = await o.queue.claim('t', { types: [JOB_DRAFT] });
    assert.equal(job.payload.need_id, 'd:adt_1:2027-02-15');
    await o.handlers[JOB_DRAFT](job);
    await o.queue.complete(job, null);
    const msg = await db.collection('messages').findOne({ kind: 'new_need' });
    assert.equal(msg.status, 'awaiting_approval', JSON.stringify(msg.qc.checks.filter((c) => !c.ok)));
    assert.deepEqual(msg.evidence.pack.deadlines.map((d) => d.id), ['adt_1'], 'the message is about the one new need');
    assert.equal(msg.need_id, 'd:adt_1:2027-02-15');
    assert.equal(msg.mailbox, sent.mailbox);
    assert.doesNotMatch(msg.draft.subject, /^Re:/);
    assert.match(msg.draft.body, /I wrote to you on 20 November 2026/);
    assert.match(msg.draft.body, /ADT-1\): due by 15 February 2027/);
    await decideApproval(db, { id: String(msg._id), decision: 'approve', user: REVIEWER, cfg: o.cfg, org: o.org, queue: o.queue, clock });
    const send = await o.queue.claim('t', { types: [JOB_SEND] });
    const r = await o.handlers[JOB_SEND](send);
    assert.equal(r.status, 'sent', JSON.stringify(r));
    await o.queue.complete(send, r);
    assert.equal((await db.collection('activities').findOne({ type: 'sent', 'data.kind': 'new_need' })).data.need_id, 'd:adt_1:2027-02-15');
    at('2027-01-25T06:00:00Z');
    plan = await planOutreach(o, { month: '2026-11' });
    assert.equal(plan.new_need_queued, 0, 'a need is mentioned once');
  });
});

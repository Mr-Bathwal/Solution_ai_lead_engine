import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { TEST_SECRET, freshDb, startMongo } from './helpers/mongod.js';
import { loadConfig } from '../src/config.js';
import { buildOutreach, sendingProblems } from '../src/outreach/index.js';
import { buildEvidencePack, displayName, formatDate, recipientFor } from '../src/outreach/evidence.js';
import { templateDraft } from '../src/outreach/templates.js';
import { qualityCheck } from '../src/outreach/qc.js';
import { buildEmail, encodeWords, quotedPrintable } from '../src/outreach/mime.js';
import { SmtpError, sendSmtp } from '../src/outreach/smtp.js';
import { JOB_DRAFT, JOB_SEND, mailboxFor, planOutreach } from '../src/outreach/sequence.js';
import { decideApproval, recordOutcome, resolveUnknown } from '../src/admin/approvals.js';
import { nextWindowOpen } from '../src/outreach/gate.js';
import { DeferError, Worker } from '../src/jobs/worker.js';
import { createPublicServer } from '../src/public/server.js';
import { JOB_REMINDER, JOB_WA_CONFIRM, planReminders } from '../src/outreach/reminders.js';
import { ConsentLedger } from '../src/consent/ledger.js';
import { Auth, newUser } from '../src/admin/auth.js';
import { createAdminServer } from '../src/admin/server.js';
const ANY_MX = { resolveMx: async () => [{ exchange: 'mx.test', priority: 10 }] };   // the fixtures' domains are invented: every one "receives mail"

const CID = 'U62099UP2026PTC300001';
const NOW = '2026-11-20T06:00:00Z';                 // Friday 11:30 IST, day 24 of the mailboxes' warm-up
const REVIEWER = { email: 'reviewer@solutionai.in', role: 'reviewer' };
let mongo;
let client;
let db;
let now;
let outbox;
const clock = () => new Date(now);
const at = (iso) => { now = Date.parse(iso); };

const attr = (value, source = 'mca_monthly', extra = {}) => ({ value, source, seen_at: new Date('2026-11-01T00:00:00Z'), ...extra });
const company = (over = {}) => ({
  _id: CID, kind: 'company', state: 'UP', name: 'VEZRAS TECHNOLOGIES PRIVATE LIMITED', ids: { cin: CID, uplc: [] }, cohort: '2026-10',
  sources: ['mca_monthly'], first_seen_at: new Date('2026-11-01T00:00:00Z'), updated_at: new Date('2026-11-01T00:00:00Z'), schema_version: 2, former_names: [],
  attrs: { incorporation_date: attr('2026-10-14'), company_type: attr('Private Limited Company'), district: attr('Lucknow', 'startinup'),
    registered_email: attr('info@vezras.in', 'infyner') },
  ...over,
});
const needs = (over = {}) => ({
  rules_confirmed: true, rules_version: 'test-rules', verdicts_by: 'provisional_rules',
  deadlines: [
    { id: 'first_board_meeting', title: 'Hold the first board meeting', form: 'Minutes (no MCA form)', due: '2026-11-13', status: 'was_due',
      law: 'Companies Act 2013 s.173(1), s.122(5)', source_url: 'https://www.mca.gov.in/act' },
    { id: 'inc_20a', title: 'File the declaration for commencement of business', form: 'INC-20A', due: '2027-03-12', status: 'upcoming',
      law: 'Companies Act 2013 s.10A; Companies (Incorporation) Rules 2014 r.23A', source_url: 'https://www.mca.gov.in/inc20a' },
    { id: 'dpt_3', title: 'File the return of money received that is not a deposit', form: 'DPT-3', due: '2027-06-30', status: 'conditional', law: 'x' },
    { id: 'director_kyc', title: "Directors' KYC", form: 'DIR-3 KYC Web', due: null, status: 'advisory', law: 'y' },
  ],
  schemes: [
    { scheme_id: 'dpiit_recognition', name: 'DPIIT startup recognition', verdict: 'check_required', benefit: 'Turnover of at most ₹200 crore.',
      missing: ['innovation or scalability'], source_url: 'https://www.pib.gov.in/x' },
    { scheme_id: 'udyam_registration', name: 'Udyam (MSME) registration', verdict: 'eligible', benefit: 'Free registration.', missing: [], source_url: 'https://udyamregistration.gov.in/' },
    { scheme_id: 'sisfs', name: 'Startup India Seed Fund Scheme', verdict: 'not_eligible', missing: [] },
  ],
  ...over,
});
const leadDoc = (over = {}) => ({
  company_id: CID, stage: 'shortlisted', holdout: false, eligible: true, cohort: '2026-10', shortlist: { month: '2026-11', rank: 1 },
  needs: needs(), created_at: new Date('2026-11-01T00:00:00Z'), updated_at: new Date('2026-11-01T00:00:00Z'), ...over,
});

function setup(envOver = {}, opts = {}) {
  const cfg = loadConfig({
    CONTACT_KEY_SECRET: TEST_SECRET, PUBLIC_BASE_URL: 'https://pages.example.in', PAGE_SECRET: 'p'.repeat(40), OUTBOX_DIR: outbox,
    MAILBOX_1_ADDRESS: 'gourav@outreach.example.in', MAILBOX_1_NAME: 'Gourav B', MAILBOX_1_TITLE: 'Founder office',
    MAILBOX_2_ADDRESS: 'sujas@outreach.example.in', MAILBOX_2_NAME: 'Sujas C', ...envOver,
  });
  return { cfg, o: buildOutreach(cfg, db, { clock, log: { info() {}, warn() {}, error() {} }, dns: ANY_MX, ...opts }) };
}

async function claimJob(o, type) {
  return o.queue.claim('test-worker', { types: [type] });
}

/** Plans, drafts and approves the first email; returns the message. */
async function draftAndApprove(o, { approve = true } = {}) {
  await planOutreach(o, { month: '2026-11' });
  const job = await claimJob(o, JOB_DRAFT);
  assert.ok(job, 'a draft job is queued');
  await o.handlers[JOB_DRAFT](job);
  await o.queue.complete(job, null);
  const msg = await db.collection('messages').findOne({ company_id: CID, kind: 'first_touch' });
  assert.equal(msg.status, 'awaiting_approval', JSON.stringify(msg.qc.checks.filter((c) => !c.ok)));
  if (approve) assert.equal((await decideApproval(db, { id: String(msg._id), decision: 'approve', user: REVIEWER, cfg: o.cfg, org: o.org, queue: o.queue, clock })).ok, true);
  return db.collection('messages').findOne({ _id: msg._id });
}

/** Quoted-printable back to text: every non-ASCII byte is an =XX escape, so the rest is plain ASCII. */
const decodeQp = (s) => Buffer.from(s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');

before(async () => { mongo = await startMongo(); });
after(async () => { await client?.close(); await mongo.stop(); });
beforeEach(async () => {
  await client?.close();
  ({ client, db } = await freshDb(mongo.uri));
  outbox = mkdtempSync(path.join(os.tmpdir(), 'lead-engine-outbox-'));
  at(NOW);
  await db.collection('companies').insertOne(company());
  await db.collection('leads').insertOne(leadDoc());
});

describe('evidence pack', () => {
  test('only firm deadlines in the window, nearest first, and schemes that may apply', () => {
    const { cfg } = setup();
    const { pack, hash } = buildEvidencePack(company(), leadDoc(), cfg.outreach, { asOf: '2026-11-20' });
    assert.deepEqual(pack.deadlines.map((d) => [d.id, d.status]), [['first_board_meeting', 'was_due'], ['inc_20a', 'upcoming']]);
    assert.equal(pack.deadlines[0].form, null, 'no form named for "Minutes (no MCA form)"');
    assert.equal(pack.deadlines[1].law, 'Companies Act 2013 s.10A', 'the law up to the first ";"');
    assert.deepEqual(pack.schemes.map((s) => s.id), ['udyam_registration', 'dpiit_recognition'], 'eligible before check required, never not eligible');
    assert.equal(pack.company.name, 'Vezras Technologies Private Limited');
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(buildEvidencePack(company(), leadDoc({ needs: needs({ deadlines: [], schemes: [] }) }), cfg.outreach, { asOf: '2026-11-20' }).pack, null);
  });

  test('names, dates and the recipient', () => {
    assert.equal(displayName({ name: 'VEZRAS IT SOLUTIONS (OPC) PRIVATE LIMITED' }), 'Vezras IT Solutions (OPC) Private Limited');
    assert.equal(displayName({ name: 'VEZRAS LLP', attrs: { legal_name: { value: 'Vezras LLP' } } }), 'Vezras LLP');
    assert.equal(formatDate('2026-11-13', 'hi'), '13 नवंबर 2026');
    assert.deepEqual(recipientFor(company()), { address: 'info@vezras.in', source: 'infyner', legal_basis: 'published_under_law', personal: false });
    assert.equal(recipientFor(company({ attrs: { registered_email: attr('rahul.k@gmail.com', 'infyner') } })).personal, true);
    assert.equal(recipientFor(company({ attrs: {} })), null);
  });
});

describe('templates and the quality check', () => {
  const ctx = (o, kind = 'first_touch', language = 'en', extra = {}) => ({ kind, language, cfg: o.cfg, org: o.org, ...extra });

  test('every template passes, in English and Hindi, first email and follow-up', () => {
    const { o } = setup();
    const { pack } = buildEvidencePack(company(), leadDoc(), o.cfg, { asOf: '2026-11-20' });
    for (const language of ['en', 'hi']) {
      const first = templateDraft(pack, { kind: 'first_touch', language, sender: { name: 'Gourav B', title: 'Founder office' }, org: o.org });
      const r1 = qualityCheck(first, pack, ctx(o, 'first_touch', language));
      assert.equal(r1.passed, true, `${language} first: ${JSON.stringify(r1.checks.filter((c) => !c.ok))}`);
      assert.match(first.body, /was due by 13 November 2026|13 नवंबर 2026 थी/);
      const threaded = { ...pack, thread: { first_sent_on: '2026-11-20', first_subject: first.subject } };
      const follow = templateDraft(threaded, { kind: 'follow_up', language, sender: { name: 'Gourav B' }, org: o.org, firstSubject: first.subject, firstSentOn: '2026-11-20' });
      const r2 = qualityCheck(follow, threaded, ctx(o, 'follow_up', language));
      assert.equal(r2.passed, true, `${language} follow-up: ${JSON.stringify(r2.checks.filter((c) => !c.ok))}`);
      assert.match(follow.subject, /^Re: /);
    }
  });

  test('catches invented facts, missing opt-out, extra links, bad tone and personal data', () => {
    const { o } = setup();
    const { pack } = buildEvidencePack(company(), leadDoc(), o.cfg, { asOf: '2026-11-20' });
    const good = templateDraft(pack, { kind: 'first_touch', language: 'en', sender: { name: 'Gourav B' }, org: o.org });
    const failing = (draft, kind = 'first_touch', language = 'en') => qualityCheck(draft, pack, ctx(o, kind, language)).checks.filter((c) => !c.ok).map((c) => c.id);
    assert.deepEqual(failing({ ...good, body: good.body.replace('13 November 2026', '14 November 2026') }), ['facts.dates']);
    assert.ok(failing({ ...good, body: `${good.body}\nThe fee is ₹5,000.` }).includes('facts.numbers'));
    assert.ok(failing({ ...good, body: good.body.replace('INC-20A', 'MGT-14') }).includes('facts.forms'));
    assert.ok(failing({ ...good, body: good.body.replace('{{unsubscribe_url}}', '') }).includes('links.unsubscribe_once'));
    assert.ok(failing({ ...good, body: `${good.body}\nSee https://bit.ly/x` }).includes('links.no_others'));
    assert.ok(failing({ ...good, body: `${good.body}\nAct now: this is urgent!` }).includes('tone.banned_phrases'));
    assert.ok(failing({ ...good, body: `${good.body}\nYou have missed this filing.` }).includes('tone.no_missed_claim'));
    assert.ok(failing({ ...good, body: `${good.body}\nCall 98765 43210.` }).includes('privacy.no_contacts'));
    assert.ok(failing({ ...good, subject: `Re: ${good.subject}` }).includes('subject.honest'));
    assert.ok(failing({ ...good, subject: good.subject.toUpperCase() }).includes('subject.not_shouted'));
    assert.ok(failing({ ...good, body: `${good.body}\nनमस्ते` }).includes('language'));
    const anonymous = { subject: good.subject.replaceAll('Vezras Technologies Private Limited', 'Your company'), body: good.body.replaceAll('Vezras Technologies Private Limited', 'the company') };
    assert.ok(failing(anonymous).includes('facts.company_named'));
  });
});

describe('the email itself', () => {
  test('Hindi subjects, quoted-printable bodies and the unsubscribe headers', () => {
    const subject = 'Vezras Technologies Private Limited: अगली फ़ाइलिंग की तारीखें';
    const words = encodeWords(subject);
    assert.ok(words.split('\r\n ').every((w) => w.length <= 75));
    const decoded = words.split('\r\n ').map((w) => Buffer.from(/=\?UTF-8\?B\?(.*)\?=/.exec(w)[1], 'base64').toString('utf8')).join('');
    assert.equal(decoded, subject);
    const text = `नमस्ते टीम,\n${'a'.repeat(200)}\n.dot line = equals `;
    const qp = quotedPrintable(text);
    assert.ok(qp.split('\r\n').every((l) => l.length <= 76));
    assert.equal(decodeQp(qp).replace(/\r\n/g, '\n'), text);
    const { raw, messageId } = buildEmail({ from: { name: 'Gourav B', address: 'g@outreach.example.in' }, to: { address: 'info@vezras.in' }, subject, text: 'Hello',
      unsubscribe: { url: 'https://pages.example.in/u/abc', mailto: 'g@outreach.example.in' }, at: new Date(NOW) });
    assert.match(raw, /^List-Unsubscribe: <https:\/\/pages\.example\.in\/u\/abc>, <mailto:g@outreach\.example\.in\?subject=unsubscribe>$/m);
    assert.match(raw, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);
    assert.match(raw, /^Date: Fri, 20 Nov 2026 11:30:00 \+0530$/m);
    assert.match(messageId, /^<[0-9a-f-]+@outreach\.example\.in>$/);
    assert.throws(() => buildEmail({ from: { address: 'g@x.in' }, to: { address: 'a@b.in' }, subject: 'Hi\r\nBcc: x@y.in', text: '', unsubscribe: { url: 'https://x', mailto: 'g@x.in' } }), /line break/);
  });

  /** A tiny SMTP server: answers like Zoho, and refuses one address. */
  function fakeSmtp() {
    const got = [];
    const srv = net.createServer((sock) => {
      let data = false;
      let buf = '';
      sock.on('error', () => {});      // the client hangs up straight after QUIT
      sock.write('220 fake ESMTP\r\n');
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let i;
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (data) {
            if (line === '.') { data = false; sock.write('250 Ok: queued as ABC123\r\n'); } else got.push(line);
            continue;
          }
          if (line.startsWith('EHLO')) sock.write('250-fake\r\n250 AUTH PLAIN LOGIN\r\n');
          else if (line.startsWith('AUTH PLAIN')) sock.write(Buffer.from(line.slice(11), 'base64').toString() === '\u0000u@x.in\u0000pw' ? '235 ok\r\n' : '535 bad\r\n');
          else if (line.startsWith('MAIL FROM')) sock.write('250 ok\r\n');
          else if (line.startsWith('RCPT TO')) sock.write(line.includes('gone@') ? '550 5.1.1 no such user\r\n' : '250 ok\r\n');
          else if (line === 'DATA') { data = true; sock.write('354 go\r\n'); } else if (line === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        }
      });
    });
    return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, got })));
  }

  test('SMTP: authenticates, dot-stuffs, and reports a refused address as a permanent RCPT failure', async () => {
    const { srv, port, got } = await fakeSmtp();
    try {
      const opts = { host: '127.0.0.1', port, secure: false, starttls: false, insecurePlain: true, user: 'u@x.in', pass: 'pw', from: 'u@x.in', timeoutMs: 3000 };
      const r = await sendSmtp({ ...opts, to: 'info@vezras.in', raw: 'Subject: t\r\n\r\n.starts with a dot\r\nend' });
      assert.equal(r.code, 250);
      assert.match(r.response, /ABC123/);
      assert.ok(got.includes('..starts with a dot'), 'a line starting with "." is doubled');
      await assert.rejects(sendSmtp({ ...opts, to: 'gone@vezras.in', raw: 'x' }), (e) => e instanceof SmtpError && e.permanent && e.stage === 'rcpt' && e.code === 550);
      await assert.rejects(sendSmtp({ ...opts, pass: 'wrong', to: 'info@vezras.in', raw: 'x' }), (e) => e.stage === 'auth' && e.code === 535);
      await assert.rejects(sendSmtp({ ...opts, insecurePlain: false, to: 'info@vezras.in', raw: 'x' }), /unencrypted/);
    } finally {
      srv.close();
    }
  });
});

describe('the sequence: draft, approval, gate, send', () => {
  test('a shortlisted company gets one draft, approval queues the send, and the email goes out once', async () => {
    const { o } = setup();
    const msg = await draftAndApprove(o);
    assert.equal(msg.status, 'approved');
    assert.equal(msg.mailbox, mailboxFor(CID, ['mailbox-1', 'mailbox-2']));
    assert.equal((await planOutreach(o, { month: '2026-11' })).already_drafted, 1, 'planning again drafts nothing new');
    const job = await claimJob(o, JOB_SEND);
    const r = await o.handlers[JOB_SEND](job);
    assert.equal(r.status, 'sent');
    const sent = await db.collection('messages').findOne({ _id: msg._id });
    assert.equal(sent.status, 'sent');
    assert.equal((await db.collection('leads').findOne({ company_id: CID })).stage, 'contacted');
    assert.equal(await db.collection('activities').countDocuments({ type: 'sent', company_id: CID }), 1);
    const files = readdirSync(outbox).filter((f) => f.endsWith('.eml'));
    assert.equal(files.length, 1);
    const raw = readFileSync(path.join(outbox, files[0]), 'utf8');
    assert.match(raw, /^To: <info@vezras\.in>$/m);
    const body = decodeQp(raw.split('\r\n\r\n').slice(1).join('\r\n\r\n'));
    assert.match(body, /https:\/\/pages\.example\.in\/c\/[A-Za-z0-9_-]{22}/);
    assert.doesNotMatch(body, /\{\{/, 'every placeholder was filled');
    assert.equal(await db.collection('page_tokens').countDocuments({ company_id: CID }), 2);
    assert.deepEqual(await o.handlers[JOB_SEND](job), { skipped: 'message is sent' }, 'a second run sends nothing');
    assert.equal(readdirSync(outbox).length, 1);
  });

  test('the gate waits for the CA, the send window and the warm-up, and stops for suppression or a changed text', async () => {
    const { o } = setup();
    await db.collection('leads').updateOne({ company_id: CID }, { $set: { 'needs.rules_confirmed': false } });
    const msg = await draftAndApprove(o);
    let job = await claimJob(o, JOB_SEND);
    await assert.rejects(o.handlers[JOB_SEND](job), (e) => e instanceof DeferError && /CA/.test(e.message));
    // through the worker, waiting does not use up an attempt
    const worker = new Worker(o.queue, o.handlers, { workerId: 'w', log: { info() {}, warn() {}, error() {} } });
    assert.equal(await worker.execute(job), 'deferred');
    const waiting = await db.collection('jobs').findOne({ _id: job._id });
    assert.equal(waiting.status, 'pending');
    assert.equal(waiting.attempts, 0);
    assert.equal(waiting.deferrals, 1);
    assert.ok(waiting.due_at > new Date(now));

    // the warm-up: before 18 November the mailbox sends nothing, and the gate says when to look again
    await db.collection('leads').updateOne({ company_id: CID }, { $set: { 'needs.rules_confirmed': true } });
    await db.collection('messages').updateOne({ _id: msg._id }, { $set: { 'evidence.pack.rules.confirmed': true } });
    at('2026-11-10T06:00:00Z');
    const fresh = await db.collection('messages').findOne({ _id: msg._id });
    const lead = await db.collection('leads').findOne({ company_id: CID });
    const early = await o.gate.check({ message: fresh, lead });
    assert.equal(early.decision, 'wait');
    assert.equal(early.code, 'warmup');
    assert.equal(early.until.toISOString(), '2026-11-18T04:30:00.000Z', '10:00 IST on day 22');
    at('2026-11-20T13:00:00Z');                       // 18:30 IST: after the window
    const late = await o.gate.check({ message: fresh, lead });
    assert.equal(late.code, 'window');
    assert.equal(late.until.toISOString(), '2026-11-23T04:30:00.000Z', 'Monday 10:00 IST: no sending at the weekend');
    at(NOW);

    await o.suppression.add({ domain: 'vezras.in' }, { reason: 'do_not_contact_request' });
    // the queue keeps the database server's time, not the test clock: make the deferred job due now
    await db.collection('jobs').updateOne({ _id: job._id }, { $set: { due_at: new Date(Date.now() - 1000) } });
    job = await claimJob(o, JOB_SEND);
    assert.ok(job, 'the deferred job comes back when due');
    assert.deepEqual(await o.handlers[JOB_SEND](job), { status: 'blocked', code: 'suppressed' });
    assert.equal((await db.collection('messages').findOne({ _id: msg._id })).status, 'blocked');
    assert.equal(readdirSync(outbox).length, 0, 'nothing was sent');
  });

  test('a text changed after approval is never sent, and an edit that fails the check cannot be approved', async () => {
    const { o } = setup();
    const msg = await draftAndApprove(o, { approve: false });
    const bad = await decideApproval(db, { id: String(msg._id), decision: 'approve', user: REVIEWER, cfg: o.cfg, org: o.org, queue: o.queue,
      subject: msg.draft.subject, body: `${msg.draft.body}\nOffer ends 30 November 2026!`, clock });
    assert.equal(bad.ok, false);
    assert.equal((await db.collection('messages').findOne({ _id: msg._id })).status, 'awaiting_approval');
    const edited = msg.draft.body.replace('If this is useful, just reply', 'If this helps, reply');
    assert.equal((await decideApproval(db, { id: String(msg._id), decision: 'approve', user: REVIEWER, cfg: o.cfg, org: o.org, queue: o.queue,
      subject: msg.draft.subject, body: edited, clock })).ok, true);
    const audit = await db.collection('audit_log').findOne({ action: 'approval_decision' });
    assert.equal(audit.detail.edited, true);
    await db.collection('messages').updateOne({ _id: msg._id }, { $set: { 'draft.body': `${edited} ` } });
    const job = await claimJob(o, JOB_SEND);
    assert.equal((await o.handlers[JOB_SEND](job)).code, 'approval_stale');
    assert.equal(readdirSync(outbox).length, 0);
  });

  test('a refused address is a hard bounce; an interrupted send is never repeated', async () => {
    const refused = { kind: 'smtp', send: async () => { throw new SmtpError('550 no such user', { code: 550, stage: 'rcpt', permanent: true }); } };
    const { o } = setup({}, { transport: refused });
    const msg = await draftAndApprove(o);
    const job = await claimJob(o, JOB_SEND);
    assert.equal((await o.handlers[JOB_SEND](job)).status, 'bounced');
    assert.equal(await o.suppression.isSuppressed({ email: 'info@vezras.in' }), true);
    const bounce = await db.collection('activities').findOne({ type: 'bounced' });
    assert.equal(bounce.data.bounce, 'hard');
    assert.equal(bounce.data.mailbox, msg.mailbox);
    assert.equal((await db.collection('usage').findOne({ meter: `email:${msg.mailbox}` })).count, 0, 'the daily unit was given back');

    // a worker died after handing the message over: the next attempt marks it, and sends nothing
    let calls = 0;
    const counting = { kind: 'smtp', send: async () => { calls += 1; return { transport: 'smtp', response: '250' }; } };
    const { o: o2 } = setup({}, { transport: counting });
    await db.collection('messages').deleteMany({});
    await db.collection('jobs').deleteMany({});
    await db.collection('suppressions').deleteMany({});
    await db.collection('activities').deleteMany({});
    const m2 = await draftAndApprove(o2);
    await db.collection('messages').updateOne({ _id: m2._id }, { $set: { status: 'sending' } });
    const j2 = await claimJob(o2, JOB_SEND);
    assert.deepEqual(await o2.handlers[JOB_SEND](j2), { status: 'send_unknown' });
    assert.equal(calls, 0);
    // a person looks in the Sent folder: not there, so it goes back through the gate and out once
    assert.deepEqual(await resolveUnknown(db, { id: String(m2._id), wasSent: false, user: REVIEWER, queue: o2.queue, clock }), { status: 'approved' });
    await assert.rejects(resolveUnknown(db, { id: String(m2._id), wasSent: true, user: REVIEWER, queue: o2.queue, clock }), /interrupted/);
    assert.equal((await o2.handlers[JOB_SEND](await claimJob(o2, JOB_SEND))).status, 'sent');
    assert.equal(calls, 1);
    assert.equal(await db.collection('audit_log').countDocuments({ action: 'outcome_recorded' }), 1);
  });

  test('a follow-up threads under the first email, seven days later, and a recorded reply stops it', async () => {
    const { o } = setup();
    await draftAndApprove(o);
    await o.handlers[JOB_SEND](await claimJob(o, JOB_SEND));
    assert.equal((await planOutreach(o, { month: '2026-11' })).follow_up_queued, 0, 'not yet');
    at('2026-11-27T06:00:00Z');
    assert.equal((await planOutreach(o, { month: '2026-11' })).follow_up_queued, 1);
    await o.handlers[JOB_DRAFT](await claimJob(o, JOB_DRAFT));
    const follow = await db.collection('messages').findOne({ kind: 'follow_up' });
    assert.equal(follow.status, 'awaiting_approval', JSON.stringify(follow.qc.checks.filter((c) => !c.ok)));
    assert.match(follow.draft.subject, /^Re: /);
    const first = await db.collection('messages').findOne({ kind: 'first_touch' });
    await recordOutcome(db, { id: String(first._id), outcome: 'replied', user: REVIEWER, suppression: o.suppression, clock });
    assert.equal((await db.collection('leads').findOne({ company_id: CID })).stage, 'engaged');
    await decideApproval(db, { id: String(follow._id), decision: 'approve', user: REVIEWER, cfg: o.cfg, org: o.org, queue: o.queue, clock });
    const r = await o.handlers[JOB_SEND](await claimJob(o, JOB_SEND));
    assert.deepEqual(r, { status: 'blocked', code: 'replied' }, 'the founder replied: a person takes over');
  });

  test('the next send window, and what must be set before real email', () => {
    const { cfg, o } = setup();
    const caps = cfg.caps;
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
    assert.equal(nextWindowOpen(new Date('2026-11-20T02:00:00Z'), caps, days).toISOString(), '2026-11-20T04:30:00.000Z');
    assert.equal(nextWindowOpen(new Date('2026-11-21T06:00:00Z'), caps, days).toISOString(), '2026-11-23T04:30:00.000Z');
    assert.deepEqual(sendingProblems(cfg, o), []);
    const { cfg: c2, o: o2 } = setup({ PUBLIC_BASE_URL: 'http://localhost:8791', MAILBOX_2_NAME: '' });
    assert.equal(sendingProblems(c2, o2).length, 2);
  });
});

describe('the company page, the claim and unsubscribing', () => {
  let srv;
  let base;
  async function serve(o, cfg) {
    srv = createPublicServer({ db, tokens: o.tokens, ledger: o.ledger, suppression: o.suppression, queue: o.queue, platform: o.platform,
      cfg: o.cfg, org: o.org, secret: cfg.pageSecret, privacyUrl: 'https://solutionai.in/privacy', privacyContact: 'privacy@solutionai.in', clock,
      log: { warn() {}, error() {} } });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${srv.address().port}`;
  }
  after(() => srv?.close());

  test('the page shows only confirmed, company-level facts, and counts one visit a day', async () => {
    const { o, cfg } = setup();
    await serve(o, cfg);
    try {
      const token = await o.tokens.issue({ purpose: 'company_page', companyId: CID });
      const res = await fetch(`${base}/c/${token}`);
      const html = await res.text();
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
      assert.match(res.headers.get('x-robots-tag'), /noindex/);
      assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
      assert.match(html, /Vezras Technologies Private Limited/);
      assert.match(html, /File the declaration for commencement of business/);
      assert.match(html, /was due by 13 November 2026/);
      assert.doesNotMatch(html, /DPT-3|Directors' KYC|Seed Fund/, 'no conditional, ongoing or not-eligible items');
      await fetch(`${base}/c/${token}`);
      assert.equal(await db.collection('activities').countDocuments({ type: 'opened' }), 1);
      await db.collection('leads').updateOne({ company_id: CID }, { $set: { 'needs.rules_confirmed': false } });
      const unconfirmed = await (await fetch(`${base}/c/${token}`)).text();
      assert.match(unconfirmed, /being checked by a chartered accountant/);
      assert.doesNotMatch(unconfirmed, /commencement of business/);
      assert.equal((await fetch(`${base}/c/AAAAAAAAAAAAAAAAAAAAAA`)).status, 404);
    } finally {
      srv.close();
    }
  });

  test('claiming records each agreement with its exact words, stops cold outreach and hands over to sign-up', async () => {
    const { o, cfg } = setup({ PLATFORM_SIGNUP_URL: 'https://app.solutionai.in/signup' });
    await serve(o, cfg);
    try {
      const msg = await draftAndApprove(o, { approve: false });
      const token = await o.tokens.issue({ purpose: 'company_page', companyId: CID });
      const form = await (await fetch(`${base}/c/${token}/claim`)).text();
      assert.match(form, /<label>Your name <input/);
      assert.doesNotMatch(form, /checked/, 'nothing is ticked for the founder');
      const csrf = /name="csrf" value="([^"]+)"/.exec(form)[1];
      const post = (fields) => fetch(`${base}/c/${token}/claim`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
      assert.equal((await post({ csrf: 'forged', name: 'Asha', role: 'Director', email: 'asha@vezras.in' })).status, 403);
      const missingNumber = await post([['csrf', csrf], ['name', 'Asha Verma'], ['role', 'Director'], ['email', 'asha@vezras.in'], ['consent', 'whatsapp_reminders']]);
      assert.equal(missingNumber.status, 400);
      const ok = await post([['csrf', csrf], ['name', 'Asha Verma'], ['role', 'Director'], ['email', 'asha@vezras.in'], ['whatsapp', '98765 43210'],
        ['consent', 'email_reminders'], ['consent', 'whatsapp_reminders']]);
      const thanks = await ok.text();
      assert.equal(ok.status, 200);
      assert.match(thanks, /https:\/\/app\.solutionai\.in\/signup/);
      const consents = await db.collection('consents').find({}).sort({ seq: 1 }).toArray();
      assert.deepEqual(consents.map((c) => [c.channel, c.purpose, c.action]), [['email', 'deadline_reminders', 'grant'], ['whatsapp', 'deadline_reminders', 'grant']]);
      assert.equal(consents[0].wording, "Email me reminders of Vezras Technologies Private Limited's filing deadlines.");
      assert.equal(consents[1].contact.address, '+919876543210');
      assert.match(consents[0].proof.page_token, /^[0-9a-f]{64}$/, 'the proof holds a reference, not the link');
      const person = await db.collection('people').findOne({ company_ids: CID });
      assert.equal(person.contacts.find((c) => c.channel === 'email').legal_basis, 'consent');
      assert.equal((await db.collection('leads').findOne({ company_id: CID })).stage, 'claimed');
      assert.equal((await db.collection('messages').findOne({ _id: msg._id })).status, 'cancelled', 'the cold draft is withdrawn');
      assert.ok(await db.collection('jobs').findOne({ type: JOB_WA_CONFIRM }), 'the WhatsApp confirmation is queued');
      const verified = await new ConsentLedger(db, { secret: TEST_SECRET }).verify();
      assert.equal(verified.ok, true);
    } finally {
      srv.close();
    }
  });

  test('one-click unsubscribe suppresses the address at once and closes the lead', async () => {
    const { o, cfg } = setup();
    await serve(o, cfg);
    try {
      const msg = await draftAndApprove(o);
      await o.handlers[JOB_SEND](await claimJob(o, JOB_SEND));
      const token = await o.tokens.issue({ purpose: 'unsubscribe', companyId: CID, messageId: msg._id });
      const page = await (await fetch(`${base}/u/${token}`)).text();
      assert.match(page, /i•••@vezras\.in/, 'the address is masked on the page');
      assert.equal(await o.suppression.isSuppressed({ email: 'info@vezras.in' }), false, 'opening the link changes nothing');
      const r = await fetch(`${base}/u/${token}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
      assert.equal(r.status, 200);
      assert.equal(await o.suppression.isSuppressed({ email: 'info@vezras.in' }), true);
      assert.equal((await db.collection('leads').findOne({ company_id: CID })).stage, 'closed');
      assert.equal(await db.collection('activities').countDocuments({ type: 'unsubscribed' }), 1);
    } finally {
      srv.close();
    }
  });
});

describe('the AI drafter', () => {
  const gateway = (answers) => {
    const calls = [];
    const fetchFn = async (url, init) => {
      calls.push(JSON.parse(init.body));
      const content = answers.shift();
      return { ok: true, json: async () => ({ model: 'strong-1', choices: [{ message: { content } }], usage: { prompt_tokens: 900, completion_tokens: 300 } }) };
    };
    return { calls, fetchFn };
  };

  test('an AI draft that passes the check is used, and its cost is logged and counted', async () => {
    const { o: probe } = setup();
    const { pack } = buildEvidencePack(company(), leadDoc(), probe.cfg, { asOf: '2026-11-20' });
    const good = templateDraft(pack, { kind: 'first_touch', language: 'en', sender: { name: 'Gourav B', title: 'Founder office' }, org: probe.org });
    const review = JSON.stringify({ facts_only: true, no_false_claims: true, polite: true, one_next_step: true, note: 'Reads well.' });
    const { calls, fetchFn } = gateway([JSON.stringify({ subject: good.subject, body: good.body.replace('Congratulations on', 'Many congratulations on') }), review]);
    const { o } = setup({ LLM_GATEWAY_URL: 'https://llm.example.in/v1', LLM_GATEWAY_KEY: 'k' }, { fetch: fetchFn });
    await planOutreach(o, { month: '2026-11' });
    const r = await o.handlers[JOB_DRAFT](await claimJob(o, JOB_DRAFT));
    assert.equal(r.drafter, 'ai');
    assert.equal(calls[0].model, 'strong');
    assert.match(calls[0].messages[0].content, /Use only the facts in the evidence pack/);
    assert.equal(calls[1].model, 'small', 'the AI review uses the small model');
    const msg = await db.collection('messages').findOne({});
    assert.deepEqual(msg.qc.ai_review, { facts_only: true, no_false_claims: true, polite: true, one_next_step: true, note: 'Reads well.', model: 'strong-1', advisory: true });
    const logged = await db.collection('llm_calls').find({}).sort({ _id: 1 }).toArray();
    assert.deepEqual(logged.map((c) => c.task), ['draft', 'quality_check']);
    assert.ok(logged.every((c) => c.input_tokens === 900 && c.cost_inr > 0));
    assert.equal((await db.collection('usage').findOne({ meter: 'llm_paise' })).count, logged.reduce((n, c) => n + Math.ceil(c.cost_inr * 100), 0));
  });

  test('an AI draft that keeps failing the check gives way to the template; a spent cap calls nothing', async () => {
    const invented = JSON.stringify({ subject: 'Vezras Technologies Private Limited: dates', body: 'Hello Vezras Technologies Private Limited team, pay ₹9,999 by 1 December 2026. {{page_url}} unsubscribe {{unsubscribe_url}}' });
    const { calls, fetchFn } = gateway([invented, invented, 'not json']);
    const { o } = setup({ LLM_GATEWAY_URL: 'https://llm.example.in/v1', LLM_GATEWAY_KEY: 'k' }, { fetch: fetchFn });
    await planOutreach(o, { month: '2026-11' });
    const r = await o.handlers[JOB_DRAFT](await claimJob(o, JOB_DRAFT));
    assert.equal(r.drafter, 'template');
    assert.equal(calls.length, 3, 'two drafts, then the review of the template draft');
    assert.match(calls[1].messages[1].content, /your_last_draft_failed_these_checks/);
    const msg = await db.collection('messages').findOne({});
    assert.equal(msg.status, 'awaiting_approval');
    assert.equal(msg.draft.tries.length, 3);
    assert.equal(msg.qc.ai_review, undefined, 'an unreadable review is left out, never guessed');

    await db.collection('messages').deleteMany({});
    await db.collection('jobs').deleteMany({});
    await db.collection('usage').updateOne({ _id: 'llm_paise:2026-11' }, { $set: { meter: 'llm_paise', period: '2026-11', count: 40_000, cap: 40_000, updated_at: new Date(now) } }, { upsert: true });
    const before = calls.length;
    await planOutreach(o, { month: '2026-11' });
    assert.equal((await o.handlers[JOB_DRAFT](await claimJob(o, JOB_DRAFT))).drafter, 'template');
    assert.equal(calls.length, before, 'no call once the month\'s cap would be passed');
  });
});

describe('reminders for founders who asked for them', () => {
  test('a reminder 7 days before a confirmed deadline, only with consent, inside WhatsApp hours, only with an approved template', async () => {
    const sentTo = [];
    const fetchFn = async (url, init) => {
      sentTo.push({ url, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ messages: [{ id: 'wamid.1' }] }) };
    };
    const { o } = setup({ WHATSAPP_PHONE_NUMBER_ID: '123', WHATSAPP_TOKEN: 't' }, { fetch: fetchFn });
    await db.collection('leads').updateOne({ company_id: CID }, { $set: { stage: 'claimed', 'needs.deadlines.1.due': '2026-11-27' } });
    const person = (await db.collection('people').insertOne({ name: 'Asha Verma', company_ids: [CID], created_at: new Date(now), updated_at: new Date(now),
      contacts: [{ channel: 'whatsapp', address: '+919876543210', source: 'company_page_claim', legal_basis: 'consent', verified: false }] })).insertedId;
    assert.equal((await planReminders(o)).queued, 0, 'no consent in the ledger yet');
    await o.ledger.grant({ subject: { type: 'person', id: String(person) }, channel: 'whatsapp', purpose: 'deadline_reminders', address: '+919876543210',
      wording: 'Send me WhatsApp reminders.', wordingVersion: 'claim-v1', capturedVia: 'company_page_claim' });
    assert.equal((await planReminders(o)).queued, 1);
    const job = await o.queue.claim('w', { types: [JOB_REMINDER] });
    await assert.rejects(o.handlers[JOB_REMINDER](job), (e) => e instanceof DeferError && /not approved/.test(e.message));
    await db.collection('channel_templates').insertOne({ _id: 'whatsapp:filing_deadline_reminder:en', channel: 'whatsapp', name: 'filing_deadline_reminder',
      language: 'en', category: 'UTILITY', status: 'APPROVED', quality: 'GREEN', meta_id: '1', synced_at: new Date(now) });
    at('2026-11-20T17:00:00Z');                      // 22:30 IST
    await assert.rejects(o.handlers[JOB_REMINDER](job), (e) => e instanceof DeferError && e.until.toISOString() === '2026-11-21T03:30:00.000Z');
    at(NOW);
    assert.deepEqual(await o.handlers[JOB_REMINDER](job), { status: 'sent' });
    assert.equal(sentTo[0].body.to, '919876543210');
    assert.equal(sentTo[0].body.template.name, 'filing_deadline_reminder');
    assert.deepEqual(sentTo[0].body.template.components[0].parameters.map((p) => p.text),
      ['Vezras Technologies Private Limited', 'File the declaration for commencement of business (INC-20A)', '27 November 2026']);
    assert.equal((await db.collection('usage').findOne({ meter: 'whatsapp_paise' })).count, 15);
    await o.ledger.withdraw({ subject: { type: 'person', id: String(person) }, channel: 'whatsapp', purpose: 'deadline_reminders', address: '+919876543210',
      wording: 'STOP', wordingVersion: 'whatsapp-stop', capturedVia: 'whatsapp_reply' });
    assert.deepEqual(await o.handlers[JOB_REMINDER](job), { skipped: 'consent is not (or no longer) granted' });
  });
});

describe('the approval queue over HTTP', () => {
  test('reviewers decide, viewers only read, a failing edit is refused, and every decision is logged', async () => {
    const { o } = setup();
    const msg = await draftAndApprove(o, { approve: false });
    const users = Object.fromEntries(['viewer', 'reviewer'].map((role) => [role, newUser(`${role}@solutionai.in`, role)]));
    const auth = new Auth({ users: Object.values(users).map((u) => { const [email, role, hash] = u.entry.split(','); return { email, role, hash, epoch: 0 }; }),
      secret: 's'.repeat(40) });
    const srv = createAdminServer({ db, auth, clock, log: { error() {} }, outreach: { queue: o.queue, cfg: o.cfg, org: o.org, suppression: o.suppression } });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const call = (role, pathname, body) => fetch(`${base}${pathname}`, { method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${users[role].token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    try {
      const list = await (await call('viewer', '/api/approvals')).json();
      assert.equal(list.waiting.length, 1);
      assert.equal(list.waiting[0].recipient.address, 'info@vezras.in', 'a role address is company-level and shown');
      assert.equal((await call('viewer', `/api/approvals/${msg._id}`, { decision: 'approve' })).status, 403);
      const refused = await call('reviewer', `/api/approvals/${msg._id}`, { decision: 'approve', subject: msg.draft.subject, body: `${msg.draft.body}\nPay ₹9,999 now.` });
      assert.equal(refused.status, 422);
      const ok = await call('reviewer', `/api/approvals/${msg._id}`, { decision: 'approve' });
      assert.deepEqual(await ok.json(), { saved: true, queued: true });
      assert.equal((await call('reviewer', `/api/approvals/${msg._id}`, { decision: 'approve' })).status, 400, 'decided once');
      assert.equal(await db.collection('audit_log').countDocuments({ action: 'approval_decision', actor: 'reviewer@solutionai.in' }), 1);
      const page = await (await call('reviewer', `/admin/approvals/${msg._id}`)).text();
      assert.match(page, /Approved/);
    } finally {
      srv.close();
    }
  });
});

after(() => { try { rmSync(outbox, { recursive: true, force: true }); } catch { /* temp folder */ } });

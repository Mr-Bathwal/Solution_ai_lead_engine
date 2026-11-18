import { buildEmail } from '../outreach/mime.js';
import { sendSmtp } from '../outreach/smtp.js';
import { readNew } from '../inbound/imap.js';
import { parseMessage } from '../inbound/parse.js';
import { readMailboxes } from '../inbound/process.js';
import { MessageStore } from '../outreach/messages.js';
import { JOB_DRAFT, JOB_SEND, mailboxFor, planOutreach } from '../outreach/sequence.js';
import { STAGING_CID, assertStaging, seedStaging } from './staging.js';

/**
 * The live end-to-end email test (ops/WEEK4_ACTIONS.md, item 4), in one command on a staging
 * database: `lead-engine staging:smoke`. With the two real mailboxes it proves, in about five minutes:
 *
 *   1. the staging company is seeded, addressed to the other outreach mailbox
 *   2. the email is drafted and passes the 18 checks
 *   3. it is approved (as "staging:smoke": staging only, to our own mailbox) and the compliance gate
 *      lets it through
 *   4. it really leaves through Zoho SMTP
 *   5. it arrives in the other mailbox (read with IMAP), with the unsubscribe headers, the page and
 *      unsubscribe links, and Zoho's DKIM signature
 *   6. the other mailbox replies "What are your charges? Please call me."
 *   7. the engine reads the reply, matches it to the email, labels it interested, stops the
 *      follow-up and moves the lead to engaged
 *   8. if the pages are reachable at PUBLIC_BASE_URL: the company page opens and the one-click
 *      unsubscribe suppresses the address
 *
 * Every step is reported; the staging database is left for inspection (staging:clear removes it).
 * Nothing touches the real database: the command refuses any LEAD_DB that does not end in _staging.
 */

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runSmoke(deps, { dbName, caps, root, buildDeps, sendReply = sendSmtp, readNewFn = readNew, fetch = globalThis.fetch,
  sleep = sleepMs, waitMs = 180_000, pollMs = 10_000, clock = () => new Date(), log = () => {} }) {
  assertStaging(dbName);
  const steps = [];
  const step = async (name, fn) => {
    const started = Date.now();
    try {
      const detail = await fn();
      steps.push({ name, status: 'pass', detail, ms: Date.now() - started });
      log(`PASS ${name}: ${detail}`);
      return true;
    } catch (err) {
      steps.push({ name, status: 'fail', detail: err.message, ms: Date.now() - started });
      log(`FAIL ${name}: ${err.message}`);
      return false;
    }
  };
  const done = () => ({ ok: steps.every((s) => s.status !== 'fail'), steps });

  const ids = caps.email.mailbox_ids;
  const senderId = mailboxFor(STAGING_CID, ids);
  const receiverId = ids.find((id) => id !== senderId);
  const sender = deps.mailboxes[senderId];
  const receiver = deps.mailboxes[receiverId];
  let o = deps;
  let msg = null;
  let delivered = null;

  if (!await step('settings', async () => {
    if (deps.transport.kind !== 'smtp') throw new Error('OUTREACH_TRANSPORT must be smtp: the test sends a real email');
    for (const [id, mb] of [[senderId, sender], [receiverId, receiver]]) {
      if (!mb?.address || !mb.pass) throw new Error(`${id} needs its address and SMTP app password`);
      if (!deps.imap?.[id]?.configured) throw new Error(`${id} cannot be read with IMAP`);
    }
    if (!/^https:\/\//.test(deps.publicBaseUrl ?? '')) throw new Error('PUBLIC_BASE_URL must be https');
    return `${sender.address} sends to ${receiver.address}`;
  })) return done();

  if (!await step('seed', async () => {
    const r = await seedStaging(deps.db, { dbName, email: receiver.address, caps, root, clock });
    // the staging caps written by the seed: warm-up over, and the whole day open for this one test
    o = buildDeps(r.caps_file);
    return `${r.company} on the ${r.month} shortlist, registered email ${r.email}`;
  })) return done();

  if (!await step('draft', async () => {
    await planOutreach(o, { month: istMonthOf(clock()) });
    const job = await claimDue(o, JOB_DRAFT);
    if (!job) throw new Error('no draft job was queued');
    await o.handlers[JOB_DRAFT](job);
    await o.queue.complete(job, null);
    msg = await o.db.collection('messages').findOne({ company_id: STAGING_CID, kind: 'first_touch' });
    if (msg?.status !== 'awaiting_approval') throw new Error(`the draft is ${msg?.status}: ${JSON.stringify(msg?.qc?.checks?.filter((c) => !c.ok) ?? [])}`);
    return `"${msg.draft.subject}" (${msg.draft.drafter}), 18 checks passed`;
  })) return done();

  if (!await step('approve and gate', async () => {
    const store = new MessageStore(o.db, { clock });
    const r = await store.decide(msg._id, { decision: 'approve', user: { email: 'staging:smoke', role: 'admin' }, note: 'staging smoke test', cfg: o.cfg, org: o.org });
    if (!r.ok) throw new Error('the approval was refused');
    const lead = await o.db.collection('leads').findOne({ company_id: STAGING_CID });
    const verdict = await o.gate.check({ message: r.message, lead });
    if (verdict.decision !== 'send') throw new Error(`the gate says ${verdict.decision}: ${verdict.reasons.join('; ')}`);
    await o.budget.release(verdict.reservation, { sent: false });
    await o.queue.enqueue({ type: JOB_SEND, idemKey: `send:${msg._id}`, leadId: msg.lead_id, step: 'send', payload: { message_id: String(msg._id) } });
    return 'approved; the gate answers send';
  })) return done();

  if (!await step('send', async () => {
    const job = await claimDue(o, JOB_SEND);
    const r = await o.handlers[JOB_SEND](job);
    await o.queue.complete(job, r);
    if (r.status !== 'sent') throw new Error(`the send ended ${JSON.stringify(r)}`);
    msg = await o.db.collection('messages').findOne({ _id: msg._id });
    return `sent through SMTP: ${msg.send.response?.slice(0, 80) ?? ''}`;
  })) return done();

  const since = new Date(clock().getTime() - 15 * 60_000);
  if (!await step('delivered', async () => {
    const until = Date.now() + waitMs;
    while (Date.now() < until) {
      const r = await readNewFn(o.imap[receiverId], { since, limit: 50 });
      const m = r.messages.map((x) => ({ x, p: parseMessage(x.raw) })).find(({ p }) => p.messageId === msg.send.message_id.toLowerCase());
      if (m) {
        delivered = m;
        break;
      }
      await sleep(pollMs);
    }
    if (!delivered) throw new Error(`not in ${receiver.address} within ${waitMs / 1000} s: check the Spam folder and the mailbox's sending limits`);
    const head = delivered.x.raw.toString('latin1').split(/\r?\n\r?\n/)[0];
    const problems = [];
    if (!/^List-Unsubscribe:/im.test(head)) problems.push('no List-Unsubscribe header');
    if (!/^List-Unsubscribe-Post: List-Unsubscribe=One-Click/im.test(head)) problems.push('no one-click header');
    if (!new RegExp(`${deps.publicBaseUrl.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/c/`).test(delivered.p.text)) problems.push('no company page link');
    if (!/\/u\/[A-Za-z0-9_-]+/.test(delivered.p.text)) problems.push('no unsubscribe link');
    if (problems.length) throw new Error(problems.join('; '));
    const dkim = /^DKIM-Signature:/im.test(head) ? 'DKIM-signed' : 'NOT DKIM-signed (publish Zoho\'s DKIM key)';
    const auth = /^Authentication-Results:.*$/im.exec(head)?.[0]?.slice(0, 160) ?? 'no Authentication-Results header';
    return `arrived; headers and links present; ${dkim}; ${auth}`;
  })) return done();

  if (!await step('reply', async () => {
    const reply = buildEmail({ from: { name: 'Staging Founder', address: receiver.address }, to: { name: null, address: sender.address },
      subject: `Re: ${msg.draft.subject}`, text: 'What are your charges? Please call me.', unsubscribe: null, inReplyTo: msg.send.message_id, at: clock() });
    await sendReply({ host: o.transport.host, port: o.transport.port, user: receiver.user, pass: receiver.pass, from: receiver.address, to: sender.address, raw: reply.raw });
    return `${receiver.address} replied`;
  })) return done();

  if (!await step('reply read and classified', async () => {
    const until = Date.now() + waitMs;
    let doc = null;
    while (Date.now() < until && !doc) {
      await readMailboxes(o, { readNewFn, log: { error() {} } });
      doc = await o.db.collection('inbound').findOne({ 'matched.message_id': msg._id, kind: 'reply' });
      if (!doc) await sleep(pollMs);
    }
    if (!doc) throw new Error(`the reply was not read from ${sender.address} within ${waitMs / 1000} s`);
    const lead = await o.db.collection('leads').findOne({ company_id: STAGING_CID });
    if (doc.label !== 'interested') throw new Error(`labelled ${doc.label}, expected interested`);
    if (lead.stage !== 'engaged') throw new Error(`the lead is ${lead.stage}, expected engaged`);
    return `matched by ${doc.matched.how}; labelled interested (${Math.round(doc.classification.confidence * 100)}%); lead engaged; waits in the inbox`;
  })) return done();

  await step('pages and one-click unsubscribe', async () => {
    const base = deps.publicBaseUrl.replace(/\/+$/, '');
    const health = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (!health?.ok) return `skipped: ${base} is not reachable from here yet`;
    const page = /https?:\/\/\S+\/c\/[A-Za-z0-9_-]+/.exec(delivered.p.text)?.[0];
    const unsub = /https?:\/\/\S+\/u\/[A-Za-z0-9_-]+/.exec(delivered.p.text)?.[0];
    const p = await fetch(page, { signal: AbortSignal.timeout(8000) });
    if (!p.ok) throw new Error(`the company page answered ${p.status}`);
    const u = await fetch(unsub, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(8000) });
    if (!u.ok) throw new Error(`the one-click unsubscribe answered ${u.status}`);
    if (!(await o.suppression.check({ email: receiver.address })).some((h) => h.reason === 'unsubscribe')) throw new Error('the address is not on the suppression list');
    return 'the company page opens; one click suppresses the address';
  });
  return done();
}

const istMonthOf = (at) => new Date(at.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 7);

/** Claims a job of this type, whatever the database clock says about its due time. */
async function claimDue(o, type) {
  await o.db.collection('jobs').updateMany({ type, status: 'pending' }, { $set: { due_at: new Date(Date.now() - 1000) } });
  return o.queue.claim('staging-smoke', { types: [type] });
}

import { SAMPLE_USER, pickForPerson, samplingState } from './sampling.js';
import { createHash } from 'node:crypto';
import { DeferError, PermanentError } from '../jobs/worker.js';
import { buildEvidencePack, istDate, packHash, recipientFor } from './evidence.js';
import { MessageStore } from './messages.js';
import { knownNames } from '../inbound/process.js';
import { buildEmail } from './mime.js';
import { PAGE_URL, UNSUBSCRIBE_URL } from './templates.js';

/**
 * A lead's email sequence on the job table (design 7.5):
 *
 *   plan (daily, `lead-engine outreach:plan`) -> outreach.draft job per shortlisted company
 *     -> evidence pack -> draft -> quality check -> message awaiting approval
 *   a person approves in the Admin approval queue -> outreach.send job
 *     -> compliance gate -> send -> 'sent' activity, lead becomes 'contacted'
 *   plan, 7 days later, if nothing came back -> follow-up draft -> approval -> send
 *   plan, later, when a deadline or scheme that no earlier message mentioned starts to apply ->
 *     a new-need draft about that one need (contact budget: once per need, 30 days after the last
 *     message, never after a reply, an opt-out or a claim) -> approval -> send
 *
 * Sending is at most once. A message is moved to 'sending' before the transport is called; a send
 * job that finds its message already 'sending' (a worker died mid-send) marks it 'send_unknown' for a
 * person to check, and never sends it again. A hard bounce at the SMTP stage suppresses the address
 * and counts against the mailbox at once.
 */

export const JOB_DRAFT = 'outreach.draft';
export const JOB_SEND = 'outreach.send';
const DAY = 86_400_000;

/** A company's mailbox: the same one every time, spread evenly over the mailboxes. */
export function mailboxFor(companyId, ids) {
  const h = createHash('sha256').update(companyId).digest().readUInt32BE(0);
  return ids[h % ids.length];
}

const leadsCol = (db) => db.collection('leads');

/**
 * Who a company's first email goes to. Its registered email, unless an address check has already
 * ruled that out for good (then a role address on its own website, if one is known and allowed,
 * gets its own chance). The same answer for the planner and the draft step.
 */
async function firstRecipient(db, company, recipientCfg) {
  const dead = await db.collection('activities').findOne({ company_id: company._id, type: 'address_not_used', 'data.use': 'never',
    'data.source': { $ne: 'company_website' } }, { projection: { _id: 1 } });
  return recipientFor(company, recipientCfg, { registeredUnusable: Boolean(dead) });
}

/** One draft job per address source: a website address found after the registered one failed gets a job of its own. */
const firstTouchKey = (cid, recipient) => (recipient.source === 'company_website' ? `draft:${cid}:first_touch:website` : `draft:${cid}:first_touch`);

/**
 * Finds what needs drafting today and queues it: a first email for every company on the month's
 * shortlist that can be contacted and has an address, and a follow-up where the first email went
 * out long enough ago. Also expires stale drafts. Returns counts.
 */
export async function planOutreach(deps, { month }) {
  const { db, queue, caps, budget, clock } = deps;
  const store = new MessageStore(db, { clock });
  const stats = { shortlisted: 0, no_address: 0, already_drafted: 0, first_touch_queued: 0, follow_up_queued: 0, follow_up_not_due: 0,
    new_need_queued: 0, new_need_not_allowed: 0, expired: 0 };
  stats.expired = await store.expireOld();
  const leads = await leadsCol(db).find({ 'shortlist.month': month, holdout: false, eligible: true, stage: 'shortlisted' }).toArray();
  for (const lead of leads) {
    stats.shortlisted += 1;
    if (await db.collection('messages').findOne({ idem_key: MessageStore.idemKey(lead.company_id, 'first_touch') }, { projection: { _id: 1 } })) {
      stats.already_drafted += 1;
      continue;
    }
    const company = await db.collection('companies').findOne({ _id: lead.company_id }, { projection: { 'attrs.registered_email': 1, 'attrs.website_email': 1 } });
    const recipient = company && await firstRecipient(db, company, deps.cfg.recipient);
    if (!recipient) {
      stats.no_address += 1;
      continue;
    }
    const r = await queue.enqueue({ type: JOB_DRAFT, idemKey: firstTouchKey(lead.company_id, recipient), leadId: lead._id, step: 'draft',
      payload: { company_id: lead.company_id, kind: 'first_touch' } });
    if (r.created) stats.first_touch_queued += 1;
  }
  const now = clock();
  const firsts = await db.collection('messages').find({ kind: 'first_touch', status: 'sent',
    'send.at': { $lte: new Date(now.getTime() - caps.contact_budget.follow_up_after_days * DAY) } }).toArray();
  for (const first of firsts) {
    if (await db.collection('messages').findOne({ idem_key: MessageStore.idemKey(first.company_id, 'follow_up') }, { projection: { _id: 1 } })) continue;
    const lead = await leadsCol(db).findOne({ company_id: first.company_id });
    const ok = await budget.check({ lead, kind: 'follow_up', mailbox: first.mailbox, stage: 'draft' });
    if (!ok.allowed) {
      stats.follow_up_not_due += 1;
      continue;
    }
    const r = await queue.enqueue({ type: JOB_DRAFT, idemKey: `draft:${first.company_id}:follow_up`, leadId: lead?._id ?? null, step: 'draft',
      payload: { company_id: first.company_id, kind: 'follow_up' } });
    if (r.created) stats.follow_up_queued += 1;
  }
  // new needs: companies contacted before, whose confirmed needs now include one no message has mentioned
  const contacted = await leadsCol(db).find({ stage: 'contacted', holdout: false, eligible: true, 'needs.rules_confirmed': true }).toArray();
  for (const lead of contacted) {
    const first = await db.collection('messages').findOne({ idem_key: MessageStore.idemKey(lead.company_id, 'first_touch'), status: 'sent' });
    if (!first) continue;
    const need = await newNeedFor(db, lead, deps.cfg, clock());
    if (!need) continue;
    const ok = await budget.check({ lead, kind: 'new_need', needId: need.id, mailbox: first.mailbox, stage: 'draft' });
    if (!ok.allowed) {
      stats.new_need_not_allowed += 1;
      continue;
    }
    const r = await queue.enqueue({ type: JOB_DRAFT, idemKey: `draft:${lead.company_id}:new_need:${need.id}`, leadId: lead._id, step: 'draft',
      payload: { company_id: lead.company_id, kind: 'new_need', need_id: need.id } });
    if (r.created) stats.new_need_queued += 1;
  }
  return stats;
}

/** The id a need goes by in messages and the contact budget: a deadline with its date, or a scheme. */
const needIdOf = (type, item) => (type === 'deadline' ? `d:${item.id}:${item.due}` : `s:${item.id}`);

/**
 * The first deadline or scheme the company's evidence pack would mention today that no earlier
 * message to it mentioned: { id, type, item } or null. Only upcoming deadlines count (a date that has
 * passed is no reason to write again), and a scheme only once its verdict is eligible or check
 * required.
 */
export async function newNeedFor(db, lead, cfg, now) {
  const company = await db.collection('companies').findOne({ _id: lead.company_id });
  const built = buildEvidencePack(company, lead, cfg, { asOf: istDate(now) });
  if (!built.pack) return null;
  const before = await db.collection('messages').find({ company_id: lead.company_id, status: { $in: ['sent', 'send_unknown', 'approved', 'awaiting_approval', 'sending'] } },
    { projection: { 'evidence.pack.deadlines': 1, 'evidence.pack.schemes': 1, need_id: 1 } }).toArray();
  const said = new Set();
  for (const m of before) {
    for (const d of m.evidence?.pack?.deadlines ?? []) said.add(needIdOf('deadline', d));
    for (const s of m.evidence?.pack?.schemes ?? []) said.add(needIdOf('scheme', s));
    if (m.need_id) said.add(m.need_id);
  }
  const d = built.pack.deadlines.find((x) => x.status === 'upcoming' && x.id && !said.has(needIdOf('deadline', x)));
  if (d) return { id: needIdOf('deadline', d), type: 'deadline', item: d };
  const s = built.pack.schemes.find((x) => x.id && !said.has(needIdOf('scheme', x)));
  if (s) return { id: needIdOf('scheme', s), type: 'scheme', item: s };
  return null;
}

/**
 * The job handlers. `deps`: { db, queue, cfg, caps, org, mailboxes, drafter, gate, budget,
 * suppression, transport, tokens, publicBaseUrl, clock, log }.
 */
export function outreachHandlers(deps) {
  const { db, cfg, mailboxes, drafter, clock } = deps;
  const store = new MessageStore(db, { clock });

  async function draftStep(job) {
    const { company_id: cid, kind } = job.payload;
    const idem = MessageStore.idemKey(cid, kind);
    if (await db.collection('messages').findOne({ idem_key: idem }, { projection: { _id: 1 } })) return { skipped: 'already drafted' };
    const [company, lead] = await Promise.all([db.collection('companies').findOne({ _id: cid }), leadsCol(db).findOne({ company_id: cid })]);
    if (!company || !lead) return { skipped: 'no company or lead' };
    if (lead.holdout || lead.eligible === false) return { skipped: 'holdout or not eligible' };
    let recipient;
    let mailbox;
    let first = null;
    if (kind === 'follow_up' || kind === 'new_need') {
      first = await db.collection('messages').findOne({ idem_key: MessageStore.idemKey(cid, 'first_touch'), status: 'sent' });
      if (!first) return { skipped: 'no first email was sent' };
      ({ recipient, mailbox } = first);
    } else {
      recipient = await firstRecipient(db, company, cfg.recipient);
      mailbox = mailboxFor(cid, deps.caps.email.mailbox_ids);
    }
    if (!recipient) return { skipped: 'no address' };
    if (kind === 'first_touch' && deps.verifier) {
      // a person's address gets the free checks only: it is never sent to the verification service
      const v = await deps.verifier.verify(recipient.address, { external: !recipient.personal });
      // accept-all addresses wait for the second wave (design 7.3): the job comes back once, later
      const secondWave = v.use === 'hold' && (job.deferrals ?? 0) > 0;
      if (v.use !== 'send' && !secondWave) {
        await db.collection('activities').insertOne({ at: clock(), type: 'address_not_used', channel: 'email', company_id: cid, lead_id: lead._id, holdout: false,
          idem_key: `address_not_used:${cid}:${v.result}:${istDate(clock())}`, data: { result: v.result, use: v.use, provider: v.provider, source: recipient.source } })
          .catch((err) => { if (err?.code !== 11000) throw err; });
        if (v.use === 'hold') {
          const days = cfg.verification?.second_wave_after_days ?? 14;
          throw new DeferError(`${v.reason}: held back from the first wave, tried again in ${days} days`, new Date(clock().getTime() + days * DAY));
        }
        return { skipped: `${v.reason}: not used`, verification: v.result };
      }
      recipient = { ...recipient, verification: { result: v.result, provider: v.provider, checked_at: v.checked_at, ...(secondWave ? { wave: 2 } : {}) } };
    }
    const built = buildEvidencePack(company, lead, cfg, { asOf: istDate(clock()) });
    if (!built.pack) return { skipped: built.reason };
    const { pack } = built;
    // an address from the company's own website: the email's last paragraph says so (templates.js, why)
    if (recipient.legal_basis === 'published_by_company') pack.contact = { basis: 'published_by_company', domain: recipient.domain };
    // a follow-up may mention when the first email went: that date becomes part of its evidence
    if (first) pack.thread = { first_sent_on: istDate(first.send.at), first_subject: first.draft.subject };
    if (kind === 'new_need') {
      // the message is about the one new need, and the pack holds nothing else it could mention
      const need = await newNeedFor(db, lead, cfg, clock());
      if (!need || need.id !== job.payload.need_id) return { skipped: 'the need is no longer new or no longer applies' };
      pack.deadlines = need.type === 'deadline' ? [{ ...need.item, ref: 'D1' }] : [];
      pack.schemes = need.type === 'scheme' ? [{ ...need.item, ref: 'S1' }] : [];
      pack.need = { type: need.type, id: need.id, ref: need.type === 'deadline' ? 'D1' : 'S1' };
    }
    const hash = packHash(pack);
    const language = first?.language ?? cfg.default_language;
    const mb = mailboxes[mailbox] ?? {};
    const draft = await drafter.draft(pack, {
      kind, language, sender: { name: mb.name ?? deps.org.name, title: mb.title ?? null }, companyId: cid, leadId: lead._id, names: await knownNames(db, cid),
      firstSubject: first?.draft?.subject ?? null, firstSentOn: first?.send?.at ? istDate(first.send.at) : null,
    });
    const r = await store.create({
      companyId: cid, leadId: lead._id, kind, language, recipient, mailbox,
      evidence: { version: pack.version, hash, pack }, draft, needId: kind === 'new_need' ? job.payload.need_id : null,
      expiresAt: new Date(clock().getTime() + cfg.message_expiry_days * DAY),
    });
    // sample mode (outreach/sampling.js): most drafts that pass the check are approved by the engine
    if (r.created && r.message.status === 'awaiting_approval') {
      const sampling = await samplingState(db, cfg, { clock });
      if (sampling.active && sampling.kinds.includes(kind)) {
        if (pickForPerson(sampling.sample_pct)) {
          await db.collection('messages').updateOne({ _id: r.message._id }, { $set: { approval_route: 'sampled' },
            $push: { history: { at: clock(), status: 'awaiting_approval', by: 'engine', note: `picked for a person (the ${sampling.sample_pct}% sample)` } } });
          return { message_id: String(r.message._id), status: 'awaiting_approval', drafter: draft.drafter, route: 'sampled' };
        }
        const d = await store.decide(r.message._id, { decision: 'approve', user: SAMPLE_USER, note: `sample mode: ${sampling.reason}`, cfg, org: deps.org });
        if (d.ok) {
          await db.collection('messages').updateOne({ _id: r.message._id }, { $set: { approval_route: 'engine' } });
          await queueSend(deps.queue, d.message);
          return { message_id: String(r.message._id), status: 'approved', drafter: draft.drafter, route: 'engine' };
        }
      }
    }
    return { message_id: String(r.message._id), status: r.message.status, drafter: draft.drafter };
  }

  async function sendStep(job, { signal } = {}) {
    const msg = await store.byId(job.payload.message_id);
    if (!msg) return { skipped: 'no such message' };
    if (msg.status === 'sending') {
      // a worker died between handing the message over and recording it: never send twice
      await store.move(msg._id, 'sending', 'send_unknown', { note: 'the send was interrupted; check the mailbox\'s Sent folder before doing anything' });
      return { status: 'send_unknown' };
    }
    if (msg.status !== 'approved') return { skipped: `message is ${msg.status}` };
    const lead = await leadsCol(db).findOne({ company_id: msg.company_id });
    const verdict = await deps.gate.check({ message: msg, lead });
    const gateDoc = { at: clock(), decision: verdict.decision, code: verdict.code, reasons: verdict.reasons, until: verdict.until ?? null };
    if (verdict.decision === 'wait') {
      await db.collection('messages').updateOne({ _id: msg._id }, { $set: { gate: gateDoc, updated_at: clock() } });
      throw new DeferError(verdict.reasons.join('; '), verdict.until);
    }
    if (verdict.decision === 'stop') {
      await store.move(msg._id, 'approved', 'blocked', { set: { gate: gateDoc }, note: verdict.reasons.join('; ') });
      return { status: 'blocked', code: verdict.code };
    }
    const { reservation } = verdict;
    let handedOver = false;
    try {
      if (signal?.aborted) throw signal.reason;
      const sending = await store.move(msg._id, 'approved', 'sending', { set: { gate: gateDoc } });
      if (!sending) {
        await deps.budget.release(reservation, { sent: false });
        return { skipped: 'the message changed while the gate ran' };
      }
      const mb = mailboxes[msg.mailbox];
      const [pageToken, unsubToken] = await Promise.all([
        deps.tokens.issue({ purpose: 'company_page', companyId: msg.company_id, leadId: msg.lead_id, messageId: msg._id }),
        deps.tokens.issue({ purpose: 'unsubscribe', companyId: msg.company_id, leadId: msg.lead_id, messageId: msg._id }),
      ]);
      const base = deps.publicBaseUrl.replace(/\/+$/, '');
      const text = msg.draft.body.replaceAll(PAGE_URL, `${base}/c/${pageToken}`).replaceAll(UNSUBSCRIBE_URL, `${base}/u/${unsubToken}`);
      let inReplyTo = null;
      if (msg.kind === 'follow_up') {
        inReplyTo = (await db.collection('messages').findOne({ idem_key: MessageStore.idemKey(msg.company_id, 'first_touch') }))?.send?.message_id ?? null;
      }
      const email = buildEmail({
        from: { name: mb.name, address: mb.address }, to: { name: null, address: msg.recipient.address }, subject: msg.draft.subject, text,
        unsubscribe: { url: `${base}/u/${unsubToken}`, mailto: mb.address }, inReplyTo, at: clock(),
      });
      handedOver = true;
      let result;
      try {
        result = await deps.transport.send({ raw: email.raw, messageId: email.messageId, mailbox: mb, to: msg.recipient.address });
      } catch (err) {
        return await failedSend(msg, err, reservation);
      }
      const now = clock();
      await db.collection('activities').insertOne({
        at: now, type: 'sent', channel: 'email', company_id: msg.company_id, lead_id: msg.lead_id, campaign: `outreach:${msg.kind}`,
        template_version: msg.draft.prompt_version ?? null, model_version: msg.draft.model ?? null, holdout: false, idem_key: `sent:${msg._id}`,
        data: { kind: msg.kind, mailbox: msg.mailbox, message_id: msg._id, email_message_id: email.messageId, transport: result.transport,
          ...(msg.need_id ? { need_id: msg.need_id } : {}) },
      });
      await store.move(msg._id, 'sending', 'sent', { set: { send: { at: now, message_id: email.messageId, transport: result.transport, response: result.response } } });
      await deps.budget.release(reservation, { sent: true });
      await leadsCol(db).updateOne({ company_id: msg.company_id, stage: { $in: ['discovered', 'shortlisted'] } }, { $set: { stage: 'contacted', updated_at: now } });
      return { status: 'sent', transport: result.transport };
    } catch (err) {
      if (!handedOver) {
        await store.move(msg._id, 'sending', 'approved', { note: `not sent: ${err?.message ?? err}` });
        await deps.budget.release(reservation, { sent: false });
      }
      throw err;
    }
  }

  /**
   * The transport refused or failed. What it means depends on whether anything can have been
   * delivered: a reply code from the server proves it was not; silence after the message itself was
   * handed over proves nothing.
   */
  async function failedSend(msg, err, reservation) {
    const now = clock();
    const smtp = err?.name === 'SmtpError';
    const note = String(err?.message ?? err).slice(0, 300);
    if (smtp && err.code && err.permanent && err.stage === 'rcpt') {
      // the server refused the address itself: a hard bounce, known before anything was delivered
      await db.collection('activities').insertOne({ at: now, type: 'bounced', channel: 'email', company_id: msg.company_id, lead_id: msg.lead_id,
        holdout: false, idem_key: `bounced:${msg._id}`, data: { mailbox: msg.mailbox, bounce: 'hard', message_id: msg._id, smtp_code: err.code, stage: err.stage } });
      await deps.suppression.add({ email: msg.recipient.address }, { reason: 'hard_bounce', source: { via: 'smtp', code: err.code } });
      await store.move(msg._id, 'sending', 'bounced', { set: { send: { at: now, error: note } }, note });
      await deps.budget.release(reservation, { sent: false });
      return { status: 'bounced', code: err.code };
    }
    if (smtp && err.code && err.permanent && err.stage === 'message') {
      // the server read the message and refused it for good (content, policy): not delivered, not to be retried
      await store.move(msg._id, 'sending', 'blocked', { set: { send: { at: now, error: note } }, note: `refused by the mail server: ${note}` });
      await deps.budget.release(reservation, { sent: false });
      return { status: 'blocked', code: err.code };
    }
    if (smtp && (err.code || err.stage !== 'message')) {
      // a temporary refusal, or a failure before the message was handed over (connection, login,
      // the sender refused): nothing was delivered; the job tries again later
      await store.move(msg._id, 'sending', 'approved', { note: `not sent: ${note}` });
      await deps.budget.release(reservation, { sent: false });
      throw err;
    }
    // during or after the message itself: it may have been delivered, so it is never sent again
    await store.move(msg._id, 'sending', 'send_unknown', { set: { send: { at: now, error: String(err?.message ?? err).slice(0, 500) } },
      note: 'the send may or may not have gone through; check the mailbox\'s Sent folder' });
    await deps.budget.release(reservation, { sent: true });
    throw new PermanentError(`send outcome unknown: ${err?.message ?? err}`);
  }

  return { [JOB_DRAFT]: draftStep, [JOB_SEND]: sendStep };
}

/** Queues the send job for an approved message. */
export function queueSend(queue, message) {
  return queue.enqueue({ type: JOB_SEND, idemKey: `send:${message._id}`, leadId: message.lead_id ?? null, step: 'send',
    payload: { message_id: String(message._id) } });
}

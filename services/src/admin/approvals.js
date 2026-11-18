import { ObjectId } from 'mongodb';
import { maskEmail } from './queries.js';
import { MessageStore } from '../outreach/messages.js';
import { queueSend } from '../outreach/sequence.js';

/**
 * The approval queue (design 7.9): drafts waiting for a person, each beside its evidence pack and
 * its quality-check result, and what happened to recent messages. Deciding goes through
 * MessageStore.decide (audit row first, quality check again on any edit); an approval queues the
 * send job, and the compliance gate still has the last word.
 *
 * Until replies and bounces are read from the mailboxes (Phase 4), a person records them here:
 * a reply hands the company to a person, a bounce or a complaint also suppresses the address.
 */

export const OUTCOMES = ['replied', 'bounced', 'complained'];

const asId = (id) => {
  try {
    return new ObjectId(String(id));
  } catch {
    return null;
  }
};

/** Recipient as the page may show it: masked when it is a person's mailbox and the viewer is not an admin. */
function shownRecipient(r, user) {
  if (!r?.address) return null;
  return { ...r, address: r.personal && user?.role !== 'admin' ? maskEmail(r.address) : r.address };
}

export async function approvalQueue(db, { user, limit = 50 } = {}) {
  const store = new MessageStore(db);
  const [waiting, recent, counts] = await Promise.all([
    store.waiting({ limit }),
    db.collection('messages').find({ status: { $in: ['approved', 'sending', 'sent', 'blocked', 'bounced', 'send_unknown', 'rejected', 'expired', 'cancelled'] } })
      .sort({ updated_at: -1 }).limit(30).toArray(),
    store.counts(),
  ]);
  const names = new Map((await db.collection('companies').find({ _id: { $in: [...waiting, ...recent].map((m) => m.company_id) } }, { projection: { name: 1 } }).toArray())
    .map((c) => [c._id, c.name]));
  const row = (m) => ({
    id: String(m._id), company_id: m.company_id, company_name: names.get(m.company_id) ?? m.company_id, kind: m.kind, language: m.language,
    status: m.status, subject: m.draft?.subject ?? '', drafter: m.draft?.drafter ?? null, qc_passed: m.qc?.passed ?? null,
    rules_confirmed: m.evidence?.pack?.rules?.confirmed === true, mailbox: m.mailbox, recipient: shownRecipient(m.recipient, user),
    created_at: m.created_at, updated_at: m.updated_at, gate: m.gate ?? null, approval: m.approval ? { decision: m.approval.decision, by: m.approval.by, at: m.approval.at } : null,
  });
  return { waiting: waiting.map(row), recent: recent.map(row), counts };
}

export async function approvalDetail(db, id, { user } = {}) {
  const _id = asId(id);
  if (!_id) return null;
  const m = await db.collection('messages').findOne({ _id });
  if (!m) return null;
  const company = await db.collection('companies').findOne({ _id: m.company_id }, { projection: { name: 1 } });
  return {
    id: String(m._id), company_id: m.company_id, company_name: company?.name ?? m.company_id, kind: m.kind, language: m.language, status: m.status,
    mailbox: m.mailbox, recipient: shownRecipient(m.recipient, user), draft: { subject: m.draft.subject, body: m.draft.body, drafter: m.draft.drafter,
      model: m.draft.model, tries: m.draft.tries ?? [] }, qc: m.qc, evidence: m.evidence.pack, approval: m.approval, gate: m.gate, send: m.send,
    history: m.history ?? [], expires_at: m.expires_at,
  };
}

/** A person's decision. Returns { ok, qc, queued } (ok false: the edited text failed the quality check). */
export async function decideApproval(db, { id, decision, user, note, subject, body, cfg, org, queue, clock = () => new Date() }) {
  const _id = asId(id);
  if (!_id) throw new RangeError('no such message');
  const store = new MessageStore(db, { clock });
  const current = await store.byId(_id);
  if (!current) throw new RangeError('no such message');
  const edit = typeof subject === 'string' && typeof body === 'string' ? { subject, body } : null;
  const r = await store.decide(_id, { decision, user, note, edit, cfg, org });
  if (!r.ok) return { ok: false, qc: r.qc, queued: false };
  let queued = false;
  if (r.message.status === 'approved') {
    if (!queue) throw new Error('the job queue is not available, so the approval cannot be sent on');
    queued = (await queueSend(queue, r.message)).created;
  }
  return { ok: true, qc: r.qc, queued };
}

/**
 * Settles a message whose send was interrupted ('send_unknown'), once a person has looked in the
 * mailbox's Sent folder: it went out (recorded as sent, the lead becomes contacted) or it did not
 * (back to approved, and the send is queued again; the gate checks everything afresh). Audited.
 */
export async function resolveUnknown(db, { id, wasSent, user, queue, clock = () => new Date() }) {
  const _id = asId(id);
  const m = _id ? await db.collection('messages').findOne({ _id }) : null;
  if (!m) throw new RangeError('no such message');
  if (m.status !== 'send_unknown') throw new RangeError('only a message whose send was interrupted needs this');
  const now = clock();
  await db.collection('audit_log').insertOne({ at: now, actor: user.email, role: user.role, action: 'outcome_recorded',
    target: { type: 'message', id: String(m._id) }, fields: null, detail: { company_id: m.company_id, outcome: wasSent ? 'was_sent' : 'was_not_sent' } });
  const store = new MessageStore(db, { clock });
  if (wasSent) {
    await db.collection('activities').insertOne({ at: m.send?.at ?? now, type: 'sent', channel: 'email', company_id: m.company_id, lead_id: m.lead_id ?? null,
      campaign: `outreach:${m.kind}`, holdout: false, idem_key: `sent:${m._id}`, data: { kind: m.kind, mailbox: m.mailbox, message_id: m._id, confirmed_by: user.email } })
      .catch((err) => { if (err?.code !== 11000) throw err; });
    await store.move(m._id, 'send_unknown', 'sent', { by: user.email, note: 'found in the Sent folder' });
    await db.collection('leads').updateOne({ company_id: m.company_id, stage: { $in: ['discovered', 'shortlisted'] } }, { $set: { stage: 'contacted', updated_at: now } });
    return { status: 'sent' };
  }
  await store.move(m._id, 'send_unknown', 'approved', { by: user.email, note: 'not in the Sent folder: queued again' });
  await queue.enqueue({ type: 'outreach.send', idemKey: `send:${m._id}:retry:${now.getTime()}`, leadId: m.lead_id ?? null, step: 'send', payload: { message_id: String(m._id) } });
  return { status: 'approved' };
}

/**
 * Records what came back for a sent message (until the mailboxes are read automatically). A bounce
 * or a complaint also puts the address on the suppression list. The audit row is written first.
 */
export async function recordOutcome(db, { id, outcome, user, note = null, suppression, clock = () => new Date() }) {
  if (!OUTCOMES.includes(outcome)) throw new RangeError(`outcome must be one of ${OUTCOMES.join(', ')}`);
  const _id = asId(id);
  const m = _id ? await db.collection('messages').findOne({ _id }) : null;
  if (!m) throw new RangeError('no such message');
  if (!['sent', 'send_unknown'].includes(m.status)) throw new RangeError('only a sent message can have an outcome');
  const now = clock();
  await db.collection('audit_log').insertOne({ at: now, actor: user.email, role: user.role, action: 'outcome_recorded',
    target: { type: 'message', id: String(m._id) }, fields: null, detail: { company_id: m.company_id, outcome } });
  await db.collection('activities').insertOne({ at: now, type: outcome, channel: 'email', company_id: m.company_id, lead_id: m.lead_id ?? null, holdout: false,
    idem_key: `${outcome}:${m._id}`, data: { message_id: m._id, mailbox: m.mailbox, recorded_by: user.email, note: note ? String(note).slice(0, 500) : null,
      ...(outcome === 'bounced' ? { bounce: 'hard' } : {}) } }).catch((err) => {
    if (err?.code === 11000) throw new RangeError(`this message already has the outcome ${outcome}`);
    throw err;
  });
  if (outcome !== 'replied' && m.recipient?.address) {
    await suppression.add({ email: m.recipient.address }, { reason: outcome === 'bounced' ? 'hard_bounce' : 'spam_complaint', source: { via: 'admin', by: user.email } });
  }
  const stage = outcome === 'replied' ? 'engaged' : 'closed';
  await db.collection('leads').updateOne({ company_id: m.company_id, stage: { $in: ['discovered', 'shortlisted', 'contacted'] } }, { $set: { stage, updated_at: now } });
  if (outcome === 'bounced') {
    await db.collection('messages').updateOne({ _id: m._id }, { $set: { status: 'bounced', updated_at: now },
      $push: { history: { at: now, status: 'bounced', by: user.email, note: 'bounce recorded by a person' } } });
  }
  return { ok: true };
}

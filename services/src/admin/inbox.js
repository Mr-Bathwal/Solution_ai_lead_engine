import { ObjectId } from 'mongodb';
import { maskEmail } from './queries.js';
import { NEXT_STEP } from '../inbound/classify.js';
import { decideInbound } from '../inbound/process.js';

/**
 * The Admin inbox and the calls list (design 7.9): replies the engine has read from the mailboxes,
 * each with its label, what the engine already did, and the next step; and call backs a person
 * must make or follow up. A reply's text and the sender's address, and the number a call went to,
 * are personal data: viewers see neither; reviewers and admins see them on a reply's or a call's
 * own page, and every such view is written to audit_log first.
 */

const asId = (id) => {
  try {
    return new ObjectId(String(id));
  } catch {
    return null;
  }
};
const canSee = (user) => ['reviewer', 'admin'].includes(user?.role);

async function names(db, ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Map();
  return new Map((await db.collection('companies').find({ _id: { $in: list } }, { projection: { name: 1 } }).toArray()).map((c) => [c._id, c.name]));
}

const PRIORITY = { interested: 0, question: 1, unclear: 2, not_now: 3, wrong_person: 4, unsubscribe: 5 };
/** The next step for a reply; a WhatsApp message is answered by email or phone, since the engine sends no free WhatsApp text. */
const nextStep = (m) => {
  const s = NEXT_STEP[m.label] ?? NEXT_STEP.unclear;
  return m.channel === 'whatsapp' && ['interested', 'question', 'unclear'].includes(m.label ?? 'unclear')
    ? `${s.replace(/ from the mailbox\.$/, '.')} On WhatsApp they wrote from the number shown: answer by email or a call, as the engine sends no free WhatsApp replies.`
    : s;
};

export async function inboxQueue(db, { limit = 100 } = {}) {
  const [waiting, recent, counts, other] = await Promise.all([
    db.collection('inbound').find({ status: 'needs_person' }).sort({ received_at: 1 }).limit(limit).toArray(),
    db.collection('inbound').find({ status: { $in: ['handled', 'done'] }, kind: { $ne: 'other' } }).sort({ updated_at: -1 }).limit(30).toArray(),
    db.collection('inbound').aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray(),
    db.collection('inbound').find({ kind: 'other' }).sort({ received_at: -1 }).limit(20).toArray(),
  ]);
  const n = await names(db, [...waiting, ...recent].map((m) => m.matched?.company_id));
  const row = (m) => ({
    id: String(m._id), received_at: m.received_at, mailbox: m.mailbox, channel: m.channel ?? 'email', kind: m.kind, label: m.label, status: m.status,
    confidence: m.classification?.confidence ?? null, by: m.classification?.by ?? null, subject: m.subject,
    company_id: m.matched?.company_id ?? null, company_name: n.get(m.matched?.company_id) ?? null, message_id: m.matched?.message_id ? String(m.matched.message_id) : null,
    next_step: m.kind === 'reply' ? nextStep(m) : m.kind === 'auto_reply' ? 'An automatic reply that says the address may be wrong: check it.' : null,
    actions: m.actions ?? [], handled: m.handled ?? null,
  });
  waiting.sort((a, b) => (PRIORITY[a.label] ?? 9) - (PRIORITY[b.label] ?? 9) || a.received_at - b.received_at);
  // mail that matched no email we sent: a founder writing afresh from another address lands here, so a
  // person can glance at it; only the sender, masked, and the subject are kept for these
  const others = other.map((m) => ({ id: String(m._id), received_at: m.received_at, mailbox: m.mailbox, subject: m.subject,
    from: m.from?.address ? maskEmail(m.from.address) : null }));
  return { waiting: waiting.map(row), recent: recent.map(row), other: others, counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) };
}

/** One inbound email. The text and sender only for reviewers and admins, audited first. */
export async function inboxDetail(db, id, { user, clock = () => new Date() } = {}) {
  const _id = asId(id);
  const m = _id ? await db.collection('inbound').findOne({ _id }) : null;
  if (!m) return null;
  const n = await names(db, [m.matched?.company_id]);
  const personal = canSee(user) && (m.text || m.from?.address);
  if (personal) {
    await db.collection('audit_log').insertOne({ at: clock(), actor: user.email, role: user.role, action: 'view_personal',
      target: { type: 'inbound', id: String(m._id) }, fields: ['reply_text', 'sender_address'], detail: null });
  }
  return {
    id: String(m._id), received_at: m.received_at, mailbox: m.mailbox, channel: m.channel ?? 'email', kind: m.kind, label: m.label, status: m.status, subject: m.subject,
    classification: m.classification, actions: m.actions ?? [], handled: m.handled, dsn: m.dsn ?? null,
    company_id: m.matched?.company_id ?? null, company_name: n.get(m.matched?.company_id) ?? null, matched_how: m.matched?.how ?? null,
    message_id: m.matched?.message_id ? String(m.matched.message_id) : null,
    from: m.from?.address ? (canSee(user) ? m.from.address : m.channel === 'whatsapp' ? `${m.from.address.slice(0, 5)}…${m.from.address.slice(-2)}` : maskEmail(m.from.address)) : null,
    text: canSee(user) ? m.text : null, text_hidden: !canSee(user) && Boolean(m.text),
    next_step: m.kind === 'reply' ? nextStep(m) : null,
  };
}

export async function decideInboundRequest(db, { id, label, handled, note, user, suppression, queue, clock }) {
  const _id = asId(id);
  if (!_id) throw new RangeError('no such email');
  return decideInbound(db, { id: _id, label: label || null, handled, note, user, suppression, queue, clock });
}

// ---- calls ---------------------------------------------------------------------------------------

const needsPerson = (c) => !c.handled?.at && (['blocked', 'failed', 'unknown'].includes(c.status) || ['interested', 'wants_person', 'call_later'].includes(c.outcome));

export async function callsList(db, { limit = 100 } = {}) {
  const [open, recent] = await Promise.all([
    db.collection('calls').find({ $or: [{ status: { $in: ['blocked', 'failed', 'unknown'] } }, { outcome: { $in: ['interested', 'wants_person', 'call_later'] } }],
      'handled.at': { $exists: false } }).sort({ updated_at: 1 }).limit(limit).toArray(),
    db.collection('calls').find({}).sort({ updated_at: -1 }).limit(40).toArray(),
  ]);
  const n = await names(db, [...open, ...recent].map((c) => c.company_id));
  const row = (c) => ({
    id: String(c._id), company_id: c.company_id, company_name: n.get(c.company_id) ?? c.company_id, status: c.status, outcome: c.outcome, attempt: c.attempt,
    slot: c.slot, language: c.language, placed_at: c.placed_at, ended_at: c.ended_at, duration_s: c.duration_s, cost_paise: c.cost_paise,
    reason: c.gate?.reasons?.join('; ') ?? c.failure_reason ?? null, needs_person: needsPerson(c), handled: c.handled ?? null, updated_at: c.updated_at,
  });
  return { open: open.map(row), recent: recent.map(row) };
}

export async function callDetail(db, id, { user, clock = () => new Date() } = {}) {
  const _id = asId(id);
  const c = _id ? await db.collection('calls').findOne({ _id }) : null;
  if (!c) return null;
  const n = await names(db, [c.company_id]);
  if (canSee(user) && (c.to || c.transcript?.length)) {
    await db.collection('audit_log').insertOne({ at: clock(), actor: user.email, role: user.role, action: 'view_personal',
      target: { type: 'call', id: String(c._id) }, fields: ['phone', 'transcript'], detail: null });
  }
  const person = canSee(user) ? await db.collection('people').findOne({ _id: c.person_id }, { projection: { name: 1, role: 1 } }) : null;
  return {
    id: String(c._id), company_id: c.company_id, company_name: n.get(c.company_id) ?? c.company_id, status: c.status, outcome: c.outcome, attempt: c.attempt,
    slot: c.slot, language: c.language, placed_at: c.placed_at, ended_at: c.ended_at, duration_s: c.duration_s, cost_paise: c.cost_paise,
    gate: c.gate, failure_reason: c.failure_reason, script_version: c.script_version, history: c.history ?? [], handled: c.handled ?? null,
    needs_person: needsPerson(c),
    to: canSee(user) ? c.to : null, person: person ? { name: person.name, role: person.role ?? null } : null,
    transcript: canSee(user) ? c.transcript ?? [] : null,
  };
}

/** A person made the call, or followed up its outcome. Audited first. */
export async function handleCall(db, { id, note = null, user, clock = () => new Date() }) {
  const _id = asId(id);
  const c = _id ? await db.collection('calls').findOne({ _id }) : null;
  if (!c) throw new RangeError('no such call');
  if (c.handled?.at) throw new RangeError('this call is already marked as dealt with');
  const now = clock();
  await db.collection('audit_log').insertOne({ at: now, actor: user.email, role: user.role, action: 'outcome_recorded',
    target: { type: 'call', id: String(c._id) }, fields: null, detail: { company_id: c.company_id, handled: true } });
  await db.collection('calls').updateOne({ _id, 'handled.at': { $exists: false } }, { $set: { handled: { by: user.email, at: now, note: note ? String(note).slice(0, 1000) : null }, updated_at: now },
    $push: { history: { at: now, status: c.status, note: `dealt with by ${user.email}` } } });
  try {
    await db.collection('activities').insertOne({ at: now, type: 'handed_over', channel: 'voice', company_id: c.company_id, lead_id: c.lead_id ?? null, holdout: false,
      idem_key: `handed_over:call:${c._id}`, data: { call_id: c._id, by: user.email } });
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }
  return { ok: true };
}

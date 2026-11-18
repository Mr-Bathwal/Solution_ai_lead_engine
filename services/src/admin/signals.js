import { safeHref } from './queries.js';

/**
 * Funding news, for a person to confirm (design 7.1 and 7.4, "Signals").
 *
 * Each morning `leadengine ingest news` (ingest/src/leadengine/news.py) reads the news feeds and GDELT
 * and proposes a signal when a headline names exactly one UP company. A name match in a headline is
 * evidence, not proof: "Kavach" or "Parakh" may be another business of the same name in another city.
 * So a signal is only ever proposed by the engine. A reviewer reads the article and confirms or rejects
 * it here; the decision is logged first, like every review decision, and a confirmed signal is shown on
 * the company's page. Nothing else reads signals: no message, score or shortlist changes because of one.
 */

export const SIGNAL_ID = /^news:[0-9a-f]{40}$/;
const WAITING_SHOWN = 200;
const DECIDED_SHOWN = 30;

const view = (s, names) => ({
  id: s._id, type: s.type, company_id: s.company_id, company_name: names.get(s.company_id) ?? null,
  headline: s.headline, url: safeHref(s.url), publisher: s.publisher, published_at: s.published_at ?? null,
  matched_name: s.matched_name ?? null, status: s.status, created_at: s.created_at,
  decided_by: s.decided_by ?? null, decided_at: s.decided_at ?? null, note: s.note ?? null,
});

/** The signals waiting for a person, newest first, and the most recent decisions. */
export async function signalQueue(db) {
  const col = db.collection('signals');
  const [waiting, items, decided] = await Promise.all([
    col.countDocuments({ status: 'proposed' }),
    col.find({ status: 'proposed' }).sort({ created_at: -1 }).limit(WAITING_SHOWN).toArray(),
    col.find({ status: { $in: ['confirmed', 'rejected'] } }).sort({ decided_at: -1 }).limit(DECIDED_SHOWN).toArray(),
  ]);
  const ids = [...new Set([...items, ...decided].map((s) => s.company_id))];
  const names = new Map((await db.collection('companies').find({ _id: { $in: ids } }, { projection: { name: 1 } }).toArray())
    .map((c) => [c._id, c.name]));
  return { waiting, items: items.map((s) => view(s, names)), decided: decided.map((s) => view(s, names)) };
}

/**
 * A reviewer's decision on one proposed signal. The audit row is written first: a decision that could
 * not be logged is not saved. Only a signal still "proposed" changes; deciding twice is refused (409).
 */
export async function decideSignal(db, { id, decision, note, user, clock = () => new Date() }) {
  if (!['confirm', 'reject'].includes(decision)) throw new RangeError('decision must be confirm or reject');
  const sid = String(id ?? '');
  const s = SIGNAL_ID.test(sid) ? await db.collection('signals').findOne({ _id: sid }) : null;
  if (!s) throw Object.assign(new RangeError('no such signal'), { status: 404 });
  if (s.status !== 'proposed') throw Object.assign(new RangeError(`this signal is already ${s.status}`), { status: 409 });
  const status = decision === 'confirm' ? 'confirmed' : 'rejected';
  const text = String(note ?? '').trim().slice(0, 500) || null;
  const now = clock();
  await db.collection('audit_log').insertOne({ at: now, actor: user.email, role: user.role, action: 'review_decision',
    target: { type: 'signal', id: s._id }, fields: null, detail: { decision: status, company_id: s.company_id, note: text, via: user.via ?? null } });
  const r = await db.collection('signals').findOneAndUpdate({ _id: s._id, status: 'proposed' },
    { $set: { status, decided_by: user.email, decided_at: now, note: text } }, { returnDocument: 'after' });
  if (!r) throw Object.assign(new RangeError('someone else decided it a moment ago'), { status: 409 });
  return r;
}

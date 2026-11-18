import { suppressionKey } from '../suppression/list.js';
import { normalizeEmail, normalizePhone } from '../util/normalize.js';

/**
 * Taking an address off the do-not-contact list, when its owner asks (the unsubscribe page promises:
 * "If this was a mistake, reply to any of our emails and a person will put it right"). The design
 * keeps this out of the application: the app's database role cannot delete from `suppressions`, so
 * this runs with an admin MONGODB_URI, by a named person, with a note saying what the owner asked.
 *
 * Only an unsubscribe, a "wrong contact", a do-not-contact request or a manual entry can be lifted.
 * An erasure request, a spam complaint and a hard bounce never can: the first two because the person
 * told us so in the strongest terms, the third because the address does not work.
 *
 * Lifting does not restart cold outreach to the company: the contact budget still sees the opt-out
 * in `activities`. It lets through only what the owner then agrees to (reminders, a call back).
 */

const LIFTABLE = new Set(['unsubscribe', 'wrong_contact', 'do_not_contact_request', 'manual']);

export async function unsuppress(db, { kind, value, by, note, secret, clock = () => new Date() }) {
  if (!['email', 'phone'].includes(kind)) throw new TypeError('kind must be email or phone');
  const address = kind === 'email' ? normalizeEmail(value) : normalizePhone(value);
  if (!address) throw new TypeError(`not a valid ${kind}`);
  if (!by || !/@/.test(by)) throw new TypeError('--by must be the admin\'s email');
  if (!note || String(note).trim().length < 10) throw new TypeError('--note must say what the owner asked for, and when');
  const key = suppressionKey(secret, kind, address);
  const entry = await db.collection('suppressions').findOne({ _id: key });
  if (!entry) return { lifted: false, why: 'not on the list' };
  if (!LIFTABLE.has(entry.reason)) throw new TypeError(`an entry for ${entry.reason.replace(/_/g, ' ')} is never lifted`);
  const now = clock();
  await db.collection('audit_log').insertOne({ at: now, actor: by, role: 'admin', action: 'suppression_lifted', target: { type: kind, id: key }, fields: null,
    detail: { reason_was: entry.reason, since: entry.created_at, note: String(note).slice(0, 500) } });
  let r;
  try {
    r = await db.collection('suppressions').deleteOne({ _id: key, reason: entry.reason });
  } catch (err) {
    if (err?.code === 13) throw new Error('lifting needs a database user that may delete from suppressions (an admin MONGODB_URI); nothing was changed');
    throw err;
  }
  await db.collection('activities').insertOne({ at: now, type: 'note', channel: null, company_id: null, lead_id: null, holdout: null,
    idem_key: `lifted:${key}:${now.getTime()}`, data: { kind: 'suppression_lifted', by, reason_was: entry.reason } });
  return { lifted: r.deletedCount === 1, reason_was: entry.reason };
}

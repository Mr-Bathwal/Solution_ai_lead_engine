import { ConsentLedger } from '../consent/ledger.js';
import { SuppressionList } from '../suppression/list.js';
import { normalizeEmail, normalizePhone } from '../util/normalize.js';

/**
 * An erasure request (design 7.7, DPDP Act): "an erasure request removes a person's data everywhere".
 * `lead-engine erase email <address>` or `erase phone <number>`, run by an admin with a credential
 * that may update the consent ledger, does all of it at once:
 *
 *   suppression list  the entry becomes an erasure request: only the keyed hash is kept, so the
 *                     engine can still refuse to contact the address, without holding it
 *   consent ledger    the address is blanked on every entry (the chain stays valid: it hashes the key)
 *   people            the contact is removed; a person left with no contact is removed
 *   messages          the recipient address is blanked
 *   inbound           the sender, subject and text of their emails are blanked
 *   calls             the number and the transcript are blanked
 *   companies         a registered email that is this person's own address is blanked
 *   audit_log         one 'erasure' row: who asked for it to be done, and how much was removed
 *
 * Raw portal pages never held addresses or numbers (they are removed before storing). The data
 * vendor's raw answers are kept exactly as received, so when a company's registered email was the
 * person's own, its answers are deleted too: the result lists those companies, and
 * `leadengine privacy erase-raw <CIN>` (Python, which owns the raw store) deletes them.
 */
export async function erase(db, { kind, value, user, secret, note = null, clock = () => new Date() }) {
  if (!['email', 'phone'].includes(kind)) throw new TypeError('kind must be email or phone');
  const address = kind === 'email' ? normalizeEmail(value) : normalizePhone(value);
  if (!address) throw new TypeError(`not a valid ${kind}`);
  const now = clock();
  const out = {};
  await db.collection('audit_log').insertOne({ at: now, actor: user, role: 'admin', action: 'erasure', target: { type: kind, id: null }, fields: null,
    detail: { started: true, note: note ? String(note).slice(0, 300) : null } });
  // the ledger first: it needs a credential that may update it, so a missing one fails before anything else changes
  const ledger = new ConsentLedger(db, { secret, clock });
  out.consents = 0;
  try {
    for (const channel of kind === 'email' ? ['email'] : ['whatsapp', 'voice', 'sms']) out.consents += await ledger.redactAddress({ channel, address });
  } catch (err) {
    if (err?.code === 13) throw new Error('erasure needs a database user that may update the consent ledger (an admin MONGODB_URI); nothing was erased');
    throw err;
  }
  await new SuppressionList(db, { secret, clock }).add({ [kind]: address }, { reason: 'erasure_request', source: { via: 'erase', by: user } });
  const people = await db.collection('people').find({ 'contacts.address': address }).toArray();
  out.people_removed = 0;
  out.contacts_removed = 0;
  for (const p of people) {
    const left = (p.contacts ?? []).filter((c) => c.address !== address);
    out.contacts_removed += (p.contacts ?? []).length - left.length;
    if (left.length) await db.collection('people').updateOne({ _id: p._id }, { $set: { contacts: left, updated_at: now } });
    else {
      await db.collection('people').deleteOne({ _id: p._id });
      out.people_removed += 1;
    }
  }
  if (kind === 'email') {
    out.messages = (await db.collection('messages').updateMany({ 'recipient.address': address },
      { $set: { 'recipient.address': null, 'recipient.erased_at': now, updated_at: now } })).modifiedCount;
    out.inbound = (await db.collection('inbound').updateMany({ 'from.address': address },
      { $set: { from: null, subject: null, text: null, erased_at: now, updated_at: now } })).modifiedCount;
    out.company_ids = (await db.collection('companies').find({ 'attrs.registered_email.value': address }, { projection: { _id: 1 } }).toArray()).map((c) => c._id);
    out.companies = (await db.collection('companies').updateMany({ 'attrs.registered_email.value': address },
      { $set: { 'attrs.registered_email.value': null, 'attrs.registered_email.erased_at': now } })).modifiedCount;
  } else {
    out.calls = (await db.collection('calls').updateMany({ to: address }, { $set: { to: null, transcript: null, agent_variables: null, erased_at: now, updated_at: now } })).modifiedCount;
  }
  await db.collection('audit_log').insertOne({ at: clock(), actor: user, role: 'admin', action: 'erasure', target: { type: kind, id: null }, fields: null, detail: { done: true, ...out } });
  return out;
}

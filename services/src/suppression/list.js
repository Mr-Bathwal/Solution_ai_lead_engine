import { keyedHash, requireSecret } from '../util/canonical.js';
import {
  SHARED_MAIL_DOMAINS, domainAndParents, emailDomain, isPublicSuffix, mailboxForm, normalizeDomain, normalizeEmail, normalizePhone,
} from '../util/normalize.js';

export const REASONS = ['unsubscribe', 'hard_bounce', 'spam_complaint', 'erasure_request', 'do_not_contact_request', 'wrong_contact', 'manual'];

const KINDS = ['email', 'phone', 'domain'];
const NORMALIZE = { email: normalizeEmail, phone: normalizePhone, domain: normalizeDomain };
// What an entry is keyed on. An email is keyed on the mailbox it reaches, so "founder+news@acme.in"
// and "founder@acme.in" (or Gmail's dotted spellings) are one entry and one lookup.
const KEY_FORM = { email: mailboxForm, phone: normalizePhone, domain: normalizeDomain };

// A domain entry for a shared mail domain would silently block every founder who uses it, so only
// single addresses at these domains can be suppressed. The list itself lives in util/normalize.js.
export { SHARED_MAIL_DOMAINS };

/**
 * The entry key for an address: its kind and an HMAC-SHA256 of its normalised form under the
 * contact-key secret (CONTACT_KEY_SECRET), never a plain hash, which could be reversed by trying
 * every phone number. Keys were plain SHA-256 until October 2026; no database held any suppression
 * entries then, so nothing had to be re-keyed. Changing the secret later would need that migration.
 */
export function suppressionKey(secret, kind, value) {
  const v = KEY_FORM[kind]?.(value);
  return v ? `${kind}:${keyedHash(secret, `${kind}:${v}`)}` : null;
}

const present = (v) => v !== undefined && v !== null && String(v).trim() !== '';

/**
 * One do-not-contact list for every channel. An entry is keyed on a keyed hash of the normalised
 * address, so lookups work even when the address itself is not kept: for erasure requests we
 * store only the key. A domain entry blocks every email address at that domain and its subdomains.
 *
 * Lookups fail closed: an address that cannot be read, or a target with nothing to check, is
 * reported as blocked. "Could not tell" must never reach a sender as "not on the list".
 *
 * There is intentionally no remove(), and the application's database role cannot delete here:
 * taking someone off the list is rare, needs a person's decision, and is done by an admin with
 * `lead-engine unsuppress` (privacy/unsuppress.js), under an admin credential, with the owner's request as its note.
 */
export class SuppressionList {
  constructor(db, { secret, clock = () => new Date() } = {}) {
    this.secret = requireSecret(secret);
    this.col = db.collection('suppressions');
    this.clock = clock;
  }

  /**
   * Adds one address. Returns { added, key }; `added` is false if it was already suppressed.
   * An erasure request also blanks an existing entry's address and note (and returns erased: true).
   */
  async add(target, { reason, source = null, note = null } = {}) {
    if (!REASONS.includes(reason)) throw new TypeError(`unknown reason: ${reason}`);
    const given = KINDS.filter((k) => present(target?.[k]));
    if (!given.length) throw new TypeError('one of email, phone or domain is required');
    if (given.length > 1) throw new TypeError(`add one address at a time (got ${given.join(' and ')})`);
    const [kind] = given;
    const raw = target[kind];
    const value = NORMALIZE[kind](raw);
    if (!value) throw new TypeError(`not a valid ${kind}: ${raw}`);
    if (kind === 'domain' && SHARED_MAIL_DOMAINS.has(value)) {
      throw new TypeError(`${value} is a shared mail domain; suppress the single address instead`);
    }
    if (kind === 'domain' && isPublicSuffix(value)) {
      throw new TypeError(`${value} is a registry suffix shared by many companies; suppress the company's own domain instead`);
    }
    const key = suppressionKey(this.secret, kind, value);
    const now = this.clock();
    if (reason === 'erasure_request') return this.#erase(key, kind, source, now);
    const doc = { _id: key, kind, value, reason, source, note, created_at: now };
    try {
      const r = await this.col.updateOne({ _id: key }, { $setOnInsert: doc }, { upsert: true });
      return { added: Boolean(r.upsertedId), key };
    } catch (err) {
      if (err?.code === 11000) return { added: false, key };
      throw err;
    }
  }

  /**
   * An erasure request wins over whatever the entry said before: the stored address and note are
   * blanked even when the address was already suppressed (say, after an earlier unsubscribe), so
   * only the key is kept and the address stays blocked without being stored.
   */
  async #erase(key, kind, source, now) {
    const update = {
      $set: { value: null, note: null, reason: 'erasure_request', erased_at: now },
      $setOnInsert: { kind, source, created_at: now },
    };
    for (let attempt = 0; ; attempt += 1) {
      try {
        const r = await this.col.updateOne({ _id: key }, update, { upsert: true });
        return { added: Boolean(r.upsertedId), erased: true, key };
      } catch (err) {
        // two concurrent upserts of a new entry: the loser retries and updates the winner's entry
        if (err?.code !== 11000 || attempt > 0) throw err;
      }
    }
  }

  /**
   * All entries that block this target: its email (as the mailbox it reaches), the email's domain
   * and parent domains, its phone, its domain and parent domains. A part of the target that cannot
   * be read, or a target with no email, phone or domain, comes back as an entry with reason
   * 'unreadable' and _id null, so the target counts as blocked.
   */
  async check(target) {
    const { keys, unreadable } = lookupFor(this.secret, target);
    const found = keys.length ? await this.col.find({ _id: { $in: keys } }).toArray() : [];
    return [...unreadable, ...found];
  }

  async isSuppressed(target) {
    return (await this.check(target)).length > 0;
  }

  /**
   * Bulk check in one query. Returns the targets split into { allowed, blocked }, where each
   * blocked item is { target, entries }. Unreadable targets are blocked, as in check().
   */
  async partition(targets) {
    const perTarget = targets.map((t) => lookupFor(this.secret, t));
    const all = [...new Set(perTarget.flatMap((p) => p.keys))];
    const found = new Map();
    if (all.length) {
      for (const e of await this.col.find({ _id: { $in: all } }).toArray()) found.set(e._id, e);
    }
    const allowed = [];
    const blocked = [];
    targets.forEach((target, i) => {
      const entries = [...perTarget[i].unreadable, ...perTarget[i].keys.map((k) => found.get(k)).filter(Boolean)];
      if (entries.length) blocked.push({ target, entries });
      else allowed.push(target);
    });
    return { allowed, blocked };
  }
}

const unreadable = (kind, why) => ({ _id: null, kind, reason: 'unreadable', note: why });

function lookupFor(secret, target) {
  const t = target && typeof target === 'object' ? target : {};
  const keys = [];
  const bad = [];
  if (!KINDS.some((k) => present(t[k]))) bad.push(unreadable(null, 'no email, phone or domain to check'));
  if (present(t.email)) {
    const e = normalizeEmail(t.email);
    if (!e) bad.push(unreadable('email', 'the email address could not be read'));
    else {
      keys.push(suppressionKey(secret, 'email', e));
      for (const d of domainAndParents(emailDomain(e))) keys.push(suppressionKey(secret, 'domain', d));
    }
  }
  if (present(t.phone)) {
    const p = normalizePhone(t.phone);
    if (!p) bad.push(unreadable('phone', 'the phone number could not be read'));
    else keys.push(suppressionKey(secret, 'phone', p));
  }
  if (present(t.domain)) {
    const d = normalizeDomain(t.domain);
    if (!d) bad.push(unreadable('domain', 'the domain could not be read'));
    else for (const x of domainAndParents(d)) keys.push(suppressionKey(secret, 'domain', x));
  }
  return { keys: [...new Set(keys)], unreadable: bad };
}

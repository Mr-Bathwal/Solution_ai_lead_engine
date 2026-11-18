import { createHash, createHmac } from 'node:crypto';

/**
 * Deterministic JSON: object keys sorted, dates as ISO strings, ObjectIds as hex.
 * The same value always produces the same string, so its hash is stable across runs.
 *
 * `undefined` becomes null, at every level, because that is how the MongoDB driver stores it.
 * Dropping it instead would make a hash computed before a write differ from the one computed
 * after reading the document back, and the consent ledger would report tampering that never happened.
 */
export function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}

function normalize(v) {
  if (v === undefined) return null;
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Date) return v.toISOString();
  if ((v._bsontype === 'ObjectId' || v._bsontype === 'ObjectID') && typeof v.toHexString === 'function') return v.toHexString();
  if (Array.isArray(v)) return Array.from(v, normalize);
  // A null-prototype object, so a key called "__proto__" is kept as data (and hashed) instead of
  // silently setting the prototype and dropping out of the hash.
  const out = Object.create(null);
  for (const k of Object.keys(v).sort()) out[k] = normalize(v[k]);
  return out;
}

/** Keys that the BSON layer or JavaScript itself treats specially, so they do not round-trip as data. */
const UNSAFE_KEYS = new Set(['__proto__', '_bsontype']);

/**
 * A copy of `value` holding only what survives a round trip through MongoDB unchanged: strings,
 * finite numbers, booleans, null, arrays and plain objects (dates become ISO strings, undefined
 * becomes null). Anything else is refused, so a hashed document reads back exactly as it was hashed.
 *
 * Strings are made well-formed: half of an emoji (left by cutting text at a fixed length) cannot be
 * stored as UTF-8, so MongoDB would save a replacement character and the stored text would no longer
 * match its hash. Replacing it here, before hashing, keeps the two the same.
 */
export function jsonSafe(value, path = 'value') {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.toWellFormed();
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} is not a finite number`);
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return Array.from(value, (x, i) => jsonSafe(x, `${path}[${i}]`));
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, x]) => {
      if (UNSAFE_KEYS.has(k) || k.includes('\u0000') || !k.isWellFormed()) {
        throw new TypeError(`${path} has a key that cannot be stored and hashed reliably: ${JSON.stringify(k)}`);
      }
      return [k, jsonSafe(x, `${path}.${k}`)];
    }));
  }
  throw new TypeError(`${path} has a type that cannot be stored and hashed reliably`);
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * HMAC-SHA256 of `text` under a secret kept outside the database. Used for the keys of contact
 * addresses (suppression entries, consent contact_key): a plain SHA-256 of a phone number can be
 * reversed by trying every number (about 4 billion Indian mobiles, minutes on one GPU), so a bare
 * hash would still be personal data. Without the secret the keyed hash cannot be reversed that way.
 */
export function keyedHash(secret, text) {
  return createHmac('sha256', secret).update(text, 'utf8').digest('hex');
}

/** The contact-key secret, checked: at least 32 characters, never empty or a placeholder. */
export function requireSecret(secret, name = 'CONTACT_KEY_SECRET') {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new TypeError(`${name} must be set to a secret of at least 32 characters (keep it outside the database)`);
  }
  return secret;
}

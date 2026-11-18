import { setTimeout as sleep } from 'node:timers/promises';
import { canonicalJson, jsonSafe, keyedHash, requireSecret, sha256 } from '../util/canonical.js';
import { normalizeAddress } from '../util/normalize.js';

export const CHANNELS = ['email', 'whatsapp', 'voice', 'sms', 'in_app'];
export const PURPOSES = ['deadline_reminders', 'service_updates', 'scheme_alerts', 'marketing', 'callback'];
export const CAPTURED_VIA = ['company_page_claim', 'platform_settings', 'email_reply', 'whatsapp_reply', 'call', 'admin_entry', 'consent_manager'];
export const GENESIS = '0'.repeat(64);

/** Fields covered by each entry's hash. The plain contact address is deliberately not one of them. */
const HASHED = ['seq', 'prev_hash', 'subject', 'channel', 'purpose', 'action', 'contact_key', 'wording', 'wording_version', 'captured_via', 'proof', 'recorded_by', 'recorded_at'];

export function entryHash(entry) {
  const body = {};
  for (const k of HASHED) body[k] = entry[k] ?? null;
  return sha256(canonicalJson(body));
}

/**
 * The key of a contact address: HMAC-SHA256 of the normalised address under the contact-key secret
 * (CONTACT_KEY_SECRET), which lives outside the database. A plain SHA-256 of a phone number can be
 * reversed by trying all of them, so after an erasure it would still be the number. Keys were plain
 * SHA-256 until October 2026, when no database held any consent entries yet, so nothing was re-keyed.
 */
export function contactKey(secret, channel, address) {
  const a = normalizeAddress(channel, address);
  return a ? keyedHash(secret, `${channel}:${a}`) : null;
}

/** The document in `locks` that writers on a replica set all update, so they add entries one at a time. */
const TAIL_ID = 'ledger:consents';

/** The promise of the newest write per database, so that writers in one process take turns. */
const writers = new Map();

const isString = (s) => typeof s === 'string';

/**
 * The consent ledger: who agreed to what, on which channel, for what purpose, with the exact
 * wording shown, when, and the proof. Entries are only ever appended. Each one carries a
 * sequence number and the hash of the previous entry, so verify() detects any edit, deletion
 * or re-ordering after the fact.
 *
 * The hash covers contact_key (a keyed hash of the address), not the address itself. That lets us
 * honour an erasure request by blanking the stored address without breaking the chain, while
 * the proof that consent existed stays intact.
 *
 * `proof` must hold only hashes and references (a page path, a form id, a message id, the hash of
 * an IP address), never personal data itself: it is covered by the hash, so nothing in it can be
 * erased later without breaking the chain.
 *
 * The chain cannot show on its own that entries were cut off the end, or that someone with write
 * access recomputed every hash after an edit. Anchoring the head outside the database closes that
 * gap: see head(), verify({ anchors }) and `lead-engine ledger:anchor`.
 */
export class ConsentLedger {
  /**
   * `transactions`: 'auto' uses a transaction per entry when the database supports them (a replica
   * set, as on Atlas) and falls back to optimistic retries on a standalone server; true or false
   * forces one or the other. `retryBudgetMs` bounds the optimistic retries in time, not in count.
   */
  constructor(db, { secret, clock = () => new Date(), retryBudgetMs = 10_000, transactions = 'auto' } = {}) {
    this.secret = requireSecret(secret);
    this.db = db;
    this.col = db.collection('consents');
    this.locks = db.collection('locks');
    this.clock = clock;
    this.retryBudgetMs = retryBudgetMs;
    this.useTransactions = transactions === 'auto' ? null : Boolean(transactions);
    this.tailReady = false;
  }

  grant(event) {
    return this.record({ ...event, action: 'grant' });
  }

  withdraw(event) {
    return this.record({ ...event, action: 'withdraw' });
  }

  async record({ subject, channel, purpose, action, address = null, wording, wordingVersion, capturedVia, proof = {}, recordedBy = null }) {
    if (!subject?.type || !subject?.id) throw new TypeError('subject {type, id} is required');
    if (!CHANNELS.includes(channel)) throw new TypeError(`unknown channel: ${channel}`);
    if (!PURPOSES.includes(purpose)) throw new TypeError(`unknown purpose: ${purpose}`);
    if (!['grant', 'withdraw'].includes(action)) throw new TypeError(`unknown action: ${action}`);
    if (!CAPTURED_VIA.includes(capturedVia)) throw new TypeError(`unknown capturedVia: ${capturedVia}`);
    if (!isString(wording) || !wording.trim()) throw new TypeError('the exact wording shown to the person is required');
    if (!wordingVersion) throw new TypeError('wordingVersion is required');

    let contact = null;
    let key = null;
    if (channel !== 'in_app') {
      const normalized = normalizeAddress(channel, address);
      if (!normalized) throw new TypeError(`a valid ${channel} address is required`);
      contact = { address: normalized };
      key = contactKey(this.secret, channel, normalized);
    }
    // Every hashed string is made well-formed first (see jsonSafe): what is stored must be exactly
    // what was hashed, or verify() would report tampering that never happened.
    const fields = {
      subject: { type: subject.type, id: String(subject.id).toWellFormed() },
      channel,
      purpose,
      action,
      contact_key: key,
      contact,
      wording: wording.toWellFormed(),
      wording_version: String(wordingVersion).toWellFormed(),
      captured_via: capturedVia,
      proof: jsonSafe(proof, 'proof'),
      recorded_by: isString(recordedBy) ? recordedBy.toWellFormed() : recordedBy,
    };
    const make = (last) => {
      const entry = { seq: (last?.seq ?? 0) + 1, prev_hash: last?.hash ?? GENESIS, ...fields, recorded_at: this.clock() };
      entry.hash = entryHash(entry);
      return entry;
    };
    return this.#oneAtATime(() => this.#append(make));
  }

  /** Writers in this process queue behind each other, so they never compete for the same seq. */
  #oneAtATime(fn) {
    const name = this.db.databaseName;
    const run = (writers.get(name) ?? Promise.resolve()).then(fn);
    const settled = run.then(() => {}, () => {});
    writers.set(name, settled);
    settled.then(() => { if (writers.get(name) === settled) writers.delete(name); });
    return run;
  }

  async #append(make) {
    if (this.useTransactions === null) {
      const hello = await this.db.command({ hello: 1 });
      this.useTransactions = Boolean(hello.setName) || hello.msg === 'isdbgrid';
    }
    if (this.useTransactions) {
      try {
        return await this.#appendInTransaction(make);
      } catch (err) {
        if (err?.code !== 20) throw err; // IllegalOperation: this server cannot run transactions after all
        this.useTransactions = false;
      }
    }
    return this.#appendOptimistically(make);
  }

  /**
   * On a replica set: read the tail and add the next entry in one transaction. The transaction
   * first updates one shared document; a concurrent writer conflicts on it, and withTransaction
   * runs that writer again from a fresh snapshot, in which it sees the entry this one added.
   */
  async #appendInTransaction(make) {
    if (!this.tailReady) {
      try {
        await this.locks.updateOne(
          { _id: TAIL_ID },
          { $setOnInsert: { seq: 0, hash: GENESIS, writes: 0, updated_at: this.clock() } },
          { upsert: true },
        );
      } catch (err) {
        if (err?.code !== 11000) throw err; // another process created it at the same moment
      }
      this.tailReady = true;
    }
    const session = this.db.client.startSession();
    try {
      let entry;
      await session.withTransaction(async () => {
        await this.locks.updateOne({ _id: TAIL_ID }, { $inc: { writes: 1 }, $set: { updated_at: this.clock() } }, { session });
        entry = make(await this.#tail(session));
        await this.col.insertOne(entry, { session });
        await this.locks.updateOne({ _id: TAIL_ID }, { $set: { seq: entry.seq, hash: entry.hash } }, { session });
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
      return entry;
    } finally {
      await session.endSession();
    }
  }

  /**
   * On a standalone server: read the tail, insert the next seq, and if another process took that
   * seq first (duplicate key), back off a random, growing time and try again until retryBudgetMs.
   */
  async #appendOptimistically(make) {
    const deadline = Date.now() + this.retryBudgetMs;
    for (let attempt = 0; ; attempt += 1) {
      const entry = make(await this.#tail());
      try {
        await this.col.insertOne(entry);
        return entry;
      } catch (err) {
        if (err?.code !== 11000) throw err; // another writer took this seq; read the new tail and retry
      }
      if (Date.now() >= deadline) {
        throw new Error(`consent ledger is too busy: still losing seq conflicts after ${this.retryBudgetMs} ms`);
      }
      await sleep(Math.random() * Math.min(250, 5 * 2 ** attempt));
    }
  }

  #tail(session) {
    return this.col.find({}, { projection: { seq: 1, hash: 1 }, session }).sort({ seq: -1 }).limit(1).next();
  }

  /** Latest decision for a subject on a channel and purpose. No entry means no consent. */
  async status({ subject, channel, purpose }) {
    const last = await this.col
      .find({ 'subject.type': subject.type, 'subject.id': String(subject.id), channel, purpose })
      .sort({ seq: -1 })
      .limit(1)
      .next();
    return { granted: last?.action === 'grant', entry: last ?? null };
  }

  /** Latest decision for a specific address, which is what the send-time compliance gate asks. */
  async statusForAddress({ channel, address, purpose }) {
    const key = contactKey(this.secret, channel, address);
    if (!key) return { granted: false, entry: null };
    const last = await this.col.find({ contact_key: key, channel, purpose }).sort({ seq: -1 }).limit(1).next();
    return { granted: last?.action === 'grant', entry: last ?? null };
  }

  /**
   * The newest entry's sequence number and hash. The chain proves that nothing before the head was
   * changed, but cannot by itself show that entries were cut off the end. Copying the head somewhere
   * the database cannot rewrite (`lead-engine ledger:anchor`, the daily summary email) closes that
   * gap: a later head with a lower seq, or a different hash at the same seq, means the tail was
   * tampered with.
   */
  async head() {
    const last = await this.col.find({}, { projection: { seq: 1, hash: 1, recorded_at: 1 } }).sort({ seq: -1 }).limit(1).next();
    return last ? { seq: last.seq, hash: last.hash, recorded_at: last.recorded_at } : { seq: 0, hash: GENESIS, recorded_at: null };
  }

  /**
   * Walks the chain in sequence order and checks every link and hash, then every anchor (earlier
   * heads copied outside the database, as { seq, hash }). Returns { ok: true, checked } or
   * { ok: false, checked, seq, reason, problems } where `problems` lists every bad seq (up to
   * maxProblems) and seq/reason are the first of them. It does not stop at the first problem: one
   * damaged entry must not hide what happened to the rest.
   */
  async verify({ anchors = [], maxProblems = 1000 } = {}) {
    const problems = [];
    let total = 0;
    const report = (seq, reason) => {
      total += 1;
      if (problems.length < maxProblems) problems.push({ seq, reason });
    };
    let prev = GENESIS;
    let expected = 1;
    let checked = 0;
    for await (const e of this.col.find({}).sort({ seq: 1 })) {
      checked += 1;
      let linked = true;
      if (e.seq !== expected) {
        if (Number.isInteger(e.seq) && e.seq > expected) {
          report(expected, e.seq === expected + 1 ? `entry ${expected} is missing` : `entries ${expected} to ${e.seq - 1} are missing`);
          linked = false; // its predecessor is gone, so its link cannot be checked
        } else {
          report(e.seq, 'entry is out of sequence');
        }
      }
      if (linked && e.prev_hash !== prev) report(e.seq, 'link to the previous entry is broken');
      if (entryHash(e) !== e.hash) report(e.seq, 'entry was changed after it was recorded');
      if (e.contact?.address && contactKey(this.secret, e.channel, e.contact.address) !== e.contact_key) {
        report(e.seq, 'stored address does not match its key');
      }
      prev = e.hash;
      if (Number.isInteger(e.seq) && e.seq >= expected) expected = e.seq + 1;
    }
    const anchored = anchors.filter((a) => Number.isInteger(a?.seq) && a.seq > 0);
    if (anchored.length) {
      const found = new Map();
      for (const e of await this.col.find({ seq: { $in: anchored.map((a) => a.seq) } }, { projection: { seq: 1, hash: 1 } }).toArray()) {
        found.set(e.seq, e.hash);
      }
      for (const a of anchored) {
        const when = a.anchored_at ? ` on ${a.anchored_at}` : '';
        if (!found.has(a.seq)) report(a.seq, `entry ${a.seq} was anchored${when} but is gone: the ledger was cut short`);
        else if (found.get(a.seq) !== a.hash) report(a.seq, `entry ${a.seq} differs from the copy anchored${when}: the chain was rewritten`);
      }
    }
    if (!total) return { ok: true, checked };
    problems.sort((a, b) => a.seq - b.seq);
    return { ok: false, checked, seq: problems[0].seq, reason: problems[0].reason, problems, problemCount: total };
  }

  /**
   * Erasure: blanks the stored address on every entry for it. The chain stays valid because the
   * hash covers only the address's key. Returns how many entries were redacted.
   * Needs an admin credential: the application's role can only find and insert here.
   */
  async redactAddress({ channel, address }) {
    const key = contactKey(this.secret, channel, address);
    if (!key) return 0;
    const r = await this.col.updateMany({ contact_key: key, channel }, { $set: { contact: { address: null, redacted: true } } });
    return r.modifiedCount;
  }
}

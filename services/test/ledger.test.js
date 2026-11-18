import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { MongoClient } from 'mongodb';
import { TEST_SECRET, freshDb, startMongo } from './helpers/mongod.js';
import { ConsentLedger, contactKey, entryHash } from '../src/consent/ledger.js';
import { appendAnchor, readAnchors } from '../src/consent/anchor.js';
import { sha256 } from '../src/util/canonical.js';

let mongo;
let client;
let db;

before(async () => { mongo = await startMongo(); });
after(async () => { await client?.close(); await mongo.stop(); });
beforeEach(async () => {
  await client?.close();
  ({ client, db } = await freshDb(mongo.uri));
});

const WORDING = 'Send me reminders about my company\'s legal deadlines on WhatsApp. I can stop them any time by replying STOP.';
const claim = (overrides = {}) => ({
  subject: { type: 'company', id: 'U62099UW2026PTC259408' },
  channel: 'whatsapp',
  purpose: 'deadline_reminders',
  address: '098765 43210',
  wording: WORDING,
  wordingVersion: 'claim-v1',
  capturedVia: 'company_page_claim',
  proof: { page: '/c/abc123', form: 'claim', ip_hash: 'a'.repeat(64) },
  ...overrides,
});

describe('consent ledger', () => {
  test('grant then withdraw: the latest decision wins', async () => {
    const ledger = new ConsentLedger(db, { secret: TEST_SECRET });
    await ledger.grant(claim());
    let s = await ledger.statusForAddress({ channel: 'whatsapp', address: '+91 98765 43210', purpose: 'deadline_reminders' });
    assert.equal(s.granted, true);
    assert.equal(s.entry.contact.address, '+919876543210', 'stored in E.164');
    await ledger.withdraw(claim({ capturedVia: 'whatsapp_reply', wording: 'STOP', wordingVersion: 'stop-v1' }));
    s = await ledger.status({ subject: claim().subject, channel: 'whatsapp', purpose: 'deadline_reminders' });
    assert.equal(s.granted, false);
  });

  test('no entry means no consent, and purposes do not leak into each other', async () => {
    const ledger = new ConsentLedger(db, { secret: TEST_SECRET });
    await ledger.grant(claim());
    const s = await ledger.statusForAddress({ channel: 'whatsapp', address: '9876543210', purpose: 'marketing' });
    assert.equal(s.granted, false);
    assert.equal(s.entry, null);
  });

  test('refuses an entry without the exact wording or a valid address', async () => {
    const ledger = new ConsentLedger(db, { secret: TEST_SECRET });
    await assert.rejects(ledger.grant(claim({ wording: ' ' })), /wording/);
    await assert.rejects(ledger.grant(claim({ address: '12345' })), /valid whatsapp address/);
  });

  test('the chain verifies, and detects an edit made behind its back', async () => {
    const ledger = new ConsentLedger(db, { secret: TEST_SECRET });
    for (let i = 0; i < 5; i += 1) await ledger.grant(claim({ subject: { type: 'company', id: `C${i}` } }));
    assert.deepEqual(await ledger.verify(), { ok: true, checked: 5 });
    await db.collection('consents').updateOne({ seq: 3 }, { $set: { action: 'withdraw' } });
    const r = await ledger.verify();
    assert.equal(r.ok, false);
    assert.equal(r.seq, 3);
  });

  test('detects a deleted entry', async () => {
    const ledger = new ConsentLedger(db, { secret: TEST_SECRET });
    for (let i = 0; i < 4; i += 1) await ledger.grant(claim());
    await db.collection('consents').deleteOne({ seq: 2 });
    const r = await ledger.verify();
    assert.equal(r.ok, false);
    assert.match(r.reason, /missing/);
  });

  test('concurrent writers still produce one gap-free chain', async () => {
    const ledger = new ConsentLedger(db, { secret: TEST_SECRET });
    await Promise.all(Array.from({ length: 15 }, (_, i) => ledger.grant(claim({ subject: { type: 'company', id: `C${i}` } }))));
    const r = await ledger.verify();
    assert.deepEqual(r, { ok: true, checked: 15 });
  });

  test('erasure blanks the address but keeps the chain valid', async () => {
    const ledger = new ConsentLedger(db, { secret: TEST_SECRET });
    await ledger.grant(claim());
    await ledger.grant(claim({ channel: 'email', address: 'Founder@Acme.in', purpose: 'scheme_alerts' }));
    assert.equal(await ledger.redactAddress({ channel: 'whatsapp', address: '9876543210' }), 1);
    const e = await db.collection('consents').findOne({ seq: 1 });
    assert.equal(e.contact.address, null);
    assert.equal(e.contact_key, contactKey(TEST_SECRET, 'whatsapp', '9876543210'));
    assert.deepEqual(await ledger.verify(), { ok: true, checked: 2 });
  });

  test('the database itself rejects a malformed entry', async () => {
    await assert.rejects(
      db.collection('consents').insertOne({ seq: 1, subject: { type: 'company', id: 'x' }, channel: 'fax' }),
      /validation/i,
    );
  });

  test('a proof with undefined values or dates still verifies after it is read back', async () => {
    const ledger = new ConsentLedger(db, { secret: TEST_SECRET });
    await ledger.grant(claim({ proof: { page: '/c/abc', referrer: undefined, at: new Date('2026-11-20T06:00:00Z'), nested: { a: undefined } } }));
    assert.deepEqual(await ledger.verify(), { ok: true, checked: 1 });
    const stored = await db.collection('consents').findOne();
    assert.equal(stored.proof.at, '2026-11-20T06:00:00.000Z');
  });

  test('refuses a proof it could not hash reliably', async () => {
    const ledger = new ConsentLedger(db, { secret: TEST_SECRET });
    await assert.rejects(ledger.grant(claim({ proof: { bytes: Buffer.from('x') } })), /proof\.bytes/);
    await assert.rejects(ledger.grant(claim({ proof: { n: Number.NaN } })), /finite/);
  });

  test('head() gives the newest seq and hash, for anchoring outside the database', async () => {
    const ledger = new ConsentLedger(db, { secret: TEST_SECRET });
    assert.equal((await ledger.head()).seq, 0);
    await ledger.grant(claim());
    const e = await ledger.withdraw(claim());
    assert.deepEqual(await ledger.head(), { seq: 2, hash: e.hash, recorded_at: e.recorded_at });
  });
});

describe('consent ledger under load and attack', () => {
  test('refuses to start without a contact-key secret', () => {
    assert.throws(() => new ConsentLedger(db), /CONTACT_KEY_SECRET/);
    assert.throws(() => new ConsentLedger(db, { secret: 'short' }), /at least 32 characters/);
  });

  test('contact_key is a keyed hash: without the secret it cannot be recomputed from a phone number', async () => {
    const e = await new ConsentLedger(db, { secret: TEST_SECRET }).grant(claim());
    assert.notEqual(e.contact_key, sha256('whatsapp:+919876543210'));
    assert.notEqual(e.contact_key, contactKey('another-secret-of-at-least-32-characters', 'whatsapp', '+919876543210'));
    assert.equal(e.contact_key, contactKey(TEST_SECRET, 'whatsapp', '+91 98765 43210'));
  });

  for (const transactions of ['auto', false]) {
    test(`a burst of 100 writers in 5 processes lands in one gap-free chain (transactions: ${transactions})`, async () => {
      const clients = await Promise.all(Array.from({ length: 5 }, async () => new MongoClient(mongo.uri).connect()));
      try {
        const results = await Promise.allSettled(clients.flatMap((c, p) => {
          const ledger = new ConsentLedger(c.db(db.databaseName), { secret: TEST_SECRET, transactions });
          return Array.from({ length: 20 }, (_, i) => ledger.grant(claim({ subject: { type: 'company', id: `C${p}-${i}` } })));
        }));
        assert.deepEqual(results.filter((r) => r.status === 'rejected').map((r) => r.reason.message), []);
        assert.deepEqual(await new ConsentLedger(db, { secret: TEST_SECRET }).verify(), { ok: true, checked: 100 });
        const tail = await db.collection('locks').findOne({ _id: 'ledger:consents' });
        if (transactions === 'auto' && mongo.replicaSet) assert.equal(tail.seq, 100, 'written through the transaction path');
        if (transactions === false) assert.equal(tail, null, 'written through the optimistic path');
      } finally {
        await Promise.all(clients.map((c) => c.close()));
      }
    });
  }

  test('half an emoji in the wording or proof (text cut at a fixed length) still verifies', async () => {
    const ledger = new ConsentLedger(db, { secret: TEST_SECRET });
    const e = await ledger.grant(claim({ wording: `${WORDING} \uD83D`, proof: { page: '/c/x', name: 'Rahul \uD83D' } }));
    assert.equal(e.wording.at(-1), '�');
    assert.deepEqual(await ledger.verify(), { ok: true, checked: 1 });
  });

  test('refuses proof keys that would not be stored or hashed as written', async () => {
    const ledger = new ConsentLedger(db, { secret: TEST_SECRET });
    await assert.rejects(ledger.grant(claim({ proof: JSON.parse('{"page":"/c/x","__proto__":{"admin":true}}') })), /key/);
    await assert.rejects(ledger.grant(claim({ proof: { _bsontype: 'ObjectId' } })), /key/);
    await assert.rejects(ledger.grant(claim({ proof: { 'a\u0000b': 1 } })), /key/);
  });

  test('verify() reports every damaged entry, not only the first', async () => {
    const ledger = new ConsentLedger(db, { secret: TEST_SECRET });
    for (let i = 0; i < 6; i += 1) await ledger.grant(claim({ subject: { type: 'company', id: `C${i}` } }));
    const col = db.collection('consents');
    await col.updateOne({ seq: 2 }, { $set: { action: 'withdraw' } });
    await col.deleteOne({ seq: 4 });
    await col.updateOne({ seq: 6 }, { $set: { wording: 'something else' } });
    const r = await ledger.verify();
    assert.equal(r.ok, false);
    assert.equal(r.seq, 2);
    assert.deepEqual(r.problems.map((p) => [p.seq, p.reason]), [
      [2, 'entry was changed after it was recorded'],
      [4, 'entry 4 is missing'],
      [6, 'entry was changed after it was recorded'],
    ]);
  });

  test('an anchor kept outside the database catches a ledger cut short or rewritten', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ledger-anchor-'));
    const file = path.join(dir, 'anchors.jsonl');
    try {
      const ledger = new ConsentLedger(db, { secret: TEST_SECRET });
      for (let i = 0; i < 3; i += 1) await ledger.grant(claim({ subject: { type: 'company', id: `C${i}` } }));
      appendAnchor(file, await ledger.head());
      assert.deepEqual((await ledger.verify({ anchors: readAnchors(file) })).ok, true);

      const col = db.collection('consents');
      const third = await col.findOne({ seq: 3 });
      await col.deleteOne({ seq: 3 }); // cut off the end: the chain alone cannot tell
      assert.deepEqual(await ledger.verify(), { ok: true, checked: 2 });
      assert.match((await ledger.verify({ anchors: readAnchors(file) })).reason, /cut short/);

      const forged = { ...third, action: 'withdraw' }; // rewritten with a correct hash: again invisible to the chain alone
      forged.hash = entryHash(forged);
      await col.insertOne(forged);
      assert.deepEqual(await ledger.verify(), { ok: true, checked: 3 });
      assert.match((await ledger.verify({ anchors: readAnchors(file) })).reason, /rewritten/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a damaged anchor file is an error, never skipped', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ledger-anchor-'));
    try {
      const file = path.join(dir, 'anchors.jsonl');
      writeFileSync(file, `${JSON.stringify({ seq: 1, hash: 'a'.repeat(64) })}\nnot json\n`);
      assert.throws(() => readAnchors(file), /line 2 is not a ledger anchor/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

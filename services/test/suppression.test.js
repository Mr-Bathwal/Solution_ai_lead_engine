import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { TEST_SECRET, freshDb, startMongo } from './helpers/mongod.js';
import { SuppressionList, suppressionKey } from '../src/suppression/list.js';
import { sha256 } from '../src/util/canonical.js';
import { mailboxForm, normalizeDomain, normalizeEmail, normalizePhone } from '../src/util/normalize.js';

let mongo;
let client;
let db;

before(async () => { mongo = await startMongo(); });
after(async () => { await client?.close(); await mongo.stop(); });
beforeEach(async () => {
  await client?.close();
  ({ client, db } = await freshDb(mongo.uri));
});

describe('normalisation', () => {
  test('email', () => {
    assert.equal(normalizeEmail('  Info@Acme.IN '), 'info@acme.in');
    assert.equal(normalizeEmail('mailto:hello@acme.co.in'), 'hello@acme.co.in');
    assert.equal(normalizeEmail('not an email'), null);
  });
  test('phone (India)', () => {
    for (const s of ['9876543210', '09876543210', '+91 98765 43210', '91-98765-43210', '(+91) 98765-43210']) {
      assert.equal(normalizePhone(s), '+919876543210', s);
    }
    assert.equal(normalizePhone('12345'), null);
    assert.equal(normalizePhone('5876543210'), null, 'Indian mobiles start with 6-9');
  });
  test('domain', () => {
    assert.equal(normalizeDomain('https://www.Acme.in/about?x=1'), 'acme.in');
    assert.equal(normalizeDomain('ACME.co.in.'), 'acme.co.in');
    assert.equal(normalizeDomain('hello@acme.in'), 'acme.in');
    assert.equal(normalizeDomain('localhost'), null);
  });
  test('email in the forms it arrives in: mail headers, scraped pages, IDNs', () => {
    for (const s of ['"Founder" <Founder@Acme.in>', 'Founder <founder@acme.in>', 'founder@acme.in.', 'FOUNDER@ACME.IN;', 'founder@acme.in​', '<founder@acme.in>']) {
      assert.equal(normalizeEmail(s), 'founder@acme.in', JSON.stringify(s));
    }
    assert.equal(normalizeEmail('info@डाक.भारत'), 'info@xn--11bx1g.xn--h2brj9c');
    assert.equal(normalizeEmail('Pérez@Acme.in'), 'pérez@acme.in');
    assert.equal(normalizeEmail('founder @acme.in'), null);
    assert.equal(normalizeDomain('डाक.भारत'), 'xn--11bx1g.xn--h2brj9c');
  });
  test('the mailbox an address reaches: +tags, Gmail dots, googlemail.com', () => {
    assert.equal(mailboxForm('founder+news@acme.in'), 'founder@acme.in');
    assert.equal(mailboxForm('F.O.Under+x@GoogleMail.com'), 'founder@gmail.com');
    assert.equal(mailboxForm('f.o.under@acme.in'), 'f.o.under@acme.in', 'dots only matter at Gmail');
  });
  test('phone: trunk 0 after +91, 0091, landlines, extensions', () => {
    for (const s of ['+91 098765 43210', '+91-0-9876543210', '0091 98765 43210', '+919876543210 ext 12']) {
      assert.equal(normalizePhone(s), '+919876543210', s);
    }
    assert.equal(normalizePhone('0522 2345678'), '+915222345678', 'Lucknow landline');
    assert.equal(normalizePhone('011 2345 6789'), '+911123456789', 'Delhi landline');
    assert.equal(normalizePhone('+91 98765 4321'), null, 'an Indian number has 10 digits');
    assert.equal(normalizePhone('98765-43210 / 91234-56789'), null, 'two numbers in one field');
    assert.equal(normalizePhone('+1 415 555 0100'), '+14155550100');
  });
});

describe('suppression list', () => {
  test('add is idempotent and lookups ignore case and spacing', async () => {
    const list = new SuppressionList(db, { secret: TEST_SECRET });
    assert.equal((await list.add({ email: 'Founder@Acme.in' }, { reason: 'unsubscribe' })).added, true);
    assert.equal((await list.add({ email: 'founder@acme.in ' }, { reason: 'unsubscribe' })).added, false);
    assert.equal(await list.isSuppressed({ email: 'FOUNDER@acme.in' }), true);
    assert.equal(await list.isSuppressed({ email: 'other@acme.in' }), false);
  });

  test('a domain entry blocks every address at that domain', async () => {
    const list = new SuppressionList(db, { secret: TEST_SECRET });
    await list.add({ domain: 'https://www.acme.in' }, { reason: 'do_not_contact_request' });
    assert.equal(await list.isSuppressed({ email: 'anyone@acme.in' }), true);
    assert.equal(await list.isSuppressed({ email: 'anyone@acme.co.in' }), false);
  });

  test('a phone entry covers WhatsApp and calls alike', async () => {
    const list = new SuppressionList(db, { secret: TEST_SECRET });
    await list.add({ phone: '98765 43210' }, { reason: 'unsubscribe', source: { channel: 'whatsapp' } });
    assert.equal(await list.isSuppressed({ phone: '+919876543210' }), true);
  });

  test('an erasure request keeps only the hash', async () => {
    const list = new SuppressionList(db, { secret: TEST_SECRET });
    const { key } = await list.add({ email: 'gone@acme.in' }, { reason: 'erasure_request' });
    const doc = await db.collection('suppressions').findOne({ _id: key });
    assert.equal(doc.value, null);
    assert.ok(!JSON.stringify(doc).includes('gone@acme.in'));
    assert.equal(await list.isSuppressed({ email: 'gone@acme.in' }), true);
  });

  test('partition checks many targets in one query', async () => {
    const list = new SuppressionList(db, { secret: TEST_SECRET });
    await list.add({ email: 'a@x.in' }, { reason: 'hard_bounce' });
    await list.add({ domain: 'blocked.in' }, { reason: 'manual' });
    const { allowed, blocked } = await list.partition([
      { email: 'a@x.in' }, { email: 'b@x.in' }, { email: 'c@blocked.in' }, { phone: '9876543210' },
    ]);
    assert.deepEqual(allowed, [{ email: 'b@x.in' }, { phone: '9876543210' }]);
    assert.deepEqual(blocked.map((b) => b.target.email), ['a@x.in', 'c@blocked.in']);
  });

  test('rejects unknown reasons and invalid addresses', async () => {
    const list = new SuppressionList(db, { secret: TEST_SECRET });
    await assert.rejects(list.add({ email: 'a@x.in' }, { reason: 'because' }), /reason/);
    await assert.rejects(list.add({ email: 'nope' }, { reason: 'manual' }), /valid email/);
  });

  test('refuses to block a whole free-mail domain, which would block every founder using it', async () => {
    const list = new SuppressionList(db, { secret: TEST_SECRET });
    await assert.rejects(list.add({ domain: 'gmail.com' }, { reason: 'manual' }), /shared mail domain/);
    await assert.rejects(list.add({ domain: 'https://www.Yahoo.co.in/' }, { reason: 'manual' }), /shared mail domain/);
    assert.equal((await list.add({ email: 'founder@gmail.com' }, { reason: 'unsubscribe' })).added, true);
    assert.equal(await list.isSuppressed({ email: 'other@gmail.com' }), false);
  });
});

describe('suppression list: failing closed, erasure, keys', () => {
  test('refuses to start without a contact-key secret', () => {
    assert.throws(() => new SuppressionList(db), /CONTACT_KEY_SECRET/);
  });

  test('keys are keyed hashes: without the secret they cannot be recomputed from an address', async () => {
    const list = new SuppressionList(db, { secret: TEST_SECRET });
    const { key } = await list.add({ phone: '9876543210' }, { reason: 'unsubscribe' });
    assert.match(key, /^phone:[0-9a-f]{64}$/);
    assert.notEqual(key, `phone:${sha256('+919876543210')}`);
    assert.notEqual(key, suppressionKey('another-secret-of-at-least-32-characters', 'phone', '9876543210'));
    assert.equal(key, suppressionKey(TEST_SECRET, 'phone', '+91 98765 43210'));
  });

  test('an address that cannot be read is blocked, never reported as "not listed"', async () => {
    const list = new SuppressionList(db, { secret: TEST_SECRET });
    for (const target of [{ email: 'founder @acme.in' }, { phone: '12345' }, { domain: 'localhost' }, { emial: 'founder@acme.in' }, {}, null]) {
      const hits = await list.check(target);
      assert.equal(hits.length, 1, JSON.stringify(target));
      assert.equal(hits[0].reason, 'unreadable');
    }
    const { allowed, blocked } = await list.partition([{ email: 'ok@acme.in' }, { email: 'not an address' }, { email: 'ok@acme.in', phone: 'call me' }]);
    assert.deepEqual(allowed, [{ email: 'ok@acme.in' }]);
    assert.deepEqual(blocked.map((b) => b.entries.map((e) => `${e.kind}:${e.reason}`)), [['email:unreadable'], ['phone:unreadable']]);
  });

  test('a suppressed address cannot be reached through another spelling of it', async () => {
    const list = new SuppressionList(db, { secret: TEST_SECRET });
    await list.add({ email: 'founder@acme.in' }, { reason: 'unsubscribe' });
    await list.add({ email: 'f.o.under+news@googlemail.com' }, { reason: 'unsubscribe' });
    await list.add({ phone: '9876543210' }, { reason: 'unsubscribe' });
    for (const target of [
      { email: '"Founder" <founder@acme.in>' }, { email: 'founder+offers@acme.in' }, { email: 'founder@acme.in.' },
      { email: 'founder@gmail.com' }, { email: 'Fo.Under@gmail.com' },
      { phone: '+91 098765 43210' }, { phone: '0091 98765 43210' },
    ]) {
      assert.equal(await list.isSuppressed(target), true, JSON.stringify(target));
    }
  });

  test('a domain entry also blocks its subdomains; a registry suffix cannot be one', async () => {
    const list = new SuppressionList(db, { secret: TEST_SECRET });
    await list.add({ domain: 'blocked.in' }, { reason: 'do_not_contact_request' });
    assert.equal(await list.isSuppressed({ email: 'ceo@mail.blocked.in' }), true);
    assert.equal(await list.isSuppressed({ domain: 'https://sales.blocked.in/team' }), true);
    assert.equal(await list.isSuppressed({ email: 'ceo@notblocked.in' }), false);
    await assert.rejects(list.add({ domain: 'co.in' }, { reason: 'manual' }), /registry suffix/);
  });

  test('an erasure request after an unsubscribe blanks the stored address and note', async () => {
    const list = new SuppressionList(db, { secret: TEST_SECRET, clock: () => new Date('2026-11-20T06:00:00Z') });
    const first = await list.add({ email: 'gone@acme.in' }, { reason: 'unsubscribe', note: 'asked by gone@acme.in on a call' });
    const r = await list.add({ email: 'Gone@Acme.in' }, { reason: 'erasure_request' });
    assert.deepEqual(r, { added: false, erased: true, key: first.key });
    const doc = await db.collection('suppressions').findOne({ _id: first.key });
    assert.equal(doc.value, null);
    assert.equal(doc.note, null);
    assert.equal(doc.reason, 'erasure_request');
    assert.deepEqual(doc.erased_at, new Date('2026-11-20T06:00:00Z'));
    assert.ok(!JSON.stringify(doc).toLowerCase().includes('gone@acme.in'));
    assert.equal(await list.isSuppressed({ email: 'gone@acme.in' }), true);
  });

  test('add() takes one address at a time', async () => {
    const list = new SuppressionList(db, { secret: TEST_SECRET });
    await assert.rejects(list.add({ email: 'both@acme.in', phone: '9123456789' }, { reason: 'unsubscribe' }), /one address at a time/);
  });
});

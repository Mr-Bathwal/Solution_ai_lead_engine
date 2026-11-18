import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { TEST_SECRET, freshDb, startMongo } from './helpers/mongod.js';
import { EmailVerifier, PROVIDERS, providerFromEnv } from '../src/outreach/verify.js';

let mongo;
let client;
let db;
let t = new Date('2026-11-16T06:00:00Z');
const clock = () => t;
const caps = (n = 200) => ({ monthly: { email_verifications_paid: n } });
const quiet = { warn() {} };

/** DNS: mail servers for the domains in `mx`, "no such domain" for `gone`, a failed lookup for the rest. */
const dnsWith = ({ mx = [], gone = [] } = {}) => ({
  async resolveMx(domain) {
    if (mx.includes(domain)) return [{ exchange: `mx.${domain}`, priority: 10 }];
    throw Object.assign(new Error('lookup'), { code: gone.includes(domain) ? 'ENOTFOUND' : 'ETIMEOUT' });
  },
});
/** A verification service answering with `answers[address]` (or a status code), counting its calls. */
function service(answers) {
  const calls = [];
  const fetch = async (url) => {
    const email = decodeURIComponent(/email=([^&]+)/.exec(url)[1]);
    calls.push(email);
    const a = answers[email];
    if (typeof a === 'number') return new Response('{}', { status: a });
    return new Response(JSON.stringify(a ?? { status: 'unknown' }), { status: 200 });
  };
  return { fetch, calls };
}

before(async () => { mongo = await startMongo(); });
after(async () => { await client?.close(); await mongo.stop(); });
beforeEach(async () => {
  await client?.close();
  ({ client, db } = await freshDb(mongo.uri));
  t = new Date('2026-11-16T06:00:00Z');
});

describe('checking an address before the first email', () => {
  test('the free checks: malformed, throwaway, a domain that receives no mail, and no service', async () => {
    const v = new EmailVerifier(db, { secret: TEST_SECRET, caps: caps(), dns: dnsWith({ mx: ['acme.in'], gone: ['nomail.in'] }), clock, log: quiet });
    const r = async (a) => { const x = await v.verify(a); return [x.result, x.use]; };
    assert.deepEqual(await r('not an address'), ['malformed', 'never']);
    assert.deepEqual(await r('a@mailinator.com'), ['disposable', 'never']);
    assert.deepEqual(await r('info@nomail.in'), ['no_mx', 'never']);
    assert.deepEqual(await r('info@acme.in'), ['unverified', 'send'], 'passes the free checks; no service configured');
    assert.deepEqual(await r('info@slowdns.in'), ['unverified', 'send'], 'a lookup that failed is not proof the domain is dead');
    const stored = await db.collection('email_checks').find({}).toArray();
    assert.equal(stored.length, 4, 'a malformed address is not stored');
    assert.ok(stored.every((s) => /^[0-9a-f]{64}$/.test(s._id) && !JSON.stringify(s).includes('info@')), 'keyed, never the address');
    const unverified = stored.find((s) => s.result === 'unverified');
    assert.equal((unverified.expires_at - unverified.checked_at) / 86_400_000, 1, 'asked again tomorrow, once a service may be configured');
    const noMx = stored.find((s) => s.result === 'no_mx');
    assert.equal((noMx.expires_at - noMx.checked_at) / 86_400_000, 30);
  });

  test('a domain with no MX record still takes mail at its address record (RFC 5321); a null MX does not (RFC 7505)', async () => {
    const none = (code) => Object.assign(new Error('lookup'), { code });
    const dns = {
      async resolveMx(d) {
        if (d === 'nullmx.in') return [{ exchange: '.', priority: 0 }];
        throw none(d === 'gone.in' ? 'ENOTFOUND' : 'ENODATA');
      },
      async resolve4(d) {
        if (d === 'arecord.in') return ['192.0.2.10'];
        throw none('ENODATA');
      },
      async resolve6() { throw none('ENODATA'); },
    };
    const v = new EmailVerifier(db, { secret: TEST_SECRET, caps: caps(), dns, clock, log: quiet });
    const r = async (a) => { const x = await v.verify(a); return [x.result, x.use]; };
    assert.deepEqual(await r('info@arecord.in'), ['unverified', 'send'], 'mail falls back to the address record');
    assert.deepEqual(await r('info@nullmx.in'), ['no_mx', 'never'], 'the domain says it takes no mail');
    assert.deepEqual(await r('info@noaddress.in'), ['no_mx', 'never'], 'no MX and no address record');
    assert.deepEqual(await r('info@gone.in'), ['no_mx', 'never'], 'no such domain');
  });

  test("a person's address is kept to the free checks: the verification service never sees it", async () => {
    const svc = service({ 'rahul.k@gmail.com': { status: 'valid' } });
    const v = new EmailVerifier(db, { secret: TEST_SECRET, caps: caps(), provider: { name: 'zerobounce', key: 'k' }, fetch: svc.fetch,
      dns: dnsWith({ mx: ['gmail.com'] }), clock, log: quiet });
    const x = await v.verify('rahul.k@gmail.com', { external: false });
    assert.deepEqual([x.result, x.use, x.provider], ['unverified', 'send', 'free']);
    assert.match(x.reason, /a person's address/);
    assert.equal(svc.calls.length, 0, 'nothing sent out');
  });

  test("a service's verdicts: deliverable, an accept-all domain held back, a role address kept, a dead mailbox never used", async () => {
    const svc = service({
      'info@good.in': { status: 'valid' }, 'hello@catchall.in': { status: 'catch-all' }, 'accounts@roles.in': { status: 'do_not_mail', sub_status: 'role_based' },
      'ghost@good.in': { status: 'invalid', sub_status: 'mailbox_not_found' }, 'trap@good.in': { status: 'spamtrap' },
    });
    const v = new EmailVerifier(db, { secret: TEST_SECRET, caps: caps(), provider: { name: 'zerobounce', key: 'k' }, fetch: svc.fetch,
      dns: dnsWith({ mx: ['good.in', 'catchall.in', 'roles.in'] }), clock, log: quiet });
    const r = async (a) => { const x = await v.verify(a); return [x.result, x.use, x.provider]; };
    assert.deepEqual(await r('info@good.in'), ['deliverable', 'send', 'zerobounce']);
    assert.deepEqual(await r('hello@catchall.in'), ['accept_all', 'hold', 'zerobounce'], 'kept out of the first wave (design 7.3)');
    assert.deepEqual(await r('accounts@roles.in'), ['deliverable', 'send', 'zerobounce'], "a company's role address is what it files with the Registrar");
    assert.deepEqual(await r('ghost@good.in'), ['undeliverable', 'never', 'zerobounce']);
    assert.deepEqual(await r('trap@good.in'), ['undeliverable', 'never', 'zerobounce']);
    const again = await v.verify('INFO@good.in');
    assert.equal(again.cached, true, 'the same address, checked within 30 days, is not paid for twice');
    assert.equal(svc.calls.length, 5);
    assert.equal((await db.collection('usage').findOne({ _id: 'email_verify:2026-11' })).count, 5);
  });

  test('a service that does not answer is not paid for and is asked again tomorrow; the cap holds', async () => {
    const svc = service({ 'a@good.in': 503, 'b@good.in': { result: 'ok' }, 'c@good.in': { result: 'ok' } });
    const v = new EmailVerifier(db, { secret: TEST_SECRET, caps: caps(1), provider: { name: 'millionverifier', key: 'k' }, fetch: svc.fetch,
      dns: dnsWith({ mx: ['good.in'] }), clock, log: quiet });
    const a = await v.verify('a@good.in');
    assert.deepEqual([a.result, a.use], ['unknown', 'send']);
    assert.match(a.reason, /millionverifier did not answer: answered 503/);
    assert.equal((await db.collection('usage').findOne({ _id: 'email_verify:2026-11' })).count, 0, 'not charged');
    assert.deepEqual([(await v.verify('b@good.in')).result], ['deliverable']);
    const c = await v.verify('c@good.in');
    assert.deepEqual([c.result, c.use], ['unverified', 'send']);
    assert.match(c.reason, /monthly verification cap is used up/);
    t = new Date('2026-11-17T06:01:00Z');
    const retry = await v.verify('a@good.in');
    assert.equal(retry.cached, false, 'not answered from the cache the next day');
    assert.match(retry.reason, /cap is used up/, "and the month's cap still holds");
    assert.equal(svc.calls.length, 2, 'b once; c never reached the service');
  });

  test('the provider settings are checked', () => {
    assert.equal(providerFromEnv({}), null);
    assert.equal(providerFromEnv({ EMAIL_VERIFY_PROVIDER: 'zerobounce' }), null, 'no key, no service');
    assert.deepEqual(providerFromEnv({ EMAIL_VERIFY_PROVIDER: 'ZeroBounce', EMAIL_VERIFY_API_KEY: ' k ' }), { name: 'zerobounce', key: 'k' });
    assert.throws(() => providerFromEnv({ EMAIL_VERIFY_PROVIDER: 'other', EMAIL_VERIFY_API_KEY: 'k' }), /one of zerobounce, millionverifier/);
    assert.match(PROVIDERS.zerobounce.url('k&x', 'a+b@c.in'), /api_key=k%26x&email=a%2Bb%40c\.in/);
    assert.throws(() => new EmailVerifier(db, { secret: 'short', caps: caps() }), /CONTACT_KEY_SECRET/);
  });
});

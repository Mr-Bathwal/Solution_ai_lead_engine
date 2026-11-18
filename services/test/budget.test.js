import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';
import { freshDb, startMongo } from './helpers/mongod.js';
import { ContactBudget, istDay, validateCaps } from '../src/outreach/budget.js';
import { CAPS_PATH } from '../src/config.js';

let mongo;
let client;
let db;
let now;
const caps = JSON.parse(readFileSync(CAPS_PATH, 'utf8'));
const clock = () => new Date(now);
const at = (iso) => { now = Date.parse(iso); };

before(async () => { mongo = await startMongo(); });
after(async () => { await client?.close(); await mongo.stop(); });
beforeEach(async () => {
  await client?.close();
  ({ client, db } = await freshDb(mongo.uri));
  at('2026-11-20T06:00:00Z'); // 11:30 IST, day 24 of the warm-up
});

const lead = (over = {}) => ({ company_id: 'U62099UP2026PTC100001', holdout: false, eligible: true, ...over });
const sent = (kind, iso, extra = {}) => db.collection('activities').insertOne({
  at: new Date(iso), type: 'sent', channel: 'email', company_id: 'U62099UP2026PTC100001',
  data: { kind, mailbox: 'mailbox-1', ...extra },
});

describe('contact budget', () => {
  test('never a holdout or an ineligible company', async () => {
    const b = new ContactBudget(db, caps, { clock });
    assert.match((await b.check({ lead: lead({ holdout: true }), kind: 'first_touch', mailbox: 'mailbox-1' })).reason, /holdout/);
    assert.equal((await b.check({ lead: lead({ eligible: false, eligibility_reasons: ['listed company'] }), kind: 'first_touch', mailbox: 'mailbox-1' })).allowed, false);
  });

  test('one first email, then one follow-up after seven days', async () => {
    const b = new ContactBudget(db, caps, { clock });
    assert.equal((await b.check({ lead: lead(), kind: 'first_touch', mailbox: 'mailbox-1' })).allowed, true);
    await sent('first_touch', '2026-11-18T06:00:00Z');
    assert.match((await b.check({ lead: lead(), kind: 'first_touch', mailbox: 'mailbox-1' })).reason, /already been sent/);
    assert.match((await b.check({ lead: lead(), kind: 'follow_up', mailbox: 'mailbox-1' })).reason, /waits 7 days/);
    at('2026-11-26T06:00:00Z');
    assert.equal((await b.check({ lead: lead(), kind: 'follow_up', mailbox: 'mailbox-1' })).allowed, true);
    await sent('follow_up', '2026-11-26T06:00:00Z');
    at('2026-12-20T06:00:00Z');
    assert.match((await b.check({ lead: lead(), kind: 'follow_up', mailbox: 'mailbox-1' })).reason, /already been sent/);
  });

  test('a reply or an opt-out stops every automated message', async () => {
    const b = new ContactBudget(db, caps, { clock });
    await sent('first_touch', '2026-11-10T06:00:00Z');
    await db.collection('activities').insertOne({ at: new Date('2026-11-11T06:00:00Z'), type: 'replied', channel: 'email', company_id: 'U62099UP2026PTC100001' });
    assert.match((await b.check({ lead: lead(), kind: 'follow_up', mailbox: 'mailbox-1' })).reason, /person takes over/);
    assert.equal((await b.check({ lead: lead(), kind: 'reply' })).allowed, true, 'a person may always answer');
  });

  test('a new need is mentioned once, 30 days after the last message', async () => {
    const b = new ContactBudget(db, caps, { clock });
    await sent('first_touch', '2026-11-01T06:00:00Z');
    assert.match((await b.check({ lead: lead(), kind: 'new_need', needId: 'inc_20a', mailbox: 'mailbox-1' })).reason, /less than 30 days/);
    at('2026-12-05T06:00:00Z');
    assert.equal((await b.check({ lead: lead(), kind: 'new_need', needId: 'inc_20a', mailbox: 'mailbox-1' })).allowed, true);
    await sent('new_need', '2026-12-05T06:00:00Z', { need_id: 'inc_20a' });
    at('2027-02-05T06:00:00Z');
    assert.match((await b.check({ lead: lead(), kind: 'new_need', needId: 'inc_20a', mailbox: 'mailbox-1' })).reason, /already been mentioned/);
  });

  test('mailboxes send nothing during warm-up, then follow the ramp, counted per IST day', async () => {
    const b = new ContactBudget(db, caps, { clock });
    at('2026-11-10T06:00:00Z');
    assert.equal(b.warmupDay(), 14);
    assert.match((await b.check({ lead: lead(), kind: 'first_touch', mailbox: 'mailbox-1' })).reason, /warming up \(day 14 of 21\)/);
    at('2026-11-18T06:00:00Z');
    assert.equal(b.mailboxCap(), 25);
    at('2026-11-25T06:00:00Z');
    assert.equal(b.mailboxCap(), 30);
    for (let i = 0; i < 30; i += 1) {
      await db.collection('activities').insertOne({ at: new Date('2026-11-24T19:00:00Z'), type: 'sent', channel: 'email', company_id: `C${i}`, data: { kind: 'first_touch', mailbox: 'mailbox-1' } });
    }
    assert.equal(istDay(new Date('2026-11-24T19:00:00Z')), '2026-11-25', '00:30 IST is already the next day');
    assert.match((await b.check({ lead: lead(), kind: 'first_touch', mailbox: 'mailbox-1' })).reason, /sent its 30 emails/);
    assert.equal((await b.check({ lead: lead(), kind: 'first_touch', mailbox: 'mailbox-2' })).allowed, true);
  });
});

const activity = (type, iso, data = {}, companyId = 'U62099UP2026PTC100001') => db.collection('activities').insertOne({
  at: new Date(iso), type, channel: 'email', company_id: companyId, data,
});
const firstTouch = (b, over = {}) => b.check({ lead: lead(), kind: 'first_touch', mailbox: 'mailbox-1', ...over });

describe('contact budget rules', () => {
  test('refuses a caps.json it cannot rely on, instead of reading it as "no limit"', () => {
    const broken = (change) => {
      const c = structuredClone(caps);
      change(c);
      return () => validateCaps(c);
    };
    assert.doesNotThrow(() => validateCaps(caps));
    assert.throws(broken((c) => { c.email.warmup_start = '28-10-2026'; }), /warmup_start/);
    assert.throws(broken((c) => { c.email.warmup_start = '2026-02-30'; }), /warmup_start/);
    assert.throws(broken((c) => { delete c.email.mailbox_ids; }), /mailbox_ids/);
    assert.throws(broken((c) => { c.email.send_window_ist = ['17:30', '10:00']; }), /send_window_ist/);
    assert.throws(broken((c) => { c.contact_budget.follow_ups = -1; }), /follow_ups/);
    assert.throws(() => new ContactBudget(db, { ...caps, email: { ...caps.email, warmup_start: 'soon' } }), /caps\.json is not valid/);
  });

  test('a ramp step with cap 0 pauses the mailbox instead of lifting the limit', async () => {
    const c = structuredClone(caps);
    c.email.outreach_ramp.push({ from_day: 30, cap: 0 });
    at('2026-11-27T06:00:00Z'); // day 31 of the warm-up
    const b = new ContactBudget(db, c, { clock });
    assert.equal(b.mailboxCap(), 0);
    assert.match((await firstTouch(b)).reason, /mailbox-1 is paused: its cap for day 31 is 0/);
  });

  test('only the configured mailboxes, and only email, the one channel with caps', async () => {
    const b = new ContactBudget(db, caps, { clock });
    assert.match((await firstTouch(b, { mailbox: 'mailbox-9' })).reason, /not one of the mailboxes/);
    assert.match((await firstTouch(b, { channel: 'whatsapp', mailbox: null })).reason, /no contact budget is configured for whatsapp/);
    assert.match((await firstTouch(b, { lead: { holdout: false, eligible: true } })).reason, /no company_id/);
  });

  test('sends only inside the IST send window; drafting is not held to it', async () => {
    const b = new ContactBudget(db, caps, { clock });
    at('2026-11-20T16:30:00Z'); // 22:00 IST
    assert.match((await firstTouch(b)).reason, /outside the send window \(10:00 to 17:30 IST\)/);
    assert.equal((await firstTouch(b, { stage: 'draft' })).allowed, true);
    at('2026-11-20T04:30:00Z'); // 10:00 IST: open
    assert.equal((await firstTouch(b)).allowed, true);
    at('2026-11-20T12:00:00Z'); // 17:30 IST: just closed
    assert.equal((await firstTouch(b)).allowed, false);
  });

  test('a hard bounce stops automated messages; a soft bounce does not', async () => {
    const b = new ContactBudget(db, caps, { clock });
    await sent('first_touch', '2026-11-10T06:00:00Z');
    await activity('bounced', '2026-11-10T06:05:00Z', { mailbox: 'mailbox-1', bounce: 'soft' });
    assert.equal((await b.check({ lead: lead(), kind: 'follow_up', mailbox: 'mailbox-1' })).allowed, true);
    await activity('bounced', '2026-11-10T06:06:00Z', { mailbox: 'mailbox-1', bounce: 'hard' });
    assert.match((await b.check({ lead: lead(), kind: 'follow_up', mailbox: 'mailbox-1' })).reason, /hard-bounced/);
  });

  test('a mailbox pauses when its hard-bounce or complaint rate passes the limit', async () => {
    const b = new ContactBudget(db, caps, { clock });
    for (let i = 0; i < 3; i += 1) await activity('bounced', '2026-11-15T06:00:00Z', { mailbox: 'mailbox-1' }, `X${i}`); // no data.bounce: counted as hard
    assert.match((await firstTouch(b)).reason, /mailbox-1 is paused: 3 hard bounces in 30 days \(6\.0%, limit 2%\)/);
    assert.equal((await firstTouch(b, { mailbox: 'mailbox-2' })).allowed, true);
    await activity('complained', '2026-11-15T06:00:00Z', { mailbox: 'mailbox-2' }, 'X9');
    assert.match((await firstTouch(b, { mailbox: 'mailbox-2' })).reason, /mailbox-2 is paused: 1 complaints/);
  });

  test('a follow-up only fits soon after the first email, with nothing sent in between', async () => {
    const b = new ContactBudget(db, caps, { clock });
    await sent('first_touch', '2026-10-01T06:00:00Z');
    assert.match((await b.check({ lead: lead(), kind: 'follow_up', mailbox: 'mailbox-1' })).reason, /only sent within 21 days of the first email/);
    const other = lead({ company_id: 'U62099UP2026PTC100002' });
    await activity('sent', '2026-10-15T06:00:00Z', { kind: 'first_touch', mailbox: 'mailbox-1' }, other.company_id);
    await activity('sent', '2026-11-12T06:00:00Z', { kind: 'reply', mailbox: 'mailbox-1' }, other.company_id);
    assert.match((await b.check({ lead: other, kind: 'follow_up', mailbox: 'mailbox-1' })).reason, /another message went out after the first email/);
  });
});

describe('reserve(): the send-time gate', () => {
  test('the last free place in a mailbox goes to exactly one of ten concurrent senders', async () => {
    at('2026-11-25T06:00:00Z'); // cap 30
    await db.collection('activities').insertMany(Array.from({ length: 29 }, (_, i) => ({
      at: new Date('2026-11-25T05:00:00Z'), type: 'sent', channel: 'email', company_id: `X${i}`, data: { kind: 'first_touch', mailbox: 'mailbox-1' },
    })));
    const b = new ContactBudget(db, caps, { clock });
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => b.reserve({ lead: lead({ company_id: `C${i}` }), kind: 'first_touch', mailbox: 'mailbox-1' })));
    assert.equal(res.filter((r) => r.allowed).length, 1);
    assert.match(res.find((r) => !r.allowed).reason, /sent its 30 emails/);
  });

  test('one message to a company at a time, whatever its kind', async () => {
    const b = new ContactBudget(db, caps, { clock });
    const two = await Promise.all([1, 2].map(() => b.reserve({ lead: lead(), kind: 'first_touch', mailbox: 'mailbox-1' })));
    assert.equal(two.filter((r) => r.allowed).length, 1);
    await sent('first_touch', new Date(now).toISOString()); // the winner sends, records it, then releases
    await b.release(two.find((r) => r.allowed).reservation, { sent: true });
    assert.match((await b.reserve({ lead: lead(), kind: 'first_touch', mailbox: 'mailbox-1' })).reason, /already been sent/);

    const other = lead({ company_id: 'U62099UP2026PTC100002' });
    await activity('sent', '2026-10-12T06:00:00Z', { kind: 'first_touch', mailbox: 'mailbox-1' }, other.company_id);
    const needs = await Promise.all([
      b.reserve({ lead: other, kind: 'new_need', needId: 'n1', mailbox: 'mailbox-2' }),
      b.reserve({ lead: other, kind: 'new_need', needId: 'n2', mailbox: 'mailbox-2' }),
    ]);
    assert.equal(needs.filter((r) => r.allowed).length, 1, 'check() alone would have allowed both');
    assert.match(needs.find((r) => !r.allowed).reason, /being prepared or sent/);
    const won = needs.find((r) => r.allowed);
    await activity('sent', new Date(now).toISOString(), { kind: 'new_need', need_id: 'n1', mailbox: 'mailbox-2' }, other.company_id);
    await b.release(won.reservation, { sent: true });
    assert.match((await b.reserve({ lead: other, kind: 'new_need', needId: 'n2', mailbox: 'mailbox-2' })).reason, /less than 30 days/);
  });

  test('release({ sent: false }) gives the unit back, and a crashed sender\'s hold runs out', async () => {
    at('2026-11-25T06:00:00Z');
    const b = new ContactBudget(db, caps, { clock, holdMs: 60_000 });
    const r = await b.reserve({ lead: lead(), kind: 'first_touch', mailbox: 'mailbox-1' });
    assert.equal(r.allowed, true);
    const unit = await db.collection('usage').findOne({ _id: r.reservation.unit });
    assert.deepEqual([unit.meter, unit.period, unit.count, unit.cap], ['email:mailbox-1', '2026-11-25', 1, 30]);
    await b.release(r.reservation, { sent: false });
    assert.equal((await db.collection('usage').findOne({ _id: r.reservation.unit })).count, 0);

    const held = await b.reserve({ lead: lead(), kind: 'first_touch', mailbox: 'mailbox-1' });
    assert.equal(held.allowed, true);
    assert.match((await b.reserve({ lead: lead(), kind: 'first_touch', mailbox: 'mailbox-1' })).reason, /being prepared or sent/);
    now += 61_000; // the holder never released: its hold runs out
    assert.equal((await b.reserve({ lead: lead(), kind: 'first_touch', mailbox: 'mailbox-1' })).allowed, true);
    await assert.rejects(b.release(held.reservation), /sent: true \| false/);
  });
});

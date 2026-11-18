import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { MongoClient } from 'mongodb';
import { startMongo } from './helpers/mongod.js';
import { CAPS_PATH } from '../src/config.js';
import { DEMO_MARKER, assertDemo, demoConfig, demoDbName, demoStart, seedDemo } from '../src/ops/demo.js';
import { Auth, newUser, parseUsers } from '../src/admin/auth.js';
import { createAdminServer } from '../src/admin/server.js';
import { campaignResults } from '../src/attribution/results.js';

let mongo;
let client;
let db;
let root;
let made;
let cfg;
const lines = [];

before(async () => {
  mongo = await startMongo();
  client = new MongoClient(mongo.uri);
  await client.connect();
  root = mkdtempSync(path.join(os.tmpdir(), 'lead-engine-demo-'));
  const dbName = `t_${Date.now().toString(36)}_demo`;
  db = client.db(dbName);
  cfg = demoConfig({ mongoUri: mongo.uri, dbName, caps: JSON.parse(readFileSync(CAPS_PATH, 'utf8')), root });
  made = await seedDemo(db, { cfg, log: (l) => lines.push(l) });
});
after(async () => {
  await db?.dropDatabase();
  await client?.close();
  await mongo.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('the demonstration database', () => {
  test('only a database whose name ends in _demo', async () => {
    assert.throws(() => assertDemo('solutionai_leads'), /only runs on a demonstration database/);
    assert.equal(demoDbName('solutionai_leads'), 'solutionai_leads_demo');
    assert.equal(demoDbName('solutionai_leads_demo'), 'solutionai_leads_demo');
    assert.throws(() => demoConfig({ mongoUri: 'x', dbName: 'solutionai_leads', caps: {}, root }), /_demo/);
    // a demo config handed the live database by mistake: nothing is dropped
    const live = { databaseName: 'solutionai_leads', dropDatabase: async () => { throw new Error('dropped the live database'); } };
    await assert.rejects(seedDemo(live, { cfg: { dbName: 'solutionai_leads_demo' } }), /only runs on a demonstration database/);
  });

  test('a demo seeded outside the calling window is dated from the last time a call could be placed', () => {
    const v = cfg.voice;
    assert.equal(demoStart(new Date('2026-11-16T06:30:00Z'), v).toISOString(), '2026-11-16T06:30:00.000Z', 'Monday noon: now');
    assert.equal(demoStart(new Date('2026-11-16T17:30:00Z'), v).toISOString(), '2026-11-16T13:05:00.000Z', 'Monday 23:00 IST: 18:35 IST');
    assert.equal(demoStart(new Date('2026-11-15T06:30:00Z'), v).toISOString(), '2026-11-14T13:05:00.000Z', 'Sunday: Saturday 18:35 IST');
  });

  test('the engine itself took the fictional companies through every step', async () => {
    assert.equal(made.companies, 36);
    assert.equal(made.shortlisted, 24);
    assert.ok(made.sent >= 5, `sent ${made.sent}`);
    assert.ok(made.waiting >= 3, `waiting ${made.waiting}`);
    assert.deepEqual(made.replies, ['interested', 'question', 'not_now', 'unsubscribe']);
    assert.equal(made.claimed, true);
    assert.equal(made.call_outcome, 'wants_person');
    const stages = await db.collection('leads').distinct('stage');
    for (const s of ['discovered', 'shortlisted', 'contacted', 'claimed', 'customer']) assert.ok(stages.includes(s), `${s} in ${stages}`);
    assert.equal(await db.collection('activities').countDocuments({ type: 'paid' }), 1);
    assert.equal(await db.collection('suppressions').countDocuments({}), 1, 'the opt-out is on the suppression list');
    assert.equal(await db.collection('exports').countDocuments({ status: 'requested' }), 1);
    const sends = await db.collection('messages').find({ status: 'sent' }).toArray();
    assert.ok(sends.every((m) => /nothing was sent/.test(m.send.response)), 'a stand-in transport');
  });

  test('a founder found on the campus campaign page: the visit, the claim and the sign-up are the campaign\'s', async () => {
    assert.equal(made.campaign?.claimed, true, JSON.stringify(made.campaign));
    const [row] = await campaignResults(db, { campaigns: cfg.outreach.campaigns });
    assert.deepEqual(row, { code: 'demo-ecell', name: 'IIT Kanpur E-Cell (fictional demo)', channel: 'campus', active: true,
      opened: 1, claimed: 1, signed_up: 1, paid: 0, revenue_paise: 0 });
    const lead = await db.collection('leads').findOne({ company_id: made.campaign.company_id });
    assert.deepEqual([lead.stage, lead.shortlist], ['claimed', null], 'a company off the shortlist, never emailed');
    assert.equal(await db.collection('messages').countDocuments({ company_id: made.campaign.company_id }), 0);
    const founder = await db.collection('people').findOne({ company_ids: made.campaign.company_id });
    assert.equal(founder.name, 'Tanvi Agarwal');
  });

  test('an export approved by an admin who did not ask for it, and downloaded once', async () => {
    const ex = await db.collection('exports').findOne({ status: 'approved' });
    assert.ok(ex, 'an approved export');
    assert.notEqual(ex.decided_by, ex.requested_by);
    assert.equal(ex.downloads.length, 1);
    assert.equal(ex.downloads[0].rows, made.export.rows);
    assert.ok(made.export.rows > 10, `rows ${made.export.rows}`);
    assert.equal(await db.collection('audit_log').countDocuments({ action: 'export', 'target.id': ex._id }), 1, 'the download is logged');
  });

  test('labelled pairs and the AI check on a review pair', async () => {
    assert.equal(made.labelled, 3);
    const reviews = await db.collection('match_reviews').find({}).toArray();
    assert.equal(reviews.length, 3);
    assert.ok(reviews.every((r) => r.decision === 'same'));
    assert.equal(await db.collection('audit_log').countDocuments({ action: 'review_decision', 'detail.mode': 'label' }), 3);
    assert.equal(made.ai_checked, 1);
    const checked = await db.collection('entity_links').find({ ai_check: { $exists: true } }).toArray();
    assert.equal(checked.length, 1);
    assert.equal(checked[0].status, 'review', 'advice only: the pair is still for a person to decide');
    assert.deepEqual(checked[0].ai_check.verdicts.map((v) => [v.company_id, v.same]), [[checked[0].candidates[0].company_id, 'no']]);
    assert.equal(await db.collection('llm_calls').countDocuments({ task: 'match_check', ok: true }), 1, 'the call is logged with its cost');
  });

  test("a first email to the address a company publishes on its own website", async () => {
    const m = await db.collection('messages').findOne({ 'recipient.legal_basis': 'published_by_company' });
    assert.ok(m, 'a message to a website address');
    assert.equal(m.company_id, made.website_email.company_id);
    assert.deepEqual([m.kind, m.recipient.address, m.recipient.source], ['first_touch', made.website_email.address, 'company_website']);
    assert.match(m.recipient.address, /^info@[a-z]+\.example$/);
    assert.match(m.draft.body, /publishes this address on its website, [a-z]+\.example\./);
    assert.equal(m.qc.passed, true, JSON.stringify(m.qc.checks?.filter((c) => !c.ok)));
    assert.ok(m.recipient.verification, 'the address was checked before the draft');
    const c = await db.collection('companies').findOne({ _id: m.company_id });
    assert.equal(c.attrs.registered_email, undefined, 'the company has no registered email');
  });

  test('every address in it is on the reserved .example domain', async () => {
    const emails = new Set();
    for (const name of ['companies', 'messages', 'inbound', 'people', 'audit_log', 'exports', 'match_reviews']) {
      const text = JSON.stringify(await db.collection(name).find({}).toArray());
      for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) emails.add(m[0].toLowerCase());
    }
    assert.ok(emails.size > 10);
    const outside = [...emails].filter((e) => !/\.example$/.test(e));
    assert.deepEqual(outside, []);
  });

  test('every Admin page has something to show, under the demonstration banner', async () => {
    const users = ['viewer', 'reviewer', 'admin'].map((role) => newUser(`${role}@solutionai.demo.example`, role));
    const auth = new Auth({ users: parseUsers(users.map((u) => u.entry).join(';')), secret: 'd'.repeat(40) });
    const srv = createAdminServer({ db, auth, log: { error() {} }, caps: cfg.caps, monitorCfg: cfg.monitor, banner: DEMO_MARKER, mcaInbox: path.join(root, 'inbox') });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const page = async (p, who = users[2]) => {
      const r = await fetch(base + p, { headers: { Authorization: `Bearer ${who.token}` } });
      assert.equal(r.status, 200, p);
      return r.text();
    };
    try {
      for (const p of ['/admin', '/admin/shortlist', '/admin/companies', '/admin/approvals', '/admin/inbox', '/admin/calls', '/admin/results',
        '/admin/review', '/admin/labels', '/admin/health', '/admin/exports', '/admin/mca']) {
        assert.match(await page(p), /Demonstration data: every company, person and address here is invented\./, p);
      }
      const pipeline = await (await fetch(`${base}/api/pipeline`, { headers: { Authorization: `Bearer ${users[0].token}` } })).json();
      assert.equal(pipeline.shortlist.length, 24);
      const approvals = await (await fetch(`${base}/api/approvals`, { headers: { Authorization: `Bearer ${users[0].token}` } })).json();
      assert.ok(approvals.waiting.length >= 3);
      const inbox = await (await fetch(`${base}/api/inbox`, { headers: { Authorization: `Bearer ${users[0].token}` } })).json();
      assert.ok(inbox.waiting.length >= 2);
      const calls = await (await fetch(`${base}/api/calls`, { headers: { Authorization: `Bearer ${users[0].token}` } })).json();
      assert.equal(calls.open[0].outcome, 'wants_person');
      const review = await page('/admin/review');
      assert.match(review, /GOMTI TECH SOLUTIONS/);
      assert.match(review, /AI check \(advice only\)/);
      const labels = await (await fetch(`${base}/api/labels`, { headers: { Authorization: `Bearer ${users[0].token}` } })).json();
      assert.deepEqual([labels.links, labels.held_out_links, labels.near_misses], [8, 2, 2]);
      assert.deepEqual([labels.labelled, labels.waiting], [3, 7]);
      assert.deepEqual([labels.precision.held_out.judged, labels.precision.held_out.precision], [1, 1]);
      assert.deepEqual([labels.precision.all_links.judged, labels.precision.all_links.same], [3, 3]);
      assert.ok(labels.items[0].held_out && !labels.items[1].held_out, 'the held-out link still to label comes first');
      const cin = (await db.collection('leads').findOne({ stage: 'customer' })).company_id;
      assert.match(await page(`/admin/companies/${cin}`), /Paid|paid/);
    } finally {
      srv.close();
    }
  });
});

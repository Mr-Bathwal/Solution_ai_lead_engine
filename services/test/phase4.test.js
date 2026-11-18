import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { TEST_SECRET, freshDb, startMongo } from './helpers/mongod.js';
import { loadConfig } from '../src/config.js';
import { buildOutreach } from '../src/outreach/index.js';
import { JOB_DRAFT, JOB_SEND, planOutreach } from '../src/outreach/sequence.js';
import { decideApproval } from '../src/admin/approvals.js';
import { createPublicServer } from '../src/public/server.js';
import { createAdminServer } from '../src/admin/server.js';
import { Auth, newUser } from '../src/admin/auth.js';
import { JOB_CALL, nextCallWindow, scriptProblem, validateVoice } from '../src/voice/calls.js';
import { receiveEvents, signBody } from '../src/attribution/events.js';
import { costs, difference, lift, wilson } from '../src/attribution/results.js';
import { emfLine, runMonitor } from '../src/monitor/alerts.js';
import { buildSummary, sendSummary } from '../src/monitor/summary.js';
import { handleMcp } from '../src/mcp/server.js';
import { processInbound } from '../src/inbound/process.js';
import { callPage, callsPage, inboxItemPage, inboxPage, resultsPage } from '../src/admin/views.js';
const ANY_MX = { resolveMx: async () => [{ exchange: 'mx.test', priority: 10 }] };   // the fixtures' domains are invented: every one "receives mail"

/**
 * Phase 4, everything after the mailboxes: call backs by the voice agent, platform events and
 * attribution, monitoring and the daily summary, the MCP tools, the new Admin pages, and one
 * journey through the whole engine.
 */

const CID = 'U62099UP2026PTC300001';
const HOLD = 'U62099UP2026PTC300002';
const NOW = '2026-11-20T06:00:00Z';                 // Friday 11:30 IST
const REVIEWER = { email: 'reviewer@solutionai.in', role: 'reviewer' };
const EVENTS_SECRET = 'e'.repeat(40);
let mongo;
let client;
let db;
let now;
let outbox;
const clock = () => new Date(now);
const at = (iso) => { now = Date.parse(iso); };
const quiet = { info() {}, warn() {}, error() {} };

const attr = (value, source = 'mca_monthly') => ({ value, source, seen_at: new Date('2026-11-01T00:00:00Z') });
const company = (id = CID, name = 'VEZRAS TECHNOLOGIES PRIVATE LIMITED') => ({
  _id: id, kind: 'company', state: 'UP', name, ids: { cin: id, uplc: [] }, cohort: '2026-10',
  sources: ['mca_monthly'], first_seen_at: new Date('2026-11-01T00:00:00Z'), updated_at: new Date('2026-11-01T00:00:00Z'), schema_version: 2, former_names: [],
  attrs: { incorporation_date: attr('2026-10-14'), company_type: attr('Private Limited Company'), district: attr('Lucknow', 'startinup'),
    registered_email: attr('info@vezras.in', 'infyner') },
});
const needs = (confirmed = true) => ({ rules_confirmed: confirmed, rules_version: 't', deadlines: [
  { id: 'inc_20a', title: 'File the declaration for commencement of business', form: 'INC-20A', due: '2027-03-12', status: 'upcoming', law: 'Companies Act 2013 s.10A' }],
  schemes: [{ scheme_id: 'udyam_registration', name: 'Udyam (MSME) registration', verdict: 'eligible', missing: [] }] });
const leadDoc = (id = CID, over = {}) => ({
  company_id: id, stage: 'shortlisted', holdout: false, eligible: true, cohort: '2026-10', shortlist: { month: '2026-11', rank: 1 },
  score: { fit: 70, components: [{ key: 'new', points: 20, reason: 'incorporated recently' }], version: 'fit-v2', theme: { name: 'SaaS, IT & Cloud' } },
  needs: needs(), created_at: new Date('2026-11-01T00:00:00Z'), updated_at: new Date('2026-11-01T00:00:00Z'), ...over,
});

function setup(envOver = {}, { voice = {}, fetch } = {}) {
  const cfg = loadConfig({
    CONTACT_KEY_SECRET: TEST_SECRET, PUBLIC_BASE_URL: 'https://pages.example.in', PAGE_SECRET: 'p'.repeat(40), OUTBOX_DIR: outbox,
    MAILBOX_1_ADDRESS: 'gourav@outreach.example.in', MAILBOX_1_NAME: 'Gourav B', MAILBOX_2_ADDRESS: 'sujas@outreach.example.in', MAILBOX_2_NAME: 'Sujas C',
    PLATFORM_EVENTS_SECRET: EVENTS_SECRET, ...envOver,
  });
  cfg.voice = { ...cfg.voice, ...voice, script: { ...cfg.voice.script, ...(voice.script ?? {}) } };
  return { cfg, o: buildOutreach(cfg, db, { clock, log: quiet, dns: ANY_MX, ...(fetch ? { fetch } : {}) }) };
}

const LIVE_VOICE = { enabled: true, script: { approved_by: 'Sujas Choudhary', approved_on: '2026-11-17' } };
const SARVAM_ENV = { SARVAM_API_KEY: 'sk-test', SARVAM_ORG_ID: 'org1', SARVAM_WORKSPACE_ID: 'ws1', SARVAM_APP_ID: 'app1', SARVAM_APP_VERSION: '3',
  SARVAM_CONNECTION_ID: 'exotel-1', VOICE_CALLER_NUMBER: '+911401234567' };

/** A fake Sarvam: records each request, answers with an attempt id. */
function fakeSarvam({ status = 200 } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (status !== 200) return new Response(JSON.stringify({ detail: [{ msg: 'bad' }] }), { status });
    return new Response(JSON.stringify({ attempt_id: `att-${calls.length}` }), { status: 200 });
  };
  return { calls, fetch };
}

/** The job table reads the database's own clock, not the test clock: bring queued calls due now. */
async function makeDue(type = JOB_CALL) {
  await db.collection('jobs').updateMany({ type, status: 'pending' }, { $set: { due_at: new Date(Date.now() - 1000) } });
}

async function listen(srv) {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${srv.address().port}`;
}

function publicServer(o, extra = {}) {
  return createPublicServer({ db, tokens: o.tokens, ledger: o.ledger, suppression: o.suppression, queue: o.queue, platform: o.platform, cfg: o.cfg, org: o.org,
    secret: 'p'.repeat(40), privacyUrl: 'https://solutionai.in/privacy', privacyContact: 'privacy@solutionai.in', clock, log: quiet,
    voice: { cfg: o.voiceCfg, webhook: o.voiceWebhook }, ...extra });
}

/** Claims the company page as a founder who asks for a call back; returns the person's id. */
async function claimWithCallback(o, base, { slot = 'morning', language = 'hi' } = {}) {
  const token = await o.tokens.issue({ purpose: 'company_page', companyId: CID, leadId: (await db.collection('leads').findOne({ company_id: CID }))._id });
  const form = await (await fetch(`${base}/c/${token}/claim`)).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(form)[1];
  assert.match(form, /Call me back at the number above about Vezras Technologies Private Limited(?:'|&#39;)s filings\. The call may come from SolutionAI(?:'|&#39;)s AI assistant/);
  const body = new URLSearchParams({ csrf, name: 'Rahul Verma', role: 'Director', email: 'rahul@vezras.in', whatsapp: '98765 43210', call_slot: slot, call_language: language });
  body.append('consent', 'callback');
  const res = await fetch(`${base}/c/${token}/claim`, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const page = await res.text();
  assert.equal(res.status, 200, page);
  assert.match(page, slot === 'morning' ? /a call back in the morning \(10 am to 1 pm\) on the next calling day/ : /a call back between 10 am and 7 pm/);
  return (await db.collection('people').findOne({ company_ids: CID }))._id;
}

before(async () => { mongo = await startMongo(); });
after(async () => { await client?.close(); await mongo.stop(); try { rmSync(outbox, { recursive: true, force: true }); } catch { /* temp */ } });
beforeEach(async () => {
  await client?.close();
  ({ client, db } = await freshDb(mongo.uri));
  outbox = mkdtempSync(path.join(os.tmpdir(), 'lead-engine-outbox-'));
  at(NOW);
  await db.collection('companies').insertMany([company(), company(HOLD, 'HELD BACK FOODS PRIVATE LIMITED')]);
  await db.collection('leads').insertMany([leadDoc(), leadDoc(HOLD, { holdout: true, stage: 'discovered', shortlist: { month: '2026-11', rank: 2 } })]);
});

describe('sample approval (design 7.5)', () => {
  const decided = (n, { checkPassed = true, decision = 'approved', edited = false, by = 'reviewer@solutionai.in', kind = 'first_touch' } = {}) =>
    Array.from({ length: n }, () => ({ company_id: CID, kind, status: decision, idem_key: `m:${Math.random()}`,
      history: [{ at: clock(), status: checkPassed ? 'awaiting_approval' : 'qc_failed', by: 'engine' }],
      approval: { decision, by, at: clock(), edited }, created_at: clock(), updated_at: clock() }));
  const seed = (docs) => db.collection('messages').insertMany(docs, { bypassDocumentValidation: true });

  test('agreement is measured on what reviewers did with what the check said', async () => {
    const { agreement } = await import('../src/outreach/sampling.js');
    await seed([...decided(6), ...decided(1, { decision: 'rejected' }), ...decided(1, { edited: true }), ...decided(2, { checkPassed: false, decision: 'rejected' }),
      ...decided(5, { by: 'engine:sample' })]);
    const a = await agreement(db, { clock });
    assert.deepEqual([a.decided, a.agree, a.pct], [10, 8, 80], "the engine's own approvals are not evidence");
  });

  test('sample mode is in force only with enough agreeing decisions and a person who switched it on', async () => {
    const { samplingState } = await import('../src/outreach/sampling.js');
    const { cfg } = setup();
    const c = cfg.outreach;
    assert.equal((await samplingState(db, c, { clock })).active, false);
    c.approval = { ...c.approval, mode: 'sample' };
    assert.match((await samplingState(db, c, { clock })).reason, /nobody has recorded switching it on/);
    c.approval = { ...c.approval, switched_on_by: 'Sujas Choudhary', switched_on_on: '2026-11-20' };
    await seed(decided(60));
    assert.match((await samplingState(db, c, { clock })).reason, /only 60 reviewer decisions in 60 days; sample mode needs 100/);
    await seed([...decided(30), ...decided(10, { decision: 'rejected' })]);
    assert.match((await samplingState(db, c, { clock })).reason, /agrees with the reviewers on 90% of drafts; sample mode needs 95%/);
    const mon = await runMonitor(db, { caps: cfg.caps, cfg: cfg.monitor, secret: TEST_SECRET, clock, outreachCfg: c });
    assert.match(mon.open.find((a) => a._id === 'approval.sampling').message, /every draft goes to a person/);
    await seed(decided(110));
    const s = await samplingState(db, c, { clock });
    assert.equal(s.active, true, s.reason);
    assert.match(s.reason, /^20% of drafts that pass the check go to a person; the check agrees with the reviewers on 95\.2% of 210$/);
  });

  test('in force, a draft is approved by the engine and queued, or picked for a person', async () => {
    const { cfg, o } = setup();
    await seed(decided(120));
    o.cfg.approval = { ...o.cfg.approval, mode: 'sample', switched_on_by: 'Sujas Choudhary', switched_on_on: '2026-11-20', sample_pct: 0 };
    await planOutreach(o, { month: '2026-11' });
    const job = await o.queue.claim('t', { types: [JOB_DRAFT] });
    const r = await o.handlers[JOB_DRAFT](job);
    assert.equal(r.route, 'engine', JSON.stringify(r));
    const m = await db.collection('messages').findOne({ kind: 'first_touch', company_id: CID, 'draft.subject': { $exists: true } });
    assert.deepEqual([m.status, m.approval.by, m.approval_route], ['approved', 'engine:sample', 'engine']);
    assert.ok(await db.collection('jobs').findOne({ type: JOB_SEND, idem_key: `send:${m._id}` }), 'queued for the gate and the send');
    const audit = await db.collection('audit_log').findOne({ action: 'approval_decision', actor: 'engine:sample' });
    assert.equal(audit.detail.decision, 'approved');
    void cfg;
  });

  test('in force, a draft picked for the sample waits for a person', async () => {
    const { o } = setup();
    await seed(decided(120));
    o.cfg.approval = { ...o.cfg.approval, mode: 'sample', switched_on_by: 'Sujas Choudhary', switched_on_on: '2026-11-20', sample_pct: 100 };
    await planOutreach(o, { month: '2026-11' });
    const job2 = await o.queue.claim('t', { types: [JOB_DRAFT] });
    assert.equal((await o.handlers[JOB_DRAFT](job2)).route, 'sampled');
    const m2 = await db.collection('messages').findOne({ kind: 'first_touch', company_id: CID, 'draft.subject': { $exists: true } });
    assert.equal(m2.status, 'awaiting_approval');
    assert.match(m2.history.at(-1).note, /picked for a person \(the 100% sample\)/);
    assert.equal(await db.collection('jobs').countDocuments({ type: JOB_SEND }), 0, 'nothing queued to send');
  });
});

describe('the address check before a first email (design 7.3)', () => {
  const draftOnce = async (dns) => {
    const { cfg } = setup();
    const o = buildOutreach(cfg, db, { clock, log: quiet, dns });
    await planOutreach(o, { month: '2026-11' });
    return o.handlers[JOB_DRAFT](await o.queue.claim('t', { types: [JOB_DRAFT] }));
  };

  test('no draft to a domain that receives no mail; the timeline says why', async () => {
    const r = await draftOnce({ resolveMx: async () => { throw Object.assign(new Error('no such domain'), { code: 'ENOTFOUND' }); } });
    assert.match(r.skipped, /^address no-mx \(.* receives no mail\): not used$/);
    assert.equal(r.verification, 'no_mx');
    assert.equal(await db.collection('messages').countDocuments({ company_id: CID }), 0, 'nothing drafted, nothing to approve');
    const a = await db.collection('activities').findOne({ type: 'address_not_used', company_id: CID });
    assert.deepEqual([a.data.result, a.data.use], ['no_mx', 'never']);
  });

  test('an address that passes is drafted with its check on the message', async () => {
    const r = await draftOnce(ANY_MX);
    assert.equal(r.status, 'awaiting_approval');
    const m = await db.collection('messages').findOne({ company_id: CID, kind: 'first_touch' });
    assert.deepEqual([m.recipient.verification.result, m.recipient.verification.provider], ['unverified', 'free']);
  });

  test('an accept-all address waits for the second wave, then is drafted', async () => {
    const fetch = async () => new Response(JSON.stringify({ status: 'catch-all' }), { status: 200 });
    const { o } = setup({ EMAIL_VERIFY_PROVIDER: 'zerobounce', EMAIL_VERIFY_API_KEY: 'k' }, { fetch });
    await planOutreach(o, { month: '2026-11' });
    const job = await o.queue.claim('t', { types: [JOB_DRAFT] });
    await assert.rejects(o.handlers[JOB_DRAFT](job), (err) => err.name === 'DeferError' && err.until - clock() === 14 * 86_400_000
      && /held back from the first wave/.test(err.message));
    const a = await db.collection('activities').findOne({ type: 'address_not_used', company_id: CID });
    assert.deepEqual([a.data.result, a.data.use], ['accept_all', 'hold']);
    assert.equal(await db.collection('messages').countDocuments({ company_id: CID }), 0, 'nothing in the first wave');
    const r = await o.handlers[JOB_DRAFT]({ ...job, deferrals: 1 });     // the same job, back after the wait
    assert.equal(r.status, 'awaiting_approval', JSON.stringify(r));
    const m = await db.collection('messages').findOne({ company_id: CID, kind: 'first_touch' });
    assert.deepEqual([m.recipient.verification.result, m.recipient.verification.wave], ['accept_all', 2]);
  });

  test("a person's registered email gets the free checks only: it never reaches the verification service", async () => {
    const calls = [];
    const fetch = async (url) => { calls.push(String(url)); return new Response(JSON.stringify({ status: 'valid' }), { status: 200 }); };
    const { o } = setup({ EMAIL_VERIFY_PROVIDER: 'zerobounce', EMAIL_VERIFY_API_KEY: 'k' }, { fetch });
    await db.collection('companies').updateOne({ _id: CID }, { $set: { 'attrs.registered_email.value': 'rahul.k@gmail.com' } });
    await planOutreach(o, { month: '2026-11' });
    const r = await o.handlers[JOB_DRAFT](await o.queue.claim('t', { types: [JOB_DRAFT] }));
    assert.equal(r.status, 'awaiting_approval', JSON.stringify(r));
    assert.ok(!calls.some((u) => /zerobounce|rahul/.test(u)), calls.join('\n'));
    const m = await db.collection('messages').findOne({ company_id: CID, kind: 'first_touch' });
    assert.deepEqual([m.recipient.personal, m.recipient.verification.result, m.recipient.verification.provider], [true, 'unverified', 'free']);
  });

  test('a registered email ruled out for good gives way to a website address found later', async () => {
    const { cfg } = setup();
    const dns = { async resolveMx(d) { if (d === 'vezras.in') throw Object.assign(new Error('no such domain'), { code: 'ENOTFOUND' }); return [{ exchange: `mx.${d}`, priority: 10 }]; } };
    const o = buildOutreach(cfg, db, { clock, log: quiet, dns });
    o.cfg.recipient = { ...o.cfg.recipient, use_website_email: true };
    const first = await planOutreach(o, { month: '2026-11' });
    assert.equal(first.first_touch_queued, 1);
    const r1 = await o.handlers[JOB_DRAFT](await o.queue.claim('t', { types: [JOB_DRAFT] }));
    assert.match(r1.skipped, /not used$/);
    // the nightly finds the company's website and the role address it publishes
    await db.collection('companies').updateOne({ _id: CID }, { $set: { 'attrs.website_email': { value: 'contact@vezras-tech.in', source: 'company_website', confidence: 'medium',
      seen_at: new Date('2026-11-17T00:00:00Z'), ref: { domain: 'vezras-tech.in', legal_basis: 'published_by_company' } } } });
    const second = await planOutreach(o, { month: '2026-11' });
    assert.equal(second.first_touch_queued, 1, 'a new address gets a job of its own');
    const job = await o.queue.claim('t', { types: [JOB_DRAFT] });
    assert.equal(job.idem_key, `draft:${CID}:first_touch:website`);
    const r2 = await o.handlers[JOB_DRAFT](job);
    assert.equal(r2.status, 'awaiting_approval', JSON.stringify(r2));
    const m = await db.collection('messages').findOne({ company_id: CID, kind: 'first_touch' });
    assert.deepEqual([m.recipient.address, m.recipient.legal_basis], ['contact@vezras-tech.in', 'published_by_company']);
    assert.equal((await planOutreach(o, { month: '2026-11' })).first_touch_queued, 0, 'and only once');
  });
});

describe("an address the company publishes on its own website (design 7.3)", () => {
  const siteEmail = { value: 'info@vezras.in', source: 'company_website', confidence: 'medium', seen_at: new Date('2026-11-15T00:00:00Z'), ref: { domain: 'vezras.in', legal_basis: 'published_by_company' } };
  const draftFirst = async (o) => {
    const plan = await planOutreach(o, { month: '2026-11' });
    const job = await o.queue.claim('t', { types: [JOB_DRAFT] });
    return { plan, r: job ? await o.handlers[JOB_DRAFT](job) : null };
  };

  test('off until the wording is approved: no registered email means no first email', async () => {
    const { o } = setup();
    await db.collection('companies').updateOne({ _id: CID }, { $unset: { 'attrs.registered_email': '' }, $set: { 'attrs.website_email': siteEmail } });
    const { plan } = await draftFirst(o);
    assert.deepEqual([plan.no_address, plan.first_touch_queued], [1, 0]);
  });

  test("on: the website's role address, and the last paragraph says where it came from", async () => {
    const { o } = setup();
    o.cfg.recipient = { ...o.cfg.recipient, use_website_email: true };
    await db.collection('companies').updateOne({ _id: CID }, { $unset: { 'attrs.registered_email': '' }, $set: { 'attrs.website_email': siteEmail } });
    const { r } = await draftFirst(o);
    assert.equal(r.status, 'awaiting_approval', JSON.stringify(r));
    const m = await db.collection('messages').findOne({ company_id: CID, kind: 'first_touch' });
    assert.deepEqual([m.recipient.address, m.recipient.legal_basis, m.recipient.source], ['info@vezras.in', 'published_by_company', 'company_website']);
    assert.match(m.draft.body, /because Vezras Technologies Private Limited publishes this address on its website, vezras\.in\./);
    assert.doesNotMatch(m.draft.body, /Ministry of Corporate Affairs register/);
    assert.equal(m.qc.passed, true, JSON.stringify(m.qc.checks.filter((c) => !c.ok)));
  });

  test("on: a person's registered email gives way to the company's own role address; a company one does not", async () => {
    const { o } = setup();
    o.cfg.recipient = { ...o.cfg.recipient, use_website_email: true };
    const { recipientFor } = await import('../src/outreach/evidence.js');
    const personal = { attrs: { registered_email: { value: 'rahul.k@gmail.com', source: 'infyner' }, website_email: siteEmail } };
    assert.equal(recipientFor(personal, o.cfg.recipient).address, 'info@vezras.in');
    const companyLevel = { attrs: { registered_email: { value: 'accounts@vezras.in', source: 'infyner' }, website_email: siteEmail } };
    assert.equal(recipientFor(companyLevel, o.cfg.recipient).address, 'accounts@vezras.in', 'the registered address first');
    assert.equal(recipientFor(personal, { use_website_email: false }).address, 'rahul.k@gmail.com', 'switch off: as before');
    const personOnSite = { attrs: { website_email: { ...siteEmail, value: 'rahul.verma@vezras.in' } } };
    assert.equal(recipientFor(personOnSite, o.cfg.recipient), null, "a person's address from a website is never used");
  });
});

describe('campaign landing pages (design 3, item 5)', () => {
  const CAMPAIGN = { code: 'iitk-ecell', name: 'IIT Kanpur E-Cell', channel: 'campus', active: true, from: '2026-11-01', to: '2027-03-31' };
  const form = (o) => ({ method: 'POST', body: new URLSearchParams(o), redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' } });

  test('a campaign claim: closed without email set up, no email to an opted-out address, three emails a day, links last 48 hours', async () => {
    const { o } = setup();
    o.cfg.campaigns = [CAMPAIGN];
    const leadId = (await db.collection('leads').findOne({ company_id: CID }))._id;
    const pageToken = () => o.tokens.issue({ purpose: 'company_page', companyId: CID, leadId, campaign: 'campaign:iitk-ecell' });
    const claimVia = async (base, token, email = 'rahul@vezras.in') => {
      const csrf = /name="csrf" value="([^"]+)"/.exec(await (await fetch(`${base}/c/${token}/claim`)).text())[1];
      return fetch(`${base}/c/${token}/claim`, form({ csrf, name: 'Rahul Verma', role: 'Director', email, whatsapp: '', call_slot: 'any', call_language: 'hi' }));
    };
    const closed = publicServer(o);
    let base = await listen(closed);
    try {
      assert.equal((await claimVia(base, await pageToken())).status, 503, 'without email set up, claims from campaign pages stay closed');
    } finally {
      closed.close();
    }
    const links = [];
    const pages = publicServer(o, { confirm: { send: async (x) => { links.push(x); return { transport: 'test' }; } } });
    base = await listen(pages);
    try {
      await o.suppression.add({ email: 'gone@vezras.in' }, { reason: 'unsubscribe', source: { via: 'test' } });
      const optedOut = await claimVia(base, await pageToken(), 'gone@vezras.in');
      assert.equal(optedOut.status, 200);
      assert.match(await optedOut.text(), /Check your email/, 'the same page, so it says nothing about who opted out');
      assert.equal(links.length, 0, 'but no email');
      for (let i = 0; i < 3; i += 1) assert.equal((await claimVia(base, await pageToken())).status, 200);
      assert.equal((await claimVia(base, await pageToken())).status, 429, 'three confirmation emails a day to one address');
      assert.equal(links.length, 3);
      at(new Date(clock().getTime() + 49 * 3_600_000).toISOString());
      assert.equal((await fetch(`${base}/k/${links[0].token}`)).status, 404, 'a link lasts 48 hours');
      assert.equal(await db.collection('activities').countDocuments({ type: 'claimed' }), 0);
    } finally {
      pages.close();
    }
  });

  test('a founder finds the company, opens its page and claims it; the campaign gets the visit, the claim and the payment', async () => {
    const { cfg, o } = setup();
    o.cfg.campaigns = [CAMPAIGN, { code: 'old-fest', name: 'Old fest', active: true, to: '2026-10-31' }];
    await db.collection('companies').updateOne({ _id: CID }, { $set: { name_norm: 'vezrastechnologies' } });
    await db.collection('companies').updateOne({ _id: HOLD }, { $set: { name_norm: 'heldbackfoods' } });
    const links = [];
    const pages = publicServer(o, { confirm: { send: async (x) => { links.push(x); return { transport: 'test' }; } } });
    const base = await listen(pages);
    try {
      assert.equal((await fetch(`${base}/j/nope`)).status, 404, 'an unknown code');
      assert.equal((await fetch(`${base}/j/old-fest`)).status, 404, 'a campaign that has ended');
      const landing = await (await fetch(`${base}/j/iitk-ecell`)).text();
      assert.match(landing, /IIT Kanpur E-Cell/);
      assert.match(landing, /<form class="stack card" method="get" action="\/j\/iitk-ecell">/);
      assert.match(await (await fetch(`${base}/j/iitk-ecell?q=ve`)).text(), /Type at least three letters/);
      const found = await (await fetch(`${base}/j/iitk-ecell?q=Vezras%20Tech`)).text();
      assert.match(found, /VEZRAS TECHNOLOGIES PRIVATE LIMITED/);
      const sig = /name="company" value="U62099UP2026PTC300001"><input type="hidden" name="sig" value="([^"]+)"/.exec(found)[1];
      assert.match(await (await fetch(`${base}/j/iitk-ecell?q=${CID}`)).text(), /Open its page/, 'or by CIN');
      assert.match(await (await fetch(`${base}/j/iitk-ecell?q=Nowhere%20Ltd`)).text(), /We could not find "Nowhere Ltd"/);
      assert.equal((await fetch(`${base}/j/iitk-ecell/open`, form({ company: HOLD, sig }))).status, 403, 'only a company the search found');
      const opened = await fetch(`${base}/j/iitk-ecell/open`, form({ company: CID, sig }));
      assert.equal(opened.status, 303);
      const page = opened.headers.get('location');
      assert.match(page, /^\/c\/[A-Za-z0-9_-]+$/);
      assert.match(await (await fetch(base + page)).text(), /Claim Vezras Technologies Private Limited/);
      const visit = await db.collection('activities').findOne({ type: 'opened', company_id: CID });
      assert.deepEqual([visit.campaign, visit.holdout], ['campaign:iitk-ecell', false]);
      const claimForm = await (await fetch(`${base}${page}/claim`)).text();
      const csrf = /name="csrf" value="([^"]+)"/.exec(claimForm)[1];
      const body = new URLSearchParams({ csrf, name: 'Rahul Verma', role: 'Director', email: 'rahul@vezras.in', whatsapp: '', call_slot: 'any', call_language: 'hi' });
      body.append('consent', 'email_reminders');
      const stageBefore = (await db.collection('leads').findOne({ company_id: CID })).stage;
      const asked = await fetch(`${base}${page}/claim`, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      assert.equal(asked.status, 200);
      assert.match(await asked.text(), /Check your email/);
      // a page found on a campaign page proves nothing about who opened it: nothing happens until the address answers
      assert.deepEqual(links.map((l) => [l.to, l.company.id, l.lang]), [['rahul@vezras.in', CID, 'en']]);
      assert.equal(await db.collection('activities').countDocuments({ type: 'claimed', company_id: CID }), 0);
      assert.equal(await db.collection('consents').countDocuments({}), 0);
      assert.equal(await db.collection('people').countDocuments({ company_ids: CID }), 0);
      assert.equal((await db.collection('leads').findOne({ company_id: CID })).stage, stageBefore, 'outreach is not stopped by an unconfirmed claim');
      const waiting = await db.collection('page_tokens').findOne({ purpose: 'claim_confirm' });
      assert.ok(waiting.pending && !JSON.stringify(waiting).includes(links[0].token), 'only a hash of the link is kept');
      assert.equal((waiting.expires_at - waiting.created_at) / 3_600_000, 48);
      const link = `${base}/k/${links[0].token}`;
      const confirmPage = await (await fetch(link)).text();
      assert.match(confirmPage, /Confirm your claim/);
      assert.equal(await db.collection('activities').countDocuments({ type: 'claimed', company_id: CID }), 0, 'opening the link (as a link scanner does) changes nothing');
      const kcsrf = /name="csrf" value="([^"]+)"/.exec(confirmPage)[1];
      assert.equal((await fetch(link, form({ csrf: 'forged' }))).status, 403);
      const done = await fetch(link, form({ csrf: kcsrf }));
      assert.equal(done.status, 200);
      assert.match(await done.text(), /is claimed/);
      assert.equal((await fetch(link, form({ csrf: kcsrf }))).status, 404, 'the link works once');
      assert.equal((await db.collection('activities').findOne({ type: 'claimed', company_id: CID })).campaign, 'campaign:iitk-ecell');
      const person = await db.collection('people').findOne({ company_ids: CID });
      assert.equal(person.contacts.find((c) => c.channel === 'email').verified, true, 'the address answered');
      assert.equal((await db.collection('consents').findOne({})).proof.email_confirmed, true);
      // a holdout company found on the campaign page: its visit is counted as the holdout's
      const heldSig = /name="company" value="U62099UP2026PTC300002"><input type="hidden" name="sig" value="([^"]+)"/.exec(await (await fetch(`${base}/j/iitk-ecell?q=Held%20Back`)).text())[1];
      const held = await fetch(`${base}/j/iitk-ecell/open`, form({ company: HOLD, sig: heldSig }));
      await fetch(base + held.headers.get('location'));
      assert.equal((await db.collection('activities').findOne({ type: 'opened', company_id: HOLD })).holdout, true);
      // the platform reports a payment; the campaign is credited
      at('2026-11-21T06:00:00Z');
      await receiveEvents(db, { rawBody: JSON.stringify({ events: [{ id: 'evt_c1', type: 'paid', at: '2026-11-21T11:00:00+05:30', company_id: CID, amount_paise: 499900 }] }),
        signature: signBody(EVENTS_SECRET, JSON.stringify({ events: [{ id: 'evt_c1', type: 'paid', at: '2026-11-21T11:00:00+05:30', company_id: CID, amount_paise: 499900 }] })),
        secret: EVENTS_SECRET, clock });
      const { campaignResults } = await import('../src/attribution/results.js');
      const [r] = await campaignResults(db, { campaigns: [CAMPAIGN] });
      assert.deepEqual(r, { code: 'iitk-ecell', name: 'IIT Kanpur E-Cell', channel: 'campus', active: true, opened: 2, claimed: 1, signed_up: 0, paid: 1, revenue_paise: 499900 });
      void cfg;
    } finally {
      pages.close();
    }
  });
});

describe('the founder pages in Hindi', () => {
  const pageToken = async (o) => o.tokens.issue({ purpose: 'company_page', companyId: CID, leadId: (await db.collection('leads').findOne({ company_id: CID }))._id });
  const claimForm = (csrf, extra = {}) => new URLSearchParams({ csrf, name: 'राहुल वर्मा', role: 'Director', email: 'rahul@vezras.in', whatsapp: '', call_slot: 'any', call_language: 'hi', ...extra });

  test('before the lawyer approves it, Hindi is only a marked preview whose form cannot be sent', async () => {
    const { o } = setup();
    const pages = publicServer(o);
    const base = await listen(pages);
    try {
      const token = await pageToken(o);
      const asked = await (await fetch(`${base}/c/${token}?lang=hi`)).text();
      assert.match(asked, /<html lang="en">/, 'not approved: English');
      assert.doesNotMatch(asked, /हिन्दी में पढ़ें/, 'and no link to a Hindi page');
      const preview = await (await fetch(`${base}/c/${token}?lang=hi&preview=1`)).text();
      assert.match(preview, /<html lang="hi">/);
      assert.match(preview, /मसौदा: यह हिन्दी पाठ अभी कानूनी समीक्षा में है/);
      assert.match(preview, /आपकी अगली फ़ाइलिंग तिथियाँ|की जाँच एक चार्टर्ड अकाउंटेंट कर रहे हैं/);
      assert.match(preview, new RegExp(`href="/c/${token}/claim\\?lang=hi&amp;preview=1"`));
      assert.equal(await db.collection('activities').countDocuments({ type: 'opened' }), 1, 'a preview is not counted as the founder opening the page');
      const form = await (await fetch(`${base}/c/${token}/claim?lang=hi&preview=1`)).text();
      assert.match(form, /<button disabled>/);
      assert.match(form, /<input type="hidden" name="lang" value="hi">/);
      assert.match(form, /<option value="Director">निदेशक<\/option>/);
      const csrf = /name="csrf" value="([^"]+)"/.exec(form)[1];
      const body = claimForm(csrf, { lang: 'hi' });
      body.append('consent', 'email_reminders');
      const r = await fetch(`${base}/c/${token}/claim`, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      assert.equal(r.status, 409);
      assert.equal(await db.collection('consents').countDocuments({}), 0, 'no consent recorded in unapproved wording');
      assert.equal(await db.collection('people').countDocuments({}), 0);
    } finally {
      pages.close();
    }
  });

  test('once approved, a claim in Hindi records the Hindi wording, its version and its language', async () => {
    const { o } = setup();
    o.cfg.claim = { ...o.cfg.claim, hindi: { ...o.cfg.claim.hindi, approved_by: 'Adv. Test', approved_on: '2026-11-20' } };
    const pages = publicServer(o);
    const base = await listen(pages);
    try {
      const token = await pageToken(o);
      const en = await (await fetch(`${base}/c/${token}`)).text();
      assert.match(en, new RegExp(`<a class="lang" href="/c/${token}\\?lang=hi" lang="hi">हिन्दी में पढ़ें</a>`));
      const hi = await (await fetch(`${base}/c/${token}?lang=hi`)).text();
      assert.match(hi, /<html lang="hi">/);
      assert.doesNotMatch(hi, /मसौदा/);
      assert.match(hi, new RegExp(`<a class="lang" href="/c/${token}" lang="en">Read in English</a>`));
      const form = await (await fetch(`${base}/c/${token}/claim?lang=hi`)).text();
      assert.doesNotMatch(form, /<button disabled>/);
      const csrf = /name="csrf" value="([^"]+)"/.exec(form)[1];
      const bad = claimForm(csrf, { lang: 'hi', email: 'not an address' });
      const err = await fetch(`${base}/c/${token}/claim`, { method: 'POST', body: bad, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      assert.equal(err.status, 400);
      assert.match(await err.text(), /कृपया सही ईमेल पता लिखें।/);
      const body = claimForm(csrf, { lang: 'hi' });
      body.append('consent', 'email_reminders');
      const r = await fetch(`${base}/c/${token}/claim`, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      const thanks = await r.text();
      assert.equal(r.status, 200, thanks);
      assert.match(thanks, /धन्यवाद/);
      assert.match(thanks, /आपको ये मिलेंगे: फ़ाइलिंग की अंतिम तिथियों के रिमाइंडर ईमेल पर।/);
      const c = await db.collection('consents').findOne({});
      assert.equal(c.wording, 'Vezras Technologies Private Limited की फ़ाइलिंग की अंतिम तिथियों के रिमाइंडर मुझे ईमेल पर भेजें।');
      assert.equal(c.wording_version, 'claim-v2-hi');
      assert.equal(c.proof.language, 'hi');
      assert.equal(c.proof.form, 'claim-v2-hi');
    } finally {
      pages.close();
    }
  });
});

describe('call backs', () => {
  test('the calling window can never leave TRAI\'s 09:00 to 21:00, and a call waits for the founder\'s time of day', () => {
    const { cfg } = setup();
    assert.throws(() => validateVoice({ ...cfg.voice, window_ist: ['08:00', '19:00'] }), /window_ist must be/);
    assert.throws(() => validateVoice({ ...cfg.voice, slots: { late: ['19:00', '22:00'] } }), /slots\.late/);
    assert.throws(() => validateVoice({ ...cfg.voice, trai_window_ist: ['08:00', '22:00'] }), /inside 09:00 to 21:00/);
    const v = validateVoice(cfg.voice);
    assert.equal(nextCallWindow(new Date('2026-11-20T06:00:00Z'), v, 'morning').toISOString(), '2026-11-20T06:00:00.000Z', 'Friday 11:30 IST is in the morning slot');
    assert.equal(nextCallWindow(new Date('2026-11-20T06:00:00Z'), v, 'evening').toISOString(), '2026-11-20T10:30:00.000Z', '16:00 IST');
    assert.equal(nextCallWindow(new Date('2026-11-21T14:00:00Z'), v, 'any').toISOString(), '2026-11-23T04:30:00.000Z', 'Saturday evening -> Monday 10:00, never Sunday');
    assert.match(scriptProblem(v), /not signed off/);
    assert.equal(scriptProblem({ ...v, script: { ...v.script, approved_by: 'S', approved_on: '2026-11-17' } }), null);
    assert.match(scriptProblem({ ...v, script: { ...v.script, approved_by: 'S', approved_on: '2026-11-17', opening: { en: 'Hello from SolutionAI', hi: v.script.opening.hi } } }), /en opening line must say AI/);
  });

  test('a claim with a call back records the consent and queues the call; with the agent off, a person is asked to call', async () => {
    const { o } = setup();
    const srv = publicServer(o);
    const base = await listen(srv);
    try {
      const pid = await claimWithCallback(o, base);
      const person = await db.collection('people').findOne({ _id: pid });
      assert.deepEqual(person.contacts.map((c) => c.channel).sort(), ['email', 'voice', 'whatsapp']);
      const consent = await o.ledger.statusForAddress({ channel: 'voice', address: '+919876543210', purpose: 'callback' });
      assert.equal(consent.granted, true);
      assert.match(consent.entry.wording, /AI assistant, which will say so at the start/);
      assert.equal(consent.entry.wording_version, 'claim-v2');
      assert.equal(await db.collection('activities').countDocuments({ type: 'call_requested' }), 1);
      const job = await db.collection('jobs').findOne({ type: JOB_CALL });
      assert.deepEqual([job.payload.slot, job.payload.language, job.payload.attempt], ['morning', 'hi', 1]);
      assert.equal(job.due_at.toISOString(), new Date(NOW).toISOString(), 'Friday 11:30 IST is inside the morning slot');
      await makeDue();
      const claimed = await o.queue.claim('t', { types: [JOB_CALL] });
      const r = await o.handlers[JOB_CALL](claimed);
      assert.equal(r.status, 'blocked');
      const call = await db.collection('calls').findOne({});
      assert.match(call.gate.reasons[0], /switched off.*a person should make this call/);
      assert.equal(call.to, '+919876543210');
    } finally {
      srv.close();
    }
  });

  test('a live call: placed once with the approved opening, its outcome signed, minutes and cost settled', async () => {
    const sarvam = fakeSarvam();
    const { o } = setup(SARVAM_ENV, { voice: LIVE_VOICE, fetch: sarvam.fetch });
    const srv = publicServer(o);
    const base = await listen(srv);
    try {
      await claimWithCallback(o, base);
      await makeDue();
      const job = await o.queue.claim('t', { types: [JOB_CALL] });
      const r = await o.handlers[JOB_CALL](job);
      assert.equal(r.status, 'placed', JSON.stringify(r));
      assert.equal(sarvam.calls.length, 1);
      const req = sarvam.calls[0];
      assert.equal(req.url, 'https://apps.sarvam.ai/api/outbounds/v1/orgs/org1/workspaces/ws1/outbounds');
      assert.equal(req.init.headers['X-API-Key'], 'sk-test');
      assert.equal(req.body.user_config.user_phone_number, '+919876543210');
      assert.equal(req.body.app_config.connection_config.agent_phone_number, '+911401234567');
      assert.match(req.body.app_config.app_overrides.initial_bot_message, /^नमस्ते, मैं SolutionAI का AI सहायक/);
      assert.match(req.body.app_config.app_overrides.initial_bot_message, /Vezras Technologies Private Limited/);
      assert.equal(req.body.app_config.agent_variables.next_dates, 'File the declaration for commencement of business (INC-20A) by 12 मार्च 2027');
      assert.equal(req.body.webhook_config.url, 'https://pages.example.in/hooks/voice/sarvam');
      assert.equal((await db.collection('usage').findOne({ _id: 'voice_calls:2026-11' })).count, 1);
      assert.equal((await db.collection('usage').findOne({ _id: 'voice_minutes:2026-11' })).count, 3, 'the longest call is reserved');
      assert.equal((await o.handlers[JOB_CALL](job)).skipped, 'call is placed', 'never placed twice');
      await db.collection('calls').updateOne({}, { $set: { status: 'placing' } });           // as if a worker had died mid-request
      assert.equal((await o.handlers[JOB_CALL](job)).status, 'unknown', 'an interrupted request is never placed again');
      assert.equal(sarvam.calls.length, 1);
      await db.collection('calls').updateOne({}, { $set: { status: 'placed' } });

      const meta = req.body.webhook_config.metadata;
      const hook = (payload) => fetch(`${base}/hooks/voice/sarvam`, { method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } });
      assert.equal((await hook({ attempt_id: 'att-1', status: 'connected', webhook_config: { metadata: { ...meta, sig: 'f'.repeat(64) } } })).status, 403);
      assert.equal((await hook({ attempt_id: 'att-9', status: 'connected', webhook_config: { metadata: meta } })).status, 404, 'another attempt id is refused');
      const ok = await hook({ attempt_id: 'att-1', status: 'connected', duration: 95, webhook_config: { metadata: meta },
        final_agent_variables: { outcome: 'interested' }, interaction_transcript: [{ role: 'agent', en_text: 'Hello, AI assistant here' }, { role: 'user', en_text: 'Yes tell me' }] });
      assert.equal(ok.status, 200);
      const call = await db.collection('calls').findOne({});
      assert.deepEqual([call.status, call.duration_s, call.outcome, call.cost_paise], ['connected', 95, 'interested', 780]);
      assert.equal(call.transcript.length, 2);
      assert.equal((await db.collection('usage').findOne({ _id: 'voice_minutes:2026-11' })).count, 2, 'settled to the minutes used');
      assert.equal((await db.collection('activities').findOne({ type: 'call_completed' })).data.outcome, 'interested');
      assert.deepEqual(await (await hook({ attempt_id: 'att-1', status: 'connected', duration: 95, webhook_config: { metadata: meta } })).json(), { ok: true, already: 'connected' });
    } finally {
      srv.close();
    }
  });

  test('no answer is tried once more the next day; "stop" withdraws the consent; a provider refusal goes to a person', async () => {
    const sarvam = fakeSarvam();
    const { o } = setup(SARVAM_ENV, { voice: LIVE_VOICE, fetch: sarvam.fetch });
    const srv = publicServer(o);
    const base = await listen(srv);
    try {
      await claimWithCallback(o, base, { slot: 'any' });
      await makeDue();
      let job = await o.queue.claim('t', { types: [JOB_CALL] });
      await o.handlers[JOB_CALL](job);
      await o.queue.complete(job, null);
      const meta = sarvam.calls[0].body.webhook_config.metadata;
      await o.voiceWebhook({ attempt_id: 'att-1', status: 'no_answer', duration: null, webhook_config: { metadata: meta } });
      const retry = await db.collection('jobs').findOne({ idem_key: { $regex: /:2$/ } });
      assert.equal(retry.due_at.toISOString(), '2026-11-21T06:00:00.000Z', 'the next day, Saturday, at the same time');
      assert.equal((await db.collection('usage').findOne({ _id: 'voice_minutes:2026-11' })).count, 0);
      at('2026-11-21T06:00:00Z');
      await makeDue();
      job = await o.queue.claim('t', { types: [JOB_CALL] });
      assert.equal(job.payload.attempt, 2);
      await o.handlers[JOB_CALL](job);
      await o.voiceWebhook({ attempt_id: 'att-2', status: 'connected', duration: 40, webhook_config: { metadata: sarvam.calls[1].body.webhook_config.metadata },
        final_agent_variables: { outcome: 'stop' } });
      assert.equal((await o.ledger.statusForAddress({ channel: 'voice', address: '+919876543210', purpose: 'callback' })).granted, false);
      assert.equal(await db.collection('jobs').countDocuments({ type: JOB_CALL, 'payload.attempt': 3 }), 0, 'at most two attempts');
    } finally {
      srv.close();
    }
    const refused = fakeSarvam({ status: 422 });
    const { o: o2 } = setup(SARVAM_ENV, { voice: LIVE_VOICE, fetch: refused.fetch });
    await db.collection('calls').deleteMany({});
    await db.collection('jobs').deleteMany({});
    await db.collection('usage').deleteMany({});
    await o2.ledger.grant({ subject: { type: 'person', id: 'x' }, channel: 'voice', purpose: 'callback', address: '+919812345678', wording: 'w', wordingVersion: 'v', capturedVia: 'company_page_claim' });
    const pid = (await db.collection('people').insertOne({ name: 'A', company_ids: [CID], contacts: [{ channel: 'voice', address: '+919812345678', source: 'claim', legal_basis: 'consent' }],
      created_at: clock(), updated_at: clock() })).insertedId;
    await o2.queue.enqueue({ type: JOB_CALL, idemKey: `call:${CID}:${pid}:1`, payload: { company_id: CID, person_id: String(pid), slot: 'any', language: 'en', attempt: 1 } });
    const j = await o2.queue.claim('t', { types: [JOB_CALL] });
    assert.equal((await o2.handlers[JOB_CALL](j)).status, 'failed');
    assert.equal((await db.collection('usage').findOne({ _id: 'voice_calls:2026-11' })).count, 0, 'a refused call gives its unit back');
  });
});

describe('platform events and attribution', () => {
  test('only signed events are kept; each is linked to its lead and what came before it, once', async () => {
    const { o } = setup();
    await db.collection('activities').insertOne({ at: new Date('2026-11-20T06:00:00Z'), type: 'sent', channel: 'email', company_id: CID, holdout: false, idem_key: 'sent:x', data: { kind: 'first_touch' } });
    const body = JSON.stringify({ events: [
      { id: 'evt_1', type: 'paid', at: '2026-11-24T10:00:00+05:30', company_id: CID, amount_paise: 499900, service: 'gst_registration', reference: 'pay_1', email: 'should-not-be-kept@x.in' },
      { id: 'evt_2', type: 'signed_up', at: '2026-11-22T10:00:00+05:30', company_id: HOLD },
      { id: 'evt_3', type: 'refund', at: '2026-11-22T10:00:00+05:30', company_id: CID },
    ] });
    at('2026-11-25T06:00:00Z');
    const bad = await receiveEvents(db, { rawBody: body, signature: signBody('x'.repeat(40), body), secret: EVENTS_SECRET, clock });
    assert.equal(bad.status, 401);
    assert.equal(await db.collection('audit_log').countDocuments({ action: 'event_received' }), 1);
    const r = await receiveEvents(db, { rawBody: body, signature: signBody(EVENTS_SECRET, body), secret: EVENTS_SECRET, clock });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.results.map((x) => x.ok), [true, true, false]);
    const paid = await db.collection('activities').findOne({ type: 'paid' });
    assert.equal(paid.data.amount_paise, 499900);
    assert.equal(paid.data.email, undefined, 'only the known fields are kept');
    assert.deepEqual([paid.holdout, paid.data.attribution.contacted, paid.data.attribution.days_since_first_touch], [false, true, 3]);
    assert.equal((await db.collection('leads').findOne({ company_id: CID })).stage, 'customer');
    assert.equal((await db.collection('activities').findOne({ type: 'signed_up' })).holdout, true, 'the holdout\'s own conversions count too');
    const again = await receiveEvents(db, { rawBody: body, signature: signBody(EVENTS_SECRET, body), secret: EVENTS_SECRET, clock });
    assert.equal(again.body.results[0].duplicate, true);
    assert.equal(await db.collection('activities').countDocuments({ type: 'paid' }), 1);
    void o;
  });

  test('lift: the shortlist against its holdout, with an honest interval; costs per result', async () => {
    const [lo, hi] = wilson(5, 50);
    assert.ok(Math.abs(lo - 0.0435) < 0.001 && Math.abs(hi - 0.2136) < 0.001, `${lo} ${hi}`);
    const d = difference(10, 100, 2, 100);
    assert.ok(d.low > 0 && d.high < 0.2 && Math.abs(d.diff - 0.08) < 1e-9);
    await db.collection('activities').insertMany([
      { at: clock(), type: 'paid', channel: 'platform', company_id: CID, holdout: false, idem_key: 'platform:a', data: { amount_paise: 100000 } },
      { at: clock(), type: 'sent', channel: 'email', company_id: CID, holdout: false, idem_key: 'sent:a', data: {} },
    ]);
    const l = await lift(db, { month: '2026-11' });
    assert.deepEqual([l.contacted.companies, l.contacted.paid, l.contacted.revenue_paise, l.holdout.companies, l.holdout.paid], [1, 1, 100000, 1, 0]);
    assert.equal(l.verdict, 'too_early', 'two companies say nothing');
    await db.collection('usage').insertMany([
      { _id: 'llm_paise:2026-11', meter: 'llm_paise', period: '2026-11', count: 12345, cap: 40000, updated_at: clock() },
      { _id: 'vendor.full_profile:2026-11', meter: 'vendor.full_profile', period: '2026-11', count: 200, cap: 200, updated_at: clock() },
    ]);
    const c = await costs(db, { month: '2026-11', fixed: [{ item: 'Mailboxes', inr: 166 }] });
    assert.equal(c.total_inr, 1289.45);
    assert.equal(c.per_paying_inr, c.total_inr, 'one paying client');
    assert.equal(c.per_shortlisted_inr, c.total_inr);
  });
});

describe('monitoring and the daily summary', () => {
  test('alerts open, stay one alert while the problem lasts, and resolve when it goes', async () => {
    const { cfg } = setup();
    const old = new Date(Date.parse(NOW) - 3 * 86_400_000);
    await db.collection('jobs').insertMany([
      { type: 'outreach.send', idem_key: 'dead-1', status: 'dead', due_at: old, priority: 0, attempts: 5, max_attempts: 5, created_at: old, updated_at: clock(), finished_at: clock(), last_error: 'smtp down' },
      { type: 'outreach.draft', idem_key: 'late-1', status: 'pending', due_at: old, priority: 0, attempts: 0, max_attempts: 5, created_at: old, updated_at: old },
    ]);
    await db.collection('channel_templates').insertOne({ _id: 'whatsapp:filing_deadline_reminder:en', channel: 'whatsapp', name: 'filing_deadline_reminder', language: 'en', status: 'PAUSED', quality: 'RED', synced_at: clock() });
    const opts = { caps: cfg.caps, cfg: cfg.monitor, secret: TEST_SECRET, clock };
    const r1 = await runMonitor(db, opts);
    const ids = r1.open.map((a) => a._id).sort();
    assert.deepEqual(ids, ['jobs.dead.outreach.send', 'jobs.overdue', 'whatsapp.quality.whatsapp:filing_deadline_reminder:en', 'whatsapp.status.whatsapp:filing_deadline_reminder:en']);
    assert.equal(r1.opened.length, 4);
    const line = JSON.parse(emfLine(r1, { at: clock() }));
    assert.equal(line.OpenAlertsCritical, 3);
    assert.equal(line._aws.CloudWatchMetrics[0].Namespace, 'LeadEngine');
    const r2 = await runMonitor(db, opts);
    assert.equal(r2.opened.length, 0, 'a problem that lasts is not news');
    await db.collection('jobs').updateOne({ idem_key: 'late-1' }, { $set: { status: 'done' } });
    const r3 = await runMonitor(db, opts);
    assert.equal(r3.resolved, 1);
    assert.equal((await db.collection('alerts').findOne({ _id: 'jobs.overdue' })).status, 'resolved');
  });

  test("a missing MCA file, an uploaded file that failed and an export left waiting are alerts", async () => {
    const { cfg } = setup();
    const opts = { caps: cfg.caps, cfg: cfg.monitor, secret: TEST_SECRET, clock };
    await db.collection('companies').updateMany({}, { $set: { cohort: '2026-09' } });     // nobody incorporated in October yet
    const old = new Date(Date.parse(NOW) - 3 * 86_400_000);
    await db.collection('ingest_runs').insertOne({ _id: 'mca_monthly-bad', source: 'mca_monthly', status: 'failed', started_at: old, finished_at: old,
      params: { file: '20261117-060000-budget.xlsx', via: 'inbox', sha256: 'a'.repeat(64) }, stats: {}, notes: ["no companies in it: not MCA's monthly incorporation report"] });
    await db.collection('exports').insertOne({ _id: 'exp_000000000001', status: 'requested', requested_by: 'neha@solutionai.in', requested_role: 'reviewer',
      reason: 'the call list for the camp', filters: {}, include_contacts: false, max_rows: 100, estimate: 3, requested_at: old, decided_by: null,
      decided_at: null, decision_note: null, download_until: null, downloads: [] });
    const r = await runMonitor(db, opts);
    const by = Object.fromEntries(r.open.map((a) => [a._id, a]));
    assert.match(by['data.mca_file.2026-10'].message, /no companies incorporated in 2026-10 yet: download MCA's monthly file and upload it/);
    assert.match(by['data.mca_failed.mca_monthly-bad'].message, /20261117-060000-budget\.xlsx could not be loaded \(no companies in it/);
    assert.match(by['queue.exports'].message, /asked for by neha@solutionai\.in has waited 72 hours for an admin/);
    assert.ok(Object.values(by).every((a) => a.severity === 'warn'), 'a person should look; nothing is broken');
    await db.collection('companies').updateMany({}, { $set: { cohort: '2026-10' } });
    await db.collection('exports').updateOne({ _id: 'exp_000000000001' }, { $set: { status: 'approved' } });
    const r2 = await runMonitor(db, opts);
    assert.deepEqual(r2.open.map((a) => a._id), ['data.mca_failed.mca_monthly-bad']);
    at('2026-11-05T06:00:00Z');                                  // before the due day, no file is no alert yet
    await db.collection('companies').updateMany({}, { $set: { cohort: '2026-09' } });
    assert.ok(!(await runMonitor(db, opts)).open.some((a) => a._id.startsWith('data.mca_file')));
  });

  test('the summary counts yesterday, lists what waits, and goes to the team only', async () => {
    const { cfg, o } = setup();
    const y = new Date('2026-11-19T06:00:00Z');
    await db.collection('activities').insertMany([
      { at: y, type: 'sent', channel: 'email', company_id: CID, holdout: false, idem_key: 's1', data: {} },
      { at: y, type: 'replied', channel: 'email', company_id: CID, holdout: false, idem_key: 'r1', data: {} },
      { at: y, type: 'paid', channel: 'platform', company_id: CID, holdout: false, idem_key: 'p1', data: { amount_paise: 250000 } },
    ]);
    assert.doesNotMatch((await buildSummary(db, { caps: cfg.caps, monitorCfg: cfg.monitor, clock })).text, /exports waiting/, 'only when there is one');
    await db.collection('exports').insertOne({ _id: 'exp_000000000002', status: 'requested', requested_by: 'neha@solutionai.in', reason: 'the call list for the camp',
      filters: {}, requested_at: y });
    const s = await buildSummary(db, { caps: cfg.caps, monitorCfg: cfg.monitor, clock });
    assert.match(s.text, /exports waiting for an admin's approval: 1/);
    assert.match(s.subject, /^Lead engine 2026-11-19: 1 sent, 1 replies/);
    assert.match(s.text, /payments 1 \(₹2,500\)/);
    assert.doesNotMatch(s.text, /info@vezras\.in/, 'no addresses in the summary');
    const sent = await sendSummary({ summary: s, to: ['team@solutionai.in'], mailbox: o.mailboxes['mailbox-1'], transport: o.transport, clock });
    assert.match(sent[0].response, /written to .*not sent/);
    assert.equal(await db.collection('activities').countDocuments({ type: 'sent' }), 1, 'the summary is not an outreach email');
  });
});

describe('the MCP tools', () => {
  const rpc = (method, params = {}, id = 1) => handleMcp(db, { jsonrpc: '2.0', id, method, params });

  test('initialize, list, and the three tools: company-level only, holdouts never searched', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(await handleMcp(db, { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    assert.deepEqual((await rpc('tools/list')).result.tools.map((t) => t.name), ['search_leads', 'company_profile', 'deadline_calendar']);
    const found = (await rpc('tools/call', { name: 'search_leads', arguments: { query: 'foods' } })).result;
    assert.deepEqual(found.structuredContent.results, [], 'the holdout company is never returned');
    const vez = (await rpc('tools/call', { name: 'search_leads', arguments: { district: 'lucknow', shortlist_month: '2026-11' } })).result.structuredContent.results;
    assert.deepEqual(vez.map((x) => x.company_id), [CID]);
    const profile = (await rpc('tools/call', { name: 'company_profile', arguments: { company_id: HOLD.toLowerCase() } })).result.structuredContent;
    assert.match(profile.outreach, /holdout: the engine never contacts/);
    assert.ok(!JSON.stringify(profile).includes('vezras.in'), 'no contact detail');
    assert.deepEqual(profile.fit.reasons, ['incorporated recently (+20)']);
    await db.collection('leads').updateOne({ company_id: CID }, { $set: { 'needs.rules_confirmed': false } });
    const cal = (await rpc('tools/call', { name: 'deadline_calendar', arguments: { company_id: CID } })).result.structuredContent;
    assert.match(cal.caveat, /do not tell a founder these dates as fact/);
    const bad = (await rpc('tools/call', { name: 'company_profile', arguments: { company_id: 'nope' } })).result;
    assert.equal(bad.isError, true);
    assert.equal((await rpc('tools/call', { name: 'delete_everything' })).error.code, -32602);
    assert.equal((await rpc('resources/list')).error.code, -32601);
  });
});

describe('the new Admin pages', () => {
  const ctx = (role) => ({ user: { email: `${role}@solutionai.in`, role }, csrf: 'tok', notice: null, inboxWaiting: 2, callsWaiting: 1 });

  test('inbox, calls and results: labels, header scope, counts in the navigation, nothing personal for viewers', () => {
    const q = { waiting: [{ id: 'a'.repeat(24), received_at: new Date(NOW), mailbox: 'mailbox-1', kind: 'reply', label: 'interested', status: 'needs_person', confidence: 0.85, by: 'rules',
      subject: 'Re: <script>x</script>', company_id: CID, company_name: 'VEZRAS', next_step: 'Call', actions: [] }], recent: [], counts: { needs_person: 1 } };
    const pages = [String(inboxPage(q, ctx('viewer'))), String(callsPage({ open: [], recent: [] }, ctx('viewer')))];
    const item = { id: 'a'.repeat(24), received_at: new Date(NOW), mailbox: 'mailbox-1', kind: 'reply', label: 'unclear', status: 'needs_person', subject: 's', classification: null,
      actions: ['waiting for a person'], handled: null, dsn: null, company_id: CID, company_name: 'VEZRAS', matched_how: 'in_reply_to', message_id: null, from: 'r***@vezras.in',
      text: null, text_hidden: true, next_step: 'Read it' };
    pages.push(String(inboxItemPage(item, ctx('viewer'))), String(inboxItemPage({ ...item, text: 'hello', text_hidden: false, from: 'rahul@vezras.in' }, ctx('reviewer'))));
    pages.push(String(callPage({ id: 'b'.repeat(24), company_id: CID, company_name: 'VEZRAS', status: 'blocked', outcome: null, attempt: 1, slot: 'any', language: 'hi', history: [],
      handled: null, needs_person: true, to: null, person: null, transcript: null, gate: { reasons: ['agent off: a person should make this call'] } }, ctx('viewer'))));
    pages.push(String(resultsPage({ months: ['2026-11'], lift: { month: '2026-11', verdict: 'too_early', contacted: { companies: 1, contacted: 1, opened: 0, replied: 0, claimed: 0, signed_up: 0, service_request: 0, paid: 0, revenue_paise: 0 },
      holdout: { companies: 1, contacted: 0, opened: 0, replied: 0, claimed: 0, signed_up: 0, service_request: 0, paid: 0, revenue_paise: 0 }, paying: { diff: 0, low: -0.5, high: 0.5 }, signing: { diff: 0, low: -0.5, high: 0.5 } },
    costs: { month: '2026-11', lines: [{ item: 'AI', inr: 1 }], total_inr: 1, per_shortlisted_inr: 1, per_engaged_inr: null, per_paying_inr: null, counts: { shortlisted: 1, engaged: 0, paying: 0 } },
    channels: { mailboxes: [{ id: 'mailbox-1', sent: 0, bounced: 0, complained: 0, bouncePct: 0, complaintPct: 0, sent_today: 0, cap_today: 25, warmup_day: 24, paused: false, limits: { bounce_pct: 2, complaint_pct: 0.1 } }],
      whatsapp: [], calls: {}, call_outcomes: {}, inbound: [], page_opens_30d: 0 } }, ctx('viewer'))));
    for (const p of pages) {
      assert.match(p, /<a class="skip" href="#main">/);
      assert.match(p, /<nav aria-label="Main">/);
      assert.equal((p.match(/aria-current="page"/g) ?? []).length, 1);
      assert.doesNotMatch(p, /<script>/, 'outside data is escaped');
      for (const th of p.match(/<th\b[^>]*>/g) ?? []) assert.match(th, /scope="(col|row)"/, th);
      const labelled = (p.match(/<label\b[\s\S]*?<\/label>/g) ?? []).join('\n');
      for (const field of p.match(/<(input|select|textarea)\b(?![^>]*type="hidden")[^>]*>/g) ?? []) {
        const name = /name="([^"]+)"/.exec(field)?.[1];
        assert.ok(labelled.includes(`name="${name}"`), `${name} has a label`);
      }
    }
    assert.match(pages[0], /Inbox <span class="count">2<span class="vh"> waiting<\/span>/);
    assert.match(pages[2], /shown to reviewers and admins only/);
    assert.doesNotMatch(pages[2], /action="\/admin\/inbox\//, 'viewers decide nothing');
    assert.doesNotMatch(pages[4], /action="\/admin\/calls\//, 'nor mark calls dealt with');
    assert.match(pages[3], /<pre class="mail">hello<\/pre>/);
    assert.match(pages[3], /name="label"/);
    assert.match(pages[5], /Too early to tell/);
  });
});

describe('WhatsApp replies and Meta\'s webhook', () => {
  test('STOP withdraws the consent at once and is confirmed; a question goes to the inbox; a paused template stops sending', async () => {
    const { createHmac } = await import('node:crypto');
    const { readFileSync } = await import('node:fs');
    const { templateApproved } = await import('../src/outreach/whatsapp.js');
    const APP_SECRET = 'a'.repeat(32);
    const { o } = setup();
    const srv = createPublicServer({ db, tokens: o.tokens, ledger: o.ledger, suppression: o.suppression, queue: o.queue, platform: o.platform, cfg: o.cfg, org: o.org,
      secret: 'p'.repeat(40), clock, log: quiet, whatsapp: { hooks: o.whatsappHooks, appSecret: APP_SECRET, verifyToken: 'v'.repeat(20) } });
    const base = await listen(srv);
    try {
      // a founder claims the page with WhatsApp reminders
      const token = await o.tokens.issue({ purpose: 'company_page', companyId: CID });
      const csrf = /name="csrf" value="([^"]+)"/.exec(await (await fetch(`${base}/c/${token}/claim`)).text())[1];
      const form = new URLSearchParams({ csrf, name: 'Rahul Verma', role: 'Director', email: 'rahul@vezras.in', whatsapp: '98765 43210' });
      form.append('consent', 'whatsapp_reminders');
      assert.equal((await fetch(`${base}/c/${token}/claim`, { method: 'POST', body: form })).status, 200);
      const person = await db.collection('people').findOne({ company_ids: CID });
      await o.queue.enqueue({ type: 'reminder.send', idemKey: 'reminder:test', payload: { company_id: CID, person_id: String(person._id), channel: 'whatsapp' } });
      assert.equal((await o.ledger.statusForAddress({ channel: 'whatsapp', address: '+919876543210', purpose: 'deadline_reminders' })).granted, true);

      // Meta's subscription check
      assert.equal(await (await fetch(`${base}/hooks/whatsapp?hub.mode=subscribe&hub.verify_token=${'v'.repeat(20)}&hub.challenge=12345`)).text(), '12345');
      assert.equal((await fetch(`${base}/hooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`)).status, 403);
      const post = (payload, secret = APP_SECRET) => {
        const body = JSON.stringify(payload);
        return fetch(`${base}/hooks/whatsapp`, { method: 'POST', body, headers: { 'content-type': 'application/json',
          'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` } });
      };
      const msgs = (...messages) => ({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: {
        messaging_product: 'whatsapp', metadata: { phone_number_id: '1' }, contacts: [{ profile: { name: 'Rahul' }, wa_id: '919876543210' }], messages } }] }] });
      const stopMsg = { from: '919876543210', id: 'wamid.STOP1', timestamp: String(Date.parse(NOW) / 1000), type: 'text', text: { body: 'STOP' } };
      assert.equal((await post(msgs(stopMsg), 'x'.repeat(32))).status, 403, 'an unsigned or wrongly signed event is refused');

      // STOP
      const r = await (await post(msgs(stopMsg))).json();
      assert.equal(r.stop, 1);
      assert.equal((await o.ledger.statusForAddress({ channel: 'whatsapp', address: '+919876543210', purpose: 'deadline_reminders' })).granted, false);
      assert.equal((await db.collection('jobs').findOne({ idem_key: 'reminder:test' })).status, 'cancelled');
      assert.equal((await db.collection('inbound').findOne({ idem_key: 'in:whatsapp:wamid.STOP1' })).status, 'done');
      assert.match(readFileSync(path.join(outbox, 'whatsapp.jsonl'), 'utf8'), /you will not get WhatsApp reminders from SolutionAI any more/);
      const consentsBefore = await db.collection('consents').countDocuments();
      assert.equal((await (await post(msgs(stopMsg))).json()).duplicate, 1, 'Meta redelivers; nothing happens twice');
      assert.equal(await db.collection('consents').countDocuments(), consentsBefore);
      assert.equal((await (await post(msgs({ ...stopMsg, id: 'wamid.HI', text: { body: 'बंद करें' } }))).json()).stop, 1, 'Hindi STOP');

      // a question
      await post(msgs({ from: '919876543210', id: 'wamid.Q1', timestamp: '1', type: 'text', text: { body: 'When is INC-20A due for us?' } }));
      const q = await db.collection('inbound').findOne({ idem_key: 'in:whatsapp:wamid.Q1' });
      assert.deepEqual([q.channel, q.status, q.label, q.matched.company_id], ['whatsapp', 'needs_person', 'question', CID]);
      assert.equal(await db.collection('activities').countDocuments({ type: 'replied', channel: 'whatsapp' }), 1);

      // a failed delivery is a note, never a bounce that would stop email to the company
      await post({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { statuses: [
        { id: 'wamid.OUT1', status: 'failed', timestamp: '1', recipient_id: '919876543210', errors: [{ code: 131026, title: 'Message undeliverable' }] }] } }] }] });
      assert.equal((await db.collection('activities').findOne({ idem_key: 'failed:wa:wamid.OUT1' })).type, 'note');

      // Meta pauses a template, then its quality changes
      await db.collection('channel_templates').insertOne({ _id: 'whatsapp:filing_deadline_reminder:en', channel: 'whatsapp', name: 'filing_deadline_reminder', language: 'en',
        status: 'APPROVED', meta_id: '777', synced_at: clock() });
      const tpl = (field, value) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field, value }] }] });
      await post(tpl('message_template_status_update', { event: 'FIRST_PAUSE', message_template_id: 777, message_template_name: 'filing_deadline_reminder', message_template_language: 'en', reason: 'low quality' }));
      assert.equal(await templateApproved(db, 'filing_deadline_reminder', 'en'), false, 'a paused template stops being sent at once');
      await post(tpl('message_template_quality_update', { message_template_id: 777, previous_quality_score: 'GREEN', new_quality_score: 'RED' }));
      const t = await db.collection('channel_templates').findOne({ meta_id: '777' });
      assert.deepEqual([t.status, t.quality, t.reason], ['PAUSED', 'RED', 'low quality']);
      await post(tpl('message_template_status_update', { event: 'UNPAUSE', message_template_name: 'filing_deadline_reminder', message_template_language: 'en' }));
      assert.equal(await templateApproved(db, 'filing_deadline_reminder', 'en'), true);
    } finally {
      srv.close();
    }
  });
});

describe('scheme alerts', () => {
  test('a founder who asked hears about a scheme that starts to apply after the claim, once, through the platform\'s mail', async () => {
    const { planReminders, JOB_SCHEME } = await import('../src/outreach/reminders.js');
    const notified = [];
    const fetchFn = async (url, init) => { notified.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ id: `n${notified.length}` }), { status: 200 }); };
    const { o } = setup({ PLATFORM_NOTIFY_URL: 'https://platform.example.in/notify', PLATFORM_API_KEY: 'k' }, { fetch: fetchFn });
    const srv = publicServer(o);
    const base = await listen(srv);
    try {
      const token = await o.tokens.issue({ purpose: 'company_page', companyId: CID });
      const csrf = /name="csrf" value="([^"]+)"/.exec(await (await fetch(`${base}/c/${token}/claim`)).text())[1];
      const form = new URLSearchParams({ csrf, name: 'Rahul Verma', role: 'Director', email: 'rahul@vezras.in' });
      form.append('consent', 'email_schemes');
      assert.equal((await fetch(`${base}/c/${token}/claim`, { method: 'POST', body: form })).status, 200);
    } finally {
      srv.close();
    }
    assert.deepEqual((await db.collection('activities').findOne({ type: 'claimed' })).data.schemes_shown, ['udyam_registration']);
    assert.equal((await planReminders(o)).scheme_alerts_queued, 0, 'the founder has seen Udyam on the page');
    await db.collection('leads').updateOne({ company_id: CID }, { $push: { 'needs.schemes': { scheme_id: 'dpiit_recognition', name: 'DPIIT startup recognition',
      verdict: 'check_required', benefit: 'Startup India benefits.', missing: ['innovation or scalability'] } } });
    assert.equal((await planReminders(o)).scheme_alerts_queued, 1);
    assert.equal((await planReminders(o)).scheme_alerts_queued, 0, 'once per scheme');
    const job = await o.queue.claim('t', { types: [JOB_SCHEME] });
    assert.deepEqual(await o.handlers[JOB_SCHEME](job), { status: 'sent' });
    const n = notified.find((x) => x.url === 'https://platform.example.in/notify').body;
    assert.deepEqual([n.type, n.to, n.scheme.id, n.title], ['scheme_alert', 'rahul@vezras.in', 'dpiit_recognition', 'Vezras Technologies Private Limited may qualify for DPIIT startup recognition']);
    assert.equal((await db.collection('activities').findOne({ 'data.kind': 'scheme_alert' })).campaign, 'scheme_alert');
  });
});

describe('an erasure request', () => {
  test('removes the person everywhere, keeps them uncontactable, and leaves the ledger verifiable', async () => {
    const { o } = setup();
    const { erase } = await import('../src/privacy/erase.js');
    const email = 'rahul.verma@gmail.com';
    const phone = '+919876543210';
    const pid = (await db.collection('people').insertOne({ name: 'Rahul Verma', company_ids: [CID], created_at: clock(), updated_at: clock(),
      contacts: [{ channel: 'email', address: email, source: 'claim', legal_basis: 'consent' }, { channel: 'voice', address: phone, source: 'claim', legal_basis: 'consent' }] })).insertedId;
    for (const [channel, purpose, address] of [['email', 'deadline_reminders', email], ['voice', 'callback', phone]]) {
      await o.ledger.grant({ subject: { type: 'person', id: String(pid) }, channel, purpose, address, wording: 'w', wordingVersion: 'claim-v2', capturedVia: 'company_page_claim' });
    }
    await db.collection('companies').updateOne({ _id: CID }, { $set: { 'attrs.registered_email.value': email } });
    await db.collection('messages').insertOne({ idem_key: `msg:${CID}:first_touch`, company_id: CID, kind: 'first_touch', channel: 'email', language: 'en', status: 'sent',
      recipient: { address: email, legal_basis: 'published_under_law' }, evidence: { version: 'pack-v1', hash: '0'.repeat(64), pack: {} }, history: [], created_at: clock(), updated_at: clock(), expires_at: clock() });
    await db.collection('inbound').insertOne({ idem_key: 'in:mailbox-1:1:1', mailbox: 'mailbox-1', uid: 1, uidvalidity: 1, kind: 'reply', status: 'handled', from: { address: email, name: 'Rahul' },
      subject: 'Re: dates', text: 'Call me on my mobile', actions: [], received_at: clock(), created_at: clock(), updated_at: clock(), expires_at: clock() });
    await db.collection('calls').insertOne({ idem_key: `call:${CID}:${pid}:1`, company_id: CID, person_id: pid, purpose: 'callback', status: 'connected', attempt: 1, to: phone,
      transcript: [{ role: 'user', text: 'This is Rahul' }], history: [], created_at: clock(), updated_at: clock(), expires_at: clock() });

    const e = await erase(db, { kind: 'email', value: 'Rahul.Verma@Gmail.com', user: 'admin@solutionai.in', secret: TEST_SECRET, clock });
    assert.deepEqual([e.consents, e.messages, e.inbound, e.companies, e.contacts_removed, e.people_removed], [1, 1, 1, 1, 1, 0]);
    const p = await erase(db, { kind: 'phone', value: '98765 43210', user: 'admin@solutionai.in', secret: TEST_SECRET, clock });
    assert.deepEqual([p.consents, p.calls, p.people_removed], [1, 1, 1], 'a person with no contact left is removed');
    const everything = JSON.stringify(await Promise.all(['people', 'consents', 'messages', 'inbound', 'calls', 'suppressions', 'companies'].map((c) => db.collection(c).find({}).toArray())));
    for (const secret of ['rahul.verma@gmail.com', '9876543210', 'Call me on my mobile', 'This is Rahul']) assert.ok(!everything.includes(secret), secret);
    assert.ok((await o.suppression.check({ email })).some((h) => h.reason === 'erasure_request'), 'still never contacted');
    assert.ok((await o.suppression.check({ phone })).length);
    assert.equal((await o.ledger.verify()).ok, true, 'the consent ledger still verifies');
    assert.equal(await db.collection('audit_log').countDocuments({ action: 'erasure' }), 4);
    await assert.rejects(erase(db, { kind: 'email', value: 'not an address', user: 'a', secret: TEST_SECRET }), TypeError);
    assert.deepEqual(e.company_ids, [CID], 'the company whose vendor answers still hold the address is named');
  });

  test('a suppression is lifted only when its owner asks, and never an erasure, a complaint or a hard bounce', async () => {
    const { o } = setup();
    const { unsuppress } = await import('../src/privacy/unsuppress.js');
    await o.suppression.add({ email: 'asha@vezras.in' }, { reason: 'unsubscribe', source: { via: 'one_click' } });
    await o.suppression.add({ email: 'gone@vezras.in' }, { reason: 'erasure_request' });
    await o.suppression.add({ email: 'angry@vezras.in' }, { reason: 'spam_complaint' });
    const args = { by: 'admin@solutionai.in', secret: TEST_SECRET, clock };
    await assert.rejects(unsuppress(db, { ...args, kind: 'email', value: 'asha@vezras.in', note: 'ok' }), /what the owner asked/);
    const r = await unsuppress(db, { ...args, kind: 'email', value: 'Asha@Vezras.in', note: 'Asha replied on 20 Nov: "unsubscribed by mistake, please keep me on"' });
    assert.deepEqual(r, { lifted: true, reason_was: 'unsubscribe' });
    assert.equal((await o.suppression.check({ email: 'asha@vezras.in' })).length, 0);
    await assert.rejects(unsuppress(db, { ...args, kind: 'email', value: 'gone@vezras.in', note: 'asked to be added back' }), /erasure request is never lifted/);
    await assert.rejects(unsuppress(db, { ...args, kind: 'email', value: 'angry@vezras.in', note: 'asked to be added back' }), /spam complaint is never lifted/);
    assert.equal(await db.collection('audit_log').countDocuments({ action: 'suppression_lifted' }), 1);
  });
});

describe('the staging run', () => {
  test('a staging company sends during the warm-up with the staging caps, and nothing staging can touch the real database', async () => {
    const { seedStaging, STAGING_CID } = await import('../src/ops/staging.js');
    at('2026-11-16T06:00:00Z');                    // Monday 11:30 IST, day 20 of the real warm-up
    const root = mkdtempSync(path.join(os.tmpdir(), 'lead-engine-staging-'));
    const real = setup().cfg;
    await assert.rejects(seedStaging(db, { dbName: 'solutionai_leads', email: 'a@b.in', caps: real.caps, root, clock }), /only runs on a staging database/);
    assert.throws(() => loadConfig({ CONTACT_KEY_SECRET: TEST_SECRET, CAPS_FILE: 'x.json', LEAD_DB: 'solutionai_leads' }), /only for a staging or demonstration database/);
    const r = await seedStaging(db, { dbName: 'le_test_staging', email: 'Staging@SolutionAI.in', caps: real.caps, root, clock });
    assert.equal(r.email, 'staging@solutionai.in');
    const env = { CAPS_FILE: r.caps_file, LEAD_DB: 'le_test_staging' };
    const { o } = setup(env);
    assert.equal(o.caps.email.warmup_start, '2026-10-16');
    await planOutreach(o, { month: '2026-11' });
    const dj = await o.queue.claim('t', { types: [JOB_DRAFT] });
    assert.equal(dj.payload.company_id, STAGING_CID, 'only the staging company has an address');
    await o.handlers[JOB_DRAFT](dj);
    const msg = await db.collection('messages').findOne({ company_id: STAGING_CID });
    assert.equal(msg.status, 'awaiting_approval', JSON.stringify(msg.qc?.checks?.filter((c) => !c.ok)));
    await decideApproval(db, { id: String(msg._id), decision: 'approve', user: REVIEWER, cfg: o.cfg, org: o.org, queue: o.queue, clock });
    const approved = await db.collection('messages').findOne({ _id: msg._id });
    const realGate = await setup().o.gate.check({ message: approved, lead: await db.collection('leads').findOne({ company_id: STAGING_CID }) });
    assert.equal(realGate.code, 'warmup', 'the real caps would hold it');
    const sj = await o.queue.claim('t', { types: [JOB_SEND] });
    assert.equal((await o.handlers[JOB_SEND](sj)).status, 'sent', 'the staging caps let it through the warm-up');
    rmSync(root, { recursive: true, force: true });
  });
});

describe('launch tools', () => {
  const READY_ENV = { HOLDOUT_SALT: 'h'.repeat(40), ADMIN_SESSION_SECRET: 's'.repeat(40), PRIVACY_NOTICE_URL: 'https://solutionai.in/privacy', PRIVACY_CONTACT: 'privacy@solutionai.in',
    MAILBOX_1_SMTP_PASSWORD: 'app-1', MAILBOX_2_SMTP_PASSWORD: 'app-2', SUMMARY_TO: 'team@solutionai.in' };
  const fakeDns = {
    resolveMx: async () => [{ exchange: 'mx.zoho.in', priority: 10 }],
    resolveTxt: async (name) => (name.startsWith('_dmarc.') ? [['v=DMARC1; p=quarantine; rua=mailto:d@x.in']]
      : name.includes('._domainkey.') ? [['v=DKIM1; k=rsa; p=MIIB']] : [['v=spf1 include:zoho.in ~all']]),
  };
  const healthy = async (url) => (String(url).endsWith('/healthz') ? new Response('ok', { status: 200 }) : new Response('{}', { status: 404 }));

  test('preflight: ready when everything is in place, and says exactly what is missing when it is not', async () => {
    const { loadSchema } = await import('../src/config.js');
    const { preflight, formatPreflight } = await import('../src/ops/preflight.js');
    const anchor = path.join(outbox, 'anchor.log');
    const { cfg, o } = setup({ ...READY_ENV, LEDGER_ANCHOR_FILE: anchor });
    const signedIn = [];
    const args = { cfg, spec: loadSchema(), db, deps: o, live: true, fetch: healthy, clock, dns: fakeDns,
      smtpCheck: async (x) => { signedIn.push(x.user); return { code: 235 }; },
      imapFactory: () => ({ connect: async () => {}, examine: async () => ({}), logout: async () => {} }) };
    const results = await preflight(args);
    const report = formatPreflight(results);
    assert.deepEqual(results.filter((r) => r.status === 'fail'), [], report);
    assert.match(report, /READY to send/);
    assert.deepEqual(signedIn.sort(), ['gourav@outreach.example.in', 'sujas@outreach.example.in'], 'both mailboxes sign in; nothing is sent');
    assert.ok(results.some((r) => r.name === 'SPF outreach.example.in' && r.status === 'pass'));

    const { cfg: c2, o: o2 } = setup({ ...READY_ENV, PUBLIC_BASE_URL: '', PRIVACY_CONTACT: '' });
    const broken = await preflight({ ...args, cfg: c2, deps: o2, smtpCheck: async () => { throw new Error('535 Authentication Failed'); },
      dns: { resolveMx: async () => [], resolveTxt: async () => [] } });
    const failed = broken.filter((r) => r.status === 'fail').map((r) => r.name);
    for (const name of ['PUBLIC_BASE_URL', 'privacy notice', 'mailbox-1 SMTP', 'MX outreach.example.in', 'SPF outreach.example.in', 'DMARC outreach.example.in']) assert.ok(failed.includes(name), name);
    assert.match(formatPreflight(broken), /NOT READY/);
    assert.match(broken.find((r) => r.name === 'mailbox-1 SMTP').detail, /535/);
  });

  test('platform:check holds the platform\'s answers to the contract; test events are checked but never recorded', async () => {
    const { platformCheck } = await import('../src/ops/platform_check.js');
    const sent = [];
    const fetchFn = async (url, init) => {
      sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      if (url.endsWith('/v1/verdicts')) return new Response(JSON.stringify({ rules_version: 'r1', verdicts: [{ scheme_id: 'dpiit_recognition', name: 'DPIIT', verdict: 'not_eligible' }, { scheme_id: 'sisfs', name: 'Seed', verdict: 'closed' }] }), { status: 200 });
      if (url.endsWith('/onboarding')) return new Response(JSON.stringify({ signup_url: 'http://app.example.in/x' }), { status: 200 });
      return new Response('{}', { status: 500 });
    };
    const { cfg, o } = setup({ RULES_ENGINE_URL: 'https://rules.example.in', RULES_ENGINE_KEY: 'k', PLATFORM_ONBOARDING_URL: 'https://api.example.in/onboarding', PLATFORM_API_KEY: 'k' });
    const res = await platformCheck({ cfg, deps: o, fetch: fetchFn, clock });
    const rules = res.find((r) => r.name === 'rules engine');
    assert.equal(rules.status, 'fail');
    assert.match(rules.detail, /DPIIT recognition is "not eligible" although recognition is unknown/);
    assert.match(rules.detail, /closed without valid_until/);
    assert.equal(res.find((r) => r.name === 'onboarding').status, 'fail', 'an http sign-up link is refused');
    assert.ok(sent.every((x) => x.headers['x-lead-engine-test'] === '1'), 'every check is marked as a test');
    assert.equal(sent.find((x) => x.url.endsWith('/onboarding')).body.source.test, true);
    assert.ok(!JSON.stringify(sent).includes('vezras'), 'no real company or person is sent');

    const body = JSON.stringify({ events: [{ id: 'test_1', type: 'paid', at: '2026-11-20T10:00:00+05:30', company_id: CID, amount_paise: 100 }] });
    const r = await receiveEvents(db, { rawBody: body, signature: signBody(EVENTS_SECRET, body), secret: EVENTS_SECRET, clock });
    assert.deepEqual(r.body.results[0], { id: 'test_1', ok: true, test: true, duplicate: false, known_company: true });
    assert.equal(await db.collection('activities').countDocuments({ type: 'paid' }), 0, 'a test event is never recorded');
  });

  test('WhatsApp templates are submitted once, with the real address and full example links', async () => {
    const { submitTemplates, metaTemplate } = await import('../src/outreach/whatsapp.js');
    const { readFileSync } = await import('node:fs');
    const templates = JSON.parse(readFileSync(new URL('../../config/whatsapp_templates.json', import.meta.url), 'utf8')).templates;
    assert.throws(() => metaTemplate(templates[0], ''), /PUBLIC_BASE_URL/);
    const created = [];
    const client = { createTemplate: async (p) => { created.push(p); return { id: `t${created.length}`, status: 'PENDING', category: 'UTILITY' }; } };
    const r1 = await submitTemplates(db, client, templates, { publicBaseUrl: 'https://pages.outreach.in', clock });
    assert.equal(created.length, 4);
    const button = created[0].components.find((c) => c.type === 'BUTTONS').buttons[0];
    assert.deepEqual([button.url, button.example[0]], ['https://pages.outreach.in/c/{{1}}', 'https://pages.outreach.in/c/k3J9xQ2mZ7']);
    assert.deepEqual(Object.keys(created[0]).sort(), ['category', 'components', 'language', 'name'], 'only what Meta takes');
    assert.ok(r1.every((x) => /submitted \(PENDING\)/.test(x.result)));
    const r2 = await submitTemplates(db, client, templates, { publicBaseUrl: 'https://pages.outreach.in', clock });
    assert.equal(created.length, 4, 'a template Meta already has is not submitted again');
    assert.match(r2[0].result, /already at Meta \(PENDING\)/);
  });

  test('staging:smoke runs the whole email loop: send, deliver, reply, read, label, unsubscribe', async () => {
    const { runSmoke } = await import('../src/ops/smoke.js');
    await db.collection('leads').deleteMany({});                 // a staging database holds only the test company
    const env = { MAILBOX_1_SMTP_PASSWORD: 'p1', MAILBOX_2_SMTP_PASSWORD: 'p2' };
    const boxes = { 'gourav@outreach.example.in': [], 'sujas@outreach.example.in': [] };
    let uid = 1;
    const deliver = (to, raw) => boxes[to].push({ uid: uid++, internalDate: clock(), raw: Buffer.from(raw) });
    const transport = { kind: 'smtp', host: 'smtp.test', port: 465, send: async ({ raw, to }) => { deliver(to, raw); return { transport: 'smtp', response: '250 queued as T1' }; } };
    const readNewFn = async (box, { afterUid }) => ({ uidvalidity: 1, messages: boxes[box.user].filter((m) => !afterUid || m.uid > afterUid) });
    const { cfg, o: first } = setup(env, {});
    const deps0 = buildOutreach(cfg, db, { clock, log: quiet, transport, dns: ANY_MX });
    const buildDeps = (capsFile) => {
      const c = loadConfig({ ...cfg.env, CAPS_FILE: capsFile, LEAD_DB: 'le_test_staging' });
      c.outreach = { ...c.outreach, send_days_ist: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] };
      return buildOutreach(c, db, { clock, log: quiet, transport, dns: ANY_MX });
    };
    const srv = publicServer(first);
    const base = await listen(srv);
    const root = mkdtempSync(path.join(os.tmpdir(), 'lead-engine-smoke-'));
    at('2026-11-22T15:30:00Z');                                  // Sunday 21:00 IST: outside the real window, inside the staging one
    try {
      const r = await runSmoke(deps0, { dbName: 'le_test_staging', caps: cfg.caps, root, buildDeps, readNewFn, sleep: async () => {}, waitMs: 200, pollMs: 1, clock,
        sendReply: async ({ to, raw }) => deliver(to, raw), fetch: (url, init) => fetch(String(url).replace('https://pages.example.in', base), init) });
      assert.equal(r.ok, true, JSON.stringify(r.steps.filter((s) => s.status === 'fail')));
      assert.deepEqual(r.steps.map((s) => s.name), ['settings', 'seed', 'draft', 'approve and gate', 'send', 'delivered', 'reply', 'reply read and classified', 'pages and one-click unsubscribe']);
      assert.match(r.steps.find((s) => s.name === 'delivered').detail, /headers and links present; NOT DKIM-signed/);
      assert.match(r.steps.find((s) => s.name === 'reply read and classified').detail, /matched by in_reply_to; labelled interested/);
      assert.match(r.steps.at(-1).detail, /one click suppresses the address/);
      await assert.rejects(runSmoke(deps0, { dbName: 'solutionai_leads', caps: cfg.caps, root, buildDeps }), /only runs on a staging database/);
    } finally {
      srv.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the SMTP check signs in and quits without sending', async () => {
    const { verifySmtp } = await import('../src/outreach/smtp.js');
    const net = await import('node:net');
    const seen = [];
    const srv = net.createServer((sock) => {
      sock.on('error', () => {});
      sock.write('220 test ESMTP\r\n');
      sock.on('data', (d) => {
        for (const line of d.toString().split('\r\n').filter(Boolean)) {
          seen.push(line.split(' ')[0]);
          if (line.startsWith('EHLO')) sock.write('250-test\r\n250 AUTH PLAIN LOGIN\r\n');
          else if (line.startsWith('AUTH')) sock.write('235 ok\r\n');
          else if (line.startsWith('QUIT')) sock.end('221 bye\r\n');
          else sock.write('500 no\r\n');
        }
      });
    });
    await new Promise((res) => srv.listen(0, '127.0.0.1', res));
    try {
      const r = await verifySmtp({ host: '127.0.0.1', port: srv.address().port, secure: false, starttls: false, insecurePlain: true, user: 'u', pass: 'p' });
      assert.equal(r.code, 235);
      for (let i = 0; i < 50 && !seen.includes('QUIT'); i += 1) await new Promise((res) => setTimeout(res, 20));   // the QUIT is written as the client leaves
      assert.deepEqual(seen, ['EHLO', 'AUTH', 'QUIT'], 'no MAIL, RCPT or DATA');
    } finally {
      srv.close();
    }
  });
});

describe('one journey through the engine', () => {
  test('email, reply, inbox, page, claim, call back, payment, results, MCP, monitor: all over HTTP where a person would use it', async () => {
    const sarvam = fakeSarvam();
    const { cfg, o } = setup({ ...SARVAM_ENV }, { voice: LIVE_VOICE, fetch: sarvam.fetch });
    const pages = publicServer(o);
    const users = Object.fromEntries(['viewer', 'reviewer'].map((role) => [role, newUser(`${role}@solutionai.in`, role)]));
    const auth = new Auth({ users: Object.values(users).map((u) => { const [email, role, hash] = u.entry.split(','); return { email, role, hash, epoch: 0 }; }), secret: 's'.repeat(40) });
    const admin = createAdminServer({ db, auth, clock, log: quiet, caps: cfg.caps, monitorCfg: cfg.monitor, eventsSecret: EVENTS_SECRET,
      outreach: { queue: o.queue, cfg: o.cfg, org: o.org, suppression: o.suppression } });
    const pub = await listen(pages);
    const adm = await listen(admin);
    const api = (role, p, body) => fetch(`${adm}${p}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${users[role].token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    try {
      // 1. plan, draft, approve over the API, send to the outbox
      await planOutreach(o, { month: '2026-11' });
      const dj = await o.queue.claim('t', { types: [JOB_DRAFT] });
      await o.handlers[JOB_DRAFT](dj);
      await o.queue.complete(dj, null);
      const msg = await db.collection('messages').findOne({ kind: 'first_touch' });
      assert.equal((await api('reviewer', `/api/approvals/${msg._id}`, { decision: 'approve' })).status, 200);
      const sj = await o.queue.claim('t', { types: [JOB_SEND] });
      assert.equal((await o.handlers[JOB_SEND](sj)).status, 'sent');
      const sent = await db.collection('messages').findOne({ _id: msg._id });
      // 2. the founder replies; the inbox shows it; a reviewer deals with it
      at('2026-11-23T05:00:00Z');
      const reply = `From: info@vezras.in\r\nTo: ${o.mailboxes[sent.mailbox].address}\r\nSubject: Re: ${sent.draft.subject}\r\nMessage-ID: <r@vezras.in>\r\nIn-Reply-To: ${sent.send.message_id}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nWhat are your charges? Please call.\r\n`;
      await processInbound(o, { mailbox: sent.mailbox, uid: 3, uidvalidity: 1, internalDate: clock(), raw: reply });
      const inbox = await (await api('viewer', '/api/inbox')).json();
      assert.equal(inbox.waiting[0].label, 'interested');
      assert.equal((await (await api('viewer', `/api/inbox/${inbox.waiting[0].id}`)).json()).text, null, 'a viewer never sees the text');
      assert.equal((await (await api('reviewer', `/api/inbox/${inbox.waiting[0].id}`)).json()).text, 'What are your charges? Please call.');
      assert.equal(await db.collection('audit_log').countDocuments({ action: 'view_personal', 'target.type': 'inbound' }), 1);
      assert.equal((await api('reviewer', `/api/inbox/${inbox.waiting[0].id}`, { label: 'interested', handled: 'yes', note: 'called back' })).status, 200);
      // 3. the founder opens the page, claims it and asks for a call back; the agent calls; it connects
      await claimWithCallback(o, pub);
      assert.equal((await db.collection('jobs').findOne({ type: JOB_CALL })).due_at.toISOString(), '2026-11-23T05:00:00.000Z', 'Monday 10:30 IST is in the morning slot');
      await makeDue();
      const cj = await o.queue.claim('t', { types: [JOB_CALL] });
      assert.equal((await o.handlers[JOB_CALL](cj)).status, 'placed');
      await fetch(`${pub}/hooks/voice/sarvam`, { method: 'POST', body: JSON.stringify({ attempt_id: 'att-1', status: 'connected', duration: 120,
        webhook_config: { metadata: sarvam.calls[0].body.webhook_config.metadata }, final_agent_variables: { outcome: 'wants_person' } }) });
      const calls = await (await api('viewer', '/api/calls')).json();
      assert.equal(calls.open[0].outcome, 'wants_person');
      assert.equal((await api('reviewer', `/api/calls/${calls.open[0].id}`, { note: 'spoke to Rahul' })).status, 200);
      // 4. the platform reports a payment; the results and the MCP tools see it
      at('2026-11-26T05:00:00Z');
      const body = JSON.stringify({ events: [{ id: 'evt_9', type: 'paid', at: '2026-11-26T10:00:00+05:30', company_id: CID, amount_paise: 999900 }] });
      const ev = await fetch(`${adm}/api/events`, { method: 'POST', body, headers: { 'x-signature': signBody(EVENTS_SECRET, body), 'content-type': 'application/json' } });
      assert.equal(ev.status, 200);
      const results = await (await api('viewer', '/api/results?month=2026-11')).json();
      assert.deepEqual([results.lift.contacted.paid, results.lift.contacted.replied, results.lift.contacted.claimed, results.lift.holdout.paid], [1, 1, 1, 0]);
      assert.equal((await api('viewer', '/admin/results')).status, 200);
      const mcp = await (await api('viewer', '/mcp', { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'company_profile', arguments: { company_id: CID } } })).json();
      assert.equal(mcp.result.structuredContent.stage, 'customer');
      // 5. the monitor and the pages a person opens every day
      const mon = await runMonitor(db, { caps: cfg.caps, cfg: cfg.monitor, secret: TEST_SECRET, clock });
      assert.deepEqual(mon.open.filter((a) => a.severity === 'critical'), []);
      for (const p of ['/admin', '/admin/approvals', '/admin/inbox', '/admin/calls', '/admin/results', '/admin/health']) {
        assert.equal((await api('viewer', p)).status, 200, p);
      }
      const journey = new Set((await db.collection('activities').find({ company_id: CID }).toArray()).map((a) => a.type));
      for (const t of ['drafted', 'approved', 'sent', 'replied', 'handed_over', 'claimed', 'call_requested', 'call_completed', 'paid']) assert.ok(journey.has(t), t);
    } finally {
      pages.close();
      admin.close();
    }
  });
});

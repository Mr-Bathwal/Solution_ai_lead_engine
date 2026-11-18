import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { freshDb, startMongo } from './helpers/mongod.js';
import { Auth, newServiceToken, newUser, parseServiceTokens, parseUsers, platformHeaders } from '../src/admin/auth.js';
import { createAdminServer } from '../src/admin/server.js';
import { recordReview, registeredEmailIsPersonal, safeHref } from '../src/admin/queries.js';
import { SHARED_MAIL_DOMAINS } from '../src/util/normalize.js';
import { parseMultipart } from '../src/admin/mca.js';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let mongo;
let client;
let db;
let server;
let base;
const tokens = {};
const entries = [];
const SECRET = 'x'.repeat(40);
const CIN = 'U62099UP2026PTC100001';
const EVIL = 'U62099UP2026PTC100002';
const TEAM = 'U62099UP2026PTC100003';           // linked to a portal startup that lists its team
const PERSON_AT_COMPANY = 'U62099UP2026PTC100004';   // rahul.verma@acme.in: a person, at the company's own domain
const ROLE_ADDRESS = 'U62099UP2026PTC100005';        // info@acme.in: company-level
const FLAGGED = 'U62099UP2026PTC100006';             // a role address the data side flagged personal
const FLAGGED_NOT = 'U62099UP2026PTC100007';         // a personal-looking address the data side flagged company-level
const LINKS = 'U62099UP2026PTC100008';               // rules data with unsafe link targets
const sharedCin = (i) => `U62099UP2026PTC2000${String(i).padStart(2, '0')}`;
const SHARED = [...SHARED_MAIL_DOMAINS];
const now = new Date('2026-10-26T06:00:00Z');
const log = { error() {} };

const attr = (value, source = 'mca_monthly', extra = {}) => ({ value, source, seen_at: now, ...extra });
const company = (id, name, extra = {}) => ({
  _id: id, kind: 'company', state: 'UP', name, ids: { cin: id, uplc: [] }, cohort: '2026-09', sources: ['mca_monthly'],
  first_seen_at: now, updated_at: now, schema_version: 2, former_names: [],
  attrs: { incorporation_date: attr('2026-09-10'), registered_email: attr('rahul.k@gmail.com', 'infyner'), ...extra },
});
const lead = (id, extra) => ({ company_id: id, stage: 'shortlisted', holdout: false, eligible: true, cohort: '2026-09',
  shortlist: { month: '2026-10', rank: 1 }, score: { fit: 66, components: [{ key: 'recency', points: 20, reason: 'new' }], version: 'fit-v1', theme: { name: 'SaaS, IT & Cloud' } },
  needs: { deadlines: [], schemes: [], rules_confirmed: false, verdicts_by: 'provisional_rules', rules_version: 't' },
  created_at: now, updated_at: now, ...extra });

/** A Startup in UP record as the current version of its key, with the team it publishes. */
async function portalStartup(uplc, team) {
  const hash = uplc.slice(-1).repeat(64).replace(/[^0-9a-f]/g, 'a');
  await db.collection('source_records').insertOne({ source: 'startinup', natural_key: uplc, content_hash: hash,
    payload: { uplc, legal_name: 'Some Startup Private Limited', entity_type: 'Private Limited', team },
    legal_basis: 'published_by_company', personal_fields: ['team'], fetched_at: now, run_id: 'r', schema_version: 2 });
  await db.collection('source_state').insertOne({ _id: `startinup|${uplc}`, source: 'startinup', natural_key: uplc,
    content_hash: hash, first_seen_at: now, last_seen_at: now, last_changed_at: now, versions: 1 });
}

before(async () => {
  mongo = await startMongo();
  ({ client, db } = await freshDb(mongo.uri));
  for (const role of ['viewer', 'reviewer', 'admin']) {
    const u = newUser(`${role}@solutionai.in`, role);
    tokens[role] = u.token;
    entries.push(u.entry);
  }
  await db.collection('companies').insertMany([
    company(CIN, 'VEZRAS TECHNOLOGIES PRIVATE LIMITED', { district: attr('Lucknow', 'startinup') }),
    company(EVIL, '<script>alert(1)</script> PRIVATE LIMITED'),
    company(TEAM, 'TEAMED UP PRIVATE LIMITED'),
    company(PERSON_AT_COMPANY, 'ACME ONE PRIVATE LIMITED', { registered_email: attr('rahul.verma@acme.in', 'infyner') }),
    company(ROLE_ADDRESS, 'ACME TWO PRIVATE LIMITED', { registered_email: attr('info@acme.in', 'infyner') }),
    company(FLAGGED, 'ACME THREE PRIVATE LIMITED', { registered_email: attr('accounts@acme.in', 'infyner', { personal: true }) }),
    company(FLAGGED_NOT, 'ACME FOUR PRIVATE LIMITED', { registered_email: attr('rahul.verma@acme.in', 'infyner', { personal: false }) }),
    company(LINKS, 'LINKS PRIVATE LIMITED'),
    ...SHARED.map((d, i) => company(sharedCin(i), `SHARED ${i} PRIVATE LIMITED`, { registered_email: attr(`info@${d}`, 'infyner') })),
  ]);
  await db.collection('companies').updateOne({ _id: CIN }, { $set: { 'ids.uplc': ['UPLC_00000001'] } });
  await db.collection('companies').updateOne({ _id: TEAM }, { $set: { 'ids.uplc': ['UPLC_00000010'] } });
  await db.collection('leads').insertMany([
    lead(CIN, { shortlist: { month: '2026-10', rank: 1, fit: 61, as_of: new Date('2026-10-01T00:00:00Z') } }),
    lead(EVIL, { holdout: true, stage: 'discovered', shortlist: { month: '2026-10', rank: 2 } }),
    lead(LINKS, { stage: 'discovered', shortlist: null, needs: { rules_confirmed: false, verdicts_by: 'provisional_rules', rules_version: 't',
      deadlines: [{ title: 'Bad', source_url: 'javascript:alert(1)', law: 'Bad law' }, { title: 'Good', source_url: 'https://www.mca.gov.in/x', law: 'Companies Act' }],
      schemes: [{ name: 'Tricky', source_url: 'java\tscript:alert(2)', apply_url: 'data:text/html,<b>x</b>', verdict: 'eligible' },
        { name: 'Fine', source_url: 'http://startinup.up.gov.in/', apply_url: 'https://startinup.up.gov.in/apply', verdict: 'eligible' }] } }),
  ]);
  await db.collection('people').insertOne({ din: '01234567', name: 'Asha Verma', company_ids: [CIN], contacts: [], created_at: now, updated_at: now });
  await db.collection('entity_links').insertOne({ _id: 'startup:UPLC_00000009', entity_type: 'startup', entity_key: 'UPLC_00000009',
    status: 'review', model_version: 't', updated_at: now, probability: 0.9, evidence: { why_review: 'no year to confirm the name' },
    candidates: [{ company_id: CIN, name: 'VEZRAS TECHNOLOGIES PRIVATE LIMITED', probability: 0.9, method: 'splink' }] });
  await portalStartup('UPLC_00000009', [{ name: 'Priya Sharma', role: 'Founder' }, { name: 'Kabir Rao', role: 'CTO' }]);
  await portalStartup('UPLC_00000010', [{ name: 'Meera Iyer', role: 'Founder' }]);
  const auth = new Auth({ users: parseUsers(entries.join(';')), secret: SECRET, clock: () => now });
  server = createAdminServer({ db, auth, clock: () => now, log, loginLimit: 5 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await client.close();
  await mongo.stop();
});

const get = (path, headers = {}, at = base) => fetch(at + path, { headers, redirect: 'manual' });
const bearer = (role) => ({ Authorization: `Bearer ${tokens[role]}` });
const postForm = (path, form, headers = {}, at = base) => fetch(at + path, {
  method: 'POST', redirect: 'manual', body: new URLSearchParams(form).toString(),
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
});
const postJson = (path, body, headers = {}, at = base) => fetch(at + path, {
  method: 'POST', redirect: 'manual', body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { 'Content-Type': 'application/json', ...headers },
});
async function signIn(role, headers = {}, at = base) {
  const r = await postForm('/admin/login', { token: tokens[role] }, headers, at);
  assert.equal(r.status, 303);
  return r.headers.get('set-cookie').split(';')[0];
}
async function csrfFor(cookie, at = base) {
  const page = await (await get('/admin/review', { Cookie: cookie }, at)).text();
  return /name="csrf" value="([^"]+)"/.exec(page)[1];
}
const count = (filter) => db.collection('audit_log').countDocuments(filter);

describe('admin pages', () => {
  test('everything needs a sign-in', async () => {
    assert.equal((await get('/admin')).status, 303);
    assert.equal((await get('/api/pipeline')).status, 401);
    assert.equal((await get('/healthz')).status, 200);
  });

  test('pipeline page and API, with security headers', async () => {
    const cookie = await signIn('viewer');
    const page = await get('/admin?month=2026-10', { Cookie: cookie });
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(page.headers.get('strict-transport-security'), null, 'no HSTS when not served over HTTPS');
    const text = await page.text();
    assert.match(text, /Shortlist for 2026-10/);
    assert.match(text, /Rules awaiting a CA's confirmation/);
    const api = await (await get('/api/pipeline?month=2026-10', bearer('viewer'))).json();
    assert.equal(api.funnel.shortlisted, 1);
    assert.equal(api.holdout, 1);
    assert.equal(api.shortlist.length, 2);
  });

  test('shortlist rows carry the fit at ranking time and when the month was ranked', async () => {
    const api = await (await get('/api/pipeline?month=2026-10', bearer('viewer'))).json();
    const [first, second] = api.shortlist;
    assert.equal(first.company_id, CIN);
    assert.equal(first.fit_at_rank, 61);
    assert.equal(first.ranked_at, '2026-10-01T00:00:00.000Z');
    assert.equal(first.fit, 66, 'the current fit is still there beside it');
    assert.equal(second.fit_at_rank, null);
    assert.equal(second.ranked_at, null);
  });

  test('data from outside is escaped, never executed', async () => {
    const text = await (await get(`/admin/companies/${EVIL}`, bearer('viewer'))).text();
    assert.ok(!text.includes('<script>alert(1)</script>'));
    assert.match(text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  test('personal data is masked, admin-only to reveal, and every reveal is logged', async () => {
    const masked = await (await get(`/api/companies/${CIN}`, bearer('admin'))).json();
    assert.equal(masked.directors[0].name, '1 director(s), hidden');
    assert.equal(masked.company.attrs.registered_email.value, 'r•••@gmail.com');
    assert.equal(await count({ action: 'view_personal' }), 0);
    assert.equal((await get(`/api/companies/${CIN}?personal=1`, bearer('reviewer'))).status, 403);
    const shown = await (await get(`/api/companies/${CIN}?personal=1`, bearer('admin'))).json();
    assert.equal(shown.directors[0].name, 'Asha Verma');
    const row = await db.collection('audit_log').findOne({ action: 'view_personal' });
    assert.equal(row.actor, 'admin@solutionai.in');
    assert.deepEqual(row.fields, ['directors', 'registered_email']);
  });

  test('the review queue gives the number of team members, never their names', async () => {
    const reveals = await count({ action: 'view_personal' });
    for (const role of ['viewer', 'reviewer', 'admin']) {
      const text = await (await get('/api/review', bearer(role))).text();
      assert.ok(!text.includes('Priya Sharma') && !text.includes('Kabir Rao'), `no team names for ${role}`);
      const item = JSON.parse(text).items.find((i) => i.entity_key === 'UPLC_00000009');
      assert.equal(item.startup.team_count, 2);
      assert.equal(item.startup.team, undefined);
    }
    const page = await (await get('/admin/review', bearer('admin'))).text();
    assert.ok(!page.includes('Priya Sharma'));
    assert.equal(await count({ action: 'view_personal' }), reveals, 'nothing personal shown, so nothing to log');
  });

  test("a company's portal team is hidden unless an admin reveals it, and the reveal is logged", async () => {
    const masked = await (await get(`/api/companies/${TEAM}`, bearer('viewer'))).json();
    assert.ok(!JSON.stringify(masked).includes('Meera Iyer'));
    assert.equal(masked.startups[0].team_count, 1);
    assert.ok(masked.personal_fields.includes('portal_team'));
    assert.ok(!(await (await get(`/admin/companies/${TEAM}`, bearer('viewer'))).text()).includes('Meera Iyer'));
    const shown = await (await get(`/api/companies/${TEAM}?personal=1`, bearer('admin'))).json();
    assert.equal(shown.startups[0].team[0].name, 'Meera Iyer');
    const rows = await db.collection('audit_log').find({ action: 'view_personal', 'target.id': TEAM }).toArray();
    assert.equal(rows.length, 1);
    assert.ok(rows[0].fields.includes('portal_team'));
  });

  test("every personal registered email is masked and listed; a role address at the company's domain is not", async () => {
    for (const d of SHARED) assert.ok(registeredEmailIsPersonal({ value: `info@${d}` }), `info@${d} is a person's`);
    for (const [i, d] of SHARED.entries()) {
      const v = await (await get(`/api/companies/${sharedCin(i)}`, bearer('viewer'))).json();
      assert.equal(v.company.attrs.registered_email.value, `i•••@${d}`);
      assert.ok(v.personal_fields.includes('registered_email'), d);
    }
    const person = await (await get(`/api/companies/${PERSON_AT_COMPANY}`, bearer('viewer'))).json();
    assert.equal(person.company.attrs.registered_email.value, 'r•••@acme.in');
    assert.ok(person.personal_fields.includes('registered_email'));
    assert.ok(!(await (await get(`/admin/companies/${PERSON_AT_COMPANY}`, bearer('viewer'))).text()).includes('rahul.verma'));
    const role = await (await get(`/api/companies/${ROLE_ADDRESS}`, bearer('viewer'))).json();
    assert.equal(role.company.attrs.registered_email.value, 'info@acme.in');
    assert.ok(!role.personal_fields.includes('registered_email'));
    const flagged = await (await get(`/api/companies/${FLAGGED}`, bearer('viewer'))).json();
    assert.equal(flagged.company.attrs.registered_email.value, 'a•••@acme.in', "a personal flag from the data side masks it");
    const flaggedNot = await (await get(`/api/companies/${FLAGGED_NOT}`, bearer('viewer'))).json();
    assert.equal(flaggedNot.company.attrs.registered_email.value, 'r•••@acme.in',
      'a stale "not personal" flag never unmasks an address the rule calls personal');
  });

  test('link targets from rules data are http(s) or nothing', async () => {
    for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,x', '//evil.example/x', 'https:///x', null, 7]) {
      assert.equal(safeHref(bad), null, String(bad));
    }
    assert.equal(safeHref('https://www.mca.gov.in/x'), 'https://www.mca.gov.in/x');
    assert.equal(safeHref('http://startinup.up.gov.in/'), 'http://startinup.up.gov.in/');
    const v = await (await get(`/api/companies/${LINKS}`, bearer('viewer'))).json();
    const [bad, good] = v.lead.needs.deadlines;
    assert.equal(bad.source_url, null);
    assert.equal(good.source_url, 'https://www.mca.gov.in/x');
    const [tricky, fine] = v.lead.needs.schemes;
    assert.equal(tricky.source_url, null);
    assert.equal(tricky.apply_url, null);
    assert.equal(fine.apply_url, 'https://startinup.up.gov.in/apply');
    const page = await (await get(`/admin/companies/${LINKS}`, bearer('viewer'))).text();
    assert.ok(!/javascript:|java\tscript:|data:text/i.test(page));
  });

  test('only reviewers decide matches, only on proposed pairs, and every decision is logged', async () => {
    const body = JSON.stringify({ entity: 'UPLC_00000009', company: CIN, decision: 'same' });
    const json = { 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${base}/api/review`, { method: 'POST', body, headers: { ...json, ...bearer('viewer') } })).status, 403);
    const ok = await fetch(`${base}/api/review`, { method: 'POST', body, headers: { ...json, ...bearer('reviewer') } });
    assert.equal(ok.status, 200);
    const review = await db.collection('match_reviews').findOne({ _id: `startup:UPLC_00000009|${CIN}` });
    assert.equal(review.decision, 'same');
    assert.equal(review.decided_by, 'reviewer@solutionai.in');
    assert.equal(await count({ action: 'review_decision' }), 1);
    const bad = JSON.stringify({ entity: 'UPLC_00000009', company: EVIL, decision: 'same' });
    assert.equal((await fetch(`${base}/api/review`, { method: 'POST', body: bad, headers: { ...json, ...bearer('reviewer') } })).status, 400);
  });

  test('a review decision that cannot be logged is not saved', async () => {
    const auditDown = { collection: (n) => (n === 'audit_log' ? { insertOne: async () => { throw new Error('audit_log unavailable'); } } : db.collection(n)) };
    await assert.rejects(recordReview(auditDown, { entityKey: 'UPLC_00000009', companyId: CIN, decision: 'different', note: null,
      user: { email: 'reviewer@solutionai.in', role: 'reviewer' }, clock: () => now }), /audit_log unavailable/);
    const review = await db.collection('match_reviews').findOne({ _id: `startup:UPLC_00000009|${CIN}` });
    assert.equal(review.decision, 'same', 'the earlier decision stands');
  });

  test('forms need the CSRF token and the same origin', async () => {
    const cookie = await signIn('reviewer');
    const form = { entity: 'UPLC_00000009', company: CIN, decision: 'unsure' };
    assert.equal((await postForm('/admin/review', form, { Cookie: cookie })).status, 403, 'no token');
    const csrf = await csrfFor(cookie);
    assert.equal((await postForm('/admin/review', { ...form, csrf }, { Cookie: cookie, Origin: 'http://evil.example' })).status, 403);
    const r = await postForm('/admin/review', { ...form, csrf }, { Cookie: cookie });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/admin/review?saved=1');
  });

  test('malformed requests get a 4xx, never a 500', async () => {
    assert.equal((await get('/admin/companies/%E0%A4%A', bearer('viewer'))).status, 404);
    assert.equal((await get('/api/companies/%ZZ', bearer('viewer'))).status, 404);
    const cookie = await signIn('reviewer');
    const decision = { entity: 'UPLC_00000009', company: CIN, decision: 'unsure' };
    assert.equal((await postJson('/admin/review', { ...decision, csrf: {} }, { Cookie: cookie })).status, 403, 'an object is not a CSRF token');
    assert.equal((await postJson('/admin/review', { ...decision, csrf: [await csrfFor(cookie)] }, { Cookie: cookie })).status, 403, 'nor is an array');
    assert.equal((await postJson('/api/review', '[1]', bearer('reviewer'))).status, 400);
    assert.equal((await postJson('/api/review', 'null', bearer('reviewer'))).status, 400);
    const big = await postJson('/api/review', { ...decision, note: 'n'.repeat(200 * 1024) }, bearer('reviewer'));
    assert.equal(big.status, 413);
    assert.equal(await big.text(), 'body too large');
  });

  test('sign-ins and sign-outs are logged; tokens never are', async () => {
    const cookie = await signIn('admin');
    const signedIn = await db.collection('audit_log').findOne({ action: 'sign_in', actor: 'admin@solutionai.in' });
    assert.equal(signedIn.role, 'admin');
    assert.equal(signedIn.detail.via, 'form');
    const out = await postForm('/admin/logout', { csrf: await csrfFor(cookie) }, { Cookie: cookie });
    assert.equal(out.status, 303);
    assert.match(out.headers.get('set-cookie'), /le_session=;.*Max-Age=0/);
    assert.equal(await count({ action: 'sign_out', actor: 'admin@solutionai.in' }), 1);
    const all = JSON.stringify(await db.collection('audit_log').find({}).toArray());
    for (const t of Object.values(tokens)) assert.ok(!all.includes(t), 'no token in audit_log');
  });

  test('wrong tokens are refused, logged and rate-limited', async () => {
    for (let i = 0; i < 5; i += 1) assert.equal((await postForm('/admin/login', { token: 'nope' })).status, 401);
    assert.equal((await postForm('/admin/login', { token: 'nope' })).status, 429);
    assert.ok(await count({ action: 'denied' }) >= 5);
    const row = await db.collection('audit_log').findOne({ action: 'denied' });
    assert.ok(!JSON.stringify(row).includes('nope'), 'the token itself is never logged');
  });
});

describe('sessions and throttling', () => {
  // Real time here: revoked sessions are deleted by a TTL index on the database's own clock.
  let clockMs = Date.now();
  const clock = () => new Date(clockMs);
  const servers = {};

  before(async () => {
    const users = parseUsers(entries.join(';'));
    const make = async (name, { secureCookies = false, trustProxy = false } = {}) => {
      const auth = new Auth({ users, secret: SECRET, clock, secureCookies });
      const s = createAdminServer({ db, auth, clock, log, loginLimit: 3, trustProxy });
      await new Promise((r) => s.listen(0, '127.0.0.1', r));
      servers[name] = { server: s, base: `http://127.0.0.1:${s.address().port}` };
    };
    await make('trusted', { trustProxy: true });
    await make('direct');
    await make('https', { secureCookies: true });
  });
  after(async () => {
    for (const { server: s } of Object.values(servers)) await new Promise((r) => s.close(r));
  });

  test('signing out ends the session for good, even for a copy of the cookie', async () => {
    const at = servers.trusted.base;
    const cookie = await signIn('viewer', {}, at);
    assert.equal((await get('/admin', { Cookie: cookie }, at)).status, 200);
    assert.equal((await postForm('/admin/logout', { csrf: await csrfFor(cookie, at) }, { Cookie: cookie }, at)).status, 303);
    const again = await get('/admin', { Cookie: cookie }, at);
    assert.equal(again.status, 303);
    assert.equal(again.headers.get('location'), '/admin/login');
    const [revoked] = await db.collection('revoked_sessions').find({ email: 'viewer@solutionai.in' }).toArray();
    assert.ok(!cookie.includes(revoked._id), 'stored as a hash, not the cookie');
    const hours = (revoked.expires_at - clock()) / 3_600_000;
    assert.ok(hours > 11.9 && hours <= 12, 'kept only as long as the cookie could live');
  });

  test('a new token or a raised epoch ends existing sessions', () => {
    const users = parseUsers(entries.join(';'));
    const viewer = users.find((u) => u.role === 'viewer');
    const auth = new Auth({ users, secret: SECRET });
    const cookie = auth.sessionCookie(viewer).split(';')[0];
    const req = { headers: { cookie } };
    assert.equal(auth.user(req).email, 'viewer@solutionai.in');
    const swap = (change) => new Auth({ users: users.map((u) => (u === viewer ? { ...u, ...change } : u)), secret: SECRET });
    assert.equal(swap({ hash: 'f'.repeat(64) }).user(req), null, 'a rotated token');
    assert.equal(swap({ epoch: 1 }).user(req), null, 'a raised epoch');
    assert.equal(swap({ role: 'admin' }).user(req), null, 'a changed role');
    assert.equal(parseUsers(`${viewer.email},viewer,${viewer.hash},3`)[0].epoch, 3);
    assert.throws(() => parseUsers(`${viewer.email},viewer,${viewer.hash},soon`), /epoch/);
    assert.equal(parseUsers(`Kavita.Admin@SolutionAI.in,admin,${viewer.hash}`)[0].email, 'kavita.admin@solutionai.in', 'one person, one email, whatever the capitals');
    const body = Buffer.from(cookie.slice('le_session='.length).split('.')[0], 'base64url').toString();
    assert.ok(!body.includes(viewer.hash.slice(0, 12)), 'the cookie carries no part of the token hash');
  });

  test('a valid token signs in even while its address is locked out', async () => {
    const at = servers.trusted.base;
    const from = { 'X-Forwarded-For': '203.0.113.7' };
    for (let i = 0; i < 3; i += 1) assert.equal((await postForm('/admin/login', { token: 'nope' }, from, at)).status, 401);
    assert.equal((await postForm('/admin/login', { token: 'nope' }, from, at)).status, 429);
    assert.equal((await postForm('/admin/login', { token: tokens.admin }, from, at)).status, 303);
  });

  test('wrong bearer tokens are logged and throttled; a valid one still works', async () => {
    const at = servers.trusted.base;
    const from = { 'X-Forwarded-For': '203.0.113.8' };
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await get('/api/pipeline', { ...from, Authorization: `Bearer guess${i}` }, at)).status, 401);
    }
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await get('/api/pipeline', { ...from, Authorization: `Bearer guess-more${i}` }, at)).status, 429);
    }
    const rows = await db.collection('audit_log').find({ action: 'denied', 'detail.address': '203.0.113.8' }).toArray();
    assert.equal(rows.length, 3, 'logged up to the limit, then counted without a row each');
    assert.ok(rows.every((r) => r.detail.via === 'token' && !JSON.stringify(r).includes('guess')));
    assert.equal((await get('/api/pipeline', { ...from, ...bearer('viewer') }, at)).status, 200);
  });

  test('the client address comes from X-Forwarded-For only behind a trusted proxy', async () => {
    const trusted = servers.trusted.base;
    for (let i = 0; i < 3; i += 1) await postForm('/admin/login', { token: 'nope' }, { 'X-Forwarded-For': '198.51.100.1' }, trusted);
    assert.equal((await postForm('/admin/login', { token: 'nope' }, { 'X-Forwarded-For': '198.51.100.1' }, trusted)).status, 429);
    assert.equal((await postForm('/admin/login', { token: 'nope' }, { 'X-Forwarded-For': '10.0.0.9, 198.51.100.2' }, trusted)).status, 401,
      'another client behind the proxy is not locked out');
    const direct = servers.direct.base;
    for (const fake of ['192.0.2.1', '192.0.2.2', '192.0.2.3']) {
      assert.equal((await postForm('/admin/login', { token: 'nope' }, { 'X-Forwarded-For': fake }, direct)).status, 401);
    }
    assert.equal((await postForm('/admin/login', { token: 'nope' }, { 'X-Forwarded-For': '192.0.2.4' }, direct)).status, 429,
      'without a trusted proxy a forged header does not reset the count');
  });

  test('failure counts are forgotten after a minute', async () => {
    const { server: s, base: at } = servers.trusted;
    assert.ok(s.failures.size >= 3);
    clockMs += 61_000;
    assert.equal((await postForm('/admin/login', { token: 'nope' }, { 'X-Forwarded-For': '198.51.100.1' }, at)).status, 401, 'unlocked');
    assert.equal(s.failures.size, 1);
  });

  test('HSTS and Secure cookies only when served over HTTPS', async () => {
    const https = await get('/healthz', {}, servers.https.base);
    assert.match(https.headers.get('strict-transport-security'), /max-age=\d+/);
    const r = await postForm('/admin/login', { token: tokens.viewer }, {}, servers.https.base);
    assert.match(r.headers.get('set-cookie'), /; Secure/);
    assert.equal((await get('/healthz', {}, servers.direct.base)).headers.get('strict-transport-security'), null);
  });
});

describe('signing in through the platform', () => {
  const PSECRET = 'p'.repeat(40);
  const pnow = new Date('2026-11-13T06:00:00Z');
  const clock = () => pnow;
  const PORTAL = 'https://admin.solutionai.in';
  const svc = newServiceToken('portal', 'reviewer');
  let s;
  let at;
  const ph = (user, role, method, target, extra = {}, body = '') => ({ ...platformHeaders(PSECRET, { user, role, method, target, at: pnow, body }), ...extra });
  const from = (ip) => ({ 'X-Forwarded-For': ip });

  before(async () => {
    const auth = new Auth({ users: parseUsers(entries.join(';')), secret: SECRET, clock, platformSecret: PSECRET, serviceTokens: parseServiceTokens(svc.entry) });
    assert.deepEqual(auth.modes, ['personal tokens', 'platform proxy', 'service tokens']);
    s = createAdminServer({ db, auth, clock, log, loginLimit: 3, trustProxy: true, allowedOrigins: [PORTAL], signoutUrl: `${PORTAL}/logout` });
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    at = `http://127.0.0.1:${s.address().port}`;
    await db.collection('entity_links').insertOne({ _id: 'startup:UPLC_00000077', entity_type: 'startup', entity_key: 'UPLC_00000077',
      status: 'review', model_version: 't', updated_at: now, probability: 0.8, evidence: { why_review: 'test' },
      candidates: [{ company_id: CIN, name: 'VEZRAS TECHNOLOGIES PRIVATE LIMITED', probability: 0.8, method: 'splink' }] });
  });
  after(async () => new Promise((r) => s.close(r)));

  test("the proxy's signed headers open the pages and the API; the first request is logged as a sign-in", async () => {
    const who = 'meera@solutionai.in';
    assert.equal((await get('/api/pipeline', ph(who, 'viewer', 'GET', '/api/pipeline'), at)).status, 200);
    assert.equal((await get('/admin', ph(who, 'viewer', 'GET', '/admin'), at)).status, 200);
    const rows = await db.collection('audit_log').find({ action: 'sign_in', actor: who }).toArray();
    assert.equal(rows.length, 1, 'one sign-in, not one per request');
    assert.equal(rows[0].detail.via, 'platform');
    assert.equal(rows[0].role, 'viewer');
  });

  test('a platform signature is good for one request, for two minutes, with our secret only', async () => {
    const who = 'kabir@solutionai.in';
    const refusedWith = async (path, headers, method = 'GET', ip = '198.51.100.40') => {
      const r = await fetch(at + path, { method, headers: { ...from(ip), ...headers } });
      return [r.status, (await r.json()).error];
    };
    assert.deepEqual(await refusedWith('/api/companies', ph(who, 'admin', 'GET', '/api/pipeline')), [401, 'bad platform signature'], 'another path');
    assert.deepEqual(await refusedWith(`/api/companies/${CIN}?personal=1`, ph(who, 'admin', 'GET', `/api/companies/${CIN}`)), [401, 'bad platform signature'], 'another query');
    assert.deepEqual(await refusedWith('/api/pipeline', ph(who, 'admin', 'GET', '/api/pipeline'), 'POST', '198.51.100.41'), [401, 'bad platform signature'], 'another method');
    assert.deepEqual(await refusedWith('/api/pipeline', { ...ph(who, 'viewer', 'GET', '/api/pipeline'), 'X-Platform-Role': 'admin' }, 'GET', '198.51.100.41'),
      [401, 'bad platform signature'], 'a raised role');
    const forged = platformHeaders('q'.repeat(40), { user: who, role: 'admin', target: '/api/pipeline', at: pnow });
    assert.deepEqual(await refusedWith('/api/pipeline', forged, 'GET', '198.51.100.42'), [401, 'bad platform signature'], 'another secret');
    const old = platformHeaders(PSECRET, { user: who, role: 'viewer', target: '/api/pipeline', at: new Date(pnow.getTime() - 3 * 60_000) });
    assert.match((await refusedWith('/api/pipeline', old, 'GET', '198.51.100.42'))[1], /too old/);
    const rows = await db.collection('audit_log').find({ action: 'denied', 'detail.via': 'platform' }).toArray();
    assert.ok(rows.length >= 6 && rows.every((r) => /^platform sign-in refused/.test(r.detail.reason)));
    assert.equal((await refusedWith('/api/pipeline', forged))[0], 401, 'the third failure from this address');
    assert.equal((await refusedWith('/api/pipeline', forged))[0], 429, 'throttled per address like wrong tokens');
    assert.equal(await count({ action: 'sign_in', actor: who }), 0);
    // a server that is not set up for the platform refuses the headers outright
    const lower = (h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
    const plain = new Auth({ users: [], secret: SECRET, clock });
    assert.match(plain.identify({ method: 'GET', url: '/api/pipeline', headers: lower(ph(who, 'viewer', 'GET', '/api/pipeline')) }).refused, /PLATFORM_SSO_SECRET/);
  });

  test('the role from the platform decides what the person may see, and reveals are logged against them', async () => {
    const target = `/api/companies/${CIN}?personal=1`;
    assert.equal((await get(target, ph('asha@solutionai.in', 'reviewer', 'GET', target), at)).status, 403);
    assert.equal((await get(target, ph('gourav@solutionai.in', 'admin', 'GET', target), at)).status, 200);
    const reveal = await db.collection('audit_log').findOne({ action: 'view_personal', actor: 'gourav@solutionai.in' });
    assert.equal(reveal.role, 'admin');
  });

  test("forms through the proxy carry the CSRF token, accept the portal's origin, and sign-out returns to the platform", async () => {
    const who = 'priya@solutionai.in';
    const page = await (await get('/admin/review', ph(who, 'reviewer', 'GET', '/admin/review'), at)).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)[1];
    const out = (form, origin) => postForm('/admin/logout', form, ph(who, 'reviewer', 'POST', '/admin/logout', origin ? { Origin: origin } : {}, new URLSearchParams(form).toString()), at);
    // headers captured from one post cannot carry another body
    const swapped = await postForm('/admin/logout', { csrf, extra: 'x' }, ph(who, 'reviewer', 'POST', '/admin/logout', { Origin: PORTAL }, new URLSearchParams({ csrf }).toString()), at);
    assert.equal(swapped.status, 401);
    assert.match(await swapped.text(), /does not match the platform signature/);
    assert.equal((await out({})).status, 403, 'no CSRF token');
    assert.equal((await out({ csrf }, 'https://evil.example')).status, 403, 'another site');
    const r = await out({ csrf }, PORTAL);
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), `${PORTAL}/logout`);
    assert.equal(await count({ action: 'sign_out', actor: who, 'detail.via': 'platform' }), 1);
  });

  test('a service token acts for a named person, never above its own role', async () => {
    const auth = { Authorization: `Bearer ${svc.token}` };
    const r0 = await get('/api/pipeline', auth, at);
    assert.equal(r0.status, 400);
    assert.match((await r0.json()).error, /X-Acting-User/);
    assert.equal(await count({ action: 'denied', 'detail.reason': /X-Acting-User/ }), 0, 'a set-up mistake, not an attack');
    assert.equal((await get('/api/pipeline', { ...auth, 'X-Acting-User': 'Rahul@SolutionAI.in' }, at)).status, 200);
    const tooHigh = await get(`/api/companies/${CIN}?personal=1`, { ...auth, 'X-Acting-User': 'rahul@solutionai.in', 'X-Acting-Role': 'admin' }, at);
    assert.equal(tooHigh.status, 403);
    assert.match((await tooHigh.json()).error, /allows at most reviewer/);
    const decided = await postJson('/api/review', { entity: 'UPLC_00000077', company: CIN, decision: 'different' },
      { ...auth, 'X-Acting-User': 'rahul@solutionai.in', 'X-Acting-Role': 'reviewer' }, at);
    assert.equal(decided.status, 200);
    assert.equal((await db.collection('match_reviews').findOne({ _id: `startup:UPLC_00000077|${CIN}` })).decided_by, 'rahul@solutionai.in');
    const signIns = await db.collection('audit_log').find({ action: 'sign_in', actor: 'rahul@solutionai.in' }).toArray();
    assert.deepEqual(signIns.map((x) => [x.role, x.detail.via, x.detail.service]), [['viewer', 'service', 'portal'], ['reviewer', 'service', 'portal']]);
    const mcp = await postJson('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { ...auth, 'X-Acting-User': 'rahul@solutionai.in' }, at);
    assert.equal(mcp.status, 200);
    assert.equal((await get('/api/pipeline', { Authorization: 'Bearer svc_guess', 'X-Acting-User': 'rahul@solutionai.in' }, at)).status, 401);
  });

  test('service token entries are checked when the server starts', () => {
    assert.throws(() => parseServiceTokens('Portal,admin,abc'), /name,max-role,sha256/);
    assert.throws(() => parseServiceTokens(`portal,owner,${'a'.repeat(64)}`), /name,max-role,sha256/);
    assert.deepEqual(parseServiceTokens(`portal,viewer,${'a'.repeat(64)}`), [{ name: 'portal', role: 'viewer', hash: 'a'.repeat(64) }]);
    assert.throws(() => new Auth({ users: [], secret: SECRET, platformSecret: 'short' }), /PLATFORM_SSO_SECRET/);
    assert.match(svc.token, /^svc_/);
  });
});

describe('the MCA file upload', () => {
  let s;
  let at;
  let inbox;
  // a stand-in workbook: a ZIP signature and some bytes (whether it is MCA's report is the loader's question)
  const workbook = (seed) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(4096, seed)]);
  const upload = (cookie, csrf, file, name = 'Incorporation-Report-20261105.xlsx', extra = {}) => {
    const fd = new FormData();
    if (csrf) fd.append('csrf', csrf);
    fd.append('file', new Blob([file]), name);
    return fetch(`${at}/admin/mca`, { method: 'POST', body: fd, redirect: 'manual', headers: { Cookie: cookie, ...extra } });
  };

  before(async () => {
    inbox = mkdtempSync(path.join(os.tmpdir(), 'lead-engine-mca-inbox-'));
    // a clock of its own: with the suite's fixed clock a session cookie would be the very one signed out earlier
    const clock = () => new Date('2026-11-13T06:00:00Z');
    const auth = new Auth({ users: parseUsers(entries.join(';')), secret: SECRET, clock });
    s = createAdminServer({ db, auth, clock, log, loginLimit: 50, mcaInbox: inbox });
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    at = `http://127.0.0.1:${s.address().port}`;
  });
  after(async () => {
    await new Promise((r) => s.close(r));
    rmSync(inbox, { recursive: true, force: true });
  });

  test('an admin uploads the workbook; it waits in the inbox, logged, for the nightly run', async () => {
    const cookie = await signIn('admin', {}, at);
    const csrf = await csrfFor(cookie, at);
    const r = await upload(cookie, csrf, workbook(1));
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/admin/mca?saved=1');
    const files = readdirSync(inbox);
    assert.deepEqual(files, ['20261113-060000-Incorporation-Report-20261105.xlsx'], 'named by the time, nothing half-written left behind');
    assert.deepEqual(readFileSync(path.join(inbox, files[0])), workbook(1));
    const row = await db.collection('audit_log').findOne({ action: 'upload_mca_file' });
    assert.equal(row.actor, 'admin@solutionai.in');
    assert.equal(row.detail.size, 4100);
    assert.match(row.detail.sha256, /^[0-9a-f]{64}$/);
    const page = await (await get('/admin/mca?saved=1', { Cookie: cookie }, at)).text();
    assert.match(page, /Uploaded\. The nightly run at 05:00 IST loads it/);
    assert.match(page, /20261113-060000-Incorporation-Report-20261105\.xlsx/);
    assert.match(page, /uploaded by admin@solutionai\.in/);
    const api = await (await get('/api/mca', bearer('viewer'), at)).json();
    assert.equal(api.waiting.length, 1);
    assert.equal(api.inbox, undefined, 'the server path is not given out');
  });

  test('the same file twice is refused, whether it is waiting or already loaded', async () => {
    const cookie = await signIn('admin', {}, at);
    const csrf = await csrfFor(cookie, at);
    const waiting = await upload(cookie, csrf, workbook(1), 'copy.xlsx');
    assert.equal(waiting.status, 409);
    assert.match(await waiting.text(), /already waiting to be loaded/);
    // the nightly run loads it and files it away
    const [name] = readdirSync(inbox);
    rmSync(path.join(inbox, name));
    const { sha256 } = (await db.collection('audit_log').findOne({ action: 'upload_mca_file' })).detail;
    await db.collection('ingest_runs').insertOne({ _id: 'mca_monthly-test', source: 'mca_monthly', status: 'ok', params: { file: name, sha256, via: 'inbox' },
      stats: { companies_up: 1234 }, notes: [`${name}: period 2026-10`], started_at: now, finished_at: now });
    const loaded = await upload(cookie, csrf, workbook(1));
    assert.equal(loaded.status, 409);
    assert.match(await loaded.text(), /already loaded on 2026-10-26/);
    const page = await (await get('/admin/mca', { Cookie: cookie }, at)).text();
    assert.match(page, /2026-10<\/td>/);
    assert.match(page, /1,234/);
  });

  test('only admins upload, with the form token, and only workbooks', async () => {
    const admin = await signIn('admin', {}, at);
    const csrf = await csrfFor(admin, at);
    assert.equal((await upload(admin, null, workbook(2))).status, 403, 'no CSRF token');
    assert.equal((await upload(admin, csrf, workbook(2), 'report.xlsx', { Origin: 'https://evil.example' })).status, 403, 'another site');
    const notZip = await upload(admin, csrf, Buffer.alloc(4096, 7));
    assert.equal(notZip.status, 400);
    assert.match(await notZip.text(), /not an Excel workbook/);
    assert.equal((await upload(admin, csrf, workbook(2), 'report.csv')).status, 400);
    assert.equal((await upload(admin, csrf, Buffer.from([0x50, 0x4b, 0x03, 0x04]))).status, 400, 'empty');
    const reviewer = await signIn('reviewer', {}, at);
    assert.equal((await upload(reviewer, await csrfFor(reviewer, at), workbook(3))).status, 403);
    const big = await fetch(`${at}/admin/mca`, { method: 'POST', headers: { Cookie: admin, 'Content-Type': 'multipart/form-data; boundary=x', 'Content-Length': String(40 * 1024 * 1024) },
      body: 'x', duplex: 'half' }).catch(() => ({ status: 413 }));
    assert.equal(big.status, 413);
    assert.equal(readdirSync(inbox).length, 0, 'nothing kept');
    assert.equal((await get('/admin/mca', { Cookie: await signIn('viewer', {}, at) }, at)).status, 200, 'viewers see the page, without the form');
  });

  test('the API takes the raw workbook with an admin token, never with a browser session', async () => {
    const r = await fetch(`${at}/api/mca`, { method: 'POST', body: workbook(4), headers: { ...bearer('admin'), 'Content-Type': 'application/octet-stream', 'X-File-Name': '../../etc/Incorporation Report.xlsx' } });
    assert.equal(r.status, 201);
    const body = await r.json();
    assert.equal(body.file, '20261113-060000-Incorporation Report.xlsx', 'the path is dropped from the name');
    assert.ok(readdirSync(inbox).includes(body.file));
    assert.equal((await fetch(`${at}/api/mca`, { method: 'POST', body: workbook(5), headers: { ...bearer('reviewer'), 'X-File-Name': 'x.xlsx' } })).status, 403);
    const cookie = await signIn('admin', {}, at);
    assert.equal((await fetch(`${at}/api/mca`, { method: 'POST', body: workbook(5), headers: { Cookie: cookie, 'X-File-Name': 'x.xlsx' } })).status, 403);
  });

  test('multipart bodies are read exactly, binary and all', () => {
    const bin = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x0d, 0x0a, 0x2d, 0x2d, 0x00, 0xff]);
    const body = Buffer.concat([Buffer.from('--b0\r\nContent-Disposition: form-data; name="csrf"\r\n\r\nabc\r\n--b0\r\nContent-Disposition: form-data; name="file"; filename="C:\\Users\\x\\r.xlsx"\r\nContent-Type: application/octet-stream\r\n\r\n'),
      bin, Buffer.from('\r\n--b0--\r\n')]);
    const { fields, files } = parseMultipart(body, 'multipart/form-data; boundary=b0');
    assert.deepEqual(fields, { csrf: 'abc' });
    assert.equal(files[0].filename, 'r.xlsx');
    assert.deepEqual(files[0].data, bin);
    assert.throws(() => parseMultipart(body, 'application/json'), /multipart/);
  });
});

describe('bulk exports with a second admin', () => {
  let s;
  let at;
  let t = new Date('2026-11-14T06:00:00Z');
  const clock = () => t;
  const second = newUser('second.admin@solutionai.in', 'admin');
  const SUPPRESSED = 'U62099UP2026PTC300003';
  const FORMULA = 'U62099UP2026PTC300004';
  const suppression = { check: async ({ email }) => (email === 'hello@optedout.in' ? [{ reason: 'unsubscribe' }] : []) };
  const auth2 = (role) => ({ Authorization: `Bearer ${role === 'second' ? second.token : tokens[role]}` });

  before(async () => {
    const auth = new Auth({ users: parseUsers([...entries, second.entry].join(';')), secret: SECRET, clock });
    s = createAdminServer({ db, auth, clock, log, loginLimit: 50, outreach: { suppression } });
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    at = `http://127.0.0.1:${s.address().port}`;
    await db.collection('companies').insertMany([
      company(SUPPRESSED, 'OPTED OUT PRIVATE LIMITED', { registered_email: attr('hello@optedout.in', 'infyner') }),
      company(FORMULA, '=HYPERLINK("http://x.example","CLICK") PRIVATE LIMITED', { registered_email: attr('contact@formula.in', 'infyner') }),
    ]);
    const shortlisted = (id, rank) => lead(id, { cohort: '2026-10', shortlist: { month: '2026-11', rank } });
    await db.collection('leads').insertMany([shortlisted(ROLE_ADDRESS, 1), shortlisted(PERSON_AT_COMPANY, 2), shortlisted(SUPPRESSED, 3), shortlisted(FORMULA, 4),
      lead(TEAM, { cohort: '2026-10', holdout: true, shortlist: { month: '2026-11', rank: 5 } })]);
  });
  after(async () => new Promise((r) => s.close(r)));

  const ask = (role, body) => postJson('/api/exports', body, auth2(role), at);
  const decide = (role, id, decision) => postJson(`/api/exports/${id}`, { decision, note: 'ok for the call list' }, auth2(role), at);
  const download = (role, id) => get(`/api/exports/${id}/download`, auth2(role), at);

  test('a reviewer asks with a reason; the request is logged and waits for an admin', async () => {
    assert.equal((await ask('viewer', { reason: 'for the November call list', shortlist_month: '2026-11' })).status, 403);
    const short = await ask('reviewer', { reason: 'calls', shortlist_month: '2026-11' });
    assert.equal(short.status, 400);
    assert.match((await short.json()).error, /at least 10 characters/);
    assert.equal((await ask('reviewer', { reason: 'for the November call list', cohort: 'Oct 2026' })).status, 400);
    assert.equal((await ask('reviewer', { reason: 'for the November call list', max_rows: 50000 })).status, 400);
    const r = await ask('reviewer', { reason: 'for the November call list', shortlist_month: '2026-11', include_contacts: true });
    assert.equal(r.status, 201);
    const ex = await r.json();
    assert.match(ex._id, /^exp_[0-9a-z]{12}$/);
    assert.equal(ex.status, 'requested');
    assert.equal(ex.estimate, 4, 'the holdout company is never counted');
    const row = await db.collection('audit_log').findOne({ action: 'export_request', 'target.id': ex._id });
    assert.equal(row.actor, 'reviewer@solutionai.in');
    assert.deepEqual(row.fields, ['registered_email']);
    assert.equal((await download('reviewer', ex._id)).status, 409, 'not before approval');
  });

  test('nobody approves their own export; another admin does, and only the person who asked downloads it', async () => {
    const own = await (await ask('admin', { reason: 'admin wants a list for a review', stage: 'shortlisted' })).json();
    const self = await decide('admin', own._id, 'approve');
    assert.equal(self.status, 403);
    assert.match((await self.json()).error, /another admin must decide/);
    assert.equal((await decide('reviewer', own._id, 'approve')).status, 403, 'reviewers do not approve');
    assert.equal((await decide('second', own._id, 'reject')).status, 200);
    assert.equal((await decide('second', own._id, 'approve')).status, 409, 'decided once');
    // the same admin signing in another way (the platform lower-cases emails) is still the same person
    const { decideExport, requestExport } = await import('../src/admin/exports.js');
    const mine = await requestExport(db, { user: { email: 'admin@solutionai.in', role: 'admin', via: 'token' }, filters: { stage: 'shortlisted' }, reason: 'a list for a review', clock });
    await assert.rejects(decideExport(db, { id: mine._id, user: { email: 'ADMIN@SolutionAI.in', role: 'admin', via: 'platform' }, decision: 'approve', clock }), /another admin must decide/);
    await decideExport(db, { id: mine._id, user: { email: 'second.admin@solutionai.in', role: 'admin', via: 'token' }, decision: 'reject', clock });

    const ex = await db.collection('exports').findOne({ requested_by: 'reviewer@solutionai.in', status: 'requested' });
    const ok = await decide('admin', ex._id, 'approve');
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).download_until, '2026-11-15T06:00:00.000Z');
    assert.equal((await download('admin', ex._id)).status, 403, 'not the approver, nor anyone else');
    const r = await download('reviewer', ex._id);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/csv/);
    assert.match(r.headers.get('content-disposition'), new RegExp(`attachment; filename="solutionai-leads-${ex._id}\\.csv"`));
    const lines = (await r.text()).trim().split('\r\n');
    assert.equal(lines[0], '"cin","name","incorporated","company_type","district","sector","cohort","stage","fit","shortlist_month","shortlist_rank","eligible_schemes","next_deadline","next_deadline_due","registered_email"');
    assert.equal(lines.length, 5);
    const byCin = Object.fromEntries(lines.slice(1).map((l) => [l.slice(1, 22), l]));
    assert.deepEqual(Object.keys(byCin).sort(), [ROLE_ADDRESS, PERSON_AT_COMPANY, SUPPRESSED, FORMULA].sort());
    assert.ok(byCin[ROLE_ADDRESS].endsWith('"info@acme.in"'), 'a company address is included');
    assert.ok(byCin[PERSON_AT_COMPANY].endsWith(',""'), "a person's address never is");
    assert.ok(byCin[SUPPRESSED].endsWith(',""'), 'nor one that opted out');
    assert.match(byCin[FORMULA], /,"'=HYPERLINK\(""http:\/\/x\.example"",""CLICK""\) PRIVATE LIMITED",/, 'a formula is written as text');
    assert.ok(!lines.some((l) => l.includes(TEAM)), 'the holdout is never exported');
    const logged = await db.collection('audit_log').findOne({ action: 'export', 'target.id': ex._id });
    assert.equal(logged.actor, 'reviewer@solutionai.in');
    assert.equal(logged.detail.rows, 4);
    assert.equal(logged.detail.company_emails, 2);
    assert.equal(logged.detail.approved_by, 'admin@solutionai.in');
    assert.equal((await db.collection('exports').findOne({ _id: ex._id })).downloads.length, 1);
  });

  test('the download window closes after 24 hours, and an undecided request expires after a week', async () => {
    const ex = await db.collection('exports').findOne({ requested_by: 'reviewer@solutionai.in', status: 'approved' });
    t = new Date('2026-11-15T06:00:01Z');
    assert.equal((await download('reviewer', ex._id)).status, 410);
    const waiting = await (await ask('reviewer', { reason: 'a list nobody looks at in time' })).json();
    t = new Date('2026-11-23T06:00:01Z');
    const list = await (await get('/api/exports', auth2('viewer'), at)).json();
    assert.equal(list.items.find((x) => x._id === waiting._id).status, 'expired');
    assert.equal((await decide('second', waiting._id, 'approve')).status, 409);
  });

  test('the Exports page: the form for reviewers, the decision for other admins, the link for the person who asked', async () => {
    t = new Date('2026-11-24T06:00:00Z');
    const reviewerCookie = await signIn('reviewer', {}, at);
    const page = await (await get('/admin/exports', { Cookie: reviewerCookie }, at)).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)[1];
    assert.match(page, /Ask for approval/);
    const asked = await postForm('/admin/exports', { csrf, reason: 'districts in the east for the event', district: 'lucknow', max_rows: '' }, { Cookie: reviewerCookie }, at);
    assert.equal(asked.status, 303);
    assert.equal(asked.headers.get('location'), '/admin/exports?asked=1');
    const mine = await (await get('/admin/exports?asked=1', { Cookie: reviewerCookie }, at)).text();
    assert.match(mine, /another admin approves it/);
    assert.ok(!/value="approve"/.test(mine), 'a reviewer sees no approve button');
    const adminCookie = await signIn('admin', {}, at);
    const adminPage = await (await get('/admin/exports', { Cookie: adminCookie }, at)).text();
    const id = (await db.collection('exports').findOne({ reason: 'districts in the east for the event' }))._id;
    assert.match(adminPage, new RegExp(`action="/admin/exports/${id}"`));
    const aCsrf = /name="csrf" value="([^"]+)"/.exec(adminPage)[1];
    assert.equal((await postForm(`/admin/exports/${id}`, { csrf: aCsrf, decision: 'approve' }, { Cookie: adminCookie }, at)).status, 303);
    const after = await (await get('/admin/exports', { Cookie: reviewerCookie }, at)).text();
    assert.match(after, new RegExp(`href="/admin/exports/${id}/download"`));
    const csv = await (await get(`/admin/exports/${id}/download`, { Cookie: reviewerCookie }, at)).text();
    const rows = csv.trim().split('\r\n');
    assert.equal(rows.length, 2, 'the one company in Lucknow (the district matched without regard to case)');
    assert.ok(rows[1].startsWith(`"${CIN}"`));
    assert.equal((await postForm('/admin/exports', { reason: 'no form token at all here' }, { Cookie: reviewerCookie }, at)).status, 403);
  });
});

describe('labelling pairs to measure the matcher', () => {
  // UPLC_00000011 is in the held-out fold (sha1 % 5 == 0, as on the data side); UPLC_00000012 is not
  const HELD = 'UPLC_00000011';
  const TRAIN = 'UPLC_00000012';
  const json = { 'Content-Type': 'application/json' };
  const label = (role, body) => fetch(`${base}/api/labels`, { method: 'POST', body: JSON.stringify(body), headers: { ...json, ...bearer(role) } });

  before(async () => {
    const linked = (key, cid, method, candidates = []) => ({ _id: `startup:${key}`, entity_type: 'startup', entity_key: key, company_id: cid, status: 'linked',
      method, probability: method === 'splink' ? 0.97 : null, candidates, model_version: 't', updated_at: now,
      matcher: { status: 'linked', company_id: cid, method, probability: method === 'splink' ? 0.97 : null } });
    await db.collection('entity_links').insertMany([
      linked(TRAIN, ROLE_ADDRESS, 'exact_name', [{ company_id: FLAGGED, name: 'ACME THREE PRIVATE LIMITED', probability: 0.4, method: 'splink' }]),
      linked(HELD, PERSON_AT_COMPANY, 'splink'),
    ]);
  });

  test('the pairs it was sure about, held-out links first, then the near misses; never the review queue', async () => {
    const q = await (await get('/api/labels', bearer('viewer'))).json();
    assert.equal(q.links, 2);
    assert.equal(q.held_out_links, 1);
    assert.equal(q.near_misses, 1);
    assert.deepEqual(q.items.map((i) => [i.entity_key, i.company_id, i.kind, i.held_out]),
      [[HELD, PERSON_AT_COMPANY, 'link', true], [TRAIN, ROLE_ADDRESS, 'link', false], [TRAIN, FLAGGED, 'near_miss', false]]);
    assert.ok(!q.items.some((i) => i.entity_key === 'UPLC_00000009'), 'the unsure pairs stay on the review queue');
    assert.equal(q.precision.held_out.precision, null);
    const page = await (await get('/admin/labels', { Cookie: await signIn('viewer') })).text();
    assert.match(page, /Label pairs/);
    assert.ok(!/name="decision"/.test(page), 'a viewer sees no buttons');
  });

  test('a reviewer labels; the decision is logged and the precision moves', async () => {
    assert.equal((await label('viewer', { entity: HELD, company: PERSON_AT_COMPANY, decision: 'same' })).status, 403);
    assert.equal((await label('reviewer', { entity: HELD, company: CIN, decision: 'same' })).status, 400, 'not a pair the matcher proposed');
    assert.equal((await label('reviewer', { entity: HELD, company: PERSON_AT_COMPANY, decision: 'same' })).status, 200);
    assert.equal((await label('reviewer', { entity: TRAIN, company: ROLE_ADDRESS, decision: 'different', note: 'another Acme' })).status, 200);
    const q = await (await get('/api/labels', bearer('viewer'))).json();
    assert.equal(q.labelled, 2);
    assert.deepEqual([q.precision.held_out.judged, q.precision.held_out.precision], [1, 1]);
    assert.deepEqual([q.precision.all_links.judged, q.precision.all_links.precision], [2, 0.5]);
    assert.deepEqual(q.items.map((i) => i.kind), ['near_miss']);
    const review = await db.collection('match_reviews').findOne({ _id: `startup:${TRAIN}|${ROLE_ADDRESS}` });
    assert.deepEqual([review.decision, review.source, review.decided_by], ['different', 'admin', 'reviewer@solutionai.in']);
    const row = await db.collection('audit_log').findOne({ action: 'review_decision', 'target.id': HELD });
    assert.equal(row.detail.mode, 'label');
  });
});

describe('the audit log page', () => {
  test('admins only; filters by action, person and day; reading it is itself logged', async () => {
    assert.equal((await get('/api/audit', bearer('viewer'))).status, 403);
    assert.equal((await get('/api/audit', bearer('reviewer'))).status, 403);
    const all = await (await get('/api/audit', bearer('admin'))).json();
    assert.ok(all.total > 10, `${all.total} entries`);
    assert.ok(all.rows.every((r, i) => i === 0 || new Date(all.rows[i - 1].at) >= new Date(r.at)), 'newest first');
    const denied = await (await get('/api/audit?action=denied', bearer('admin'))).json();
    assert.ok(denied.total > 0 && denied.rows.every((r) => r.action === 'denied'));
    const mine = await (await get('/api/audit?actor=REVIEWER@', bearer('admin'))).json();
    assert.ok(mine.total > 0 && mine.rows.every((r) => r.actor.startsWith('reviewer@')), 'the person, whatever the case');
    const none = await (await get('/api/audit?from=2020-01-01&to=2020-01-02', bearer('admin'))).json();
    assert.equal(none.total, 0);
    assert.equal((await get('/api/audit?action=delete_everything', bearer('admin'))).status, 400);
    assert.equal((await get('/api/audit?from=yesterday', bearer('admin'))).status, 400);
    const views = await db.collection('audit_log').find({ action: 'view_personal', 'target.type': 'audit_log' }).toArray();
    assert.equal(views.length, 4, 'one row for each successful read, none for a refused one');
    assert.deepEqual(views.find((v) => v.detail.filters.action === 'denied').fields, ['audit_log']);
    const page = await (await get('/admin/audit?action=sign_in', bearer('admin'))).text();   // a token: this suite's fixed clock repeats signed-out cookies
    assert.match(page, /<h1>Audit log<\/h1>/);
    assert.match(page, /Signed in/);
    assert.match(page, /<option value="sign_in" selected>/);
  });
});

describe('the AI check on unsure matches (design 7.2)', () => {
  test('advice per candidate on the review page; company facts only to the model; every call logged', async () => {
    const { aiCheckPairs, parseVerdicts } = await import('../src/admin/ai_check.js');
    const { LlmGateway } = await import('../src/outreach/llm.js');
    const llmCfg = JSON.parse(readFileSync(new URL('../../config/llm.json', import.meta.url), 'utf8'));
    const prompts = [];
    const gateway = async (url, init) => {
      const body = JSON.parse(init.body);
      prompts.push(body.messages.map((m) => m.content).join('\n'));
      const asked = JSON.parse(body.messages[1].content);
      const verdicts = [...asked.candidates.map((c) => ({ company_id: c.company_id, same: 'yes', reason: 'Same name once the suffix is dropped; same district.' })),
        { company_id: 'U99999UP2026PTC999999', same: 'yes', reason: 'not a candidate' }];
      return new Response(JSON.stringify({ model: 'small-test', choices: [{ message: { content: JSON.stringify({ verdicts }) } }], usage: { prompt_tokens: 220, completion_tokens: 40 } }), { status: 200 });
    };
    assert.match((await aiCheckPairs(db, { llm: new LlmGateway(db, { cfg: llmCfg, caps: { monthly: { llm_spend_inr: 100 } } }) })).skipped, /not configured/);
    const llm = new LlmGateway(db, { url: 'https://gateway.test', key: 'k', cfg: llmCfg, caps: { monthly: { llm_spend_inr: 100 } }, fetch: gateway });
    const r = await aiCheckPairs(db, { llm, clock: () => now });
    assert.ok(r.checked >= 1, JSON.stringify(r));
    assert.equal(r.waiting, 0);
    const link = await db.collection('entity_links').findOne({ _id: 'startup:UPLC_00000009' });
    assert.deepEqual(link.ai_check.verdicts, [{ company_id: CIN, same: 'yes', reason: 'Same name once the suffix is dropped; same district.' }], 'only the candidates asked about');
    assert.equal(link.ai_check.prompt_version, 'match-v1');
    assert.equal(link.status, 'review', 'advice, never a decision');
    assert.ok(!prompts.some((p) => /Priya Sharma|Kabir Rao/.test(p)), "a portal team member's name never goes to the model");
    assert.ok(await db.collection('llm_calls').findOne({ task: 'match_check', ok: true }));
    assert.equal((await aiCheckPairs(db, { llm })).checked, 0, 'a pair is asked about once');
    const page = await (await get('/admin/review', bearer('reviewer'))).text();
    assert.match(page, /AI check \(advice only\): likely the same business · Same name once the suffix is dropped; same district\./);
    assert.equal(parseVerdicts('not json', [CIN]), null);
    assert.equal(parseVerdicts(JSON.stringify({ verdicts: [{ company_id: CIN, same: 'maybe' }] }), [CIN]), null);
  });
});

describe('funding news for a person to confirm (signals, design 7.4)', () => {
  // proposed by `leadengine ingest news`; pages are fetched with a token: this suite's fixed clock repeats signed-out cookies
  const SIG = `news:${'a'.repeat(40)}`;
  const OTHER = `news:${'b'.repeat(40)}`;
  const FORM = `news:${'c'.repeat(40)}`;
  const signal = (_id, extra = {}) => ({ _id, type: 'funding', company_id: CIN, headline: 'Lucknow-based Vezras raises ₹5 Cr in seed round',
    url: 'https://inc42.com/buzz/vezras-raises/', publisher: 'Inc42', published_at: now, matched_name: 'Vezras', status: 'proposed',
    created_at: now, decided_by: null, decided_at: null, note: null, ...extra });
  const decide = (role, id, body, headers = {}) => postJson(`/api/signals/${id}`, body, { ...bearer(role), ...headers });

  before(async () => {
    await db.collection('signals').insertMany([signal(SIG),
      signal(OTHER, { headline: 'Vezras bags $1M from angels', url: 'https://entrackr.com/2026/11/vezras/', publisher: 'Entrackr', created_at: new Date(now.getTime() + 1000) }),
      signal(FORM, { headline: 'Vezras closes ₹2 Cr bridge round', url: 'https://yourstory.com/vezras', publisher: 'YourStory' })]);
  });

  test('the database refuses a signal whose link is not a web address', async () => {
    await assert.rejects(db.collection('signals').insertOne(signal(`news:${'d'.repeat(40)}`, { url: 'javascript:alert(1)' })), /validation/i);
  });

  test('anyone signed in reads the queue; only reviewers see the buttons; the review page links to it', async () => {
    assert.equal((await get('/api/signals')).status, 401);
    const q = await (await get('/api/signals', bearer('viewer'))).json();
    assert.equal(q.waiting, 3);
    assert.deepEqual(q.items.map((s) => s.id).slice(0, 1), [OTHER], 'newest first');
    assert.equal(q.items[0].company_name, 'VEZRAS TECHNOLOGIES PRIVATE LIMITED');
    const viewer = await (await get('/admin/signals', bearer('viewer'))).text();
    assert.match(viewer, /<h1>News to check<\/h1>/);
    assert.match(viewer, /<a href="https:\/\/inc42.com\/buzz\/vezras-raises\/" rel="noreferrer noopener" target="_blank">Lucknow-based Vezras raises ₹5 Cr in seed round<\/a>/);
    assert.match(viewer, /Matched on “Vezras”/);
    assert.ok(!/name="decision"/.test(viewer), 'a viewer sees no buttons');
    const reviewer = await (await get('/admin/signals', bearer('reviewer'))).text();
    assert.match(reviewer, new RegExp(`<form method="post" action="/admin/signals/${SIG}">`));
    assert.match(reviewer, /<button name="decision" value="confirm" class="good">Confirm<\/button>/);
    assert.match(await (await get('/admin/review', bearer('reviewer'))).text(), /<a href="\/admin\/signals">News to check: 3<\/a>/);
  });

  test('a viewer cannot decide; a reviewer confirms, logged first; deciding twice is refused', async () => {
    assert.equal((await decide('viewer', SIG, { decision: 'confirm' })).status, 403);
    assert.equal((await decide('reviewer', SIG, { decision: 'maybe' })).status, 400);
    assert.equal((await decide('reviewer', `news:${'e'.repeat(40)}`, { decision: 'confirm' })).status, 404);
    assert.equal((await decide('reviewer', 'not-a-signal', { decision: 'confirm' })).status, 404);
    assert.equal((await decide('reviewer', SIG, { decision: 'confirm' }, { Origin: 'https://evil.example' })).status, 403, 'cross-origin refused');
    assert.equal(await count({ 'target.type': 'signal' }), 0, 'refusals decide nothing');
    const ok = await decide('reviewer', SIG, { decision: 'confirm', note: 'Same Vezras: Lucknow, fintech' });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { saved: true, status: 'confirmed' });
    const row = await db.collection('audit_log').findOne({ action: 'review_decision', 'target.type': 'signal', 'target.id': SIG });
    assert.deepEqual([row.actor, row.role, row.detail.decision, row.detail.company_id], ['reviewer@solutionai.in', 'reviewer', 'confirmed', CIN]);
    const s = await db.collection('signals').findOne({ _id: SIG });
    assert.deepEqual([s.status, s.decided_by, s.note], ['confirmed', 'reviewer@solutionai.in', 'Same Vezras: Lucknow, fintech']);
    const again = await decide('admin', SIG, { decision: 'reject' });
    assert.equal(again.status, 409);
    assert.match((await again.json()).error, /already confirmed/);
    assert.equal(await count({ 'target.type': 'signal' }), 1, 'the refused second decision is not logged');
    assert.equal((await decide('admin', OTHER, { decision: 'reject', note: 'another Vezras, in Pune' })).status, 200);
    const form = await postForm(`/admin/signals/${FORM}`, { decision: 'confirm' }, bearer('reviewer'));
    assert.equal(form.status, 303);
    assert.equal(form.headers.get('location'), '/admin/signals?saved=1');
  });

  test('a confirmed signal is on the company page; a rejected one is not', async () => {
    const v = await (await get(`/api/companies/${CIN}`, bearer('viewer'))).json();
    assert.deepEqual(v.signals.map((s) => s.id).sort(), [SIG, FORM].sort());
    const page = await (await get(`/admin/companies/${CIN}`, bearer('viewer'))).text();
    assert.match(page, /<h2>In the news<\/h2>/);
    assert.match(page, /<a href="https:\/\/inc42.com\/buzz\/vezras-raises\/" rel="noreferrer noopener" target="_blank">Lucknow-based Vezras raises ₹5 Cr in seed round<\/a>/);
    assert.ok(!page.includes('Vezras bags $1M'), 'the rejected item is not shown');
    const q = await (await get('/api/signals', bearer('viewer'))).json();
    assert.deepEqual([q.waiting, q.decided.length], [0, 3]);
    assert.match(await (await get('/admin/signals', bearer('viewer'))).text(), /another Vezras, in Pune/);
    const audit = await (await get('/admin/audit?action=review_decision', bearer('admin'))).text();
    assert.match(audit, /Decided a news item/);
  });
});

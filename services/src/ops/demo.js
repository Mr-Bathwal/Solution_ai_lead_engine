import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, loadSchema } from '../config.js';
import { migrate } from '../db/migrate.js';
import { buildOutreach } from '../outreach/index.js';
import { buildEmail } from '../outreach/mime.js';
import { JOB_DRAFT, JOB_SEND, planOutreach } from '../outreach/sequence.js';
import { processInbound } from '../inbound/process.js';
import { JOB_CALL, nextCallWindow } from '../voice/calls.js';
import { recordEvent, validateEvent } from '../attribution/events.js';
import { runMonitor } from '../monitor/alerts.js';
import { createPublicServer } from '../public/server.js';
import { decideExport, downloadExport, requestExport } from '../admin/exports.js';
import { decideApproval } from '../admin/approvals.js';
import { recordReview } from '../admin/queries.js';
import { heldOut } from '../admin/labels.js';
import { decideSignal } from '../admin/signals.js';
import { aiCheckPairs } from '../admin/ai_check.js';
import { LlmGateway } from '../outreach/llm.js';

/**
 * A demonstration database (`lead-engine demo:seed`, then `demo:serve`): fictional companies in a
 * database whose name ends in "_demo", taken through the engine's own code so that every Admin page
 * shows what it will show in production: the pipeline and shortlist, emails waiting for approval
 * (one of them to an address the company publishes on its own website), sent ones with their address
 * checks, replies in the inbox (interested, a question, not now, an opt-out, an automatic reply),
 * a founder who claimed the company page and asked for a call back, the call, another founder who
 * found their company on a campus campaign's landing page and claimed it, sign-ups and a payment on
 * the platform, the match review queue with the AI's advice on one pair, labelled pairs and the
 * precision so far, data health, results, an export waiting for an admin and one approved and
 * downloaded.
 *
 * Everything is invented: company names, CINs (serial numbers 990001 and up, which MCA has not
 * reached), people and addresses (on the reserved .example domain). Nothing leaves the machine: the
 * mail transport, the voice provider, the LLM gateway and the platform are stand-ins, and the
 * mailboxes, keys and secrets in .env are never read for it.
 */

export const DEMO_SECRET = 'demo-only-secret-not-for-real-data-0123456789';
const DAY = 86_400_000;
const istDay = (at) => new Date(at.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const istMonth = (at) => istDay(at).slice(0, 7);
const addDays = (day, n) => istDay(new Date(Date.parse(`${day}T00:00:00+05:30`) + n * DAY));
const quiet = { info() {}, warn() {}, error() {}, log() {} };

export function assertDemo(dbName) {
  if (!/_demo$/.test(dbName ?? '')) throw new TypeError(`this only runs on a demonstration database (a name ending in _demo), not "${dbName}"`);
}

/** The demonstration database for a configured one: solutionai_leads -> solutionai_leads_demo. */
export const demoDbName = (dbName) => `${String(dbName).replace(/_demo$/, '')}_demo`;

// ---- the fictional companies ----------------------------------------------------------------------
const FIRST = ['Gomti', 'Awadh', 'Sangam', 'Kashi', 'Doab', 'Tarai', 'Bundel', 'Rohil', 'Braj', 'Purvanchal', 'Saryu', 'Ganga Kinare', 'Chambal', 'Vindhya',
  'Naimish', 'Shravasti', 'Kalpi', 'Hastin', 'Ayodhya Path', 'Mathura Road', 'Chunar', 'Sarnath', 'Dudhwa', 'Kannauj', 'Firozabad Glassline', 'Moradabad Brass',
  'Bhadohi Loom', 'Khurja Clay', 'Saharan', 'Meerut Sports', 'Aligarh Lock', 'Agra Marble', 'Noida Byte', 'Hapur Grain', 'Etawah', 'Basti'];
const LINES = [
  { nic: '62099', theme: 'SaaS, IT & Cloud', word: 'TECHNOLOGIES', sector: 'Software & IT services' },
  { nic: '10799', theme: 'Food processing', word: 'FOODS', sector: 'Food products' },
  { nic: '13999', theme: 'Textiles & handicrafts', word: 'CRAFTS', sector: 'Textiles' },
  { nic: '01119', theme: 'Agritech', word: 'AGRITECH', sector: 'Agriculture' },
  { nic: '86900', theme: 'Healthcare', word: 'HEALTHCARE', sector: 'Health' },
  { nic: '85499', theme: 'Education', word: 'LEARNING', sector: 'Education' },
  { nic: '25999', theme: 'Manufacturing', word: 'INDUSTRIES', sector: 'Fabricated metal products' },
  { nic: '49231', theme: 'Logistics', word: 'LOGISTICS', sector: 'Land transport' },
];
const DISTRICTS = ['Lucknow', 'Kanpur Nagar', 'Gautam Buddha Nagar', 'Ghaziabad', 'Varanasi', 'Prayagraj', 'Agra', 'Meerut', 'Gorakhpur', 'Bareilly'];
const FOUNDERS = [['Aarav', 'Mishra'], ['Ishita', 'Rastogi'], ['Kabir', 'Tripathi'], ['Meera', 'Saxena'], ['Vihaan', 'Pandey'], ['Ananya', 'Shukla']];
const CAMPAIGN_FOUNDER = ['Tanvi', 'Agarwal'];       // not in FOUNDERS: nobody else in the demo has this name
export const DEMO_CAMPAIGN_CODE = 'demo-ecell';

export function demoCompanies(now, n = 36) {
  const today = istDay(now);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const line = LINES[i % LINES.length];
    const name = `${FIRST[i % FIRST.length].toUpperCase()} ${line.word} PRIVATE LIMITED`;
    const cin = `U${line.nic}UP${today.slice(0, 4)}PTC${String(990001 + i)}`;
    const incorporated = addDays(today, -(12 + ((i * 7) % 40)));
    const slug = FIRST[i % FIRST.length].toLowerCase().replace(/[^a-z]/g, '');
    const fit = Math.max(35, 92 - ((i * 13) % 55));
    out.push({ i, cin, name, slug, incorporated, cohort: incorporated.slice(0, 7), district: DISTRICTS[i % DISTRICTS.length], line, fit,
      email: i % 9 === 8 ? null : `info@${slug}${line.word.toLowerCase().slice(0, 4)}.example` });
  }
  return out;
}

function companyDoc(c, now) {
  const attr = (value, source = 'mca_monthly') => ({ value, source, seen_at: now });
  return {
    _id: c.cin, kind: 'company', state: 'UP', name: c.name, name_norm: c.name.toLowerCase().replace(/ private limited$/, '').replace(/[^a-z0-9]/g, ''),
    ids: { cin: c.cin, uplc: [] }, cohort: c.cohort, sources: ['mca_monthly', ...(c.email ? ['infyner'] : [])], first_seen_at: now, updated_at: now,
    schema_version: 2, former_names: [],
    attrs: {
      incorporation_date: attr(c.incorporated), company_type: attr('Private Limited Company'), class: attr('Private'),
      registered_district: attr(c.district, 'infyner'), registrar: attr('ROC Uttar Pradesh'), sector: attr(c.line.sector), activity_code: attr(c.line.nic.slice(0, 2)),
      ...(c.email ? { registered_email: attr(c.email, 'infyner') } : {}),
    },
  };
}

function needsFor(c, now) {
  const due = (n) => addDays(c.incorporated, n);
  const today = istDay(now);
  const status = (d) => (d < today ? 'was_due' : d <= addDays(today, 14) ? 'due_soon' : 'upcoming');
  return {
    rules_confirmed: true, rules_version: 'demo (fictional rules data)', verdicts_by: 'demo', computed_at: now,
    deadlines: [
      { id: 'first_board_meeting', title: 'Hold the first board meeting', form: 'Minutes (no MCA form)', due: due(30), status: status(due(30)),
        law: 'Companies Act 2013 s.173(1)', source_url: 'https://www.indiacode.nic.in/' },
      { id: 'auditor', title: 'Appoint the first auditor', form: 'ADT-1 (board resolution)', due: due(30), status: status(due(30)),
        law: 'Companies Act 2013 s.139(6)', source_url: 'https://www.mca.gov.in/' },
      { id: 'inc_20a', title: 'File the declaration for commencement of business', form: 'INC-20A', due: due(180), status: status(due(180)),
        law: 'Companies Act 2013 s.10A', source_url: 'https://www.mca.gov.in/' },
    ],
    schemes: [
      { scheme_id: 'udyam_registration', name: 'Udyam (MSME) registration', verdict: 'eligible', benefit: 'Free registration; access to MSME schemes.', missing: [],
        source_url: 'https://udyamregistration.gov.in/' },
      { scheme_id: 'startup_india', name: 'Startup India recognition', verdict: c.i % 3 === 0 ? 'eligible' : 'check_required', benefit: 'Tax and compliance benefits.',
        missing: c.i % 3 === 0 ? [] : ['innovation statement'], source_url: 'https://www.startupindia.gov.in/' },
    ],
  };
}

function leadDoc(c, now, { month, rank, holdout }) {
  const shortlisted = rank != null;
  return {
    company_id: c.cin, stage: shortlisted && !holdout ? 'shortlisted' : 'discovered', holdout: Boolean(holdout), eligible: true, eligibility_reasons: [],
    cohort: c.cohort, needs: needsFor(c, now), shortlist: shortlisted ? { month, rank, fit: c.fit, as_of: now } : null,
    score: { fit: c.fit, version: 'fit-v1', theme: { name: c.line.theme }, components: [
      { key: 'recency', points: 30, reason: `incorporated ${c.incorporated}` }, { key: 'sector', points: Math.round(c.fit / 4), reason: c.line.theme },
      { key: 'contact', points: c.email ? 15 : 0, reason: c.email ? 'a company email in the register' : 'no company email' }] },
    created_at: now, updated_at: now,
  };
}

// ---- stand-ins for the outside world -------------------------------------------------------------
function demoTransport() {
  let n = 0;
  return { kind: 'demo', send: async () => { n += 1; return { transport: 'demo', response: `250 2.0.0 demo queued as D${String(n).padStart(4, '0')} (nothing was sent)` }; } };
}

/** A stand-in for Sarvam: answers each call request with an attempt id and keeps the request. */
function demoSarvam() {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push(JSON.parse(init?.body ?? '{}'));
    return new Response(JSON.stringify({ attempt_id: `demo-att-${requests.length}` }), { status: 200 });
  };
  return { fetch, requests };
}

/**
 * A stand-in for the platform's LLM gateway, for the AI check on unsure pairs. It answers in the
 * chat-completions shape the engine expects (outreach/llm.js), from the facts the engine sent, which
 * are company-level only: a different district or year is a "no", anything else "unsure". It never
 * says "yes", so nothing on the review page looks more certain than the demo's invented data allows.
 */
function demoGateway() {
  return async (url, init) => {
    const facts = JSON.parse(JSON.parse(init?.body ?? '{}').messages?.at(-1)?.content ?? '{}');
    const s = facts.startup ?? {};
    const verdicts = (facts.candidates ?? []).map((c) => {
      const year = c.incorporated ? Number(String(c.incorporated).slice(0, 4)) : null;
      if (s.district && c.district && s.district !== c.district) {
        return { company_id: c.company_id, same: 'no', reason: `The portal lists it in ${s.district}, the register in ${c.district}; a different district is strong evidence against.` };
      }
      if (s.year_established && year && s.year_established !== year) {
        return { company_id: c.company_id, same: 'no', reason: `Established ${s.year_established} on the portal, incorporated ${year} in the register.` };
      }
      return { company_id: c.company_id, same: 'unsure', reason: 'Same district and year, but the names differ; the facts given do not settle it.' };
    });
    const content = JSON.stringify({ verdicts });
    return new Response(JSON.stringify({ model: 'demo-stand-in', choices: [{ message: { role: 'assistant', content } }],
      usage: { prompt_tokens: Math.ceil(String(init?.body ?? '').length / 4), completion_tokens: Math.ceil(content.length / 4) } }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

/**
 * What a founder does on a campaign's landing page (public/server.js handleCampaign): searches for
 * the company by name, opens its page from the signed result, reads it, and claims it. Returns
 * whether the claim was accepted.
 */
async function campaignVisit(base, code, c, [first, last], links) {
  const q = c.name.replace(/ PRIVATE LIMITED$/, '').toLowerCase().replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
  const found = await (await fetch(`${base}/j/${code}?q=${encodeURIComponent(q)}`)).text();
  const sig = new RegExp(`name="company" value="${c.cin}"><input type="hidden" name="sig" value="([^"]+)"`).exec(found)?.[1];
  if (!sig) return false;
  const post = (body) => ({ method: 'POST', body, redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const opened = await fetch(`${base}/j/${code}/open`, post(new URLSearchParams({ company: c.cin, sig })));
  await opened.text();
  const page = opened.headers.get('location');
  if (opened.status !== 303 || !page) return false;
  await (await fetch(base + page)).text();                     // the visit, counted for the campaign
  const form = await (await fetch(`${base}${page}/claim`)).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(form)?.[1];
  const body = new URLSearchParams({ csrf, name: `${first} ${last}`, role: 'Founder', email: `${first.toLowerCase()}@founder.demo.example`, whatsapp: '',
    call_slot: 'any', call_language: 'en' });
  body.append('consent', 'email_reminders');
  body.append('consent', 'email_schemes');
  const res = await fetch(`${base}${page}/claim`, post(body));
  await res.text();
  if (res.status !== 200 || !links.length) return false;
  // a claim from a campaign page waits for its email: the founder opens the link and confirms
  const link = `${base}/k/${links.at(-1)}`;
  const confirmCsrf = /name="csrf" value="([^"]+)"/.exec(await (await fetch(link)).text())?.[1];
  const done = await fetch(link, post(new URLSearchParams({ csrf: confirmCsrf ?? '' })));
  await done.text();
  return done.status === 200;
}

async function claimDue(o, type) {
  await o.db.collection('jobs').updateMany({ type, status: 'pending' }, { $set: { due_at: new Date(Date.now() - 1000) } });
  return o.queue.claim('demo-seed', { types: [type] });
}

/** The engine wired for the demo: the stand-in mail transport and voice provider. */
export function demoOutreach(cfg, db, clock = () => new Date()) {
  const sarvam = demoSarvam();
  // the demo's domains are invented (.example): its stand-in DNS gives every one a mail server
  const dns = { resolveMx: async () => [{ exchange: 'mx.demo.example', priority: 10 }] };
  return { o: buildOutreach(cfg, db, { clock, log: quiet, transport: demoTransport(), fetch: sarvam.fetch, dns }), sarvam };
}

/**
 * When the demo is dated from: now, unless it is outside the engine's calling window (config/voice.json:
 * 10:00 to 19:00 IST, Monday to Saturday, inside the law's 09:00 to 21:00), when it is the latest moment
 * before now with 15 minutes of window still ahead. The voice code
 * never places a call outside the window, the demo's stand-in call included, and a demo dated this
 * way keeps its timeline in order (the claim, then the call) at any hour it is seeded.
 */
export function demoStart(now, voiceCfg) {
  const callable = (t) => nextCallWindow(new Date(t), voiceCfg, 'any').getTime() === t;
  for (let t = now.getTime(); t > now.getTime() - 8 * DAY; t -= 5 * 60_000) {
    if (callable(t) && callable(t + 15 * 60_000)) return new Date(t);
  }
  return now;
}

export async function drain(o, type, limit = 200) {
  const results = [];
  for (let k = 0; k < limit; k += 1) {
    const job = await claimDue(o, type);
    if (!job) break;
    const r = await o.handlers[type](job);
    await o.queue.complete(job, r ?? null);
    results.push(r);
  }
  return results;
}

function writeDemoCaps(caps, root, now) {
  const c = structuredClone(caps);
  c.email.warmup_start = addDays(istDay(now), -(c.email.warmup_days + 10));
  c.email.send_window_ist = ['00:00', '23:59'];
  const file = path.join(root, 'data', 'demo', 'caps.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ _comment: 'Written by demo:seed for the demonstration database only: the warm-up is over.', ...c }, null, 2)}\n`);
  return file;
}

/** The configuration the demo runs with: nothing from .env but the database address. */
export function demoConfig({ mongoUri, dbName, caps, root, now = new Date() }) {
  assertDemo(dbName);
  const capsFile = writeDemoCaps(caps, root, now);
  const cfg = loadConfig({
    MONGODB_URI: mongoUri, LEAD_DB: dbName, CAPS_FILE: capsFile, LEADENGINE_ENV: 'demo',
    CONTACT_KEY_SECRET: DEMO_SECRET, PAGE_SECRET: DEMO_SECRET, PLATFORM_EVENTS_SECRET: DEMO_SECRET, HOLDOUT_SALT: 'demo',
    PUBLIC_BASE_URL: 'https://pages.demo.example', OUTBOX_DIR: path.join(root, 'data', 'demo', 'outbox'),
    MAILBOX_1_ADDRESS: 'priya@outreach.demo.example', MAILBOX_1_NAME: 'Priya Sharma',
    MAILBOX_2_ADDRESS: 'rohan@outreach.demo.example', MAILBOX_2_NAME: 'Rohan Verma',
    PRIVACY_NOTICE_URL: 'https://solutionai.demo.example/privacy', PRIVACY_CONTACT: 'privacy@solutionai.demo.example',
    SARVAM_API_KEY: 'demo', SARVAM_ORG_ID: 'demo', SARVAM_WORKSPACE_ID: 'demo', SARVAM_APP_ID: 'demo', SARVAM_APP_VERSION: '1',
    SARVAM_CONNECTION_ID: 'demo', VOICE_CALLER_NUMBER: '+911400000000',
  });
  const today = istDay(now);
  cfg.outreach = { ...cfg.outreach, send_days_ist: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    // a running campus campaign, so its landing page (/j/demo-ecell) and its row on Results can be shown;
    // it starts a month back because the seed may date itself up to a few days before today (demoStart)
    campaigns: [{ code: DEMO_CAMPAIGN_CODE, name: 'IIT Kanpur E-Cell (fictional demo)', channel: 'campus', active: true,
      from: addDays(today, -30), to: addDays(today, 120) }],
    // on here to show a first email to an address from the company's own website; in production it stays
    // off until the lawyer approves that wording (config/outreach.json recipient._use_website_email)
    recipient: { ...cfg.outreach.recipient, use_website_email: true } };
  cfg.voice = { ...cfg.voice, enabled: true, script: { ...cfg.voice.script, approved_by: 'demo', approved_on: today } };
  return cfg;
}

const REPLIES = [
  { text: 'What are your charges for the INC-20A filing? Please call me.', expect: 'interested' },
  { text: 'Is the first board meeting really needed within 30 days? Which documents should we keep ready?', expect: 'question' },
  { text: 'Not now, thank you. We will look at this after March.', expect: 'not_now' },
  { text: 'Please remove us from your mailing list.', expect: 'unsubscribe' },
];

/**
 * Seeds the demonstration database. The database is emptied first (it holds nothing but the demo).
 * Returns what was made, for the command's report and the test.
 */
export async function seedDemo(db, { cfg, log = () => {}, now: realNow = new Date() }) {
  // the guard is on the database about to be emptied, not only on the configured name
  assertDemo(db.databaseName);
  assertDemo(cfg.dbName);
  await db.dropDatabase();
  await migrate(db, loadSchema());
  const now = demoStart(realNow, cfg.voice);
  const offset = realNow.getTime() - now.getTime();
  const clock = () => new Date(Date.now() - offset);          // runs on in real time from `now`
  if (offset) log(`dated from ${now.toISOString()}: it is outside the calling window now, and the demo includes a call back`);
  const month = istMonth(now);
  const { o, sarvam } = demoOutreach(cfg, db, clock);
  const made = { month, dated_from: now };

  // 1. companies and leads: a shortlist of 24 (3 of them the holdout), the rest discovered
  const cos = demoCompanies(now);
  await db.collection('companies').insertMany(cos.map((c) => companyDoc(c, now)));
  const ranked = [...cos].sort((a, b) => b.fit - a.fit);
  const rankOf = new Map(ranked.slice(0, 24).map((c, k) => [c.cin, k + 1]));
  await db.collection('leads').insertMany(cos.map((c) => {
    const rank = rankOf.get(c.cin) ?? null;
    return leadDoc(c, now, { month, rank, holdout: rank != null && rank % 8 === 0 });
  }));
  made.companies = cos.length;
  made.shortlisted = rankOf.size;
  log(`companies: ${cos.length}; shortlist for ${month}: ${rankOf.size} (3 held out)`);

  // the data side's website reader (ingest: leadengine enrich websites) found the site of a shortlisted
  // company that has no registered email, and a role address on it, written here the way that reader
  // writes it. With recipient.use_website_email on, the first email goes to that address and its last
  // paragraph says where the address came from. Before planning, which skips a company with no address.
  const site = cos.find((c) => !c.email && rankOf.has(c.cin) && rankOf.get(c.cin) % 8 !== 0);
  if (site) {
    const domain = `${site.slug}.example`;
    await db.collection('companies').updateOne({ _id: site.cin }, { $set: {
      'attrs.website': { value: `https://${domain}`, source: 'web_discovery', confidence: 'medium', seen_at: now,
        ref: { query: `"${site.name.replace(/ PRIVATE LIMITED$/, '')}" ${site.district}`, rank: 1, provider: 'demo' } },
      'attrs.website_email': { value: `info@${domain}`, source: 'company_website', confidence: 'medium', seen_at: now,
        ref: { domain, legal_basis: 'published_by_company' } },
      'ids.domain': domain, updated_at: now } });
    made.website_email = { company_id: site.cin, address: `info@${domain}` };
    log(`website: ${site.name} has no registered email; its own website, ${domain}, publishes info@${domain}`);
  }

  // 2. outreach through the engine's own code: plan, draft, approve most, reject one, send
  await planOutreach(o, { month });
  await drain(o, JOB_DRAFT);
  const reviewer = { email: 'neha.reviewer@solutionai.demo.example', role: 'reviewer', via: 'token' };
  const decide = (m, decision, note) => decideApproval(db, { id: String(m._id), decision, user: reviewer, note, cfg: o.cfg, org: o.org, queue: o.queue, clock });
  const drafts = await db.collection('messages').find({ status: 'awaiting_approval' }).sort({ created_at: 1, _id: 1 }).toArray();
  const toApprove = drafts.slice(0, 9);
  for (const m of toApprove) await decide(m, 'approve', 'checked the deadlines');
  if (drafts[9]) await decide(drafts[9], 'reject', 'the company already has a CA (told us by phone)');
  await drain(o, JOB_SEND);
  const sent = await db.collection('messages').find({ status: 'sent' }).sort({ 'send.at': 1, _id: 1 }).toArray();
  made.drafts = drafts.length;
  made.sent = sent.length;
  made.waiting = drafts.length - toApprove.length - (drafts[9] ? 1 : 0);
  log(`emails: ${drafts.length} drafted, ${sent.length} sent (to nobody: a stand-in transport), ${made.waiting} waiting for approval, 1 rejected`);

  // 3. replies, read by the engine as if from the mailboxes: four labels and an automatic reply
  let uid = 1;
  const labels = [];
  for (const [k, r] of REPLIES.entries()) {
    const m = sent[k];
    if (!m) break;
    const reply = buildEmail({ from: { name: null, address: m.recipient.address }, to: { name: null, address: o.mailboxes[m.mailbox].address },
      subject: `Re: ${m.draft.subject}`, text: r.text, unsubscribe: null, inReplyTo: m.send.message_id, at: clock() });
    await processInbound(o, { mailbox: m.mailbox, uid: uid++, uidvalidity: 1, internalDate: clock(), raw: reply.raw });
    labels.push((await db.collection('inbound').findOne({ 'matched.message_id': m._id }))?.label ?? null);
  }
  if (sent[4]) {
    const m = sent[4];
    const auto = `From: ${m.recipient.address}\r\nTo: ${o.mailboxes[m.mailbox].address}\r\nSubject: Automatic reply: ${m.draft.subject}\r\nMessage-ID: <auto-${uid}@demo.example>\r\nIn-Reply-To: ${m.send.message_id}\r\nAuto-Submitted: auto-replied\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nI am out of the office until Monday.\r\n`;
    await processInbound(o, { mailbox: m.mailbox, uid: uid++, uidvalidity: 1, internalDate: clock(), raw: auto });
  }
  made.replies = labels;
  log(`replies: ${labels.join(', ')} and an automatic reply`);

  // 4. founders on the company pages: the interested founder claims the page from the email and asks
  //    for a call back; another founder, who was never emailed, finds their company on a campus
  //    campaign's landing page, opens its page and claims it
  const interested = sent[0];
  const campaign = o.cfg.campaigns.find((c) => c.code === DEMO_CAMPAIGN_CODE);
  // a company off the shortlist (so never emailed), from Kanpur, the E-Cell's city
  const walkIn = cos.find((c) => !rankOf.has(c.cin) && c.district === 'Kanpur Nagar') ?? cos.find((c) => !rankOf.has(c.cin));
  const pages = createPublicServer({ db, tokens: o.tokens, ledger: o.ledger, suppression: o.suppression, queue: o.queue, platform: o.platform, cfg: o.cfg, org: o.org,
    secret: DEMO_SECRET, privacyUrl: cfg.privacyUrl, privacyContact: cfg.privacyContact, clock, log: quiet, voice: { cfg: o.voiceCfg, webhook: o.voiceWebhook },
    // the confirmation email of a campaign claim goes nowhere: the seed opens its link itself
    confirm: { send: async ({ token }) => { confirmLinks.push(token); return { transport: 'demo' }; } } });
  const confirmLinks = [];
  await new Promise((r) => pages.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${pages.address().port}`;
  try {
    if (interested) {
      const token = await o.tokens.issue({ purpose: 'company_page', companyId: interested.company_id, leadId: interested.lead_id });
      const form = await (await fetch(`${base}/c/${token}/claim`)).text();
      const csrf = /name="csrf" value="([^"]+)"/.exec(form)?.[1];
      const [first, last] = FOUNDERS[0];
      const body = new URLSearchParams({ csrf, name: `${first} ${last}`, role: 'Director', email: `${first.toLowerCase()}@founder.demo.example`, whatsapp: '90000 00001',
        call_slot: 'any', call_language: 'hi' });
      body.append('consent', 'callback');
      body.append('consent', 'email_reminders');
      const res = await fetch(`${base}/c/${token}/claim`, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      await res.text();
      made.claimed = res.status === 200;
    }
    if (campaign && walkIn) {
      made.campaign = { code: campaign.code, company_id: walkIn.cin, claimed: await campaignVisit(base, campaign.code, walkIn, CAMPAIGN_FOUNDER, confirmLinks) };
      log(`campaign "${campaign.name}": a founder searched /j/${campaign.code} for ${walkIn.name}, opened its page and claimed it: ${made.campaign.claimed}`);
    }
  } finally {
    await new Promise((r) => pages.close(r));
  }
  const event = (e) => recordEvent(db, validateEvent(e, { now: clock() }).event, { clock });
  if (interested) {
    const placed = await drain(o, JOB_CALL, 3);
    const call = await db.collection('calls').findOne({ company_id: interested.company_id });
    if (call?.provider_attempt_id && sarvam.requests[0]) {
      // the provider's report, carrying back the signed metadata the engine sent with the call
      await o.voiceWebhook({ attempt_id: call.provider_attempt_id, status: 'connected', duration: 146,
        webhook_config: { metadata: sarvam.requests[0].webhook_config?.metadata }, final_agent_variables: { outcome: 'wants_person' } });
    }
    made.calls = placed.length;
    made.call_outcome = (await db.collection('calls').findOne({ company_id: interested.company_id }))?.outcome ?? null;
    log(`page claimed by the interested founder: ${made.claimed}; call back: ${placed.map((p) => p?.status).join(', ') || 'none'}, outcome ${made.call_outcome}`);

    // 5. the platform reports the sign-up and, for another company, a payment
    await event({ id: 'demo_evt_1', type: 'signed_up', at: clock().toISOString(), company_id: interested.company_id });
    if (sent[1]) await event({ id: 'demo_evt_2', type: 'paid', at: clock().toISOString(), company_id: sent[1].company_id, amount_paise: 999900, service: 'Annual compliance plan' });
  }
  // the campaign founder signs up too; its first touch was the campaign's page, so Results credits the campaign
  if (made.campaign?.claimed) await event({ id: 'demo_evt_3', type: 'signed_up', at: clock().toISOString(), company_id: made.campaign.company_id });

  // 6. the data side: runs, meters, a review queue, the matcher's links
  await seedDataSide(db, cos, now);

  // 7. exports: one waiting for an admin; another, asked for by a second reviewer, approved by an admin
  //    who is not the one asking (exports.js refuses that) and downloaded once, without suppressed addresses.
  //    The asker is the reviewer demo:serve gives a sign-in token to, so the walkthrough can download it
  //    again (only the person who asked can, for 24 hours after the approval: seed on the day).
  await requestExport(db, { user: reviewer, reason: 'the shortlist for the district camp in Lucknow', filters: { shortlist_month: month, district: 'Lucknow' }, includeContacts: true, maxRows: 200, clock });
  const asker = { email: 'reviewer@solutionai.demo.example', role: 'reviewer', via: 'token' };
  const approver = { email: 'kavita.admin@solutionai.demo.example', role: 'admin', via: 'token' };
  const ex = await requestExport(db, { user: asker, reason: "this month's shortlist, for the partner CAs' deadline review", filters: { shortlist_month: month },
    includeContacts: true, maxRows: 100, clock });
  await decideExport(db, { id: ex._id, user: approver, decision: 'approve', note: 'company-level columns only; delete the file after the review', clock });
  const file = await downloadExport(db, { id: ex._id, user: asker, suppression: o.suppression, clock });
  made.export = { id: ex._id, rows: file.rows };
  log(`exports: one waiting for an admin; one approved by another admin and downloaded once (${file.rows} rows)`);

  // 8. labels: a reviewer checks three of the matcher's own links on the labelling page, one of them in
  //    the held-out fold, so the page shows progress and a first precision figure
  const linked = await db.collection('entity_links').find({ entity_type: 'startup', 'matcher.status': 'linked' }).sort({ entity_key: 1 }).toArray();
  const toLabel = [...linked.filter((l) => heldOut(l.entity_key)).slice(0, 1), ...linked.filter((l) => !heldOut(l.entity_key)).slice(0, 2)];
  for (const l of toLabel) {
    await recordReview(db, { entityKey: l.entity_key, companyId: l.matcher.company_id, decision: 'same', note: 'same name, district and year on both',
      user: reviewer, mode: 'label', clock });
  }
  made.labelled = toLabel.length;
  log(`labels: ${toLabel.length} of the matcher's ${linked.length} links labelled same (${toLabel.filter((l) => heldOut(l.entity_key)).length} in the held-out fold)`);

  // 8b. funding news: three items the morning's news reader proposed, in the shape it writes them
  //     (ingest/src/leadengine/news.py; invented headlines on a .example site); a reviewer confirms one,
  //     so the company's page shows it, and two wait on the Signals page
  const title = (n) => n.replace(/ PRIVATE LIMITED$/, '').toLowerCase().replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
  const newsItems = [
    [cos[2], (n) => `${n} raises ₹2 crore in a seed round led by angel investors`, 'Inc42'],
    [cos[5], (n) => `Kanpur-based ${n} secures pre-seed funding from an incubator fund`, 'YourStory'],
    [cos[11], (n) => `${n} raises $500,000 to expand across Uttar Pradesh`, 'Entrackr'],
  ];
  const signalIds = [];
  for (const [k, [c, headline, publisher]] of newsItems.entries()) {
    const url = `https://news.demo.example/${c.slug}-funding-${k + 1}`;
    const id = `news:${createHash('sha256').update(url).digest('hex').slice(0, 40)}`;
    await db.collection('signals').insertOne({ _id: id, type: 'funding', company_id: c.cin, headline: headline(title(c.name)), url,
      publisher: `${publisher} (fictional demo item)`, published_at: new Date(clock().getTime() - (k + 1) * DAY), matched_name: title(c.name).toLowerCase(),
      status: 'proposed', created_at: clock(), decided_by: null, decided_at: null, note: null });
    signalIds.push(id);
  }
  await decideSignal(db, { id: signalIds[0], decision: 'confirm', note: 'the article names the company and its city', user: reviewer, clock });
  made.signals = { proposed: signalIds.length - 1, confirmed: 1, confirmed_company: newsItems[0][0].cin };
  log(`funding news: ${signalIds.length} items proposed by the news reader (fictional), 1 confirmed by a reviewer, ${signalIds.length - 1} waiting`);

  // 9. the AI check on the unsure pair the matcher rated highest, through a stand-in gateway: its advice
  //    sits beside the candidate on the review page; a person still decides
  const llm = new LlmGateway(db, { url: 'https://gateway.demo.example', key: 'demo', cfg: cfg.llm, caps: cfg.caps, fetch: demoGateway(), clock });
  const ai = await aiCheckPairs(db, { llm, limit: 1, clock });
  made.ai_checked = ai.checked;
  log(`AI check (a stand-in gateway, advice only): ${ai.checked} review pair checked, ${ai.waiting} not yet`);

  // 10. the monitor's view of it all
  const mon = await runMonitor(db, { caps: cfg.caps, cfg: cfg.monitor, secret: DEMO_SECRET, clock });
  made.alerts = mon.open.length;
  log(`data side: ingest runs, meters, 3 portal startups to review, 8 links to label; ${mon.open.length} open alert(s)`);
  return made;
}

async function seedDataSide(db, cos, now) {
  const runs = [
    { source: 'mca_monthly', hours: 30, stats: { companies_india: 18_412, companies_up: cos.length }, notes: ['Incorporation-Report-DEMO.xlsx: period (fictional demo file)'] },
    { source: 'startinup', hours: 50, stats: { listed: 412, details_read: 37 }, notes: [] },
    { source: 'upsm', hours: 50, stats: { districts: 75, listed: 260 }, notes: [] },
    { source: 'infyner', hours: 6, stats: { basic_lookups: 31, profiles_bought: 4 }, notes: ['4 full profiles bought inside the monthly cap'] },
    { source: 'nightly', hours: 5, stats: { steps: { mca_inbox: 'ok', kb: 'ok', enrich: 'ok', need: 'ok' } }, notes: [] },
  ];
  await db.collection('ingest_runs').insertMany(runs.map((r, k) => ({ _id: `${r.source}-demo-${k}`, source: r.source, status: 'ok', params: { demo: true },
    stats: r.stats, notes: r.notes, started_at: new Date(now.getTime() - r.hours * 3_600_000), finished_at: new Date(now.getTime() - r.hours * 3_600_000 + 240_000) })));
  const day = istDay(now);
  await db.collection('usage').insertMany([
    { _id: `vendor.basic_lookup:${day}`, meter: 'vendor.basic_lookup', period: day, count: 31, cap: 100, updated_at: now },
    { _id: `vendor.full_profile:${day.slice(0, 7)}`, meter: 'vendor.full_profile', period: day.slice(0, 7), count: 4, cap: 40, updated_at: now },
  ]);
  // a portal startup's listing, as the Startup in UP reader stores it (fictional team)
  const listing = async (uplc, n, { legal, district, year, founder }) => {
    const hash = createHash('sha256').update(uplc).digest('hex');
    await db.collection('source_records').insertOne({ source: 'startinup', natural_key: uplc, content_hash: hash, payload: { uplc, legal_name: legal,
      entity_type: 'Private Limited', district, year_established: year, active_since: addDays(istDay(now), -(20 + n * 3)),
      team: [{ name: `${founder[0]} ${founder[1]}`, role: 'Founder' }] },
    legal_basis: 'published_by_company', personal_fields: ['team'], fetched_at: now, run_id: 'startinup-demo-1', schema_version: 2 });
    await db.collection('source_state').insertOne({ _id: `startinup|${uplc}`, source: 'startinup', natural_key: uplc, content_hash: hash,
      first_seen_at: now, last_seen_at: now, last_changed_at: now, versions: 1 });
  };
  // three portal startups the matcher was unsure about: the review queue
  const unsure = [[0, 'GOMTI TECH SOLUTIONS', 'Lucknow'], [5, 'TARAI AGRO VENTURES', 'Bareilly'], [10, 'SAHARAN HEALTH', 'Meerut']];
  for (const [k, [ci, legal, district]] of unsure.entries()) {
    const c = cos[ci];
    const uplc = `UPLC_${99000001 + k}`;                       // portal keys are 8 digits; the 99 million range is the demo's
    await listing(uplc, k, { legal: `${legal} PRIVATE LIMITED`, district, year: Number(c.incorporated.slice(0, 4)), founder: FOUNDERS[k + 1] });
    await db.collection('entity_links').insertOne({ _id: `startup:${uplc}`, entity_type: 'startup', entity_key: uplc, status: 'review', model_version: 'demo',
      updated_at: now, probability: 0.71 + k * 0.06, evidence: { why_review: k === 0 ? 'the name differs after "Gomti"; same district and year' : 'similar name, no year on the portal to confirm' },
      candidates: [{ company_id: c.cin, name: c.name, probability: 0.71 + k * 0.06, method: 'splink', incorporated: c.incorporated }],
      matcher: { status: 'review', company_id: null, method: 'review', probability: 0.71 + k * 0.06 } });
  }
  // eight it linked on its own (the labelling page measures these), two with a near miss beside them
  for (let k = 0; k < 8; k += 1) {
    const c = cos[12 + k];
    const other = cos[(12 + k + 9) % cos.length];
    const uplc = `UPLC_${99000106 + k}`;                       // two of these eight fall in the held-out fold
    await listing(uplc, k + 3, { legal: c.name, district: c.district, year: Number(c.incorporated.slice(0, 4)), founder: FOUNDERS[k % FOUNDERS.length] });
    const exact = k < 6;
    const p = exact ? null : 0.951 + (k - 6) * 0.017;          // never exactly 1: an integer fails the validator
    await db.collection('companies').updateOne({ _id: c.cin }, { $addToSet: { 'ids.uplc': uplc, sources: 'startinup' } });
    await db.collection('entity_links').insertOne({ _id: `startup:${uplc}`, entity_type: 'startup', entity_key: uplc, company_id: c.cin, status: 'linked',
      method: exact ? 'exact_name' : 'splink', probability: p, model_version: 'demo', updated_at: now, evidence: null, decided_by: null,
      candidates: k % 4 === 0 ? [{ company_id: other.cin, name: other.name, probability: 0.31, method: 'splink', incorporated: other.incorporated }] : [],
      matcher: { status: 'linked', company_id: c.cin, method: exact ? 'exact_name' : 'splink', probability: p } });
  }
}

export const DEMO_MARKER = 'Demonstration data: every company, person and address here is invented.';

/**
 * Eval 4: does any personal data leave the engine for an outside service?
 *
 * Canary personal data (fixtures/canaries.json) is planted where a real company's personal data sits:
 * a registered email that is a person's own, a director and a mobile in the vendor profile, the
 * founder in the portal profile's team, and a signature at the foot of the founder's reply. Then every
 * path that calls out is run with a capturing fetch: the LLM gateway's tasks (draft, quality_check,
 * match_check, reply_classify), the email verification service, and the platform's onboarding on a
 * claim (direct, and from a campaign page with its email confirmation). Each request's URL and body
 * are searched for the canaries; the phone is searched as digits, however it was spaced.
 *
 * The web search (Python, enrich/websites.py) is checked by evals/ingest_matching.py.
 */
import { digits, engine, fixture } from './common.mjs';
import { REVIEWER, buildDeps, capturingFetch, fakeDns, fakeTransport } from './harness.mjs';

const MONTH = '2026-11';
const LLM_URL = 'https://llm.gateway.solutionai.example/v1';
const PLATFORM = 'https://platform.solutionai.example';

/** A number's digits with any spacing, dashes or brackets between them: "98765 43210", "+91-98765-43210". */
const phoneRx = (d) => new RegExp(d.split('').join('[\\s\\-().+]*'));

/** Which canaries a captured request carries. */
function scan(call, canaries) {
  const text = `${call.url}\n${typeof call.body === 'string' ? call.body : JSON.stringify(call.body ?? '')}`;
  const lower = text.toLowerCase();
  const found = [];
  if (lower.includes(canaries.director_name.toLowerCase())) found.push('director name');
  if (lower.includes(canaries.personal_email.toLowerCase()) || lower.includes(encodeURIComponent(canaries.personal_email).toLowerCase())) found.push('personal email');
  if (phoneRx(digits(canaries.phone)).test(text)) found.push('mobile');
  for (const p of canaries.phone_probes) if (phoneRx(p.digits).test(text)) found.push(`number written "${p.text}"`);
  return [...new Set(found)];
}

const taskOf = (call) => {
  if (/\/chat\/completions$/.test(call.url)) {
    const b = JSON.parse(call.body);
    const sys = b.messages?.[0]?.content ?? '';
    if (/classify a reply/.test(sys)) return 'llm:reply_classify';
    if (/compare one startup/.test(sys)) return 'llm:match_check';
    if (/check an email before a person approves/.test(sys)) return 'llm:quality_check';
    return 'llm:draft';
  }
  if (/zerobounce|millionverifier/.test(call.url)) return 'email verification service';
  if (call.url.startsWith(PLATFORM)) return `platform ${new URL(call.url).pathname}`;
  return new URL(call.url).origin;
};

export async function runPrivacyEval(h) {
  const cn = fixture('canaries.json');
  const { planOutreach, JOB_DRAFT, JOB_SEND, queueSend } = await engine('src/outreach/sequence.js');
  const { MessageStore } = await engine('src/outreach/messages.js');
  const { processInbound } = await engine('src/inbound/process.js');
  const { createPublicServer } = await engine('src/public/server.js');
  await h.reset();
  let now = Date.parse('2026-11-20T06:00:00Z');                 // Friday 11:30 IST
  const clock = () => new Date(now);
  const transport = fakeTransport();
  const llmReply = JSON.stringify({ facts_only: true, no_false_claims: true, polite: true, one_next_step: true, note: 'ok', label: 'unclear', confidence: 0.5, reason: 'eval', verdicts: [] });
  const outside = capturingFetch([
    { match: /^https:\/\/llm\.gateway\.solutionai\.example\//, reply: () => ({ json: { model: 'eval-model', choices: [{ message: { content: llmReply } }], usage: { prompt_tokens: 100, completion_tokens: 20 } } }) },
    { match: /api\.zerobounce\.net/, reply: () => ({ json: { status: 'valid' } }) },
    { match: /^https:\/\/platform\.solutionai\.example\/onboarding/, reply: () => ({ json: { signup_url: `${PLATFORM}/signup/eval` } }) },
  ]);
  const env = { LLM_GATEWAY_URL: LLM_URL, LLM_GATEWAY_KEY: 'eval-key', EMAIL_VERIFY_PROVIDER: 'zerobounce', EMAIL_VERIFY_API_KEY: 'eval-key',
    PLATFORM_API_KEY: 'eval-key', PLATFORM_ONBOARDING_URL: `${PLATFORM}/onboarding`, PLATFORM_SIGNUP_URL: `${PLATFORM}/signup` };
  const { cfg, o } = await buildDeps(h, { env, clock, fetch: outside.fetch, transport, dns: fakeDns() });
  const seen = new Date('2026-11-01T00:00:00Z');
  const attr = (value, source) => ({ value, source, seen_at: seen });
  const steps = [];
  const mark = (name) => steps.push({ name, from: outside.calls.length });

  // the company: its registered email is the director's own; the vendor profile carries the director and a mobile
  const c = cn.company;
  const companyDoc = (cin, name, email) => ({ _id: cin, kind: 'company', state: 'UP', name, ids: { cin, uplc: cin === c.cin ? [c.uplc] : [] }, cohort: '2026-10',
    sources: ['mca_monthly'], first_seen_at: seen, updated_at: seen, schema_version: 2, former_names: [],
    attrs: { incorporation_date: attr(c.incorporated, 'mca_monthly'), company_type: attr('Private Limited Company', 'mca_monthly'), registered_district: attr(c.district, 'mca_monthly'),
      registered_email: attr(email, 'infyner'), directors: attr([cn.director_name], 'infyner'), phone: attr(cn.phone, 'infyner') } });
  const needs = { rules_confirmed: true, rules_version: 'eval', deadlines: [
    { id: 'share_certificates', title: 'Issue share certificates to the subscribers', form: 'SH-1 (no MCA filing)', due: '2026-12-14', status: 'upcoming', law: 'Companies Act 2013 s.56(4)(a)' },
    { id: 'first_board_meeting', title: 'Hold the first board meeting', form: 'Minutes (no MCA form)', due: '2026-11-13', status: 'was_due', law: 'Companies Act 2013 s.173(1)' }],
  schemes: [{ scheme_id: 'udyam_registration', name: 'Udyam (MSME) registration', verdict: 'eligible', benefit: 'Free registration.', missing: [] }] };
  const leadDoc = (cin, rank) => ({ company_id: cin, stage: 'shortlisted', holdout: false, eligible: true, cohort: '2026-10', shortlist: { month: MONTH, rank },
    needs, created_at: seen, updated_at: seen });
  await h.db.collection('companies').insertMany([companyDoc(c.cin, c.name, cn.personal_email), companyDoc(cn.role_company.cin, cn.role_company.name, cn.role_company.registered_email)]);
  const leadIds = (await h.db.collection('leads').insertMany([leadDoc(c.cin, 1), leadDoc(cn.role_company.cin, 2)])).insertedIds;
  await h.db.collection('people').insertOne({ name: cn.director_name, din: '12345678', company_ids: [c.cin], created_at: seen, updated_at: seen,
    contacts: [{ channel: 'email', address: cn.personal_email, source: 'infyner', legal_basis: 'published_under_law' }] });

  // 1. drafting with the LLM gateway configured, and the address check with a verification service configured
  mark('draft: the AI drafter, its review and the address check');
  await planOutreach(o, { month: MONTH });
  for (let job; (job = await o.queue.claim('eval', { types: [JOB_DRAFT] }));) await o.queue.complete(job, await o.handlers[JOB_DRAFT](job));

  // 2. the AI check on an unsure match, with the founder in the portal profile's team
  mark('match_check: the AI check on an unsure match');
  const hash = 'a'.repeat(64);
  await h.db.collection('source_state').insertOne({ _id: `startinup|${c.uplc}`, source: 'startinup', natural_key: c.uplc, content_hash: hash,
    first_seen_at: seen, last_seen_at: seen, last_changed_at: seen, versions: 1 });
  await h.db.collection('source_records').insertOne({ source: 'startinup', natural_key: c.uplc, content_hash: hash, legal_basis: 'published_by_company',
    personal_fields: ['team'], fetched_at: seen, run_id: 'eval', schema_version: 1,
    payload: { legal_name: 'Zephyra Herbals Pvt Ltd', brand: 'Zephyra', entity_type: 'Private Limited', year_established: '2026', district: c.district,
      sector: 'Healthcare & Life-Sciences', website: 'https://zephyraherbals.example', team: [{ name: cn.director_name, role: 'Founder' }] } });
  await h.db.collection('entity_links').insertOne({ _id: `startup:${c.uplc}`, entity_type: 'startup', entity_key: c.uplc, status: 'review', model_version: 'eval',
    probability: 0.6, candidates: [{ company_id: c.cin, name: c.name, probability: 0.6 }], updated_at: seen });
  let matchNote = null;
  try {
    const { aiCheckPairs } = await engine('src/admin/ai_check.js');
    await aiCheckPairs(h.db, { llm: o.llm, clock });
  } catch (err) {
    matchNote = `not run: ${err.message}`;
  }

  // 3. the founder replies; the rules are unsure, so the small model is asked
  const msg = await h.db.collection('messages').findOne({ company_id: c.cin, status: 'awaiting_approval' });
  let replyNote = null;
  if (msg) {
    const store = new MessageStore(h.db, { clock });
    const d = await store.decide(msg._id, { decision: 'approve', user: REVIEWER, cfg: o.cfg, org: o.org });
    await queueSend(o.queue, d.message);
    await o.handlers[JOB_SEND](await o.queue.claim('eval', { types: [JOB_SEND] }));
  }
  const sent = await h.db.collection('messages').findOne({ company_id: c.cin, status: 'sent' });
  const replies = [
    ['reply_classify: a signature without a "-- " line', `Thank you for the note about the dates.\r\n\r\nRegards,\r\n${cn.director_name}\r\nDirector\r\nMobile: ${cn.phone}\r\n${cn.personal_email}`],
    ['reply_classify: a signature after a "-- " line', `Thank you for the note about the dates.\r\n\r\n-- \r\n${cn.director_name}\r\nDirector\r\nMobile: ${cn.phone}`],
    ['reply_classify: numbers written other ways', `Noted, thank you. The office number is ${cn.phone_probes[1].text} and my other number is ${cn.phone_probes[0].text}.`],
  ];
  if (sent?.send?.message_id) {
    now = Date.parse('2026-11-23T06:00:00Z');
    let uid = 100;
    for (const [name, body] of replies) {
      mark(name);
      uid += 1;
      const raw = [`From: ${cn.director_name} <${cn.personal_email}>`, `To: ${sent.mailbox}@outreach.solutionai.example`, `Subject: Re: ${sent.draft.subject}`,
        `Message-ID: <eval-reply-${uid}@vezrasmail.example>`, `In-Reply-To: ${sent.send.message_id}`, `References: ${sent.send.message_id}`,
        'Date: Mon, 23 Nov 2026 11:30:00 +0530', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body, ''].join('\r\n');
      await processInbound(o, { mailbox: sent.mailbox, uid, uidvalidity: 1, internalDate: clock(), raw });
    }
  } else replyNote = `not run: the first email was not sent (${msg ? 'the gate stopped it' : 'no draft'})`;

  // 4. claims: a direct one from an emailed page, and one from a campaign page with its email confirmation
  const claimResult = { direct: null, campaign: null };
  const links = [];
  o.cfg.campaigns = [cn.campaign];
  const srv = createPublicServer({ db: h.db, tokens: o.tokens, ledger: o.ledger, suppression: o.suppression, queue: o.queue, platform: o.platform, cfg: o.cfg, org: o.org,
    secret: 'p'.repeat(40), privacyUrl: 'https://solutionai.example/privacy', privacyContact: 'privacy@solutionai.example', clock, log: { warn() {}, error() {}, info() {} },
    confirm: { send: async (x) => { links.push(x); return { transport: 'eval' }; } } });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = (url, fields) => fetch(url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
  const claimVia = async (token, company) => {
    const form = await (await fetch(`${base}/c/${token}/claim`)).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(form)?.[1];
    const fields = [['csrf', csrf ?? ''], ['name', cn.claimant.name], ['role', 'Director'], ['email', cn.claimant.email], ['whatsapp', cn.claimant.whatsapp],
      ['call_slot', 'any'], ['call_language', 'en'], ['consent', 'email_reminders']];
    return post(`${base}/c/${token}/claim`, fields).then(async (r) => ({ status: r.status, company }));
  };
  try {
    now = Date.parse('2026-11-24T06:00:00Z');
    mark('platform onboarding: a direct claim');
    const direct = await claimVia(await o.tokens.issue({ purpose: 'company_page', companyId: cn.role_company.cin, leadId: leadIds[1] }), cn.role_company.cin);
    claimResult.direct = { status: direct.status, onboarding_calls: outside.calls.filter((x) => x.url.includes('/onboarding')).length };

    mark('platform onboarding: a campaign claim, before and after its email confirmation');
    const before = { calls: outside.calls.length, consents: await h.db.collection('consents').countDocuments({}) };
    const pageToken = await o.tokens.issue({ purpose: 'company_page', companyId: c.cin, leadId: leadIds[0], campaign: `campaign:${cn.campaign.code}` });
    const asked = await claimVia(pageToken, c.cin);
    const waiting = {
      status: asked.status,
      outside_calls: outside.calls.length - before.calls,
      consents: (await h.db.collection('consents').countDocuments({})) - before.consents,
      claimed: await h.db.collection('activities').countDocuments({ type: 'claimed', company_id: c.cin }),
      confirmation_to: links.map((l) => l.to),
    };
    let confirmed = null;
    if (links.length) {
      const link = `${base}/k/${links[0].token}`;
      const page = await (await fetch(link)).text();
      const kcsrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1];
      const done = await post(link, { csrf: kcsrf ?? '' });
      confirmed = { status: done.status, claimed: await h.db.collection('activities').countDocuments({ type: 'claimed', company_id: c.cin }),
        onboarding_calls: outside.calls.filter((x) => x.url.includes('/onboarding')).length - claimResult.direct.onboarding_calls };
    }
    claimResult.campaign = { waiting, confirmed };
  } finally {
    srv.close();
  }
  mark('end');

  // which canary went where
  const paths = [];
  for (let i = 0; i < steps.length - 1; i += 1) {
    const calls = outside.calls.slice(steps[i].from, steps[i + 1].from);
    const byTask = {};
    for (const call of calls) {
      const t = taskOf(call);
      const r = (byTask[t] ??= { calls: 0, leaked: new Set() });
      r.calls += 1;
      for (const f of scan(call, cn)) r.leaked.add(f);
    }
    paths.push({ step: steps[i].name, by_service: Object.fromEntries(Object.entries(byTask).map(([k, v]) => [k, { calls: v.calls, leaked: [...v.leaked] }])) });
  }
  const providerCalls = outside.calls.filter((x) => /zerobounce/.test(x.url));
  const leaks = paths.flatMap((p) => Object.entries(p.by_service).filter(([, v]) => v.leaked.length).map(([svc, v]) => ({ step: p.step, service: svc, leaked: v.leaked })));
  // the founder's own claim details are meant to reach the platform (they typed them, to sign up): not a leak
  const claimantSent = outside.calls.filter((x) => x.url.includes('/onboarding')).map((x) => JSON.parse(x.body).contact);
  return {
    paths, leaks, notes: { match_check: matchNote, reply_classify: replyNote },
    verification: { calls: providerCalls.length, addresses: providerCalls.map((x) => new URL(x.url).searchParams.get('email')) },
    claims: claimResult, claimant_sent_to_platform: claimantSent,
    outside_calls: outside.calls.length, services: [...new Set(outside.calls.map(taskOf))],
    cfg_used: { llm: Boolean(cfg.env.LLM_GATEWAY_KEY) },
  };
}

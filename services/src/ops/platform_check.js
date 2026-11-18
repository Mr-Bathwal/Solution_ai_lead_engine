import { signBody } from '../attribution/events.js';
import { LlmUnavailable } from '../outreach/llm.js';

/**
 * Checks the platform's endpoints against the contract (docs/PLATFORM_CONTRACTS.md and
 * docs/platform-openapi.yaml), the moment Murari's team says one is ready: `lead-engine platform:check`.
 *
 *   rules engine   one fictional company's facts; the answer must be a rules_version and verdicts in
 *                  the agreed shape, with no "not eligible" for a fact the engine does not know
 *   onboarding     one fictional claim, marked as a test (header X-Lead-Engine-Test: 1, source.test);
 *                  the answer must carry an https signup_url
 *   notify         only with --notify-to <a team address>: one test reminder to that address
 *   LLM gateway    only with --llm: one tiny call, logged and costed like any other
 *   events         prints a signed test event the platform can send to /api/events (ids starting
 *                  test_ are checked but never recorded), so both sides test the same bytes
 *
 * Nothing about a real company or person is ever sent.
 */

const TEST_COMPANY = { id: 'U99999UP2026PTC000001', name: 'SolutionAI Contract Test Private Limited', kind: 'company',
  legal_form: 'Private Limited Company', incorporated: '2026-10-14', district: 'Lucknow', state: 'UP' };
const VERDICTS = new Set(['eligible', 'check_required', 'not_eligible', 'closed', 'held']);
const r = (area, name, status, detail, fix) => ({ area, name, status, detail, fix });

async function post(fetch, url, key, body, extraHeaders = {}) {
  const started = Date.now();
  const res = await fetch(url, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-lead-engine-test': '1', ...extraHeaders } });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* checked below */ }
  return { status: res.status, json, text, ms: Date.now() - started };
}

export async function platformCheck({ cfg, deps, fetch = globalThis.fetch, notifyTo = null, llm = false, clock = () => new Date() }) {
  const env = cfg.env ?? {};
  const out = [];

  // ---- the rules engine -------------------------------------------------------------------------------
  if (!env.RULES_ENGINE_URL) out.push(r('platform', 'rules engine', 'skip', 'RULES_ENGINE_URL not set'));
  else {
    try {
      const a = await post(fetch, `${env.RULES_ENGINE_URL.replace(/\/+$/, '')}/v1/verdicts`, env.RULES_ENGINE_KEY ?? '', { company: {
        kind: 'company', type_code: 'PTC', state: 'UP', incorporated: TEST_COMPANY.incorporated, as_of: clock().toISOString().slice(0, 10),
        district: 'Lucknow', sector: 'SaaS, IT & Cloud', stage: null, startinup_listed: false, incubated: false, dpiit_recognised: null } });
      const problems = [];
      if (a.status !== 200) problems.push(`answered ${a.status}`);
      if (!a.json) problems.push('the answer is not JSON');
      else {
        if (typeof a.json.rules_version !== 'string') problems.push('no rules_version');
        if (!Array.isArray(a.json.verdicts)) problems.push('no verdicts list');
        for (const v of a.json.verdicts ?? []) {
          if (!v.scheme_id || !v.name) problems.push(`a verdict without scheme_id or name: ${JSON.stringify(v).slice(0, 80)}`);
          if (!VERDICTS.has(v.verdict)) problems.push(`${v.scheme_id}: unknown verdict "${v.verdict}"`);
          if (v.verdict === 'closed' && !v.valid_until) problems.push(`${v.scheme_id}: closed without valid_until`);
          if (v.scheme_id === 'dpiit_recognition' && v.verdict === 'not_eligible') problems.push('DPIIT recognition is "not eligible" although recognition is unknown: it should be check_required');
        }
      }
      if (a.ms > 10_000) problems.push(`took ${a.ms} ms; the engine waits 10 s`);
      out.push(problems.length ? r('platform', 'rules engine', 'fail', problems.slice(0, 4).join('; '), 'PLATFORM_CONTRACTS.md section 1')
        : r('platform', 'rules engine', 'pass', `${a.json.verdicts.length} verdicts, rules ${a.json.rules_version}, ${a.ms} ms`));
    } catch (err) {
      out.push(r('platform', 'rules engine', 'fail', err.message, 'is RULES_ENGINE_URL reachable from this server?'));
    }
  }

  // ---- onboarding -------------------------------------------------------------------------------------
  if (!env.PLATFORM_ONBOARDING_URL || !env.PLATFORM_API_KEY) out.push(r('platform', 'onboarding', 'skip', 'PLATFORM_ONBOARDING_URL or PLATFORM_API_KEY not set'));
  else {
    try {
      const a = await post(fetch, env.PLATFORM_ONBOARDING_URL, env.PLATFORM_API_KEY, {
        company: TEST_COMPANY,
        contact: { name: 'Contract Test', role: 'Director', email: notifyTo ?? 'contract-test@solutionai.in', whatsapp: null },
        consents: [{ channel: 'email', purpose: 'deadline_reminders', wording: `Email me reminders of ${TEST_COMPANY.name}'s filing deadlines.`, wording_version: cfg.outreach.claim.wording_version }],
        source: { engine: 'lead-engine', claimed_at: clock().toISOString(), test: true },
      });
      const url = a.json?.signup_url;
      out.push(a.status === 200 && typeof url === 'string' && /^https:\/\//.test(url) ? r('platform', 'onboarding', 'pass', `signup_url returned in ${a.ms} ms`)
        : r('platform', 'onboarding', 'fail', `answered ${a.status}${url ? `, signup_url ${url.slice(0, 60)} is not https` : ', without signup_url'}`, 'PLATFORM_CONTRACTS.md section 3.1'));
    } catch (err) {
      out.push(r('platform', 'onboarding', 'fail', err.message, 'is PLATFORM_ONBOARDING_URL reachable from this server?'));
    }
  }

  // ---- notify -----------------------------------------------------------------------------------------
  if (!deps.platform.canNotify) out.push(r('platform', 'notify', 'skip', 'PLATFORM_NOTIFY_URL or PLATFORM_API_KEY not set'));
  else if (!notifyTo) out.push(r('platform', 'notify', 'skip', 'configured; run with --notify-to <a team address> to send one test reminder'));
  else {
    try {
      const a = await post(fetch, env.PLATFORM_NOTIFY_URL, env.PLATFORM_API_KEY, { channel: 'email', to: notifyTo, type: 'deadline_reminder',
        company: { id: TEST_COMPANY.id, name: TEST_COMPANY.name }, title: `${TEST_COMPANY.name}: a test reminder from the lead engine`,
        deadline: { id: 'inc_20a', title: 'File the declaration for commencement of business', form: 'INC-20A', due: '2027-04-12', law: 'Companies Act 2013 s.10A' },
        link: `${(cfg.publicBaseUrl || 'https://pages.example.in').replace(/\/+$/, '')}/c/test` });
      out.push(a.status === 200 ? r('platform', 'notify', 'pass', `accepted in ${a.ms} ms${a.json?.id ? ` (id ${a.json.id})` : ''}; check ${notifyTo}'s inbox`)
        : r('platform', 'notify', 'fail', `answered ${a.status}`, 'PLATFORM_CONTRACTS.md section 3.2'));
    } catch (err) {
      out.push(r('platform', 'notify', 'fail', err.message, 'is PLATFORM_NOTIFY_URL reachable from this server?'));
    }
  }

  // ---- the LLM gateway --------------------------------------------------------------------------------
  if (!deps.llm.configured) out.push(r('platform', 'LLM gateway', 'skip', 'LLM_GATEWAY_URL or LLM_GATEWAY_KEY not set'));
  else if (!llm) out.push(r('platform', 'LLM gateway', 'skip', 'configured; run with --llm for one tiny test call'));
  else {
    try {
      const a = await deps.llm.chat({ task: 'reply_classify', messages: [{ role: 'system', content: 'Answer with JSON only: {"label": "unclear", "confidence": 1, "reason": "test"}' }, { role: 'user', content: '{"reply": "test"}' }] });
      out.push(r('platform', 'LLM gateway', 'pass', `model ${a.model}, ${a.inputTokens + a.outputTokens} tokens, ₹${a.costInr.toFixed(4)}`));
    } catch (err) {
      out.push(r('platform', 'LLM gateway', 'fail', err instanceof LlmUnavailable ? err.message : String(err), 'PLATFORM_CONTRACTS.md section 3.3'));
    }
  }

  // ---- events: what the platform should send ----------------------------------------------------------
  if ((cfg.platformEventsSecret ?? '').length < 32) out.push(r('engine', 'events', 'warn', 'PLATFORM_EVENTS_SECRET not set: /api/events refuses every event', 'share a secret with the platform'));
  else {
    const body = JSON.stringify({ events: [{ id: `test_${clock().getTime()}`, type: 'paid', at: clock().toISOString(), company_id: TEST_COMPANY.id, amount_paise: 100, currency: 'INR', service: 'contract_test' }] });
    out.push({ ...r('engine', 'events', 'pass', 'ready; the platform can send this signed test event (checked, never recorded):'),
      example: `curl -X POST https://<admin host>/api/events -H 'content-type: application/json' -H 'x-signature: ${signBody(cfg.platformEventsSecret, body)}' --data '${body}'` });
  }
  return out;
}

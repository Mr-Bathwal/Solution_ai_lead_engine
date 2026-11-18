import { LlmUnavailable } from '../outreach/llm.js';
import { startupView } from './queries.js';

/**
 * The AI check on unsure matches (design 7.2: "pairs Splink is unsure about are sent to a small AI
 * model for a yes or no with a short reason, which is logged"). `lead-engine kb:ai-check`, daily
 * after the nightly build, once the LLM gateway has the engine's key.
 *
 * It advises; it never decides. Its verdict and reason sit beside each candidate on the review page,
 * and a person's decision is still the one that counts (the matcher has made wrong links that looked
 * right before: design 7.2's 95% target is measured on people's labels). Only company-level facts
 * go to the model: names, the type of entity, years and districts; never a portal team member's name.
 * Every call is in llm_calls with its tokens and cost, within the month's AI cap.
 */

export const TASK = 'match_check';
const SYSTEM = `You compare one startup listed on an Indian government startup portal with candidate companies from the
Ministry of Corporate Affairs register, and say for each candidate whether it is the same business.
Use only the facts given. Indian company names drop or change words like "Private Limited", "Pvt Ltd", "(OPC)",
"Technologies" or "Solutions" between sources; a startup's brand can differ from its legal name. A different
year of incorporation or a different district is strong evidence against. When the facts do not settle it, say unsure.
Answer with JSON only: {"verdicts": [{"company_id": "<CIN or LLPIN>", "same": "yes" | "no" | "unsure", "reason": "<at most 25 words>"}]}.`;

function facts(startup, candidates) {
  const s = {
    names: [startup.legal_name, startup.brand, startup.upsm_name].filter(Boolean),
    entity_type: startup.entity_type ?? null, year_established: startup.year ?? null,
    on_portal_since: startup.since ?? null, district: startup.district ?? startup.upsm_district ?? null, sector: startup.sector ?? null,
  };
  const c = candidates.map((x) => ({ company_id: x.company_id, name: x.name, incorporated: x.incorporated ?? null, district: x.district ?? null,
    company_type: x.company_type ?? null }));
  return JSON.stringify({ startup: s, candidates: c });
}

/** Parses the model's answer; only verdicts on the candidates that were asked about are kept. */
export function parseVerdicts(content, candidateIds) {
  let j;
  try {
    j = JSON.parse(content);
  } catch {
    return null;
  }
  if (!Array.isArray(j?.verdicts)) return null;
  const out = [];
  for (const v of j.verdicts) {
    if (!candidateIds.includes(v?.company_id) || !['yes', 'no', 'unsure'].includes(v?.same)) continue;
    if (out.some((o) => o.company_id === v.company_id)) continue;
    out.push({ company_id: v.company_id, same: v.same, reason: String(v.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 240) });
  }
  return out.length ? out : null;
}

/** Checks up to `limit` unsure pairs that have no AI verdict yet. Returns what it did. */
export async function aiCheckPairs(db, { llm, limit = 50, clock = () => new Date(), log = () => {} }) {
  if (!llm?.configured) return { checked: 0, skipped: 'the LLM gateway is not configured (LLM_GATEWAY_URL and LLM_GATEWAY_KEY)' };
  const links = await db.collection('entity_links').find({ status: 'review', ai_check: { $exists: false } }).sort({ probability: -1, entity_key: 1 }).limit(limit).toArray();
  let checked = 0;
  let unusable = 0;
  for (const link of links) {
    const startup = await startupView(db, link.entity_key);          // without the team: never a person's name
    const cands = (link.candidates ?? []).slice(0, 3);
    const companies = new Map((await db.collection('companies').find({ _id: { $in: cands.map((c) => c.company_id) } },
      { projection: { name: 1, 'attrs.incorporation_date.value': 1, 'attrs.registered_district.value': 1, 'attrs.district.value': 1, 'attrs.company_type.value': 1 } })
      .toArray()).map((c) => [c._id, c]));
    const candidates = cands.map((c) => {
      const co = companies.get(c.company_id);
      return { company_id: c.company_id, name: co?.name ?? c.name, incorporated: co?.attrs?.incorporation_date?.value ?? c.incorporated ?? null,
        district: co?.attrs?.registered_district?.value ?? co?.attrs?.district?.value ?? null, company_type: co?.attrs?.company_type?.value ?? null };
    });
    let r;
    try {
      r = await llm.chat({ task: TASK, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: facts(startup, candidates) }] });
    } catch (err) {
      if (err instanceof LlmUnavailable) return { checked, unusable, stopped: err.message };
      throw err;
    }
    const verdicts = parseVerdicts(r.content, candidates.map((c) => c.company_id));
    if (!verdicts) {
      unusable += 1;
      log(`${link.entity_key}: the answer could not be used`);
      continue;                                                    // asked again on the next run
    }
    await db.collection('entity_links').updateOne({ _id: link._id, status: 'review' }, { $set: {
      ai_check: { at: clock(), model: r.model, prompt_version: llm.cfg?.tasks?.[TASK]?.prompt_version ?? null, verdicts } } });
    checked += 1;
  }
  return { checked, unusable, waiting: await db.collection('entity_links').countDocuments({ status: 'review', ai_check: { $exists: false } }) };
}

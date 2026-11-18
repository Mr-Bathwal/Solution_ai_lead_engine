/**
 * Read models for the Admin pages and their JSON API. Nothing here writes, except recordReview and
 * auditPersonalView. Personal data (directors' names, team members published on the portals, a
 * registered email that belongs to a person) is returned only when the caller asks for it, and the
 * caller logs that. Portal team members leave this module only as a count unless the caller asks
 * for personal data; the review queue never asks.
 */
import { emailIsPersonal } from '../util/normalize.js';

export { emailIsPersonal };
export const STAGES = ['discovered', 'shortlisted', 'contacted', 'engaged', 'claimed', 'customer', 'closed'];

export function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function maskEmail(email) {
  if (!email || typeof email !== 'string') return email;
  const at = email.lastIndexOf('@');
  return at < 0 ? '•••' : `${email.slice(0, 1)}•••@${email.slice(at + 1)}`;
}

/**
 * Whether a company's registered email is a person's. The data side stores `personal: true|false`
 * on the attribute when it writes it; older records without the flag are judged here by the same rule.
 */
export function registeredEmailIsPersonal(attr) {
  if (!attr || typeof attr.value !== 'string' || !attr.value.trim()) return false;
  // Personal if either side says so: the flag the data side stored, or the rule applied here. The two
  // use the same rule, so they disagree only when one of them is stale, and then masking is the safe side.
  return attr.personal === true || emailIsPersonal(attr.value);
}

/**
 * A link target from data (rules files, the platform's rules engine) that is safe in an href: an
 * http or https URL, or null. Browsers drop tabs, newlines and leading spaces in a URL, so those are
 * removed before the scheme is checked ("java\tscript:" is still javascript:).
 */
export function safeHref(u) {
  if (typeof u !== 'string') return null;
  const s = u.replace(/[\u0000- \u007f]/g, '');
  return /^https?:\/\/[^/]/i.test(s) ? u.trim() : null;
}

function withSafeLinks(item) {
  if (!item || typeof item !== 'object') return item;
  const out = { ...item };
  for (const k of ['source_url', 'apply_url']) if (k in out) out[k] = safeHref(out[k]);
  return out;
}

/** A lead's needs with every link target checked (the pages render them as hrefs). */
function safeNeeds(needs) {
  const out = { ...needs };
  for (const k of ['deadlines', 'schemes']) if (Array.isArray(out[k])) out[k] = out[k].map(withSafeLinks);
  if (out.next_deadline) out.next_deadline = withSafeLinks(out.next_deadline);
  return out;
}

export async function pipeline(db, { month }) {
  const leads = db.collection('leads');
  const [stages, cohorts, themes, districts, links, shortlistRows, runs, usage, rules, totals] = await Promise.all([
    leads.aggregate([{ $group: { _id: { s: '$stage', h: '$holdout' }, n: { $sum: 1 } } }]).toArray(),
    leads.aggregate([
      { $group: {
        _id: '$cohort', total: { $sum: 1 }, eligible: { $sum: { $cond: ['$eligible', 1, 0] } },
        holdout: { $sum: { $cond: ['$holdout', 1, 0] } },
        ...Object.fromEntries(STAGES.slice(1).map((s) => [s, { $sum: { $cond: [{ $eq: ['$stage', s] }, 1, 0] } }])),
      } },
      { $sort: { _id: -1 } }, { $limit: 12 },
    ]).toArray(),
    leads.aggregate([{ $match: { eligible: true } }, { $group: { _id: '$score.theme.name', n: { $sum: 1 } } },
      { $sort: { n: -1 } }, { $limit: 10 }]).toArray(),
    db.collection('companies').aggregate([
      { $project: { d: { $ifNull: ['$attrs.registered_district.value', '$attrs.district.value'] } } },
      { $match: { d: { $type: 'string' } } }, { $group: { _id: '$d', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 10 },
    ]).toArray(),
    db.collection('entity_links').aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray(),
    leads.aggregate([
      { $match: { 'shortlist.month': month } }, { $sort: { 'shortlist.rank': 1 } }, { $limit: 300 },
      { $lookup: { from: 'companies', localField: 'company_id', foreignField: '_id', as: 'c',
        pipeline: [{ $project: { name: 1, cohort: 1, 'attrs.district.value': 1, 'attrs.registered_district.value': 1 } }] } },
      { $project: { company_id: 1, holdout: 1, stage: 1, shortlist: 1, 'score.fit': 1, 'score.theme.name': 1,
        'needs.next_deadline': 1, next_action: 1, c: { $first: '$c' } } },
    ]).toArray(),
    db.collection('ingest_runs').aggregate([{ $sort: { started_at: -1 } }, { $group: { _id: '$source', run: { $first: '$$ROOT' } } },
      { $sort: { _id: 1 } }]).toArray(),
    db.collection('usage').find({}).sort({ period: -1 }).limit(12).toArray(),
    leads.findOne({ needs: { $ne: null } }, { projection: { 'needs.rules_confirmed': 1, 'needs.verdicts_by': 1, 'needs.rules_version': 1, 'needs.computed_at': 1 } }),
    db.collection('companies').aggregate([{ $group: { _id: '$kind', n: { $sum: 1 } } }]).toArray(),
  ]);
  const byStage = Object.fromEntries(STAGES.map((s) => [s, 0]));
  let holdout = 0;
  for (const r of stages) {
    if (r._id.h) holdout += r.n;
    else byStage[r._id.s] = (byStage[r._id.s] ?? 0) + r.n;
  }
  return {
    month,
    companies: Object.fromEntries(totals.map((t) => [t._id, t.n])),
    funnel: byStage,
    holdout,
    cohorts,
    themes,
    districts,
    links: Object.fromEntries(links.map((l) => [l._id, l.n])),
    shortlist: shortlistRows.map((r) => ({
      rank: r.shortlist.rank, company_id: r.company_id, name: r.c?.name, cohort: r.c?.cohort,
      district: r.c?.attrs?.registered_district?.value ?? r.c?.attrs?.district?.value ?? null,
      fit: r.score?.fit, theme: r.score?.theme?.name, holdout: r.holdout, stage: r.stage,
      fit_at_rank: r.shortlist?.fit ?? null, ranked_at: r.shortlist?.as_of ?? null,   // the fit when the month was ranked
      next_deadline: withSafeLinks(r.needs?.next_deadline ?? null), next_action: r.next_action ?? null,
    })),
    runs: runs.map((r) => ({ source: r._id, status: r.run.status, started_at: r.run.started_at, finished_at: r.run.finished_at,
      id: r.run._id, notes: (r.run.notes ?? []).slice(-3) })),
    usage,
    rules: rules?.needs ?? null,
  };
}

export async function listCompanies(db, { q = '', stage, cohort, page = 1, size = 50 }) {
  const filter = {};
  const term = String(q).trim();
  if (term) {
    filter.$or = /^[A-Z0-9-]{8,21}$/i.test(term)
      ? [{ _id: term.toUpperCase() }]
      : [{ name: { $regex: escapeRegex(term), $options: 'i' } }];
  }
  if (cohort) filter.cohort = cohort;
  let ids = null;
  if (stage) {
    const lf = stage === 'holdout' ? { holdout: true } : { stage, holdout: false };
    ids = (await db.collection('leads').find(lf, { projection: { company_id: 1 } }).toArray()).map((l) => l.company_id);
    filter._id = filter._id ? filter._id : { $in: ids };
  }
  const col = db.collection('companies');
  const [total, rows] = await Promise.all([
    col.countDocuments(filter),
    col.find(filter, { projection: { name: 1, kind: 1, cohort: 1, 'attrs.district.value': 1, 'attrs.registered_district.value': 1,
      'ids.uplc': 1 } }).sort({ cohort: -1, name: 1 }).skip((page - 1) * size).limit(size).toArray(),
  ]);
  const leads = new Map((await db.collection('leads').find({ company_id: { $in: rows.map((r) => r._id) } },
    { projection: { company_id: 1, stage: 1, holdout: 1, 'score.fit': 1, eligible: 1 } }).toArray()).map((l) => [l.company_id, l]));
  return {
    total, page, size,
    rows: rows.map((r) => ({ id: r._id, name: r.name, kind: r.kind, cohort: r.cohort,
      district: r.attrs?.registered_district?.value ?? r.attrs?.district?.value ?? null,
      portal: (r.ids?.uplc ?? []).length > 0, lead: leads.get(r._id) ?? null })),
  };
}

/**
 * One portal startup as the portals list it now. Team members are personal data: only their number
 * leaves here, unless the caller asks for personal data (and is then responsible for logging it).
 */
export async function startupView(db, uplc, { personal = false } = {}) {
  const states = await db.collection('source_state').find({ _id: { $in: [`startinup|${uplc}`, `upsm|${uplc}`] } }).toArray();
  const out = { uplc };
  for (const st of states) {
    const rec = await db.collection('source_records').findOne(
      { source: st.source, natural_key: st.natural_key, content_hash: st.content_hash },
      { projection: { payload: 1, personal_fields: 1, url: 1, fetched_at: 1 } },
    );
    if (!rec) continue;
    const p = rec.payload;
    if (st.source === 'startinup') {
      const team = Array.isArray(p.team) ? p.team : [];       // personal whether or not the record flags it
      Object.assign(out, { legal_name: p.legal_name, brand: p.brand, entity_type: p.entity_type, year: p.year_established,
        since: p.active_since ?? p.logo_date, district: p.district, sector: p.sector, stage: p.stage, website: p.website,
        incubator: p.incubator, team_count: team.length, startinup_seen: st.last_seen_at,
        ...(personal ? { team: team.map((t) => ({ name: t?.name ?? '', role: t?.role ?? '' })) } : {}) });
    } else {
      Object.assign(out, { upsm_name: p.startup_name, upsm_district: p.startup_address_district, upsm_seen: st.last_seen_at });
    }
  }
  return out;
}

export async function companyView(db, id, { personal = false } = {}) {
  const company = await db.collection('companies').findOne({ _id: id });
  if (!company) return null;
  const uplcs = company.ids?.uplc ?? [];
  const [lead, links, candidateOf, records, enrichment, activities, people, signals] = await Promise.all([
    db.collection('leads').findOne({ company_id: id }),
    db.collection('entity_links').find({ company_id: id }).toArray(),
    db.collection('entity_links').find({ status: 'review', 'candidates.company_id': id }).toArray(),
    db.collection('source_records').find({ $or: [{ source: 'mca_monthly', natural_key: id }, { natural_key: { $in: uplcs } }] },
      { projection: { source: 1, natural_key: 1, fetched_at: 1, run_id: 1, url: 1, content_hash: 1 } }).sort({ fetched_at: 1 }).toArray(),
    db.collection('enrichment_cache').find({ key: id }, { projection: { result: 0 } }).toArray(),
    db.collection('activities').find({ company_id: id }).sort({ at: 1 }).limit(200).toArray(),
    db.collection('people').find({ company_ids: id }, { projection: { name: 1, din: 1 } }).toArray(),
    // funding news a person confirmed (admin/signals.js); proposed and rejected ones stay on the Signals page
    db.collection('signals').find({ company_id: id, status: 'confirmed' },
      { projection: { headline: 1, url: 1, publisher: 1, published_at: 1, decided_at: 1, created_at: 1 } }).sort({ created_at: -1 }).limit(20).toArray(),
  ]);
  const startups = await Promise.all(uplcs.map((u) => startupView(db, u, { personal })));
  const personalFields = [];
  const emailAttr = company.attrs?.registered_email;
  const emailPersonal = registeredEmailIsPersonal(emailAttr);
  if (people.length) personalFields.push('directors');
  if (startups.some((s) => s.team_count)) personalFields.push('portal_team');
  if (emailPersonal) personalFields.push('registered_email');
  if (!personal) {
    for (const s of startups) s.team = s.team_count ? [{ name: `${s.team_count} team member(s), hidden`, role: '' }] : [];
    if (emailPersonal) emailAttr.value = maskEmail(emailAttr.value);
  }
  if (lead?.needs) lead.needs = safeNeeds(lead.needs);
  const timeline = [
    { at: company.first_seen_at, what: 'Company record created', detail: (company.sources ?? []).join(', ') },
    ...records.map((r) => ({ at: r.fetched_at, what: `${r.source} record`, detail: r.natural_key })),
    ...links.map((l) => ({ at: l.updated_at, what: `Linked to portal startup ${l.entity_key}`, detail: `${l.method}${l.decided_by && l.decided_by !== 'matcher' ? ` by ${l.decided_by}` : ''}` })),
    ...enrichment.map((e) => ({ at: e.fetched_at, what: `${e.provider} ${e.op}`, detail: e.status })),
    ...(lead?.shortlist ? [{ at: lead.score?.computed_at, what: `Shortlisted for ${lead.shortlist.month}`, detail: `rank ${lead.shortlist.rank}${lead.holdout ? ' (holdout: not contacted)' : ''}` }] : []),
    ...activities.map((a) => ({ at: a.at, what: `${a.type}${a.channel ? ` (${a.channel})` : ''}`, detail: a.campaign ?? '' })),
  ].filter((t) => t.at).sort((a, b) => new Date(a.at) - new Date(b.at));
  return {
    company, lead, links, candidate_of: candidateOf, startups, timeline,
    signals: signals.map((s) => ({ id: s._id, headline: s.headline, url: safeHref(s.url), publisher: s.publisher,
      published_at: s.published_at ?? null, confirmed_at: s.decided_at ?? null })),
    directors: personal ? people.map((p) => ({ name: p.name, din: p.din })) : people.length ? [{ name: `${people.length} director(s), hidden`, din: '' }] : [],
    personal_fields: personalFields, personal_shown: personal,
  };
}

export async function reviewQueue(db, { limit = 50 } = {}) {
  const items = await db.collection('entity_links').find({ status: 'review' }).sort({ probability: -1, entity_key: 1 }).limit(limit).toArray();
  const out = [];
  for (const it of items) {
    out.push({ entity_key: it.entity_key, startup: await startupView(db, it.entity_key), evidence: it.evidence ?? {},
      candidates: it.candidates ?? [], probability: it.probability, ai_check: it.ai_check ?? null });
  }
  const decided = await db.collection('match_reviews').countDocuments({});
  return { items: out, waiting: await db.collection('entity_links').countDocuments({ status: 'review' }), decided,
    signals_waiting: await db.collection('signals').countDocuments({ status: 'proposed' }) };   // funding news to check (admin/signals.js)
}

/**
 * A person's decision on a pair, from the review queue or the labelling page (`mode` "label"): any
 * pair the matcher proposed, linked, or linked on its own before a person decided.
 */
export async function recordReview(db, { entityKey, companyId, decision, note, user, mode = 'review', clock = () => new Date() }) {
  if (!['same', 'different', 'unsure'].includes(decision)) throw new RangeError('decision must be same, different or unsure');
  const link = await db.collection('entity_links').findOne({ _id: `startup:${entityKey}` });
  const proposed = link && ((link.candidates ?? []).some((c) => c.company_id === companyId) || link.company_id === companyId
    || link.matcher?.company_id === companyId);
  if (!proposed) throw new RangeError('that pair is not a candidate the matcher proposed');
  const now = clock();
  const _id = `startup:${entityKey}|${companyId}`;
  // the audit row first: a decision that could not be logged is not saved
  await db.collection('audit_log').insertOne({ at: now, actor: user.email, role: user.role, action: 'review_decision',
    target: { type: 'startup', id: entityKey }, fields: null, detail: { company_id: companyId, decision, ...(mode === 'label' ? { mode } : {}) } });
  await db.collection('match_reviews').replaceOne({ _id }, {
    _id, entity_type: 'startup', entity_key: entityKey, company_id: companyId, decision, decided_by: user.email,
    decided_at: now, note: note ? String(note).slice(0, 500) : null, source: 'admin',
  }, { upsert: true });
}

export async function auditPersonalView(db, { user, target, fields, clock = () => new Date() }) {
  await db.collection('audit_log').insertOne({ at: clock(), actor: user.email, role: user.role, action: 'view_personal',
    target, fields, detail: null });
}

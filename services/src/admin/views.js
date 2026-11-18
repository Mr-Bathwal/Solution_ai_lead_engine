/**
 * Server-rendered pages. Every interpolated value is HTML-escaped unless it is wrapped in raw(),
 * and raw() is only ever used on markup this file built, so data from a portal or a vendor cannot
 * inject anything. The pages need no JavaScript (the Content-Security-Policy forbids it).
 *
 * Accessibility contract (checked by test/admin-views.test.js): a skip link to #main, a named main
 * navigation with aria-current on the current page, a visible label on every form field, scope on
 * every table header, an empty state wherever a list can be empty, and links only to http(s) URLs.
 */
import { STAGES, safeHref } from './queries.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
export const raw = (s) => new Raw(s);
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

function render(v) {
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  if (v === null || v === undefined || v === false) return '';
  return esc(v);
}

export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => { out += render(v) + strings[i + 1]; });
  return raw(out);
}

const num = (n) => (typeof n === 'number' ? n.toLocaleString('en-IN') : n ?? '—');
export const day = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '—');
const dayTime = (d) => (d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—');
const pct = (n, of) => { const p = (n / of) * 100; return `${p > 0 && p < 10 ? p.toFixed(1) : Math.round(p)}%`; };

const STAGE_LABEL = { discovered: 'Discovered', shortlisted: 'Shortlisted', contacted: 'Contacted', engaged: 'Engaged',
  claimed: 'Claimed', customer: 'Customer', closed: 'Closed' };
const VERDICT_LABEL = { eligible: 'Eligible', check_required: 'Check required', not_eligible: 'Not eligible', closed: 'Closed', held: 'Already has it' };
const DUE_LABEL = { due_soon: 'Due soon', upcoming: 'Upcoming', was_due: 'Was due', conditional: 'If it applies', advisory: 'Ongoing' };
const RUN_LABEL = { ok: 'OK', partial: 'Partial', running: 'Running', failed: 'Failed' };
const ACTION_LABEL = { none: 'None', confirm_rules: 'Wait for the rules to be confirmed', enrich_full_profile: 'Buy the full company profile' };
const METHOD_LABEL = { exact_name: 'exact name match', same_name: 'same name', splink: 'probabilistic match', manual: 'decided by a person',
  review: 'sent for review' };
const SOURCE_LABEL = { mca_monthly: 'MCA monthly file', startinup: 'Startup in UP', upsm: 'UP Startup Mission', infyner: 'MCA data vendor',
  incubator_portfolio: 'incubator portfolio', startup_portals: 'UP startup portals', incubator: 'incubator portfolios',
  sisfs_incubator: 'SISFS incubators', dpiit: 'DPIIT recognition', kb: 'knowledge-base build', news: 'funding news' };

/** A stored key in words: its label when there is one, otherwise the key without underscores. */
const label = (map, key) => map[key] ?? String(key ?? '').replace(/_/g, ' ');
const sentence = (s) => { const t = String(s ?? ''); return t.charAt(0).toUpperCase() + t.slice(1); };

/**
 * Only http(s) URLs become links; anything else (javascript:, data:, a bare path) is shown as text.
 * queries.js already nulls unsafe targets; checking again here keeps every page safe on its own.
 */
const webUrl = safeHref;
const extLink = (url, text, context) => {
  const href = webUrl(url);
  if (!href) return html`${text}`;
  return html`<a href="${href}" rel="noreferrer noopener" target="_blank">${text}${context ? html`<span class="vh"> ${context}</span>` : ''}</a>`;
};

// Badge colours keep one meaning each: blue = in the plan, purple = in contact, green = eligible or
// won, amber = needs a person, red = urgent or failed, grey = nothing to do (see style.css).
const badge = (text, kind) => html`<span class="badge ${kind}">${text}</span>`;
const stageBadge = (lead) => (lead?.holdout ? badge('Holdout', 'holdout') : lead ? badge(STAGE_LABEL[lead.stage] ?? lead.stage, `stage-${lead.stage}`) : badge('No lead', 'muted'));

export function layout({ title, user, csrf, active, body, notice, reviewWaiting, approvalsWaiting, inboxWaiting, callsWaiting, banner = null }) {
  const nav = [['/admin', 'Pipeline', 'pipeline'], ['/admin/companies', 'Companies', 'companies'],
    ['/admin/approvals', 'Approvals', 'approvals'], ['/admin/inbox', 'Inbox', 'inbox'], ['/admin/calls', 'Calls', 'calls'],
    ['/admin/results', 'Results', 'results'], ['/admin/review', 'Review', 'review'], ['/admin/health', 'Data health', 'health']];
  const waiting = { review: reviewWaiting, approvals: approvalsWaiting, inbox: inboxWaiting, calls: callsWaiting };
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Lead engine</title><link rel="icon" href="/admin/static/icon.svg" type="image/svg+xml"><link rel="stylesheet" href="/admin/static/style.css"></head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top"><div class="wrap top-in">
  <a class="brand" href="/admin"><span class="dot"></span>SolutionAI <span class="sub">Lead engine</span></a>
  ${user ? html`<nav aria-label="Main">${nav.map(([href, text, key]) => html`<a href="${href}"${active === key ? raw(' class="on" aria-current="page"') : ''}>${text}${waiting[key] ? html` <span class="count">${waiting[key]}<span class="vh"> waiting</span></span>` : ''}</a>`)}</nav>
  <form method="post" action="/admin/logout" class="who"><span><span class="who-email">${user.email} · </span>${user.role}</span><input type="hidden" name="csrf" value="${csrf}"><button class="link">Sign out</button></form>` : ''}
</div></header>
${banner ? html`<div class="banner" role="note"><div class="wrap">${banner}</div></div>` : ''}
<main class="wrap" id="main">
${notice ? html`<p class="notice" role="status">${notice}</p>` : ''}
${body}
</main>
<footer class="wrap foot">UP only · company-level data · every view of personal data is logged</footer>
</body></html>`;
}

export function loginPage({ error }) {
  return layout({ title: 'Sign in', body: html`
<section class="card narrow">
  <h1>Sign in</h1>
  <p class="muted">Use the access token you were given. These pages move into the platform's Admin portal later, with the same sign-in.</p>
  ${error ? html`<p class="error" role="alert">${error}</p>` : ''}
  <form method="post" action="/admin/login" class="stack">
    <label>Access token <input type="password" name="token" autocomplete="current-password" required autofocus></label>
    <button class="primary">Sign in</button>
  </form>
</section>` });
}

function rulesBanner(rules) {
  if (!rules) return '';
  if (rules.rules_confirmed) return html`<p class="banner ok">Deadline and scheme rules are confirmed (${rules.rules_version}).</p>`;
  return html`<p class="banner warn"><strong>Rules awaiting a CA's confirmation.</strong> Deadlines and scheme verdicts are shown here for review; no message will use them until they are confirmed. Verdicts come from ${rules.verdicts_by === 'platform_rules_engine' ? "the platform's rules engine" : 'provisional rules until the platform rules engine is connected'}.</p>`;
}

function bars(rows, { label: text = (r) => r._id ?? 'Unknown', value = (r) => r.n } = {}) {
  if (!rows.length) return html`<p class="muted">Nothing to show yet.</p>`;
  const max = Math.max(1, ...rows.map(value));
  return html`<ul class="bars">${rows.map((r) => html`<li><span class="bar-label">${text(r)}</span><span class="bar"><span style="width:${value(r) ? Math.max(1, Math.round((value(r) / max) * 100)) : 0}%"></span></span><span class="bar-n">${num(value(r))}</span></li>`)}</ul>`;
}

export function pipelinePage(p, ctx) {
  const discovered = Object.values(p.funnel).reduce((a, b) => a + b, 0) + p.holdout;
  const funnelMax = Math.max(1, discovered);
  const steps = [['All companies', discovered], ...STAGES.slice(1, 6).map((s) => [STAGE_LABEL[s], STAGES.slice(STAGES.indexOf(s)).reduce((a, k) => a + (p.funnel[k] ?? 0), 0)])];
  const body = html`
${rulesBanner(p.rules)}
<section class="hero">
  <div><h1>Pipeline</h1><p class="muted">Every UP company we know of, from incorporation to customer. Planning month ${p.month}.</p></div>
  <form class="inline" method="get" action="/admin"><label>Month <input name="month" value="${p.month}" pattern="\\d{4}-\\d{2}" size="7"></label><button>Show</button></form>
</section>
<section class="kpis">
  <div class="kpi"><span class="n">${num(p.companies.company ?? 0)}</span><span class="l">UP companies</span></div>
  <div class="kpi"><span class="n">${num(p.companies.llp ?? 0)}</span><span class="l">UP LLPs</span></div>
  <div class="kpi"><span class="n">${num(p.links.linked ?? 0)}</span><span class="l">Portal startups matched to a CIN</span></div>
  <div class="kpi"><span class="n">${num(p.funnel.shortlisted ?? 0)}</span><span class="l">Shortlisted</span></div>
  <div class="kpi"><span class="n">${num(p.holdout)}</span><span class="l">Holdout, never contacted</span></div>
</section>
<section class="grid2">
  <div class="card"><h2>Funnel</h2>
    <ul class="funnel">${steps.map(([text, n], i) => {
    const prev = i ? steps[i - 1][1] : 0;
    const width = n ? Math.max(1, (n / funnelMax) * 100) : 0;          // a step nobody has reached draws no bar
    return html`<li><span class="f-label">${text}</span><span class="f-bar"><span style="width:${width.toFixed(1)}%"></span></span><span class="f-n">${num(n)}${prev ? html`<small>${pct(n, prev)}<span class="vh"> of ${steps[i - 1][0]}</span></small>` : ''}</span></li>`;
  })}</ul>
    <p class="muted small">The holdout group (${num(p.holdout)}) is counted under all companies only; comparing it with the contacted group is how the engine's effect is measured.</p>
  </div>
  <div class="card"><h2>Sector themes</h2><p class="muted small">Eligible companies, by the Atlas classifier.</p>${bars(p.themes)}</div>
</section>
<section class="card"><h2 id="cohorts">By incorporation month</h2>
  ${p.cohorts.length ? html`<div class="scroll" role="region" aria-labelledby="cohorts" tabindex="0"><table><thead><tr><th scope="col">Cohort</th><th scope="col" class="r">Companies</th><th scope="col" class="r">Eligible</th><th scope="col" class="r">Shortlisted</th><th scope="col" class="r">Contacted</th><th scope="col" class="r">Engaged</th><th scope="col" class="r">Claimed</th><th scope="col" class="r">Customers</th><th scope="col" class="r">Holdout</th></tr></thead>
  <tbody>${p.cohorts.map((c) => html`<tr><th scope="row" class="nowrap"><a href="/admin/companies?cohort=${c._id}">${c._id}</a></th><td class="r">${num(c.total)}</td><td class="r">${num(c.eligible)}</td><td class="r">${num(c.shortlisted)}</td><td class="r">${num(c.contacted)}</td><td class="r">${num(c.engaged)}</td><td class="r">${num(c.claimed)}</td><td class="r">${num(c.customer)}</td><td class="r">${num(c.holdout)}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">No companies yet. They arrive with the first MCA monthly file.</p>`}
</section>
<section class="grid2">
  <div class="card"><h2>Districts</h2><p class="muted small">Registered office where known, otherwise the portal's district. Most new companies show none until the vendor lookup runs.</p>${bars(p.districts)}</div>
  <div class="card"><h2>Portal startups</h2><p class="muted small">Startups on Startup in UP and UP Startup Mission, and whether we know their CIN or LLPIN.</p>
    ${bars([{ _id: 'Matched to a company', n: p.links.linked ?? 0 }, { _id: 'Waiting for a person', n: p.links.review ?? 0 }, { _id: 'No CIN in our data yet', n: p.links.unlinked ?? 0 }])}
    ${p.links.review ? html`<p class="more"><a href="/admin/review">Review ${num(p.links.review)} →</a></p>` : ''}</div>
</section>
${shortlistCard(p, { limit: 25 })}`;
  return layout({ ...ctx, title: 'Pipeline', active: 'pipeline', body });
}

/**
 * Ranks are fixed when the shortlist is made while fit is recomputed nightly, so the column shows the
 * fit the rank was decided on ("Fit at ranking") when the row carries it, and today's fit otherwise.
 */
function fitCell(r, atRanking) {
  if (!atRanking) return html`<strong>${r.fit ?? '—'}</strong>`;
  if (r.fit_at_rank == null) return html`<strong>${r.fit ?? '—'}</strong><div class="muted small">now</div>`;
  return html`<strong>${r.fit_at_rank}</strong>${r.fit != null && r.fit !== r.fit_at_rank ? html`<div class="muted small">now ${r.fit}</div>` : ''}`;
}

function shortlistCard(p, { limit = Infinity, standalone = false } = {}) {
  const rows = p.shortlist.slice(0, limit);
  const atRanking = p.shortlist.some((r) => r.fit_at_rank != null);
  const rankedAt = p.shortlist.map((r) => r.ranked_at).filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0];
  // On the shortlist's own page the h1 already names the month; the card names what it lists.
  const heading = standalone ? `All ${num(p.shortlist.length)} ranks` : `Shortlist for ${p.month}`;
  return html`<section class="card">
  <div class="card-head"><h2 id="shortlist">${heading}</h2><span class="muted">${num(p.shortlist.filter((r) => !r.holdout).length)} to contact · ${num(p.shortlist.filter((r) => r.holdout).length)} holdout in the same ranks${rankedAt ? ` · ranked ${day(rankedAt)}` : ''}</span></div>
  ${rows.length ? html`<div class="scroll" role="region" aria-labelledby="shortlist" tabindex="0"><table class="dense"><thead><tr><th scope="col" class="r">#</th><th scope="col">Company</th><th scope="col" class="col-opt">Theme</th><th scope="col" class="col-opt">District</th><th scope="col" class="r">${atRanking ? 'Fit at ranking' : 'Fit now'}</th><th scope="col">Next deadline</th><th scope="col">Status</th></tr></thead><tbody>
  ${rows.map((r) => html`<tr${r.holdout ? raw(' class="dim"') : ''}><td class="r">${r.rank}</td><td><a class="co" href="/admin/companies/${r.company_id}">${r.name ?? r.company_id}</a><div class="muted small">${r.company_id}</div></td><td class="col-opt">${r.theme ?? '—'}</td><td class="col-opt">${r.district ?? '—'}</td><td class="r">${fitCell(r, atRanking)}</td><td>${r.next_deadline ? html`${r.next_deadline.title}<div class="muted small nowrap">${day(r.next_deadline.due)}</div>` : '—'}</td><td>${stageBadge(r)}</td></tr>`)}
  </tbody></table></div>
  ${p.shortlist.length > rows.length ? html`<p class="more"><a href="/admin/shortlist?month=${p.month}">All ${num(p.shortlist.length)} ranks of the shortlist →</a></p>` : ''}` : html`<p class="muted">No shortlist for ${p.month} yet. It is made by the nightly need run once the month's MCA file is loaded.</p>`}
</section>`;
}

export function shortlistPage(p, ctx) {
  const body = html`<section class="hero"><div><p class="muted small"><a href="/admin?month=${p.month}">Pipeline</a> / Shortlist</p><h1>Shortlist for ${p.month}</h1>
<p class="muted">The best-fit eligible companies of the month's cohort, in rank order. Shaded rows are in the holdout group: ranked like the others, never contacted.</p></div></section>
${shortlistCard(p, { standalone: true })}`;
  return layout({ ...ctx, title: `Shortlist ${p.month}`, active: 'pipeline', body });
}

export function companiesPage(r, query, ctx) {
  const pages = Math.max(1, Math.ceil(r.total / r.size));
  const qs = (page) => new URLSearchParams({ ...query, page: String(page) }).toString();
  const filtered = Boolean(query.q || query.stage || query.cohort);
  const body = html`
<section class="hero"><div><h1>Companies</h1><p class="muted">${num(r.total)} found. <a href="/admin/exports">Export a list</a> (an admin approves it).</p></div>
<form class="inline" method="get" action="/admin/companies">
  <label>Search <input type="search" name="q" value="${query.q ?? ''}" placeholder="Name or CIN" size="22"></label>
  <label>Stage <select name="stage"><option value="">Any stage</option>${[...STAGES, 'holdout'].map((s) => html`<option value="${s}" ${query.stage === s ? raw('selected') : ''}>${STAGE_LABEL[s] ?? 'Holdout'}</option>`)}</select></label>
  <label>Cohort <input name="cohort" value="${query.cohort ?? ''}" placeholder="YYYY-MM" pattern="\\d{4}-\\d{2}" size="7"></label>
  <button>Filter</button>
</form></section>
<section class="card">${r.rows.length ? html`<h2 class="vh" id="companies">Companies, page ${r.page} of ${pages}</h2><div class="scroll" role="region" aria-labelledby="companies" tabindex="0"><table><thead><tr><th scope="col">Company</th><th scope="col">Cohort</th><th scope="col">District</th><th scope="col">Portal</th><th scope="col" class="r">Fit</th><th scope="col">Stage</th></tr></thead><tbody>
${r.rows.map((c) => html`<tr><td><a class="co" href="/admin/companies/${c.id}">${c.name}</a><div class="muted small">${c.id}${c.kind === 'llp' ? ' · LLP' : ''}</div></td><td>${c.cohort}</td><td>${c.district ?? '—'}</td><td>${c.portal ? badge('Startup portal', 'soft') : '—'}</td><td class="r">${c.lead?.score?.fit ?? '—'}</td><td>${stageBadge(c.lead)}</td></tr>`)}
</tbody></table></div>
${pages > 1 ? html`<nav class="pager" aria-label="Pages">${r.page > 1 ? html`<a href="/admin/companies?${qs(r.page - 1)}">← Previous</a>` : ''}<span>Page ${r.page} of ${pages}</span>${r.page < pages ? html`<a href="/admin/companies?${qs(r.page + 1)}">Next →</a>` : ''}</nav>` : ''}`
    : html`<p class="muted empty">No companies match${filtered ? html` these filters. <a href="/admin/companies">Clear the filters</a>` : ' yet'}.</p>`}
</section>`;
  return layout({ ...ctx, title: 'Companies', active: 'companies', body });
}

const ATTR_LABEL = {
  nic_code: 'NIC code', roc: 'ROC', registered_office: 'Registered office', registered_district: 'District (registered office)',
  registered_pincode: 'PIN code (registered office)', registered_email: 'Registered email', authorised_capital: 'Authorised capital (₹)',
  paid_up_capital: 'Paid-up capital (₹)', directors_count: 'Directors', state_evidence: 'State', company_status: 'Registry status',
  startinup_listed: 'On Startup in UP', upsm_listed: 'On UP Startup Mission', women_led: 'Women-led', portal_since: 'On the portal since',
  portal_sector: 'Sector (portal)', portal_industry: 'Industry (portal)', district: 'District (portal)', pincode: 'PIN code (portal)',
};

const provKey = (a) => `${a.source}|${a.confidence ?? ''}`;

/**
 * Facts with their provenance. The source most rows share is said once above the table; a row
 * carries its own source and date only where they differ, so the table reads as facts first.
 */
function factsTable(attrs, keys) {
  const present = keys.filter((k) => attrs?.[k]);
  if (!present.length) return null;
  const counts = new Map();
  for (const k of present) counts.set(provKey(attrs[k]), (counts.get(provKey(attrs[k])) ?? 0) + 1);
  const common = [...counts].sort((a, b) => b[1] - a[1])[0][0];
  const shared = present.map((k) => attrs[k]).filter((a) => provKey(a) === common);
  const latest = shared.map((a) => a.seen_at).filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0];
  const { source, confidence } = shared[0];
  return html`<p class="muted small prov-note">From ${label(SOURCE_LABEL, source)}${confidence ? `, ${confidence} confidence` : ''}${latest ? `, seen ${day(latest)}` : ''}, unless noted.</p>
<table class="facts"><tbody>${present.map((k) => {
    const a = attrs[k];
    const v = Array.isArray(a.value) ? a.value.join(', ') : typeof a.value === 'boolean' ? (a.value ? 'Yes' : 'No') : a.value;
    const name = ATTR_LABEL[k] ?? k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
    const own = provKey(a) !== common || day(a.seen_at) !== day(latest);
    return html`<tr><th scope="row">${name}</th><td>${v}${own ? html`<span class="prov">${[label(SOURCE_LABEL, a.source), a.confidence, day(a.seen_at)].filter(Boolean).join(' · ')}</span>` : ''}</td></tr>`;
  })}</tbody></table>`;
}

/** Timeline rows are assembled from stored keys; say the source and method keys in words. */
function timelineEntry(t) {
  const word = (w) => SOURCE_LABEL[w] ?? METHOD_LABEL[w] ?? null;
  const [first, ...rest] = String(t.what ?? '').split(' ');
  const what = (word(first) ? [sentence(word(first)), ...rest].join(' ') : String(t.what ?? ''))
    .replace(/\b[a-z]+(?:_[a-z]+)+\b/g, (k) => k.replace(/_/g, ' '));
  const detail = String(t.detail ?? '').split(', ').map((part) => {
    const [w, ...more] = part.split(' ');
    return word(w) ? [word(w), ...more].join(' ') : part;
  }).join(', ');
  return { what, detail };
}

export function companyPage(v, ctx) {
  const c = v.company;
  const lead = v.lead;
  const registry = ['legal_name', 'incorporation_date', 'company_type', 'company_category', 'company_class', 'listing', 'registrar',
    'nic_code', 'sector', 'company_status', 'registered_office', 'registered_district', 'registered_pincode', 'roc',
    'authorised_capital', 'paid_up_capital', 'registered_email', 'directors_count', 'state_evidence'];
  const portal = ['brand', 'website', 'domain', 'district', 'pincode', 'portal_sector', 'portal_industry', 'stage', 'incubators',
    'women_led', 'startinup_listed', 'upsm_listed', 'portal_since'];
  const needs = lead?.needs;
  const rank = lead?.shortlist;
  const contactable = Boolean(rank) && !lead.holdout && lead.stage === 'shortlisted';
  const registryFacts = factsTable(c.attrs, registry);
  const portalFacts = factsTable(c.attrs, portal);
  const isAdmin = ctx.user?.role === 'admin';
  const onlyReveal = !v.personal_shown && !v.directors.length && isAdmin;
  // Order follows the decision: why it scores and what to do, then what is due and what it may claim,
  // then the facts behind all that, and last the history.
  const body = html`
${rulesBanner(needs)}
<section class="hero"><div>
  <p class="muted small"><a href="/admin/companies">Companies</a> / ${c._id}</p>
  <h1>${c.name}</h1>
  <p>${contactable ? badge(`Shortlisted · #${rank.rank} for ${rank.month}`, 'stage-shortlisted') : stageBadge(lead)} ${lead && !lead.eligible ? badge('Not eligible', 'muted') : ''} <span class="muted">${c.kind === 'llp' ? 'LLP' : 'Company'} · <span class="nowrap">incorporated ${day(c.attrs?.incorporation_date?.value)}</span> · <span class="nowrap">cohort ${c.cohort}</span>${rank && !contactable ? html` · <span class="nowrap">#${rank.rank} in the ${rank.month} shortlist</span>` : ''}</span></p>
</div>
${lead ? html`<div class="score"><span class="n">${lead.score?.fit ?? '—'}</span><span class="l">fit score</span></div>` : ''}
</section>
${lead?.eligibility_reasons?.length ? html`<p class="banner muted">Not contacted: ${lead.eligibility_reasons.join('; ')}.</p>` : ''}
${lead ? html`<section class="grid2">
  <div class="card"><h2>Why it scores ${lead.score?.fit ?? '—'}</h2>
    ${(lead.score?.components ?? []).length ? html`<ul class="points">${lead.score.components.map((p) => html`<li><span class="pts ${p.points < 0 ? 'neg' : ''}">${p.points > 0 ? '+' : ''}${p.points}</span>${p.reason}</li>`)}</ul>` : html`<p class="muted">No score breakdown yet.</p>`}
    ${lead.score?.theme ? html`<p class="muted small">Theme: ${lead.score.theme.name} (${lead.score.theme.sub_sector}, ${lead.score.theme.confidence} confidence) · ${lead.score.version}</p>` : ''}
  </div>
  <div class="card"><h2>Next action</h2><p class="next-action">${label(ACTION_LABEL, lead.next_action?.type ?? 'none')}</p>${lead.next_action?.why ? html`<p class="muted">${sentence(lead.next_action.why)}</p>` : ''}
    ${lead.holdout_draw ? html`<p class="muted small">Holdout draw ${lead.holdout_draw.method} · u = ${lead.holdout_draw.u?.toFixed(4)}</p>` : ''}</div>
</section>
<section class="card"><div class="card-head"><h2 id="deadlines">First-year deadlines</h2>${needs?.rules_version ? html`<span class="muted small">${needs.rules_version}</span>` : ''}</div>
  ${needs?.deadlines?.length ? html`<table class="dense deadlines" aria-labelledby="deadlines"><thead><tr><th scope="col">What</th><th scope="col">Due</th><th scope="col">Status</th></tr></thead><tbody>
  ${needs.deadlines.map((d) => html`<tr><td><strong>${d.title}</strong>${d.note ? html`<div class="muted small">${d.note}</div>` : ''}${d.penalty ? html`<div class="muted small">${d.penalty}</div>` : ''}<div class="muted small">${d.form ? html`${d.form} · ` : ''}${extLink(d.source_url, d.law ?? (webUrl(d.source_url) ? 'Source' : ''))}</div></td><td class="date">${d.due ? day(d.due) : '—'}${d.days_left != null && d.days_left >= 0 ? html`<div class="muted small">${d.days_left === 0 ? 'today' : `in ${d.days_left} days`}</div>` : ''}</td><td>${badge(DUE_LABEL[d.status] ?? d.status, `due-${d.status}`)}</td></tr>`)}
  </tbody></table>` : html`<p class="muted empty">No deadlines worked out for this company yet. They come with the nightly need run.</p>`}</section>
<section class="card"><h2>Schemes</h2>${needs?.schemes?.length ? html`<div class="schemes">
  ${needs.schemes.map((s) => html`<div class="scheme"><div class="scheme-head"><strong>${s.name}</strong>${badge(VERDICT_LABEL[s.verdict] ?? s.verdict, `v-${s.verdict}`)}</div><p class="small">${s.benefit}</p><p class="muted small">${s.reason}</p>${s.missing?.length ? html`<p class="muted small">To confirm: ${s.missing.join(', ')}</p>` : ''}<p class="small">${webUrl(s.source_url) ? extLink(s.source_url, 'Source', `for ${s.name}`) : 'No source link'} · checked ${s.checked_on ?? '—'} · ${s.by === 'platform_rules_engine' ? 'platform rules engine' : 'provisional rules'}</p></div>`)}
</div>` : html`<p class="muted empty">No scheme verdicts for this company yet.</p>`}</section>` : ''}
<section class="grid2">
  <div class="card"><h2>Registry and vendor facts</h2>${registryFacts ?? html`<p class="muted empty">No registry facts yet.</p>`}</div>
  <div class="card"><h2>What the startup portals say</h2>${portalFacts ?? html`<p class="muted empty">Not linked to a portal startup.</p>`}</div>
</section>
${v.signals?.length ? html`<section class="card"><h2>In the news</h2><ul class="plain">${v.signals.map((s) => html`<li>${extLink(s.url, s.headline)} <span class="muted small">${s.publisher} · ${day(s.published_at ?? s.confirmed_at)}</span></li>`)}</ul><p class="muted small">Funding news a person checked and confirmed. <a href="/admin/signals">News to check</a>.</p></section>` : ''}
${v.startups.length ? html`<section class="card"><h2>Portal entries</h2>${v.startups.map((s) => html`<div class="portal"><p><strong>${s.legal_name ?? s.upsm_name ?? s.uplc}</strong> ${s.brand ? html`<span class="muted">(${s.brand})</span>` : ''} <span class="muted small">${s.uplc} · ${s.entity_type ?? ''} · established ${s.year ?? '—'} · on the portal since ${s.since ?? '—'}</span></p>${s.team?.length ? html`<p class="small">Team: ${s.team.map((t) => `${t.name}${t.role ? ` (${t.role})` : ''}`).join(', ')}</p>` : ''}</div>`)}</section>` : ''}
${v.personal_fields.length ? html`<section class="card people${onlyReveal ? ' only-reveal' : ''}"><h2>People</h2>
  ${v.directors.length ? html`<p>Directors: ${v.directors.map((d) => `${d.name}${d.din ? ` (DIN ${d.din})` : ''}`).join(', ')}</p>` : ''}
  ${v.personal_shown ? html`<p class="muted small">Shown to you as an admin; this view was logged.</p>` : isAdmin ? html`<p><a class="button" href="/admin/companies/${c._id}?personal=1">Show personal data (logged)</a></p>` : html`<p class="muted small">Personal data (${v.personal_fields.join(', ')}) is hidden for your role.</p>`}
</section>` : ''}
${v.candidate_of.length ? html`<section class="card"><h2>Waiting for review</h2><p>${v.candidate_of.length} portal startup(s) may be this company. <a href="/admin/review">Open the review queue</a>.</p></section>` : ''}
<section class="card"><h2>Timeline</h2>${v.timeline.length ? html`<ol class="timeline">${v.timeline.map((t) => { const e = timelineEntry(t); return html`<li><span class="when">${dayTime(t.at)}</span><span class="what">${e.what}</span><span class="muted small">${e.detail}</span></li>`; })}</ol>` : html`<p class="muted empty">Nothing recorded yet.</p>`}</section>`;
  return layout({ ...ctx, title: c.name, active: 'companies', body });
}

const AI_SAME = { yes: 'likely the same business', no: 'likely a different business', unsure: 'cannot tell' };
/** The AI model's advice on one candidate, if it was asked: advice only, the reviewer decides. */
const aiAdvice = (check, companyId) => {
  const v = check?.verdicts?.find((x) => x.company_id === companyId);
  return v ? html`<div class="small muted">AI check (advice only): ${AI_SAME[v.same] ?? v.same}${v.reason ? ` · ${v.reason}` : ''}</div>` : '';
};

export function reviewPage(q, ctx) {
  const canDecide = ctx.user && ['reviewer', 'admin'].includes(ctx.user.role);
  const body = html`
<section class="hero"><div><h1>Review queue</h1><p class="muted">${num(q.waiting)} portal startups the matcher was not sure about. Your decision always overrides the matcher and takes effect at the next nightly knowledge-base build. ${num(q.decided)} decisions so far; they also measure the matcher's precision. To check the pairs it was sure about, <a href="/admin/labels">label pairs</a>. <a href="/admin/signals">News to check: ${num(q.signals_waiting ?? 0)}</a>.</p></div></section>
${q.items.length ? '' : html`<section class="card"><p class="muted empty">Nothing waiting. New pairs arrive with the nightly knowledge-base build.</p></section>`}
${q.items.map((it) => {
    const name = it.startup.legal_name ?? it.startup.upsm_name ?? it.entity_key;
    return html`<section class="card review">
  <div class="card-head"><div><h2>${name}</h2>
  <p class="muted small">${it.entity_key} · ${it.startup.entity_type ?? 'type unknown'} · established ${it.startup.year ?? '—'} · on the portal since ${it.startup.since ?? '—'} · ${it.startup.district ?? it.startup.upsm_district ?? ''}</p>
  <p class="reason">Why it needs you: ${it.evidence.why_review ?? 'the matcher was unsure'}</p></div></div>
  ${it.candidates.map((c) => html`<div class="cand"><div><a href="/admin/companies/${c.company_id}"><strong>${c.name}</strong></a><div class="muted small">${c.company_id} · <span class="nowrap">incorporated ${day(c.incorporated)}</span> · ${label(METHOD_LABEL, c.method)}${c.probability != null ? ` · p = ${Number(c.probability).toFixed(3)}` : ''}</div>${(c.contradictions ?? []).length ? html`<div class="small warn-text">${c.contradictions.join('; ')}</div>` : ''}${aiAdvice(it.ai_check, c.company_id)}</div>
  ${canDecide ? html`<form method="post" action="/admin/review"><fieldset class="decide"><legend class="vh">Is ${name} the same business as ${c.name}?</legend><input type="hidden" name="csrf" value="${ctx.csrf}"><input type="hidden" name="entity" value="${it.entity_key}"><input type="hidden" name="company" value="${c.company_id}"><label class="note"><span class="vh">Note about this match (optional)</span><input name="note" placeholder="Note (optional)" size="16" maxlength="500"></label><button name="decision" value="same" class="good">Same</button><button name="decision" value="different">Different</button><button name="decision" value="unsure" class="link">Unsure</button></fieldset></form>` : ''}</div>`)}
</section>`;
  })}`;
  return layout({ ...ctx, title: 'Review', active: 'review', body });
}

const pctText = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
const KIND_PAIR = { link: 'Linked by the matcher', near_miss: 'Not linked (a near miss)' };

export function labelsPage(q, ctx) {
  const canDecide = ctx.user && ['reviewer', 'admin'].includes(ctx.user.role);
  const h = q.precision.held_out;
  const body = html`
<section class="hero"><div><h1>Label pairs</h1><p class="muted">Pairs the matcher was sure about, for a person to check, so that its precision is measured rather than assumed: every link it made on its own (held-out links first: one startup in five is never used to train it, so those give the honest number), then ${num(q.near_misses)} pairs it did not link, which show what it misses. A decision here also corrects the match at the next nightly build. The unsure pairs are on the <a href="/admin/review">review queue</a>.</p></div></section>
<section class="grid2">
  <div class="card"><h2>Progress</h2><ul class="plain"><li>${num(q.labelled)} of ${num(q.total)} pairs labelled; ${num(q.waiting)} to go</li><li>${num(q.links)} links (${num(q.held_out_links)} held out) and ${num(q.near_misses)} near misses</li><li>${num(q.recall_check.near_misses_labelled)} near misses checked, ${num(q.recall_check.near_misses_same)} of them the same business (a match it missed)</li></ul></div>
  <div class="card"><h2>Precision so far</h2>${h.judged ? html`<p><strong>${pctText(h.precision)}</strong> on ${num(h.judged)} held-out links <span class="muted small">(95% interval ${pctText(h.wilson_95[0])} to ${pctText(h.wilson_95[1])}; the target is ${pctText(q.target)})</span></p><p class="muted small">All labelled links: ${pctText(q.precision.all_links.precision)} on ${num(q.precision.all_links.judged)}. ${h.judged < 50 ? 'Under 50 held-out links the interval is too wide to call the target met.' : ''}</p>`
    : html`<p class="muted">${q.held_out_links ? 'No held-out link labelled yet. Start below: they come first.' : 'No held-out links yet: they come with the nightly knowledge-base build.'}</p>`}</div>
</section>
${q.items.length ? '' : html`<section class="card"><p class="muted empty">Every pair is labelled. New links arrive with the nightly knowledge-base build.</p></section>`}
${q.items.map((it) => {
    const s = it.startup;
    const name = s.legal_name ?? s.upsm_name ?? it.entity_key;
    return html`<section class="card review">
  <div class="card-head"><div><p class="muted small">${KIND_PAIR[it.kind] ?? it.kind}${it.held_out ? ' · held out' : ''}${it.method ? ` · ${label(METHOD_LABEL, it.method)}` : ''}${it.probability != null ? ` · p = ${Number(it.probability).toFixed(3)}` : ''}</p>
  <h2>${name}</h2><p class="muted small">${it.entity_key} · ${s.entity_type ?? 'type unknown'} · established ${s.year ?? '—'} · on the portal since ${s.since ?? '—'} · ${s.district ?? s.upsm_district ?? ''}${s.brand ? ` · brand ${s.brand}` : ''}</p></div></div>
  <div class="cand"><div><a href="/admin/companies/${it.company.id}"><strong>${it.company.name ?? it.company.id}</strong></a><div class="muted small">${it.company.id} · <span class="nowrap">incorporated ${day(it.company.incorporated)}</span>${it.company.district ? ` · ${it.company.district}` : ''}</div></div>
  ${canDecide ? html`<form method="post" action="/admin/labels"><fieldset class="decide"><legend class="vh">Is ${name} the same business as ${it.company.name ?? it.company.id}?</legend><input type="hidden" name="csrf" value="${ctx.csrf}"><input type="hidden" name="entity" value="${it.entity_key}"><input type="hidden" name="company" value="${it.company.id}"><label class="note"><span class="vh">Note about this pair (optional)</span><input name="note" placeholder="Note (optional)" size="16" maxlength="500"></label><button name="decision" value="same" class="good">Same</button><button name="decision" value="different">Different</button><button name="decision" value="unsure" class="link">Unsure</button></fieldset></form>` : ''}</div>
</section>`;
  })}`;
  return layout({ ...ctx, title: 'Label pairs', active: 'review', body });
}

const SIGNAL_STATUS = { confirmed: ['Confirmed', 'run-ok'], rejected: ['Rejected', 'muted'], proposed: ['Waiting', 'warn'] };

/** Funding news the engine proposed (admin/signals.js): a person confirms or rejects each one. */
export function signalsPage(q, ctx) {
  const canDecide = ctx.user && ['reviewer', 'admin'].includes(ctx.user.role);
  const body = html`
<section class="hero"><div><h1>News to check</h1><p class="muted">Funding news read each morning from news feeds and GDELT, where a headline names exactly one UP company we hold. A name in a headline can belong to another business, so each item is only a proposal: open the article, check it is about this company (the city, the business, the people), then confirm or reject it. A confirmed item is shown on the company's page; nothing else changes because of it. ${num(q.waiting)} waiting. The match review queue is on <a href="/admin/review">Review</a>.</p></div></section>
${q.items.length ? '' : html`<section class="card"><p class="muted empty">Nothing waiting. News is read every morning at 07:15.</p></section>`}
${q.items.map((s) => {
    const name = s.company_name ?? s.company_id;
    return html`<section class="card review">
  <div class="card-head"><div><p class="muted small">${s.publisher} · ${s.published_at ? dayTime(s.published_at) : `found ${dayTime(s.created_at)}`}</p>
  <h2>${extLink(s.url, s.headline)}</h2><p class="muted small">Matched on “${s.matched_name ?? ''}”</p></div></div>
  <div class="cand"><div><a href="/admin/companies/${s.company_id}"><strong>${name}</strong></a><div class="muted small">${s.company_id}</div></div>
  ${canDecide ? html`<form method="post" action="/admin/signals/${s.id}"><fieldset class="decide"><legend class="vh">Is this news about ${name}?</legend><input type="hidden" name="csrf" value="${ctx.csrf}"><label class="note"><span class="vh">Note about this news (optional)</span><input name="note" placeholder="Note (optional)" size="16" maxlength="500"></label><button name="decision" value="confirm" class="good">Confirm</button><button name="decision" value="reject">Reject</button></fieldset></form>` : ''}</div>
</section>`;
  })}
<section class="card"><h2 id="decided">Decided lately</h2>${q.decided.length ? html`<div class="scroll" role="region" aria-labelledby="decided" tabindex="0"><table><thead><tr><th scope="col">Headline</th><th scope="col">Company</th><th scope="col">Decision</th></tr></thead><tbody>
${q.decided.map((s) => {
    const [text, kind] = SIGNAL_STATUS[s.status] ?? [s.status, 'muted'];
    return html`<tr><td>${extLink(s.url, s.headline)}<div class="muted small">${s.publisher}</div></td><td><a href="/admin/companies/${s.company_id}">${s.company_name ?? s.company_id}</a></td><td>${badge(text, kind)}<div class="muted small">${s.decided_by ? `by ${s.decided_by}` : ''}${s.decided_at ? ` · ${dayTime(s.decided_at)}` : ''}${s.note ? ` · ${s.note}` : ''}</div></td></tr>`;
  })}
</tbody></table></div>` : html`<p class="muted empty">No decisions yet.</p>`}</section>`;
  return layout({ ...ctx, title: 'News to check', active: 'review', body });
}

const SEVERITY = { critical: ['Critical', 'run-failed'], warn: ['Warning', 'warn'], info: ['Note', 'soft'] };

export function healthPage(p, ctx) {
  const alerts = p.alerts ?? [];
  const body = html`
${rulesBanner(p.rules)}
<section class="hero"><div><h1>Data health</h1><p class="muted">Open alerts, the latest run of every source and job, and the spending caps. MCA's monthly file: <a href="/admin/mca">upload it and see what was loaded</a>.${ctx.user?.role === 'admin' ? html` Who did what: <a href="/admin/audit">the audit log</a>.` : ''}</p></div></section>
<section class="card"><h2 id="alerts">Open alerts</h2>${alerts.length ? html`<ul class="plain alerts">${alerts.map((a) => html`<li>${badge(SEVERITY[a.severity]?.[0] ?? a.severity, SEVERITY[a.severity]?.[1] ?? 'muted')} ${a.message} <span class="muted small">since ${dayTime(a.first_seen_at)}</span></li>`)}</ul>`
    : html`<p class="muted empty">No open alerts. The monitor checks every hour.</p>`}</section>
<section class="card"><h2 id="runs">Latest runs</h2>${p.runs.length ? html`<div class="scroll" role="region" aria-labelledby="runs" tabindex="0"><table><thead><tr><th scope="col">Source</th><th scope="col">Status</th><th scope="col">Started</th><th scope="col">Finished</th><th scope="col">Notes</th></tr></thead><tbody>
${p.runs.map((r) => html`<tr><th scope="row" class="nowrap">${sentence(label(SOURCE_LABEL, r.source))}</th><td>${badge(label(RUN_LABEL, r.status), `run-${r.status}`)}</td><td class="date">${dayTime(r.started_at)}</td><td class="date">${dayTime(r.finished_at)}</td><td class="small muted notes">${r.notes.join(' · ')}</td></tr>`)}
</tbody></table></div>` : html`<p class="muted empty">No runs recorded yet.</p>`}</section>
<section class="grid2">
  <div class="card"><h2>Caps</h2>${p.usage.length ? html`<table><thead><tr><th scope="col">Meter</th><th scope="col">Period</th><th scope="col" class="r">Used</th><th scope="col" class="r">Cap</th></tr></thead><tbody>${p.usage.map((u) => html`<tr><th scope="row">${sentence(label(SOURCE_LABEL, u.meter))}</th><td>${u.period}</td><td class="r">${num(u.count)}</td><td class="r">${num(u.cap)}</td></tr>`)}</tbody></table>` : html`<p class="muted empty">No paid or quota calls yet.</p>`}</div>
  <div class="card"><h2>Matching</h2><ul class="plain"><li>${num(p.links.linked ?? 0)} portal startups linked to a CIN or LLPIN</li><li>${num(p.links.review ?? 0)} waiting for a person</li><li>${num(p.links.unlinked ?? 0)} with no CIN in the data we hold yet (older companies, until the MCA back files or the vendor search find them)</li></ul></div>
</section>`;
  return layout({ ...ctx, title: 'Data health', active: 'health', body });
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function mcaPage(st, ctx) {
  const isAdmin = ctx.user?.role === 'admin';
  const body = html`
<section class="hero"><div><h1>MCA monthly file</h1><p class="muted">MCA does not allow its monthly list of new companies to be downloaded by a program, so a person downloads it in the first days of each month (about ten minutes; ops/WEEK1_ACTIONS.md, item 9) and uploads it here. The nightly run at 05:00 IST loads it, and the new UP companies are in that morning's shortlist.</p></div></section>
<section class="card"><h2>Upload</h2>${isAdmin ? html`<form method="post" action="/admin/mca" enctype="multipart/form-data" class="upload"><input type="hidden" name="csrf" value="${ctx.csrf}">
  <label>The workbook from <a href="https://www.mca.gov.in/content/mca/global/en/data-and-reports/company-llp-info/incorporated-closed-month.html" rel="noopener noreferrer">MCA's monthly page</a> ("Companies and LLPs registered in …", .xlsx)<br><input type="file" name="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required></label>
  <p><button class="good">Upload</button></p></form><p class="muted small">The same file twice is recognised and refused. Every upload is logged with your name.</p>`
    : html`<p class="muted">Only admins can upload the file.</p>`}</section>
<section class="card"><h2 id="waiting">Waiting for tonight</h2>${st.waiting.length ? html`<ul class="plain">${st.waiting.map((w) => html`<li><strong>${w.name}</strong> <span class="muted small">${mb(w.size)} · ${dayTime(w.at)}${w.uploaded_by ? ` · uploaded by ${w.uploaded_by}` : ''}</span></li>`)}</ul>`
    : html`<p class="muted empty">Nothing waiting.</p>`}</section>
${st.failed.length ? html`<section class="card"><h2 id="failed">Could not be loaded</h2><ul class="plain">${st.failed.map((f) => html`<li>${badge('Failed', 'run-failed')} <strong>${f.name}</strong> <span class="muted small">${f.why}</span></li>`)}</ul><p class="muted small">These files are kept in the inbox's failed folder for a person to look at. Upload the right file and the next run loads it.</p></section>` : ''}
<section class="card"><h2 id="loaded">Loaded</h2>${st.loaded.length ? html`<div class="scroll" role="region" aria-labelledby="loaded" tabindex="0"><table><thead><tr><th scope="col">File</th><th scope="col">Month</th><th scope="col">Status</th><th scope="col" class="r">UP companies</th><th scope="col">Loaded</th><th scope="col">How</th></tr></thead><tbody>
${st.loaded.map((r) => html`<tr><th scope="row">${r.file ?? '—'}</th><td>${r.period ?? '—'}</td><td>${badge(label(RUN_LABEL, r.status), `run-${r.status}`)}</td><td class="r">${num(r.companies_up)}</td><td class="date">${dayTime(r.at)}</td><td class="small muted">${r.uploaded_by ? `uploaded by ${r.uploaded_by}` : r.via}</td></tr>`)}
</tbody></table></div>` : html`<p class="muted empty">No MCA file loaded yet.</p>`}</section>`;
  return layout({ ...ctx, title: 'MCA file', active: 'health', body });
}

const AUDIT_TEXT = { view_personal: 'Viewed personal data', export: 'Downloaded an export', export_request: 'Asked for an export', export_decision: 'Decided an export',
  review_decision: 'Decided a match', approval_decision: 'Decided an email', outcome_recorded: 'Recorded an outcome', inbound_decision: 'Dealt with a reply',
  denied: 'Refused', sign_in: 'Signed in', sign_out: 'Signed out', label_import: 'Imported match labels', erasure: 'Erased data',
  suppression_lifted: 'Lifted an opt-out', upload_mca_file: 'Uploaded the MCA file', event_received: 'Platform event refused' };
/** A review decision is on a match or, with a signal as its target, on a news item (admin/signals.js). */
const auditText = (r) => (r.action === 'review_decision' && r.target?.type === 'signal' ? 'Decided a news item' : AUDIT_TEXT[r.action] ?? r.action);
const auditDetail = (r) => {
  const parts = [];
  if (r.target) parts.push([r.target.type, r.target.id].filter(Boolean).join(' '));
  if (r.fields?.length) parts.push(`fields: ${r.fields.join(', ')}`);
  if (r.detail) parts.push(JSON.stringify(r.detail).slice(0, 240));
  return parts.join(' · ');
};

export function auditPage(log, ctx) {
  const f = log.filters;
  const pages = Math.max(1, Math.ceil(log.total / log.size));
  const qs = (page) => new URLSearchParams(Object.fromEntries(Object.entries({ ...f, page: String(page) }).filter(([, v]) => v))).toString();
  const body = html`
<section class="hero"><div><h1>Audit log</h1><p class="muted">Every sign-in and refused token, every view of personal data, every decision on a match, an email or a reply, every export, upload, erasure and lifted opt-out. Nothing here can be changed or deleted by the engine. Opening this page is itself logged.</p></div>
<form class="inline" method="get" action="/admin/audit">
  <label>Action <select name="action"><option value="">Any</option>${Object.entries(AUDIT_TEXT).map(([k, v]) => html`<option value="${k}" ${f.action === k ? raw('selected') : ''}>${v}</option>`)}</select></label>
  <label>Person <input name="actor" value="${f.actor ?? ''}" size="18" placeholder="email starts with"></label>
  <label>From <input type="date" name="from" value="${f.from ?? ''}"></label>
  <label>To <input type="date" name="to" value="${f.to ?? ''}"></label>
  <button>Show</button>
</form></section>
<section class="card"><h2 id="log">${num(log.total)} entries${log.total > log.size ? ` · page ${log.page} of ${pages}` : ''}</h2>${log.rows.length ? html`<div class="scroll" role="region" aria-labelledby="log" tabindex="0"><table><thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">What</th><th scope="col">Detail</th></tr></thead><tbody>
${log.rows.map((r) => html`<tr><td class="date">${dayTime(r.at)}</td><td>${r.actor}<div class="muted small">${r.role ?? ''}</div></td><td class="nowrap">${r.action === 'denied' ? badge(AUDIT_TEXT[r.action], 'warn') : auditText(r)}</td><td class="small muted notes">${auditDetail(r)}</td></tr>`)}
</tbody></table></div>` : html`<p class="muted empty">Nothing matches.</p>`}
${pages > 1 ? html`<nav class="pager" aria-label="Pages">${log.page > 1 ? html`<a href="/admin/audit?${qs(log.page - 1)}">← Newer</a>` : ''}<span>Page ${log.page} of ${pages}</span>${log.page < pages ? html`<a href="/admin/audit?${qs(log.page + 1)}">Older →</a>` : ''}</nav>` : ''}</section>
<section class="card"><h2>The last 30 days</h2><ul class="plain">${log.last_30_days.map((c) => html`<li>${AUDIT_TEXT[c._id] ?? c._id}: ${num(c.n)}</li>`)}</ul></section>`;
  return layout({ ...ctx, title: 'Audit log', active: 'health', body });
}

const EXPORT_STATUS = { requested: ['Waiting for an admin', 'warn'], approved: ['Approved', 'run-ok'], rejected: ['Rejected', 'muted'], expired: ['Expired', 'muted'] };
const filterText = (f) => [f.stage && `stage ${STAGE_LABEL[f.stage] ?? f.stage}`, f.cohort && `incorporated ${f.cohort}`,
  f.shortlist_month && `shortlist ${f.shortlist_month}`, f.district && `district ${f.district}`].filter(Boolean).join(' · ') || 'all companies';

export function exportsPage(list, ctx) {
  const me = ctx.user?.email;
  const canAsk = ctx.user && ['reviewer', 'admin'].includes(ctx.user.role);
  const isAdmin = ctx.user?.role === 'admin';
  const now = Date.now();
  const body = html`
<section class="hero"><div><h1>Exports</h1><p class="muted">A list of companies as a spreadsheet (CSV). Every export is approved by an admin other than the person asking, can be downloaded by that person for 24 hours, and every download is logged. Lists are company-level: the MCA facts, stage, fit, deadlines and schemes. Holdout companies are never included. With contacts, a company's registered email is added only when it is a company address and has not opted out; directors and personal addresses are never exported.</p></div></section>
${canAsk ? html`<section class="card"><h2>Ask for a list</h2><form method="post" action="/admin/exports" class="stack"><input type="hidden" name="csrf" value="${ctx.csrf}">
  <div class="inline">
  <label>Stage <select name="stage"><option value="">Any stage</option>${list.stages.map((s) => html`<option value="${s}">${STAGE_LABEL[s] ?? s}</option>`)}</select></label>
  <label>Incorporated in <input name="cohort" placeholder="YYYY-MM" size="8" pattern="\\d{4}-\\d{2}"></label>
  <label>Shortlist of <input name="shortlist_month" placeholder="YYYY-MM" size="8" pattern="\\d{4}-\\d{2}"></label>
  <label>District <input name="district" size="12" maxlength="60"></label>
  <label>Rows, at most <input name="max_rows" type="number" min="1" max="${list.max_rows}" value="5000" size="6"></label>
  </div>
  <label class="check"><input type="checkbox" name="include_contacts" value="yes"> Include the company's registered email (company addresses only)</label>
  <label>What is it for? <span class="muted small">(the approving admin reads this)</span><textarea name="reason" rows="2" minlength="10" maxlength="500" required></textarea></label>
  <p><button class="good">Ask for approval</button></p></form></section>` : ''}
<section class="card"><h2 id="list">Requests</h2>${list.items.length ? html`<div class="scroll" role="region" aria-labelledby="list" tabindex="0"><table><thead><tr><th scope="col">Asked</th><th scope="col">List</th><th scope="col" class="r">Rows</th><th scope="col">Why</th><th scope="col">Status</th><th scope="col"></th></tr></thead><tbody>
${list.items.map((x) => {
    const [text, kind] = EXPORT_STATUS[x.status] ?? [x.status, 'muted'];
    const live = x.status === 'approved' && new Date(x.download_until).getTime() > now;
    const action = x.status === 'requested' && isAdmin && x.requested_by !== me
      ? html`<form method="post" action="/admin/exports/${x._id}"><input type="hidden" name="csrf" value="${ctx.csrf}"><label class="note"><span class="vh">Note (optional)</span><input name="note" placeholder="Note (optional)" size="14" maxlength="500"></label><button name="decision" value="approve" class="good">Approve</button><button name="decision" value="reject">Reject</button></form>`
      : x.status === 'requested' && x.requested_by === me ? html`<span class="muted small">another admin approves it</span>`
        : live && x.requested_by === me ? html`<a href="/admin/exports/${x._id}/download">Download CSV</a> <span class="muted small">until ${dayTime(x.download_until)}</span>`
          : x.downloads?.length ? html`<span class="muted small">downloaded ${x.downloads.length}×</span>` : '';
    return html`<tr><td class="date">${dayTime(x.requested_at)}<div class="muted small">${x.requested_by}</div></td><td>${filterText(x.filters)}${x.include_contacts ? html`<div class="small">with company emails</div>` : ''}</td><td class="r">${num(x.estimate)}</td><td class="small">${x.reason}</td><td>${badge(text, kind)}${x.decided_by ? html`<div class="muted small">by ${x.decided_by}${x.decision_note ? `: ${x.decision_note}` : ''}</div>` : ''}</td><td>${action}</td></tr>`;
  })}
</tbody></table></div>` : html`<p class="muted empty">No exports asked for yet.</p>`}</section>`;
  return layout({ ...ctx, title: 'Exports', active: 'companies', body });
}

export function errorPage(status, message, ctx = {}) {
  return layout({ ...ctx, title: String(status), body: html`<section class="card narrow"><h1>${status}</h1><p>${message}</p><p><a href="/admin">Back to the pipeline</a></p></section>` });
}

const MSG_LABEL = { qc_failed: 'Failed the check', awaiting_approval: 'Waiting for you', approved: 'Approved', rejected: 'Rejected', sending: 'Sending',
  sent: 'Sent', send_unknown: 'Check the mailbox', blocked: 'Blocked', bounced: 'Bounced', expired: 'Expired', cancelled: 'Cancelled' };
const KIND_LABEL = { first_touch: 'First email', follow_up: 'Follow-up', new_need: 'New need' };
const msgBadge = (status) => badge(MSG_LABEL[status] ?? status, `msg-${status}`);
const CHECK_TEXT = { deliverable: 'the mailbox exists', unverified: 'passed the free checks; no verification service yet', unknown: 'the verification service could not tell' };
const recipientText = (r) => (r ? `${r.address}${r.personal ? " (a person's address, published in the MCA register)" : ''}${r.verification ? ` · address check: ${CHECK_TEXT[r.verification.result] ?? r.verification.result}` : ''}` : 'no address');

export function approvalsPage(q, ctx) {
  const c = q.counts;
  const body = html`
<section class="hero"><div><h1>Approvals</h1><p class="muted">${q.sampling?.active ? `Sample mode (design 7.5): ${q.sampling.reason}; the others are approved by the engine and listed below as approved by engine:sample.` : 'Every email is approved by a person before it is sent (design 7.5).'} The quality check has already run; the compliance gate runs again at the moment of sending.${q.sampling?.agreement ? ` The check agrees with the reviewers on ${q.sampling.agreement.pct ?? '—'}% of ${q.sampling.agreement.decided} decisions in ${q.sampling.agreement.window_days} days.` : ''}${q.sampling && q.sampling.mode === 'sample' && !q.sampling.active ? ` Sample mode is configured but not in force: ${q.sampling.reason}.` : ''}</p></div></section>
<section class="kpis">
  <div class="kpi"><span class="n">${num((c.awaiting_approval ?? 0) + (c.qc_failed ?? 0))}</span><span class="l">Waiting for a decision</span></div>
  <div class="kpi"><span class="n">${num(c.approved ?? 0)}</span><span class="l">Approved, waiting for the gate</span></div>
  <div class="kpi"><span class="n">${num(c.sent ?? 0)}</span><span class="l">Sent</span></div>
  <div class="kpi"><span class="n">${num((c.blocked ?? 0) + (c.bounced ?? 0) + (c.send_unknown ?? 0))}</span><span class="l">Blocked, bounced or unsure</span></div>
</section>
<section class="card"><h2 id="waiting">Waiting for a decision</h2>
${q.waiting.length ? html`<div class="scroll" role="region" aria-labelledby="waiting" tabindex="0"><table><thead><tr><th scope="col">Company</th><th scope="col">Message</th><th scope="col">Check</th><th scope="col">Drafted</th></tr></thead><tbody>
${q.waiting.map((m) => html`<tr><td><a class="co" href="/admin/approvals/${m.id}">${m.company_name}</a><div class="muted small">${m.company_id}</div></td><td>${m.subject}<div class="muted small">${KIND_LABEL[m.kind] ?? m.kind} · ${m.language === 'hi' ? 'Hindi' : 'English'} · ${m.drafter === 'ai' ? 'AI draft' : 'template'}${m.rules_confirmed ? '' : ' · rules not yet confirmed'}</div></td><td>${m.qc_passed ? badge('Passed', 'msg-sent') : badge('Failed', 'msg-blocked')}</td><td class="date">${dayTime(m.created_at)}</td></tr>`)}
</tbody></table></div>` : html`<p class="muted empty">Nothing waiting. Drafts arrive after the daily outreach plan, for shortlisted companies whose registered email is known.</p>`}
</section>
<section class="card"><h2 id="recent">Recent messages</h2>
${q.recent.length ? html`<div class="scroll" role="region" aria-labelledby="recent" tabindex="0"><table><thead><tr><th scope="col">Company</th><th scope="col">Message</th><th scope="col">Status</th><th scope="col">Updated</th></tr></thead><tbody>
${q.recent.map((m) => html`<tr><td><a class="co" href="/admin/approvals/${m.id}">${m.company_name}</a></td><td>${m.subject}${m.gate?.reasons?.length && m.status !== 'sent' ? html`<div class="muted small">${m.gate.reasons.join('; ')}</div>` : ''}</td><td>${msgBadge(m.status)}</td><td class="date">${dayTime(m.updated_at)}</td></tr>`)}
</tbody></table></div>` : html`<p class="muted empty">No messages yet.</p>`}
</section>`;
  return layout({ ...ctx, title: 'Approvals', active: 'approvals', body });
}

function evidenceList(p) {
  return html`<dl class="evidence">
<dt>Company</dt><dd>${p.company.name} · ${p.company.id}${p.company.legal_form ? ` · ${p.company.legal_form}` : ''} · incorporated ${day(p.company.incorporated)}${p.company.district ? ` · ${p.company.district}` : ''}</dd>
<dt>Deadlines it may mention</dt><dd>${p.deadlines.length ? html`<ul class="plain">${p.deadlines.map((d) => html`<li>${d.ref}: ${d.title}${d.form ? ` (${d.form})` : ''}, ${d.status === 'was_due' ? 'was due by' : 'due by'} ${day(d.due)}${d.law ? ` · ${d.law}` : ''}</li>`)}</ul>` : 'none'}</dd>
<dt>Schemes it may mention</dt><dd>${p.schemes.length ? html`<ul class="plain">${p.schemes.map((s) => html`<li>${s.ref}: ${s.name} (${label(VERDICT_LABEL, s.verdict)})${s.missing?.length ? ` · to check: ${s.missing.join(', ')}` : ''}</li>`)}</ul>` : 'none'}</dd>
<dt>Rules</dt><dd>${p.rules.confirmed ? `confirmed (${p.rules.version})` : `not yet confirmed by a CA (${p.rules.version ?? '—'}): this message waits at the gate until they are`}</dd>
</dl>`;
}

export function approvalPage(m, ctx) {
  const canDecide = ctx.user && ['reviewer', 'admin'].includes(ctx.user.role);
  const open = ['awaiting_approval', 'qc_failed'].includes(m.status);
  const canRecord = canDecide && m.status === 'sent';
  const canResolve = canDecide && m.status === 'send_unknown';
  const body = html`
<section class="hero"><div><p class="muted small"><a href="/admin/approvals">Approvals</a> / ${m.company_id}</p>
<h1>${m.company_name}</h1>
<p>${msgBadge(m.status)} <span class="muted">${KIND_LABEL[m.kind] ?? m.kind} · ${m.language === 'hi' ? 'Hindi' : 'English'} · from ${m.mailbox} · to ${recipientText(m.recipient)}</span></p></div></section>
${m.evidence.rules.confirmed ? '' : html`<p class="banner warn"><strong>Rules awaiting a CA's confirmation.</strong> You can approve the wording now; the compliance gate holds the email until the rules are confirmed.</p>`}
${m.gate?.reasons?.length && m.status !== 'sent' ? html`<p class="banner ${m.gate.decision === 'stop' ? 'muted' : 'warn'}">Compliance gate: ${m.gate.reasons.join('; ')}${m.gate.until ? ` · looks again ${dayTime(m.gate.until)}` : ''}</p>` : ''}
<section class="grid2">
  <div class="card"><h2>The email</h2>
    ${open && canDecide ? html`<form method="post" action="/admin/approvals/${m.id}" class="stack edit">
      <input type="hidden" name="csrf" value="${ctx.csrf}">
      <label>Subject <input type="text" name="subject" value="${m.draft.subject}" maxlength="200" required></label>
      <label>Body <span class="muted small">{{page_url}} and {{unsubscribe_url}} become the company's own links when it is sent.</span><textarea name="body" required>${m.draft.body}</textarea></label>
      <label>Note <span class="muted small">Optional; kept with your decision.</span><input type="text" name="note" maxlength="500"></label>
      <div class="actions"><button name="decision" value="approve" class="good">Approve</button><button name="decision" value="reject">Reject</button><span class="muted small">Edits are checked again before they can be approved.</span></div>
    </form>` : html`<p><strong>${m.draft.subject}</strong></p><pre class="mail">${m.draft.body}</pre>`}
  </div>
  <div class="card"><h2>Quality check</h2>
    <p>${m.qc.passed ? badge('Passed', 'msg-sent') : badge('Failed', 'msg-blocked')} <span class="muted small">${m.qc.checker} · ${m.draft.drafter === 'ai' ? `AI draft (${m.draft.model ?? 'model'})` : 'template draft'}</span></p>
    <ul class="checks">${m.qc.checks.map((c) => html`<li class="${c.ok ? 'ok' : 'no'}">${c.id.replace(/[._]/g, ' ')}${c.ok ? '' : html`<div class="small warn-text">${c.detail}</div>`}</li>`)}</ul>
    ${m.qc.ai_review ? html`<h2>AI review <span class="muted small">(advice only, ${m.qc.ai_review.model ?? 'small model'})</span></h2>
    <ul class="checks">${[['facts_only', 'only facts from the evidence pack'], ['no_false_claims', 'no promises, threats or urgency'], ['polite', 'polite and plain'], ['one_next_step', 'one clear next step']]
    .map(([k, text]) => html`<li class="${m.qc.ai_review[k] ? 'ok' : 'no'}">${text}</li>`)}</ul>${m.qc.ai_review.note ? html`<p class="muted small">${m.qc.ai_review.note}</p>` : ''}` : ''}
    <h2>Evidence pack</h2>${evidenceList(m.evidence)}
  </div>
</section>
${canResolve ? html`<section class="card"><h2>Was it sent?</h2><p>The send was interrupted, so the engine cannot tell whether the email went out, and it will not send it again by itself. Look in the Sent folder of ${m.mailbox}${m.send?.at ? ` around ${dayTime(m.send.at)}` : ''}.</p>
  <form method="post" action="/admin/approvals/${m.id}/resolve"><fieldset class="decide"><legend class="vh">Was the email to ${m.company_name} sent?</legend><input type="hidden" name="csrf" value="${ctx.csrf}">
  <button name="sent" value="yes" class="good">It was sent</button><button name="sent" value="no">It was not sent: send it again</button></fieldset></form></section>` : ''}
${canRecord ? html`<section class="card"><h2>What came back</h2><p class="muted small">Until replies are read from the mailbox automatically, record them here. A bounce or a complaint also suppresses the address.</p>
  <form method="post" action="/admin/approvals/${m.id}/outcome"><fieldset class="decide"><legend class="vh">What came back from ${m.company_name}?</legend><input type="hidden" name="csrf" value="${ctx.csrf}">
  <label class="note"><span class="vh">Note about the outcome (optional)</span><input name="note" placeholder="Note (optional)" maxlength="500"></label>
  <button name="outcome" value="replied" class="good">They replied</button><button name="outcome" value="bounced">It bounced</button><button name="outcome" value="complained">They complained</button></fieldset></form></section>` : ''}
<section class="card"><h2>History</h2>${m.history.length ? html`<ol class="timeline">${m.history.map((h) => html`<li><span class="when">${dayTime(h.at)}</span><span class="what">${MSG_LABEL[h.status] ?? h.status}</span><span class="muted small">${h.by}${h.note ? ` · ${h.note}` : ''}</span></li>`)}</ol>` : html`<p class="muted empty">Nothing recorded yet.</p>`}</section>`;
  return layout({ ...ctx, title: `Approval: ${m.company_name}`, active: 'approvals', body });
}


// ---- Phase 4: the inbox, calls and results ------------------------------------------------------------------

const LABEL_TEXT = { interested: 'Interested', question: 'Question', not_now: 'Not now', unsubscribe: 'Opted out', wrong_person: 'Wrong address', unclear: 'Unclear' };
const KIND_TEXT = { reply: 'Reply', auto_reply: 'Automatic reply', bounce: 'Bounce', complaint: 'Complaint', other: 'Other' };
const BY_TEXT = { rules: 'rules', ai: 'AI', person: 'a person' };
const labelBadge = (m) => (m.kind === 'reply' || m.label ? badge(LABEL_TEXT[m.label] ?? 'Unlabelled', `l-${m.label ?? 'unclear'}`) : badge(KIND_TEXT[m.kind] ?? m.kind, 'muted'));
const confidence = (m) => (m.confidence != null ? `${Math.round(m.confidence * 100)}% sure, by ${BY_TEXT[m.by] ?? m.by}` : '');

export function inboxPage(q, ctx) {
  const c = q.counts;
  const body = html`
<section class="hero"><div><h1>Inbox</h1><p class="muted">Replies the engine read from the outreach mailboxes. Answer them from the mailbox itself; mark each one dealt with here. Bounces and opt-outs are handled by the engine and listed under Recent.</p></div></section>
<section class="kpis">
  <div class="kpi"><span class="n">${num(c.needs_person ?? 0)}</span><span class="l">Waiting for a person</span></div>
  <div class="kpi"><span class="n">${num(c.handled ?? 0)}</span><span class="l">Dealt with by a person</span></div>
  <div class="kpi"><span class="n">${num(c.done ?? 0)}</span><span class="l">Handled by the engine</span></div>
  <div class="kpi"><span class="n">${num(c.ignored ?? 0)}</span><span class="l">Not about our outreach</span></div>
</section>
<section class="card"><h2 id="waiting">Waiting for a person</h2>
${q.waiting.length ? html`<div class="scroll" role="region" aria-labelledby="waiting" tabindex="0"><table><thead><tr><th scope="col">Company</th><th scope="col">Reply</th><th scope="col">Label</th><th scope="col">Received</th></tr></thead><tbody>
${q.waiting.map((m) => html`<tr><td><a class="co" href="/admin/inbox/${m.id}">${m.company_name ?? 'Unknown sender'}</a>${m.company_id ? html`<div class="muted small">${m.company_id}</div>` : ''}</td><td>${m.channel === 'whatsapp' ? 'WhatsApp message' : m.subject || '(no subject)'}<div class="muted small">${m.next_step ?? ''}</div></td><td>${labelBadge(m)}<div class="muted small">${confidence(m)}</div></td><td class="date">${dayTime(m.received_at)}</td></tr>`)}
</tbody></table></div>` : html`<p class="muted empty">Nothing waiting. The mailboxes are read every ten minutes.</p>`}
</section>
<section class="card"><h2 id="recent">Recent</h2>
${q.recent.length ? html`<div class="scroll" role="region" aria-labelledby="recent" tabindex="0"><table><thead><tr><th scope="col">Company</th><th scope="col">What it was</th><th scope="col">What was done</th><th scope="col">Updated</th></tr></thead><tbody>
${q.recent.map((m) => html`<tr><td><a class="co" href="/admin/inbox/${m.id}">${m.company_name ?? 'Unknown sender'}</a></td><td>${labelBadge(m)}</td><td class="small">${m.handled ? `Dealt with by ${m.handled.by}` : m.actions.join('; ')}</td><td class="date">${dayTime(m.received_at)}</td></tr>`)}
</tbody></table></div>` : html`<p class="muted empty">Nothing yet.</p>`}
</section>
<section class="card"><h2 id="other">Other mail</h2><p class="muted small">Mail that answers no email we sent: warm-up mail and newsletters, but also a founder writing afresh from another address. Glance at the subjects; open the mailbox for anything that looks like a founder.</p>
${q.other?.length ? html`<div class="scroll" role="region" aria-labelledby="other" tabindex="0"><table><thead><tr><th scope="col">From</th><th scope="col">Subject</th><th scope="col">Mailbox</th><th scope="col">Received</th></tr></thead><tbody>
${q.other.map((m) => html`<tr><td class="small">${m.from ?? '—'}</td><td>${m.subject || '(no subject)'}</td><td class="small">${m.mailbox}</td><td class="date">${dayTime(m.received_at)}</td></tr>`)}
</tbody></table></div>` : html`<p class="muted empty">None.</p>`}
</section>`;
  return layout({ ...ctx, title: 'Inbox', active: 'inbox', body });
}

export function inboxItemPage(m, ctx) {
  const canDecide = ctx.user && ['reviewer', 'admin'].includes(ctx.user.role);
  const labels = ['interested', 'question', 'not_now', 'unsubscribe', 'wrong_person', 'unclear'];
  const body = html`
<section class="hero"><div><p class="muted small"><a href="/admin/inbox">Inbox</a> / ${m.company_id ?? 'unknown sender'}</p>
<h1>${m.company_name ?? 'Unknown sender'}</h1>
<p>${labelBadge(m)} <span class="muted">${m.channel === 'whatsapp' ? 'WhatsApp message' : `${KIND_TEXT[m.kind] ?? m.kind} · to ${m.mailbox}`} · ${dayTime(m.received_at)}${m.from ? ` · from ${m.from}` : ''}</span></p></div></section>
<section class="grid2">
  <div class="card"><h2>${m.channel === 'whatsapp' ? 'The message' : m.subject || '(no subject)'}</h2>
    ${m.text ? html`<pre class="mail">${m.text}</pre>` : m.text_hidden ? html`<p class="muted">The text of a reply is shown to reviewers and admins only.</p>` : html`<p class="muted">No text kept for this kind of email.</p>`}
    ${m.dsn?.recipients?.length ? html`<h2>Delivery report</h2><ul class="plain">${m.dsn.recipients.map((r) => html`<li>${r.status ?? 'no status'} · ${r.action ?? ''}${r.diagnostic ? html`<div class="small muted">${r.diagnostic}</div>` : ''}</li>`)}</ul>` : ''}
  </div>
  <div class="card"><h2>What the engine did</h2>
    ${m.next_step ? html`<p class="banner ${m.status === 'needs_person' ? 'warn' : 'ok'}">${m.next_step}</p>` : ''}
    <ul class="plain">${m.actions.map((a) => html`<li>${a}</li>`)}</ul>
    ${m.classification ? html`<p class="muted small">Label ${LABEL_TEXT[m.classification.label] ?? m.classification.label}, ${Math.round((m.classification.confidence ?? 0) * 100)}% sure, by ${BY_TEXT[m.classification.by] ?? m.classification.by}${m.classification.model ? ` (${m.classification.model})` : ''}${m.classification.reasons?.length ? `: ${m.classification.reasons.join('; ')}` : ''}.</p>` : ''}
    ${m.message_id ? html`<p class="small"><a href="/admin/approvals/${m.message_id}">The email it answers</a> <span class="muted">(matched by ${String(m.matched_how ?? '').replace(/_/g, ' ')})</span></p>` : ''}
    ${m.handled ? html`<p class="muted small">Dealt with by ${m.handled.by}, ${dayTime(m.handled.at)}${m.handled.note ? `: ${m.handled.note}` : ''}.</p>` : ''}
  </div>
</section>
${canDecide && (m.kind === 'reply' || m.kind === 'auto_reply') ? html`<section class="card"><h2>Your decision</h2>
<form method="post" action="/admin/inbox/${m.id}" class="stack"><input type="hidden" name="csrf" value="${ctx.csrf}">
  <label>Label <select name="label">${labels.map((l) => html`<option value="${l}"${m.label === l ? raw(' selected') : ''}>${LABEL_TEXT[l]}</option>`)}</select></label>
  <label>Note <span class="muted small">Optional; for example when they asked to be contacted again.</span><input type="text" name="note" maxlength="500"></label>
  <div class="actions"><button name="handled" value="yes" class="good">Save and mark dealt with</button><button name="handled" value="no">Save the label only</button>
  <span class="muted small">Choosing Opted out or Wrong address suppresses the sender's ${m.channel === 'whatsapp' ? 'number' : 'address'}.</span></div>
</form></section>` : ''}`;
  return layout({ ...ctx, title: `Inbox: ${m.company_name ?? 'reply'}`, active: 'inbox', body });
}

const CALL_TEXT = { queued: 'Queued', placing: 'Calling', placed: 'Placed', connected: 'Connected', no_answer: 'No answer', busy: 'Busy', failed: 'Failed',
  blocked: 'For a person', cancelled: 'Cancelled', unknown: 'Check with the provider' };
const OUTCOME_TEXT = { interested: 'Interested', call_later: 'Call later', not_interested: 'Not interested', wants_person: 'Wants a person', stop: 'Asked not to be called', unclear: 'Unclear' };
const SLOT_TEXT = { morning: 'morning', afternoon: 'afternoon', evening: 'evening', any: 'any time' };
const secs = (s) => (s == null ? '—' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
const rupees = (paise) => (paise == null ? '—' : `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

export function callsPage(q, ctx) {
  const body = html`
<section class="hero"><div><h1>Calls</h1><p class="muted">Call backs founders asked for on their company page. The AI voice agent makes them once it is live (DLT registration, the number and a signed-off script); until then, and whenever it cannot, a person makes the call and marks it dealt with here.</p></div></section>
<section class="card"><h2 id="open">For a person</h2>
${q.open.length ? html`<div class="scroll" role="region" aria-labelledby="open" tabindex="0"><table><thead><tr><th scope="col">Company</th><th scope="col">Status</th><th scope="col">Why</th><th scope="col">Updated</th></tr></thead><tbody>
${q.open.map((c) => html`<tr><td><a class="co" href="/admin/calls/${c.id}">${c.company_name}</a><div class="muted small">${c.company_id} · ${SLOT_TEXT[c.slot] ?? c.slot} · ${c.language === 'en' ? 'English' : 'Hindi'}</div></td><td>${badge(c.outcome ? OUTCOME_TEXT[c.outcome] : CALL_TEXT[c.status] ?? c.status, `c-${c.outcome ? 'connected' : c.status}`)}</td><td class="small">${c.reason ?? ''}</td><td class="date">${dayTime(c.updated_at)}</td></tr>`)}
</tbody></table></div>` : html`<p class="muted empty">No call waits for a person.</p>`}
</section>
<section class="card"><h2 id="recent-calls">Recent calls</h2>
${q.recent.length ? html`<div class="scroll" role="region" aria-labelledby="recent-calls" tabindex="0"><table><thead><tr><th scope="col">Company</th><th scope="col">Status</th><th scope="col">Outcome</th><th scope="col" class="r">Length</th><th scope="col" class="r">Cost</th><th scope="col">Updated</th></tr></thead><tbody>
${q.recent.map((c) => html`<tr><td><a class="co" href="/admin/calls/${c.id}">${c.company_name}</a><div class="muted small">attempt ${c.attempt}</div></td><td>${badge(CALL_TEXT[c.status] ?? c.status, `c-${c.status}`)}</td><td>${c.outcome ? OUTCOME_TEXT[c.outcome] ?? c.outcome : '—'}</td><td class="r">${secs(c.duration_s)}</td><td class="r">${rupees(c.cost_paise)}</td><td class="date">${dayTime(c.updated_at)}</td></tr>`)}
</tbody></table></div>` : html`<p class="muted empty">No calls yet. They start when a founder ticks "call me back" on the claim form.</p>`}
</section>`;
  return layout({ ...ctx, title: 'Calls', active: 'calls', body });
}

export function callPage(c, ctx) {
  const canDecide = ctx.user && ['reviewer', 'admin'].includes(ctx.user.role);
  const body = html`
<section class="hero"><div><p class="muted small"><a href="/admin/calls">Calls</a> / ${c.company_id}</p>
<h1>${c.company_name}</h1>
<p>${badge(CALL_TEXT[c.status] ?? c.status, `c-${c.status}`)} <span class="muted">attempt ${c.attempt} · ${SLOT_TEXT[c.slot] ?? c.slot} · ${c.language === 'en' ? 'English' : 'Hindi'}${c.person ? ` · ${c.person.name}${c.person.role ? `, ${c.person.role}` : ''}` : ''}${c.to ? ` · ${c.to}` : ''}</span></p></div></section>
${c.gate?.reasons?.length ? html`<p class="banner ${c.status === 'blocked' ? 'warn' : 'muted'}">${c.gate.reasons.join('; ')}${c.gate.until ? ` · tries again ${dayTime(c.gate.until)}` : ''}</p>` : ''}
${c.failure_reason ? html`<p class="banner warn">${c.failure_reason}</p>` : ''}
<section class="grid2">
  <div class="card"><h2>The call</h2><dl class="evidence">
    <dt>Outcome</dt><dd>${c.outcome ? OUTCOME_TEXT[c.outcome] ?? c.outcome : '—'}</dd>
    <dt>Placed</dt><dd>${dayTime(c.placed_at)}</dd><dt>Ended</dt><dd>${dayTime(c.ended_at)}</dd>
    <dt>Length</dt><dd>${secs(c.duration_s)}</dd><dt>Cost</dt><dd>${rupees(c.cost_paise)}</dd><dt>Script</dt><dd>${c.script_version ?? '—'}</dd>
  </dl>
  ${c.handled ? html`<p class="muted small">Dealt with by ${c.handled.by}, ${dayTime(c.handled.at)}${c.handled.note ? `: ${c.handled.note}` : ''}.</p>` : ''}
  ${canDecide && c.needs_person ? html`<form method="post" action="/admin/calls/${c.id}" class="stack"><input type="hidden" name="csrf" value="${ctx.csrf}">
    <label>Note <span class="muted small">What happened on your call, or what you agreed.</span><input type="text" name="note" maxlength="500"></label>
    <div class="actions"><button class="good">Mark dealt with</button></div></form>` : ''}</div>
  <div class="card"><h2>Transcript</h2>${c.transcript === null ? html`<p class="muted">Shown to reviewers and admins only.</p>` : c.transcript.length ? html`<ol class="timeline">${c.transcript.map((t) => html`<li><span class="when">${t.role === 'agent' ? 'Agent' : 'Founder'}</span><span class="what">${t.text}</span></li>`)}</ol>` : html`<p class="muted empty">No transcript: the call did not connect, or it has not happened yet.</p>`}</div>
</section>
<section class="card"><h2>History</h2>${c.history.length ? html`<ol class="timeline">${c.history.map((h) => html`<li><span class="when">${dayTime(h.at)}</span><span class="what">${CALL_TEXT[h.status] ?? h.status}</span><span class="muted small">${h.note ?? ''}</span></li>`)}</ol>` : html`<p class="muted empty">Nothing yet.</p>`}</section>`;
  return layout({ ...ctx, title: `Call: ${c.company_name}`, active: 'calls', body });
}

const VERDICT_TEXT = {
  too_early: ['Too early to tell', 'muted', 'The holdout grows by about 20 companies a month; the comparison says something once both groups are larger and there are at least ten paying clients between them.'],
  lift: ['The engine adds clients', 'stage-customer', 'Contacted companies pay at a clearly higher rate than the holdout.'],
  no_clear_difference: ['No clear difference yet', 'warn', 'The two groups pay at rates that could be the same.'],
  worse: ['Contacted companies do worse', 'run-failed', 'Contacted companies pay at a lower rate than the holdout: look at the messages.'],
};
const pctOf = (k, n) => (n ? `${((100 * k) / n).toFixed(1)}%` : '—');
const pp = (x) => `${x >= 0 ? '+' : ''}${(100 * x).toFixed(1)}`;

export function resultsPage(r, ctx) {
  const { lift: l, costs: c, channels: h, months } = r;
  const v = VERDICT_TEXT[l.verdict];
  const rows = [['Companies', 'companies'], ['Contacted', 'contacted'], ['Opened their page', 'opened'], ['Replied', 'replied'], ['Claimed their page', 'claimed'],
    ['Signed up', 'signed_up'], ['Raised a service request', 'service_request'], ['Paid', 'paid']];
  const body = html`
<section class="hero"><div><h1>Results</h1><p class="muted">What the engine adds, measured the only honest way: the month's shortlist against its holdout, the companies that would have been on it but were never contacted (design 7.4).</p></div>
${months.length ? html`<form class="inline" method="get" action="/admin/results"><label>Shortlist <select name="month">${months.map((m) => html`<option${m === l.month ? raw(' selected') : ''}>${m}</option>`)}</select></label><button>Show</button></form>` : ''}</section>
<section class="card"><h2 id="lift">Contacted against the holdout, ${l.month}</h2>
<p>${badge(v[0], v[1])} <span class="muted">${v[2]}</span></p>
<div class="scroll" role="region" aria-labelledby="lift" tabindex="0"><table><thead><tr><th scope="col">Companies that…</th><th scope="col" class="r">Shortlist</th><th scope="col" class="r">Rate</th><th scope="col" class="r">Holdout</th><th scope="col" class="r">Rate</th></tr></thead><tbody>
${rows.map(([text, k]) => html`<tr><th scope="row">${text}</th><td class="r">${num(l.contacted[k])}</td><td class="r">${k === 'companies' ? '' : pctOf(l.contacted[k], l.contacted.companies)}</td><td class="r">${num(l.holdout[k])}</td><td class="r">${k === 'companies' ? '' : pctOf(l.holdout[k], l.holdout.companies)}</td></tr>`)}
<tr><th scope="row">Revenue</th><td class="r">${rupees(l.contacted.revenue_paise)}</td><td></td><td class="r">${rupees(l.holdout.revenue_paise)}</td><td></td></tr>
</tbody></table></div>
<p class="small muted">Difference in the paying rate: ${pp(l.paying.diff)} points (95% interval ${pp(l.paying.low)} to ${pp(l.paying.high)}). Sign-ups: ${pp(l.signing.diff)} points (${pp(l.signing.low)} to ${pp(l.signing.high)}). The holdout cannot claim a page or reply, since it is never written to; sign-ups, service requests and payments come from the platform for both groups.</p>
</section>
<section class="grid2">
  <div class="card"><h2 id="costs">Cost, ${c.month}</h2><div class="scroll" role="region" aria-labelledby="costs" tabindex="0"><table><thead><tr><th scope="col">Item</th><th scope="col" class="r">₹</th></tr></thead><tbody>
  ${c.lines.map((x) => html`<tr><th scope="row">${x.item}${x.fixed ? html` <span class="muted small">fixed</span>` : ''}</th><td class="r">${x.inr.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td></tr>`)}
  <tr><th scope="row"><strong>Total</strong></th><td class="r"><strong>${c.total_inr.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</strong></td></tr></tbody></table></div>
  <ul class="plain small"><li>Per shortlisted company: ${c.per_shortlisted_inr === null ? '—' : `₹${c.per_shortlisted_inr}`} (${num(c.counts.shortlisted)})</li><li>Per engaged company: ${c.per_engaged_inr === null ? '—' : `₹${c.per_engaged_inr}`} (${num(c.counts.engaged)})</li><li>Per paying client: ${c.per_paying_inr === null ? 'none yet' : `₹${c.per_paying_inr}`} (${num(c.counts.paying)})</li></ul></div>
  <div class="card"><h2 id="mailboxes">Mailboxes, last 30 days</h2><div class="scroll" role="region" aria-labelledby="mailboxes" tabindex="0"><table><thead><tr><th scope="col">Mailbox</th><th scope="col" class="r">Sent</th><th scope="col" class="r">Bounces</th><th scope="col" class="r">Complaints</th><th scope="col" class="r">Today</th></tr></thead><tbody>
  ${h.mailboxes.map((m) => html`<tr><th scope="row">${m.id}${m.paused ? html` ${badge('Paused', 'run-failed')}` : ''}</th><td class="r">${num(m.sent)}</td><td class="r">${num(m.bounced)} <span class="muted small">${m.bouncePct.toFixed(1)}%</span></td><td class="r">${num(m.complained)} <span class="muted small">${m.complaintPct.toFixed(2)}%</span></td><td class="r">${num(m.sent_today)} of ${num(m.cap_today)}</td></tr>`)}
  </tbody></table></div><p class="small muted">Rates divide by at least 50 sends. Sending pauses above ${h.mailboxes[0]?.limits.bounce_pct ?? 2}% bounces or ${h.mailboxes[0]?.limits.complaint_pct ?? 0.1}% complaints. Warm-up day ${h.mailboxes[0]?.warmup_day ?? '—'}.</p></div>
</section>
<section class="grid2">
  <div class="card"><h2>WhatsApp templates</h2>${h.whatsapp.length ? html`<ul class="plain">${h.whatsapp.map((t) => html`<li>${t.name} (${t.language}): ${badge(t.status, t.status === 'APPROVED' ? 'run-ok' : 'warn')}${t.quality ? html` <span class="muted small">quality ${t.quality}</span>` : ''}</li>`)}</ul>` : html`<p class="muted empty">Not on Meta yet: submit them, then run whatsapp:templates --sync.</p>`}</div>
  <div class="card"><h2>Calls and replies, last 30 days</h2><ul class="plain">
    <li>Calls: ${Object.keys(h.calls).length ? Object.entries(h.calls).map(([s, x]) => `${CALL_TEXT[s] ?? s} ${x.n}`).join(', ') : 'none'}</li>
    <li>Call outcomes: ${Object.keys(h.call_outcomes).length ? Object.entries(h.call_outcomes).map(([o, n]) => `${OUTCOME_TEXT[o] ?? o} ${n}`).join(', ') : 'none'}</li>
    <li>Replies: ${h.inbound.filter((x) => x.kind === 'reply').length ? h.inbound.filter((x) => x.kind === 'reply').map((x) => `${LABEL_TEXT[x.label] ?? 'unlabelled'} ${x.n}`).join(', ') : 'none'}</li>
    <li>Bounces ${h.inbound.filter((x) => x.kind === 'bounce').reduce((n, x) => n + x.n, 0)}, automatic replies ${h.inbound.filter((x) => x.kind === 'auto_reply').reduce((n, x) => n + x.n, 0)}</li>
    <li>Company pages opened: ${num(h.page_opens_30d)}</li></ul></div>
</section>
<section class="card"><h2 id="campaigns">Campaigns</h2>${r.campaigns?.length ? html`<div class="scroll" role="region" aria-labelledby="campaigns" tabindex="0"><table><thead><tr><th scope="col">Campaign</th><th scope="col">Landing page</th><th scope="col" class="r">Pages opened</th><th scope="col" class="r">Claimed</th><th scope="col" class="r">Signed up</th><th scope="col" class="r">Paid</th><th scope="col" class="r">Revenue</th></tr></thead><tbody>
${r.campaigns.map((c) => html`<tr><th scope="row">${c.name}${c.active ? '' : html` <span class="muted small">(off)</span>`}</th><td class="small">/j/${c.code}</td><td class="r">${num(c.opened)}</td><td class="r">${num(c.claimed)}</td><td class="r">${num(c.signed_up)}</td><td class="r">${num(c.paid)}</td><td class="r">${rupees(c.revenue_paise)}</td></tr>`)}
</tbody></table></div><p class="muted small">Companies counted once each. A campaign page is open to every company, the holdout included, so these are counts, not a measured lift.</p>`
    : html`<p class="muted empty">No campaigns yet. Add one to config/outreach.json (campaigns); its landing page is the pages' address followed by /j/ and its code.</p>`}</section>`;
  return layout({ ...ctx, title: 'Results', active: 'results', body });
}

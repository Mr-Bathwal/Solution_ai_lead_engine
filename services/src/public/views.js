/**
 * The pages a founder sees: the company page, the claim form, the thank-you page and the
 * unsubscribe page. Same rules as the Admin pages: every value escaped, no JavaScript, links only to
 * http(s) targets, a visible label on every field, and nothing about any person.
 *
 * The company page, the claim form and the thank-you page come in English and Hindi (i18n.js); the
 * Hindi is served only once the lawyer has approved it, and before that only as a marked preview
 * whose form cannot be sent. `alt` is the link to the same page in the other language, if any.
 */
import { html, raw } from '../admin/views.js';
import { safeHref } from '../admin/queries.js';
import { TEXT } from './i18n.js';

const VERDICT_CLASS = { eligible: 'good', check_required: '' };
const ROLES = ['Director', 'Founder', 'Partner', 'Employee', 'Other'];
const SLOTS = ['morning', 'afternoon', 'evening', 'any'];

function layout({ title, body, org, lang = 'en', alt = null, preview = false }) {
  const t = TEXT[lang];
  return html`<!doctype html>
<html lang="${t.html_lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">
<title>${title} · ${org.name}</title><link rel="stylesheet" href="/static/public.css"></head>
<body>
<a class="skip" href="#main">${t.skip}</a>
<header class="top"><div class="wrap"><a class="brand" href="${safeHref(org.website) ?? '#main'}" rel="noreferrer"><span class="dot" aria-hidden="true"></span>${org.name}</a>${alt ? html`<a class="lang" href="${alt}" lang="${lang === 'en' ? 'hi' : 'en'}">${t.switch_to}</a>` : ''}</div></header>
${preview ? html`<p class="draft" role="note">${TEXT.hi.draft_banner}</p>` : ''}
<main class="wrap" id="main">${body}</main>
<footer class="wrap small muted">${t.footer(org.legal_name ?? org.name)}</footer>
</body></html>`;
}

const linkFor = (t) => (url, text) => {
  const href = safeHref(url);
  return href ? html`<a href="${href}" rel="noreferrer noopener" target="_blank">${text}<span class="skip">${t.new_tab}</span></a>` : html`${text}`;
};

/** The company page. `view`: { company: { name, id, kind, legal_form, incorporated, district }, confirmed, deadlines, schemes }. */
export function companyPage(view, { org, claimUrl, lang = 'en', alt = null, preview = false }) {
  const t = TEXT[lang];
  const link = linkFor(t);
  const c = view.company;
  const facts = [c.kind === 'llp' ? `LLPIN ${c.id}` : `CIN ${c.id}`, c.legal_form, c.incorporated ? t.incorporated(c.kind, t.date(c.incorporated)) : null, c.district].filter(Boolean);
  const body = html`
<h1>${c.name}</h1>
<p class="muted">${facts.join(' · ')}</p>
${view.confirmed ? html`
<section class="card" aria-labelledby="dates"><h2 id="dates">${t.dates_title}</h2>
${view.deadlines.length ? html`<ul class="dates">${view.deadlines.map((d) => html`<li><div><strong>${d.title}</strong>${d.form ? html` <span class="tag">${d.form}</span>` : ''}
<div class="small muted">${d.law ? link(d.source_url, d.law) : ''}</div>${d.note ? html`<div class="small muted">${d.note}</div>` : ''}</div>
<div class="when${d.past ? ' past' : ''}">${t.due(d.past, t.date(d.due))}</div></li>`)}</ul>
<p class="small muted">${t.dates_note}</p>`
    : html`<p class="muted">${t.no_dates}</p>`}
</section>
<section class="card" aria-labelledby="schemes"><h2 id="schemes">${t.schemes_title(c.name)}</h2>
${view.schemes.length ? view.schemes.map((s) => html`<div class="scheme"><p><strong>${s.name}</strong> <span class="tag ${VERDICT_CLASS[s.verdict] ?? ''}">${t.verdict[s.verdict] ?? s.verdict}</span></p>
${s.benefit ? html`<p class="small">${s.benefit}</p>` : ''}${s.missing?.length ? html`<p class="small muted">${t.to_check(s.missing.join(', '))}</p>` : ''}<p class="small">${link(s.source_url, t.source)}</p></div>`)
    : html`<p class="muted">${t.no_schemes}</p>`}
</section>`
    : html`<section class="card"><p class="notice">${t.being_checked(c.name)}</p></section>`}
<section class="card"><h2>${t.yours}</h2>
<p>${t.claim_pitch(org.name, c.name)}</p>
<p><a class="button" href="${claimUrl}">${t.claim(c.name)}</a></p></section>`;
  return layout({ title: c.name, body, org, lang, alt, preview });
}

/** The exact wording of each consent on the claim form; what is ticked is stored with this text. */
export function consentOptions(companyName, org = { name: 'SolutionAI' }, lang = 'en') {
  const w = TEXT[lang].consent;
  return [
    { key: 'email_reminders', channel: 'email', purpose: 'deadline_reminders', text: w.email_reminders(companyName) },
    { key: 'whatsapp_reminders', channel: 'whatsapp', purpose: 'deadline_reminders', text: w.whatsapp_reminders(companyName) },
    { key: 'email_schemes', channel: 'email', purpose: 'scheme_alerts', text: w.email_schemes(companyName) },
    { key: 'callback', channel: 'voice', purpose: 'callback', text: w.callback(companyName, org.name) },
  ];
}

export function noticeText(org, privacyUrl, contact, lang = 'en') {
  return TEXT[lang].notice(org.legal_name ?? org.name, org.name, contact, Boolean(privacyUrl));
}

/** The message for a claim that cannot be accepted, in the page's language. */
export const claimError = (lang, key) => TEXT[lang].errors[key];

export function claimPage({ company, csrf, error = null, values = {} }, { org, privacyUrl, contact, action, lang = 'en', alt = null, preview = false, back = null }) {
  const t = TEXT[lang];
  const options = consentOptions(company.name, org, lang);
  const body = html`
<p class="small muted"><a href="${back ?? action.replace(/\/claim$/, '')}">${company.name}</a> / ${t.crumb_claim}</p>
<h1>${t.claim(company.name)}</h1>
<p class="muted">${noticeText(org, privacyUrl, contact, lang)} ${privacyUrl ? linkFor(t)(privacyUrl, t.privacy_link) : ''}</p>
${error ? html`<p class="error" role="alert">${error}</p>` : ''}
<form class="stack card" method="post" action="${action}">
  <input type="hidden" name="csrf" value="${csrf}">${lang !== 'en' ? html`<input type="hidden" name="lang" value="${lang}">` : ''}
  <label>${t.f_name} <input type="text" name="name" autocomplete="name" required minlength="2" maxlength="100" value="${values.name ?? ''}"></label>
  <label>${t.f_role(company.name)} <select name="role" required>${ROLES.map((r) => html`<option value="${r}"${values.role === r ? raw(' selected') : ''}>${t.roles[r]}</option>`)}</select></label>
  <label>${t.f_email} <input type="email" name="email" autocomplete="email" required maxlength="200" value="${values.email ?? ''}"></label>
  <label>${t.f_mobile} <span class="hint">${t.f_mobile_hint}</span><input type="tel" name="whatsapp" autocomplete="tel" maxlength="20" value="${values.whatsapp ?? ''}"></label>
  <fieldset><legend>${t.hear_about}</legend>
  ${options.map((o) => html`<label class="check"><input type="checkbox" name="consent" value="${o.key}"${(values.consent ?? []).includes(o.key) ? raw(' checked') : ''}><span>${o.text}</span></label>`)}
  <p class="small muted">${t.nothing_ticked}</p></fieldset>
  <fieldset><legend>${t.if_callback}</legend>
  <label>${t.best_time} <select name="call_slot">${SLOTS.map((k) => html`<option value="${k}"${(values.call_slot ?? 'any') === k ? raw(' selected') : ''}>${t.slots[k].charAt(0).toUpperCase() + t.slots[k].slice(1)}</option>`)}</select></label>
  <label>${t.language} <select name="call_language"><option value="hi"${values.call_language !== 'en' ? raw(' selected') : ''}>${t.lang_names.hi}</option><option value="en"${values.call_language === 'en' ? raw(' selected') : ''}>${t.lang_names.en}</option></select></label>
  <p class="small muted">${t.call_days}</p></fieldset>
  <button${preview ? raw(' disabled') : ''}>${t.claim(company.name)}</button>
</form>`;
  return layout({ title: t.claim(company.name), body, org, lang, alt, preview });
}

/** "reminders of filing deadlines by email and WhatsApp, an email when a scheme may apply, and a call back in the morning" */
function youWillGet(chosen, callSlot = 'any', lang = 'en') {
  const g = TEXT[lang].get;
  const by = chosen.filter((c) => c.purpose === 'deadline_reminders').map((c) => g.channel[c.channel === 'whatsapp' ? 'whatsapp' : 'email']);
  const parts = [];
  if (by.length) parts.push(g.reminders(by));
  if (chosen.some((c) => c.purpose === 'scheme_alerts')) parts.push(g.scheme);
  if (chosen.some((c) => c.purpose === 'callback')) parts.push(g.callback(TEXT[lang].slots[callSlot] ?? TEXT[lang].slots.any));
  return g.join(parts);
}

export function claimedPage({ company, signupUrl, prefilled, chosen, callSlot = 'any' }, { org, lang = 'en' }) {
  const t = TEXT[lang];
  const body = html`
<h1>${t.thanks}</h1>
<p>${t.claimed(company.name)} ${chosen.length ? t.you_will_get(youWillGet(chosen, callSlot, lang)) : t.none_asked}</p>
${signupUrl ? html`<section class="card"><h2>${t.setup(org.name)}</h2><p>${prefilled ? t.prefilled(company.name) : t.create(org.name, company.name)}</p><p><a class="button" href="${safeHref(signupUrl) ?? '#'}" rel="noreferrer">${t.continue_to(org.name)}</a></p></section>` : ''}`;
  return layout({ title: t.claimed_title, body, org, lang });
}

/** A campaign's landing page: find your company. `results` null: no search yet; [] nothing found. */
export function campaignPage({ campaign, signupUrl, query = '', results = null, tooShort = false }, { org }) {
  const body = html`
<p class="small muted">${campaign.name}</p>
<h1>Your company's filing dates, free</h1>
<p>${org.name} shows each new company in Uttar Pradesh its next filing deadlines and the government schemes it may qualify for. Find your company to see its page.</p>
<form class="stack card" method="get" action="/j/${campaign.code}">
  <label>Company name or CIN <input type="search" name="q" value="${query}" required minlength="3" maxlength="120" autocomplete="organization"></label>
  <button>Find my company</button>
</form>
${tooShort ? html`<p class="error" role="alert">Type at least three letters of the name, or the CIN from the certificate of incorporation.</p>` : ''}
${results && results.length ? html`<section class="card" aria-labelledby="found"><h2 id="found">Is it one of these?</h2><ul class="found">${results.map((c) => html`<li><form method="post" action="/j/${campaign.code}/open"><input type="hidden" name="company" value="${c.id}"><input type="hidden" name="sig" value="${c.sig}">
<div><strong>${c.name}</strong><div class="small muted">${c.kind === 'llp' ? 'LLPIN' : 'CIN'} ${c.id}${c.incorporated ? ` · ${c.kind === 'llp' ? 'registered' : 'incorporated'} ${c.incorporated}` : ''}${c.district ? ` · ${c.district}` : ''}</div></div>
<button>Open its page</button></form></li>`)}</ul></section>` : ''}
${results && !results.length ? html`<section class="card"><p>We could not find "${query}". New companies registered in Uttar Pradesh appear here a few days after the Ministry of Corporate Affairs publishes its monthly list.${signupUrl ? html` You can <a href="${signupUrl}" rel="noreferrer">sign up with ${org.name}</a> directly.` : ''}</p></section>` : ''}`;
  return layout({ title: campaign.name, body, org });
}

export function unsubscribePage({ masked, done = false, csrf = '', action = '' }, { org }) {
  const body = done
    ? html`<h1>You are unsubscribed</h1><p>${org.name} will not email ${masked} again. If this was a mistake, reply to any of our emails and a person will put it right.</p>`
    : html`<h1>Stop emails from ${org.name}?</h1><p>We will stop all emails to ${masked}.</p>
<form method="post" action="${action}"><input type="hidden" name="csrf" value="${csrf}"><button>Stop emails</button></form>`;
  return layout({ title: 'Unsubscribe', body, org });
}

/** After a claim from a campaign page: the confirmation link is on its way. */
export function checkEmailPage({ company, masked }, { org, lang = 'en' }) {
  const t = TEXT[lang].confirm;
  const body = html`<h1>${t.check_title}</h1><p>${t.check(company.name, masked)}</p><p class="small muted">${t.check_again}</p>`;
  return layout({ title: t.check_title, body, org, lang });
}

/** The confirmation link's page: a button, because link scanners open every link in an email. */
export function confirmClaimPage({ company, csrf, action, chosen = [], callSlot = 'any' }, { org, lang = 'en' }) {
  const T = TEXT[lang];
  const body = html`<h1>${T.confirm.page_title}</h1>
<p>${T.confirm.ask(company.name)} ${chosen.length ? T.you_will_get(youWillGet(chosen, callSlot, lang)) : ''}</p>
<form method="post" action="${action}"><input type="hidden" name="csrf" value="${csrf}"><button>${T.confirm.button}</button></form>`;
  return layout({ title: T.confirm.page_title, body, org, lang });
}

export function notFoundPage({ org }) {
  return layout({ title: 'Not found', body: html`<h1>This link has expired or does not exist</h1><p>Links in our emails work for a few months. Reply to the email you got and a person from ${org.name} will help.</p>`, org });
}

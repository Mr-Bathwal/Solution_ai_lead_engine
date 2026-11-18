/**
 * Eval 1: draft factuality and lawfulness.
 *
 * The engine writes drafts (services/src/outreach/draft.js, with the reviewed templates in
 * templates.js; no LLM is configured, so the templates write every draft, exactly as in production
 * until the gateway has a key). This file grades each draft with its own checker, written from what
 * the engine promises (README "What Week 3 delivers", templates.js header, config/outreach.json)
 * rather than from qc.js: its own date, form, section and rupee readers, its own month names, and
 * whole-token comparison where qc.js uses substring and set membership.
 *
 * Packs are built by the engine (buildEvidencePack, recipientFor). The three edits draftStep makes to a
 * pack (sequence.js: the website basis, the thread of a follow-up, the one need of a new-need message)
 * are mirrored here, because running the job table for 90 drafts would add a database without
 * changing what is graded.
 */
import { engine, fixture, readText } from './common.mjs';

const PAGE = '{{page_url}}';
const UNSUB = '{{unsubscribe_url}}';

// ---- my own readers (deliberately not imported from the engine) ------------------------------------

const EN_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
// Hindi month names in the spellings people use (with and without the nukta and the half-m)
const HI_MONTHS = [['जनवरी'], ['फ़रवरी', 'फरवरी'], ['मार्च'], ['अप्रैल', 'अप्रेल'], ['मई'], ['जून'], ['जुलाई'], ['अगस्त'], ['सितंबर', 'सितम्बर'],
  ['अक्टूबर', 'अक्तूबर'], ['नवंबर', 'नवम्बर'], ['दिसंबर', 'दिसम्बर']];
const HI_INDEX = new Map(HI_MONTHS.flatMap((names, i) => names.map((n) => [n, i])));
const EN_SHORT = new Map(EN_MONTHS.flatMap((m, i) => [[m, i], [m.slice(0, 3), i], ...(m === 'september' ? [['sept', i]] : [])]));
const DEVANAGARI_DIGITS = /[०-९]/g;
const asciiDigits = (s) => s.replace(DEVANAGARI_DIGITS, (d) => String(d.charCodeAt(0) - 0x0966));
const iso = (y, m, d) => {
  const t = Date.UTC(y, m, d);
  const dt = new Date(t);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : `invalid:${y}-${m + 1}-${d}`;
};

/** Every date written in a text, in any of the forms a person or a model might use, as ISO days. */
export function findDates(text) {
  const t = asciiDigits(text);
  const out = [];
  const enNames = [...EN_SHORT.keys()].sort((a, b) => b.length - a.length).join('|');
  const hiNames = [...HI_INDEX.keys()].join('|');
  const patterns = [
    [new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${enNames})\\.?,?\\s+(\\d{4})\\b`, 'gi'), (m) => iso(+m[3], EN_SHORT.get(m[2].toLowerCase()), +m[1])],
    [new RegExp(`\\b(${enNames})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'), (m) => iso(+m[3], EN_SHORT.get(m[1].toLowerCase()), +m[2])],
    [new RegExp(`(\\d{1,2})\\s+(${hiNames})\\s*,?\\s+(\\d{4})`, 'g'), (m) => iso(+m[3], HI_INDEX.get(m[2]), +m[1])],
    [/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => iso(+m[1], +m[2] - 1, +m[3])],
    // figures are read the Indian way, day first
    [/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/g, (m) => iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2] - 1, +m[1])],
  ];
  for (const [rx, read] of patterns) for (const m of t.matchAll(rx)) out.push({ text: m[0], iso: read(m), at: m.index });
  return out;
}

/** Form codes as MCA, the LLP registry and the tax department write them. */
const FORM_RX = /\b(?:[A-Z]{2,6}-\d{1,2}[A-Z]{0,2}(?:\s+KYC(?:\s+Web)?)?|Form\s+\d{1,2}[A-Z]?|फ़ॉर्म\s+\d{1,2}|फॉर्म\s+\d{1,2})(?![\w-])/g;
export const findForms = (text) => [...asciiDigits(text).matchAll(FORM_RX)].map((m) => m[0].replace(/\s+/g, ' ').replace(/^(?:फ़ॉर्म|फॉर्म)/, 'Form'));

/** Section and rule numbers: "s.10A", "s.173(1)", "section 248", "r.23A", "धारा 10A". */
const SECTION_RX = /\b(?:s|ss|r)\.\s?\d+[A-Z]{0,3}(?:\(\d+[A-Za-z]?\))*|\b(?:sections?|rules?)\s+\d+[A-Z]{0,3}(?:\(\d+[A-Za-z]?\))*|(?:धारा|नियम)\s+\d+[A-Z]{0,3}(?:\(\d+\))*/gi;
function canonSection(s) {
  const m = /^(s|ss|r|sections?|rules?|धारा|नियम)\.?\s*(\d+[A-Z]{0,3})((?:\([^)]*\))*)$/i.exec(s.trim());
  if (!m) return s.toLowerCase();
  const kind = /^(r|rules?|नियम)$/i.test(m[1]) ? 'r' : 's';
  return `${kind}.${m[2].toUpperCase()}${m[3]}`;
}
export const findSections = (text) => (asciiDigits(text).match(SECTION_RX) ?? []).map(canonSection);

/** Rupee amounts, as a value in rupees: "₹20 lakh", "Rs. 3,000", "INR 4.8 lakh", "₹20,000". */
const UNIT = { lakh: 1e5, lac: 1e5, lakhs: 1e5, 'लाख': 1e5, crore: 1e7, crores: 1e7, cr: 1e7, 'करोड़': 1e7, 'करोड': 1e7, thousand: 1e3, 'हज़ार': 1e3, 'हजार': 1e3 };
const RUPEE_RX = /(?:₹|\bRs\.?|\bINR|रु\.?|रुपये)\s?(\d[\d,]*(?:\.\d+)?)(?:\s*(lakhs?|lac|crores?|cr|thousand|लाख|करोड़|करोड|हज़ार|हजार))?|(\d[\d,]*(?:\.\d+)?)\s*(lakhs?|crores?|लाख|करोड़|करोड)\b/gi;
export function findRupees(text) {
  const out = [];
  for (const m of asciiDigits(text).matchAll(RUPEE_RX)) {
    const num = Number((m[1] ?? m[3]).replace(/,/g, ''));
    const unit = (m[2] ?? m[4] ?? '').toLowerCase();
    out.push({ text: m[0].trim(), value: Math.round(num * (UNIT[unit] ?? 1)) });
  }
  return out;
}

const LINK_RX = /\bhttps?:\/\/[^\s<>()"']+|\bwww\.[^\s<>()"']+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:in|com|org|net|co|io|ai|app|example|gov\.in|co\.in)\b(?:\/[^\s<>()"']*)?/gi;
const EMAIL_RX = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}/gi;
const PHONE_RX = /(?:\+?\d[\s-]?){10,13}/g;
const TONE_RX = /\b(?:missed|overdue|defaulted|non-?compliant|late fee|penalt(?:y|ies)|fined?|prosecut\w*|legal action|urgent(?:ly)?|immediately|act now|last chance|final notice)\b|जुर्मान|दंड|चूक|तुरंत|कानूनी कार्रवाई|अंतिम चेतावनी/i;
// an instruction to opt out, not a promise to stop ("you will not get another email about this" is not one)
const OPT_OUT_EN = /\bunsubscribe\b|\bstop (?:all )?e-?mails?\b|\bnot (?:to )?hear from us\b|\bnot write again\b|\bopt out\b/i;
const OPT_OUT_HI = /unsubscribe|अनसब्सक्राइब|ईमेल बंद|नहीं चाहते/;
const words = (s) => s.split(/\s+/).filter(Boolean).length;

/** Every ISO day anywhere in a pack: the only dates a draft may state. */
function packDates(pack) {
  const out = new Set();
  const walk = (v) => {
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) out.add(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(pack);
  return out;
}
const packStrings = (pack) => {
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(pack);
  return out.join('\n');
};
const fmt = (isoDay, lang) => {
  const [y, m, d] = isoDay.split('-').map(Number);
  return lang === 'hi' ? `${d} ${HI_MONTHS[m - 1][0]} ${y}` : `${d} ${EN_MONTHS[m - 1][0].toUpperCase()}${EN_MONTHS[m - 1].slice(1)} ${y}`;
};

/**
 * The grader. `d`: { draft: { subject, body }, pack, kind, language, basis, domain, company (fixture
 * row), others (other companies' names), people (names, emails, phones that must not appear) }.
 * Returns [{ id, ok, detail }].
 */
export function gradeDraft(d, cfg) {
  const { subject, body } = d.draft;
  const text = `${subject}\n${body}`;
  const checks = [];
  const add = (id, ok, detail = null) => checks.push({ id, ok: Boolean(ok), detail: ok ? null : detail });
  const pack = d.pack;
  const facts = packStrings(pack);

  // dates: each one is a date in the pack
  const allowed = packDates(pack);
  const found = findDates(text);
  const stray = found.filter((x) => !allowed.has(x.iso));
  add('facts.dates_in_pack', !stray.length, `dates not in the pack: ${stray.map((x) => x.text).join(', ')}`);
  // and each deadline line carries that deadline's own date, not another one from the pack
  const misattributed = [];
  for (const dl of pack.deadlines ?? []) {
    for (const line of body.split('\n').filter((l) => l.includes(dl.title))) {
      const ds = findDates(line).map((x) => x.iso);
      if (ds.length && !ds.includes(dl.due)) misattributed.push(`${dl.title}: ${findDates(line).map((x) => x.text).join(', ')} (pack: ${dl.due})`);
    }
  }
  add('facts.dates_attributed', !misattributed.length, `a deadline shown with another date: ${misattributed.join('; ')}`);

  // form codes, compared as whole codes ("INC-20" is not "INC-20A")
  const packForms = new Set(findForms(facts));
  const strayForms = findForms(text).filter((f) => !packForms.has(f));
  add('facts.forms_in_pack', !strayForms.length, `form codes not in the pack: ${[...new Set(strayForms)].join(', ')}`);

  // section and rule numbers
  const packSections = new Set(findSections(facts));
  const straySections = findSections(text).filter((s) => !packSections.has(s));
  add('facts.sections_in_pack', !straySections.length, `section or rule numbers not in the pack: ${[...new Set(straySections)].join(', ')}`);

  // rupee figures
  const packRupees = new Set(findRupees(facts).map((r) => r.value));
  const strayRupees = findRupees(text).filter((r) => !packRupees.has(r.value));
  add('facts.rupees_in_pack', !strayRupees.length, `rupee figures not in the pack: ${strayRupees.map((r) => r.text).join(', ')}`);

  // the company: its registered name (any capitalisation) in the subject and greeting, and no other company's
  const name = pack.company.name;
  const nameIsRegistered = name.toLowerCase() === d.company.name.toLowerCase();
  const greeting = body.split('\n')[0];
  add('company.name_right', nameIsRegistered && subject.includes(name) && greeting.includes(name),
    !nameIsRegistered ? `the pack names "${name}", the register "${d.company.name}"` : `the name is missing from the ${subject.includes(name) ? 'greeting' : 'subject'}`);
  const lower = text.toLowerCase();
  const wrong = d.others.filter((n) => lower.includes(n.toLowerCase()) && !name.toLowerCase().includes(n.toLowerCase()));
  add('company.no_other_company', !wrong.length, `names another company: ${wrong.join(', ')}`);

  // links: one page link, one unsubscribe link, nothing else that a mail client would make clickable
  const nPage = body.split(PAGE).length - 1;
  const nUnsub = body.split(UNSUB).length - 1;
  add('links.one_page_link', nPage === 1 && !subject.includes(PAGE), `page link ${nPage} times`);
  add('links.one_unsubscribe_link', nUnsub === 1, `unsubscribe link ${nUnsub} times`);
  const stripped = text.replaceAll(PAGE, ' ').replaceAll(UNSUB, ' ').replace(EMAIL_RX, ' ');
  // the company's own domain, named in the website basis line, is the founder's own site: not counted
  const others = (stripped.match(LINK_RX) ?? []).filter((u) => !(d.domain && u.toLowerCase().replace(/[.,;:]+$/, '') === d.domain));
  add('links.no_other_links', !others.length, `other links: ${[...new Set(others)].join(', ')}`);
  add('links.no_unknown_placeholders', !/\{\{(?!page_url\}\}|unsubscribe_url\}\})[^}]*\}\}/.test(text), 'an unfilled {{placeholder}}');

  // why you are getting this: the basis the address was really used under
  const why = body.split('\n\n').find((p) => /getting this|इसलिए मिला/.test(p)) ?? '';
  let whyOk;
  let whyDetail;
  if (!why) [whyOk, whyDetail] = [false, `no "why you are getting this" line (${d.kind})`];
  else if (d.basis === 'published_by_company') {
    whyOk = /website|वेबसाइट/i.test(why) && why.includes(d.domain) && !/Corporate Affairs|कॉर्पोरेट कार्य|\bMCA\b|register|रजिस्टर/i.test(why);
    whyDetail = 'a website address, but the line does not say so (or names the MCA register)';
  } else {
    whyOk = /Ministry of Corporate Affairs|कॉर्पोरेट कार्य मंत्रालय|\bMCA\b/.test(why) && !/website|वेबसाइट/i.test(why);
    whyDetail = 'a registered address, but the line does not name the MCA register (or names a website)';
  }
  add('why.matches_basis', whyOk, whyDetail);

  // opt-out in words, not only the link
  const noLink = body.replaceAll(UNSUB, ' ');
  add('opt_out.words', (d.language === 'hi' ? OPT_OUT_HI : OPT_OUT_EN).test(noLink), 'no opt-out sentence in words');

  // no person's details
  const leaks = [];
  for (const n of d.people.names) if (lower.includes(n.toLowerCase())) leaks.push(n);
  for (const e of text.match(EMAIL_RX) ?? []) leaks.push(e);
  for (const p of text.match(PHONE_RX) ?? []) if (p.replace(/\D/g, '').length >= 10) leaks.push(p.trim());
  add('privacy.no_person', !leaks.length, `personal details: ${leaks.join(', ')}`);

  // never something that may not apply, never a threat or urgency
  const iffy = (d.company.deadlines ?? []).filter((x) => x && typeof x === 'object' && !Array.isArray(x)).map((x) => d.rules.get(x.id)).filter(Boolean)
    .filter((r) => body.includes(r.title) || (r.form && findForms(r.form).some((f) => findForms(body).includes(f))));
  add('lawful.no_conditional_obligation', !iffy.length, `mentions an obligation that may not apply: ${iffy.map((r) => r.title).join(', ')}`);
  const tone = TONE_RX.exec(text);
  add('lawful.no_threat_or_urgency', !tone, `"${tone?.[0]}"`);

  // lengths, from config/outreach.json
  const q = cfg.quality;
  const lim = q.body_max_words[d.kind];
  const maxWords = typeof lim === 'object' ? lim[d.language] ?? lim.en : lim;
  add('length.subject', subject.trim().length > 0 && subject.length <= q.subject_max_chars, `subject ${subject.length} characters (limit ${q.subject_max_chars})`);
  add('length.body', words(body) <= maxWords, `body ${words(body)} words (limit ${maxWords})`);
  return checks;
}

// ---- producing the drafts with the engine -----------------------------------------------------------

const DAY = 86_400_000;
const addDays = (isoDay, n) => new Date(Date.parse(`${isoDay}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const addMonths = (isoDay, n) => {
  const [y, m, d] = isoDay.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, d)).toISOString().slice(0, 10);
};

function rulesById() {
  const deadlines = JSON.parse(readText('config/rules/deadlines.json')).rules;
  const schemes = JSON.parse(readText('config/rules/schemes.json')).schemes;
  return { deadlines: new Map(deadlines.map((r) => [r.id, r])), schemes: new Map(schemes.map((s) => [s.id, s])) };
}

/** A fixture row as the engine stores it: the company record and its lead with worked-out needs. */
function engineRecords(row, rules, asOf, { later = false } = {}) {
  const seen = new Date('2026-11-01T00:00:00Z');
  const attr = (value, source) => ({ value, source, seen_at: seen });
  const attrs = { incorporation_date: attr(row.incorporated, 'mca_monthly'), company_type: attr(row.type, 'mca_monthly'),
    registered_district: attr(row.district, 'mca_monthly'), directors: attr(row.directors, 'infyner'), phone: attr(row.phone, 'infyner') };
  if (row.registered_email) attrs.registered_email = attr(row.registered_email, 'infyner');
  if (row.website_email) attrs.website_email = { ...attr(row.website_email, 'company_website'), ref: { domain: row.website_email.split('@')[1], legal_basis: 'published_by_company' } };
  const company = { _id: row.cin, kind: row.kind, state: 'UP', name: row.name, ids: { cin: row.kind === 'company' ? row.cin : null, uplc: [] }, attrs };
  const deadlines = row.deadlines.map((x) => {
    if (typeof x === 'string' || Array.isArray(x)) {
      const [id, given] = Array.isArray(x) ? x : [x, null];
      const r = rules.deadlines.get(id);
      let due = given;
      if (!due && r.due?.anchor === 'incorporation') due = r.due.days ? addDays(row.incorporated, r.due.days) : addMonths(row.incorporated, r.due.months);
      return { id, title: r.title, form: r.form, law: r.law, due, status: due < asOf ? 'was_due' : 'upcoming', source_url: r.source_url ?? null };
    }
    const r = rules.deadlines.get(x.id);
    return { id: x.id, title: r.title, form: r.form, law: r.law, due: x.due ?? null, status: x.status };
  });
  const schemes = (later && row.schemes_later ? row.schemes_later : row.schemes).map(([id, verdict]) => {
    const s = rules.schemes.get(id);
    return { scheme_id: id, name: s.name, verdict, benefit: s.benefit ?? null, missing: verdict === 'check_required' ? ['details to check'] : [], source_url: s.source_url ?? null };
  });
  const lead = { company_id: row.cin, needs: { rules_confirmed: true, rules_version: 'eval', deadlines, schemes } };
  return { company, lead };
}

export async function runDraftEval(cfg) {
  const { buildEvidencePack, recipientFor } = await engine('src/outreach/evidence.js');
  const { Drafter } = await engine('src/outreach/draft.js');
  const fx = fixture('draft_companies.json');
  const rules = rulesById();
  const o = cfg.outreach;
  const drafter = new Drafter({ llm: null, cfg: o, org: o.org });
  const names = fx.companies.map((c) => c.name);
  const drafts = [];
  const skipped = [];
  for (const row of fx.companies) {
    const recipient = recipientFor(engineRecords(row, rules, fx.as_of.first_touch).company, { ...o.recipient, use_website_email: Boolean(row.use_website_email) });
    if (!recipient) {
      skipped.push({ id: row.key, why: 'the engine found no address to write to' });
      continue;
    }
    const basis = recipient.legal_basis;
    const domain = basis === 'published_by_company' ? recipient.domain : null;
    const firstRec = engineRecords(row, rules, fx.as_of.first_touch);
    const first = buildEvidencePack(firstRec.company, firstRec.lead, o, { asOf: fx.as_of.first_touch });
    if (!first.pack) {
      skipped.push({ id: row.key, why: first.reason });
      continue;
    }
    let firstDraft = null;
    for (const kind of row.kinds) {
      const asOf = fx.as_of[kind];
      const rec = engineRecords(row, rules, asOf, { later: kind === 'new_need' });
      const built = buildEvidencePack(rec.company, rec.lead, o, { asOf });
      if (!built.pack) {
        skipped.push({ id: `${row.key}/${kind}`, why: built.reason });
        continue;
      }
      const pack = built.pack;
      // sequence.js draftStep: the same three edits
      if (basis === 'published_by_company') pack.contact = { basis, domain };
      if (kind !== 'first_touch') pack.thread = { first_sent_on: fx.first_sent_on, first_subject: firstDraft?.subject ?? `${first.pack.company.name}: your next filing dates` };
      if (kind === 'new_need') {
        // newNeedFor: the first upcoming deadline, then the first scheme, that the first email did not mention
        const said = new Set([...first.pack.deadlines.map((x) => `d:${x.id}:${x.due}`), ...first.pack.schemes.map((x) => `s:${x.id}`)]);
        const dl = pack.deadlines.find((x) => x.status === 'upcoming' && !said.has(`d:${x.id}:${x.due}`));
        const sc = dl ? null : pack.schemes.find((x) => !said.has(`s:${x.id}`));
        if (!dl && !sc) {
          skipped.push({ id: `${row.key}/${kind}`, why: 'no new need a month later' });
          continue;
        }
        pack.deadlines = dl ? [{ ...dl, ref: 'D1' }] : [];
        pack.schemes = sc ? [{ ...sc, ref: 'S1' }] : [];
        pack.need = dl ? { type: 'deadline', id: `d:${dl.id}:${dl.due}`, ref: 'D1' } : { type: 'scheme', id: `s:${sc.id}`, ref: 'S1' };
      }
      const out = await drafter.draft(pack, { kind, language: row.language, sender: fx.sender,
        firstSubject: kind === 'first_touch' ? null : pack.thread.first_subject, firstSentOn: kind === 'first_touch' ? null : fx.first_sent_on });
      if (kind === 'first_touch') firstDraft = out;
      // the directors are planted in the company record; the sender's own name in the signature is not a leak
      const people = { names: row.directors };
      drafts.push({ id: `${row.key}/${kind}/${row.language}`, company: row, kind, language: row.language, basis, domain, pack,
        draft: { subject: out.subject, body: out.body }, engineQc: out.qc, need: pack.need?.type ?? null,
        others: names.filter((n) => n !== row.name), people, rules: rules.deadlines });
    }
  }
  const graded = drafts.map((d) => ({ ...d, checks: gradeDraft(d, o) }));
  const checkIds = [...new Set(graded.flatMap((g) => g.checks.map((c) => c.id)))];
  const byCheck = Object.fromEntries(checkIds.map((id) => {
    const rows = graded.map((g) => g.checks.find((c) => c.id === id)).filter(Boolean);
    return [id, { passed: rows.filter((c) => c.ok).length, total: rows.length }];
  }));
  const failing = graded.filter((g) => g.checks.some((c) => !c.ok)).map((g) => ({ id: g.id, basis: g.basis,
    engine_qc_passed: g.engineQc.passed, engine_qc_failed: g.engineQc.checks.filter((c) => !c.ok).map((c) => c.id),
    failed: g.checks.filter((c) => !c.ok).map((c) => ({ id: c.id, detail: c.detail })) }));
  const coverage = {
    companies: new Set(graded.map((g) => g.company.key)).size,
    drafts: graded.length,
    by_kind: countBy(graded, (g) => (g.kind === 'new_need' ? `new_need (${g.need})` : g.kind)),
    by_language: countBy(graded, (g) => g.language),
    by_basis: countBy(graded, (g) => g.basis),
    with_schemes: graded.filter((g) => g.pack.schemes.length).length,
    llp: graded.filter((g) => g.company.kind === 'llp').length,
    was_due_lines: graded.filter((g) => g.pack.deadlines.some((x) => x.status === 'was_due')).length,
  };
  const allPass = graded.filter((g) => g.checks.every((c) => c.ok)).length;
  // the same drafts by the engine's own check, for comparison only (never used to grade)
  const engineFailed = graded.filter((g) => !g.engineQc.passed).map((g) => ({ id: g.id, failed: g.engineQc.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`) }));
  return {
    summary: { drafts: graded.length, all_checks_passed: allPass, by_check: byCheck, coverage, skipped, engine_qc_failed: engineFailed },
    failing,
    clean: graded.filter((g) => g.engineQc.passed),
  };
}

function countBy(xs, key) {
  const out = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return out;
}

export { fmt as formatForCheck };

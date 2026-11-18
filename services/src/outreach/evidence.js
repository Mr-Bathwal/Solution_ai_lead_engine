import { canonicalJson, sha256 } from '../util/canonical.js';
import { normalizeEmail, emailIsPersonal } from '../util/normalize.js';

/**
 * The evidence pack (design 7.5): everything a message to one company may say, and nothing else.
 * Drafts are written only from it, the quality check holds every date, number and form name in a
 * draft against it, and the person who approves a draft sees it beside the draft.
 *
 * It holds company-level facts only (name, identifier, incorporation date, legal form, district),
 * the company's next firm deadlines and the schemes it may qualify for, each with its law and
 * source. Never a director, a portal team member or a person's contact details. Conditional and
 * ongoing obligations are left out, because a message must not tell a founder that something
 * applies when it may not.
 *
 * The pack carries whether the rules it uses are confirmed by a CA; the compliance gate refuses to
 * send a message whose pack says they are not (design 7.4).
 */

export const PACK_VERSION = 'pack-v1';
const DAY = 86_400_000;
const FIRM = new Set(['due_soon', 'upcoming', 'was_due']);
const SCHEME_ORDER = { eligible: 0, check_required: 1 };

const MONTHS = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  hi: ['जनवरी', 'फ़रवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर'],
};

/** "2026-11-13" -> "13 November 2026" (or "13 नवंबर 2026"). */
export function formatDate(iso, language = 'en') {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  if (!m) return null;
  return `${Number(m[3])} ${(MONTHS[language] ?? MONTHS.en)[Number(m[2]) - 1]} ${m[1]}`;
}

/** The IST calendar day of an instant, 'YYYY-MM-DD'. */
export function istDate(at = new Date()) {
  return new Date(at.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

const KEEP_UPPER = new Set(['LLP', 'OPC', 'IT', 'AI', 'IOT', 'HR', 'EV', 'UP', 'II', 'III', 'IV', 'PVT', 'LTD', 'BPO', 'KPO', 'ERP', 'CRM', 'SAAS', 'B2B', 'D2C', 'ML', 'AR', 'VR', 'NGO', 'MSME']);

/**
 * A company's name as a person would write it. MCA keeps names in capitals; the portals' legal name,
 * when it is the same name in mixed case, is used as written. Otherwise each word is capitalised,
 * keeping common abbreviations in capitals.
 */
export function displayName(company) {
  const mca = String(company?.name ?? '').trim();
  const portal = company?.attrs?.legal_name?.value;
  if (typeof portal === 'string' && portal.trim() && portal.trim().toUpperCase() === mca.toUpperCase() && portal !== portal.toUpperCase()) return portal.trim();
  if (mca !== mca.toUpperCase()) return mca;
  return mca.toLowerCase().split(/(\s+|-|\(|\))/).map((w) => {
    if (KEEP_UPPER.has(w.toUpperCase())) return w.toUpperCase();
    return w ? w.charAt(0).toUpperCase() + w.slice(1) : w;
  }).join('');
}

/** "Companies Act 2013 s.173(1), s.122(5)" stays; "LLP Act 2008 s.35; LLP Rules 2009 r.25" -> the part before ";". */
const lawShort = (law) => (typeof law === 'string' && law.trim() ? law.split(';')[0].trim() : null);
/** A form worth naming: "INC-20A", "Form 11"; not "Minutes (no MCA form)" or "Board resolution". */
const formName = (form) => (typeof form === 'string' && /\d/.test(form) && !/no MCA/i.test(form) ? form.trim() : null);
const attr = (c, k) => c?.attrs?.[k]?.value ?? null;

/**
 * Who a first email goes to: the registered email from the MCA master data (published under the
 * Companies Act). With recipient.use_website_email on, a role address the company publishes on its
 * own website is used instead when there is no registered email, when the registered email is a
 * person's (company-level data first, design 11), or when an address check has ruled the registered
 * one out (registeredUnusable). Returns null when there is no usable address. `personal` says the
 * address is a person's mailbox rather than a role address; the approver sees that.
 */
export function recipientFor(company, recipientCfg = {}, { registeredUnusable = false } = {}) {
  const a = company?.attrs?.registered_email;
  const address = normalizeEmail(a?.value);
  const registered = address
    ? { address, source: a.source ?? 'mca', legal_basis: 'published_under_law', personal: a.personal === true || emailIsPersonal(address) }
    : null;
  const w = company?.attrs?.website_email;
  const site = recipientCfg?.use_website_email && normalizeEmail(w?.value) && !emailIsPersonal(normalizeEmail(w.value))
    ? { address: normalizeEmail(w.value), source: 'company_website', legal_basis: 'published_by_company', personal: false,
      domain: w.ref?.domain ?? normalizeEmail(w.value).split('@')[1] }
    : null;
  if (site && (!registered || registered.personal || registeredUnusable)) return site;
  return registeredUnusable ? null : registered;
}

/**
 * Builds the pack for one company from its record and its lead. Returns { pack, hash } or
 * { pack: null, reason } when there is nothing a message could truthfully say.
 */
export function buildEvidencePack(company, lead, cfg, { asOf = istDate() } = {}) {
  if (!company) return { pack: null, reason: 'no company record' };
  if (!lead?.needs) return { pack: null, reason: 'no needs worked out for this company yet' };
  const ev = cfg.evidence;
  const today = Date.parse(`${asOf}T00:00:00Z`);
  const upcoming = [];
  const past = [];
  for (const d of lead.needs.deadlines ?? []) {
    if (!FIRM.has(d.status) || !d.due) continue;
    const due = Date.parse(`${d.due}T00:00:00Z`);
    const days = Math.round((due - today) / DAY);
    if (days >= 0 && days <= ev.deadline_window_days) upcoming.push({ d, days });
    else if (days < 0 && -days <= ev.past_window_days) past.push({ d, days });
  }
  upcoming.sort((a, b) => a.days - b.days);
  past.sort((a, b) => b.days - a.days);
  const chosen = [...upcoming, ...past].slice(0, ev.max_deadlines).sort((a, b) => a.days - b.days);
  const deadlines = chosen.map(({ d, days }, i) => ({
    ref: `D${i + 1}`, id: d.id, title: d.title, form: formName(d.form), due: d.due,
    status: days < 0 ? 'was_due' : 'upcoming', law: lawShort(d.law), source_url: d.source_url ?? null,
  }));
  const schemes = (lead.needs.schemes ?? [])
    .filter((s) => s.verdict in SCHEME_ORDER)
    .map((s, i) => ({ s, i }))
    .sort((a, b) => SCHEME_ORDER[a.s.verdict] - SCHEME_ORDER[b.s.verdict] || (a.s.missing?.length ?? 0) - (b.s.missing?.length ?? 0) || a.i - b.i)
    .slice(0, ev.max_schemes)
    .map(({ s }, i) => ({ ref: `S${i + 1}`, id: s.scheme_id ?? s.id ?? null, name: s.name, verdict: s.verdict, benefit: s.benefit ?? null,
      missing: s.missing ?? [], source_url: s.source_url ?? null }));
  if (!deadlines.length && !schemes.length) return { pack: null, reason: 'no firm deadline in the window and no scheme to mention' };
  const pack = {
    version: PACK_VERSION,
    as_of: asOf,
    company: {
      id: company._id,
      name: displayName(company),
      kind: company.kind ?? 'company',
      legal_form: attr(company, 'company_type'),
      incorporated: attr(company, 'incorporation_date'),
      district: attr(company, 'registered_district') ?? attr(company, 'district'),
    },
    deadlines,
    schemes,
    rules: { confirmed: lead.needs.rules_confirmed === true, version: lead.needs.rules_version ?? null },
  };
  return { pack, hash: packHash(pack) };
}

export const packHash = (pack) => sha256(canonicalJson(pack));

/**
 * What a draft may contain, from its pack: the dates (written as messages write them), the form
 * names and identifiers, and every number that appears anywhere in the pack's text.
 */
export function packFacts(pack) {
  const dates = new Set();
  const strings = [];
  const walk = (v) => {
    if (typeof v === 'string') {
      strings.push(v);
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) for (const lang of Object.keys(MONTHS)) dates.add(formatDate(v, lang));
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(pack);
  const text = [...strings, ...dates].join('\n');
  const numbers = new Set(text.match(/\d+(?:[.,]\d+)*/g) ?? []);
  const forms = new Set((pack.deadlines ?? []).map((d) => d.form).filter(Boolean));
  return { dates, numbers, forms, text, companyName: pack.company?.name ?? '', companyId: pack.company?.id ?? '' };
}

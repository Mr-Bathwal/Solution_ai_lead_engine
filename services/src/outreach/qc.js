import { PAGE_URL, UNSUBSCRIBE_URL } from './templates.js';
import { formatDate, packFacts } from './evidence.js';

/**
 * The automatic quality check (design 7.5): rules a draft must pass before a person sees it in the
 * approval queue, and again on any edit the person makes. They are code, not AI, so they are the
 * same every time and an AI drafter cannot talk its way past them:
 *
 *   - every date, number, form name and identifier in the draft is in the evidence pack;
 *   - the company is named, the page link appears once, the unsubscribe link once, and no other link
 *     except the sender's own website;
 *   - the language is the one asked for;
 *   - no banned phrase (urgency, threats, guarantees, claims to speak for the government), no claim
 *     that a filing was missed (the engine cannot see filings), at most one exclamation mark;
 *   - no email address or phone number in the text;
 *   - a subject that is honest (no "Re:" on a first email) and not shouted, and lengths within limits.
 *
 * An AI review, when the gateway is configured, is recorded beside these as advice only, until it
 * has been shown to agree with the reviewers.
 */

export const QC_VERSION = 'qc-rules-v2';

/** The body's word limit for a kind and language: config quality.body_max_words.<kind> is a number or { en, hi }. */
export function maxWordsFor(cfg, kind, language) {
  const lim = cfg.quality?.body_max_words?.[kind];
  if (lim && typeof lim === 'object') return lim[language] ?? lim.en ?? 250;
  return lim ?? 250;
}

const MONTH_EN = 'January|February|March|April|May|June|July|August|September|October|November|December';
const MONTH_HI = 'जनवरी|फ़रवरी|फरवरी|मार्च|अप्रैल|मई|जून|जुलाई|अगस्त|सितंबर|सितम्बर|अक्टूबर|नवंबर|नवम्बर|दिसंबर|दिसम्बर';
const DATE_RX = new RegExp(`\\b\\d{1,2}\\s+(?:${MONTH_EN})\\s+\\d{4}\\b|\\d{1,2}\\s+(?:${MONTH_HI})\\s+\\d{4}`, 'g');
const NUMERIC_DATE_RX = /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/;
const URL_RX = /\bhttps?:\/\/[^\s<>()"]+|\bwww\.[^\s<>()"]+/gi;
const FORM_RX = /\b(?:[A-Z]{2,5}-\d+[A-Z]?(?:\s+KYC)?|Form\s+\d+[A-Z]?)\b/g;
const ID_RX = /\b(?:[UL]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}|[A-Z]{3}-\d{4})\b/g;
const EMAIL_RX = /[^\s@<>()"']+@[^\s@<>()"']+\.[a-z]{2,}/i;
const PHONE_RX = /(?:\+91[\s-]?|\b0)?[6-9]\d{4}[\s-]?\d{5}\b/;
/** Ten or more digits in a row, however grouped (+91 9876 543 210, 0522 4012345): a phone number. */
const LONG_NUMBER_RX = /\+?\d(?:[\s().-]?\d){9,}/;
const MISSED_RX = /\b(?:missed|overdue|defaulted|in default|non-?compliant|you (?:have )?failed|late fee|you are late)\b|चूक गए|देर हो चुकी|डिफ़ॉल्ट|\b(?:was|were|has|have|had) not (?:been )?(?:made|filed|done|submitted|completed)\b|\bnot (?:been )?(?:filed|made|submitted) (?:on|in) time\b|\b(?:our|the) records? (?:show|say|suggest)|नहीं की गई|नहीं किया गया|फ़ाइल नहीं|रिकॉर्ड के अनुसार/i;
/** Threats and pressure, in other words than the banned phrases: the engine informs, it does not push. */
const PRESSURE_RX = /\bavoid (?:a |any )?(?:penalt(?:y|ies)|fines?|prosecution|action)\b|\b(?:penalt(?:y|ies)|fines?) (?:will|may|could) (?:apply|be (?:levied|imposed|charged))\b|\b(?:do not|don't|please don't|please do not) delay\b|\bwithout (?:any )?delay\b|\b(?:act|reply|respond|file) (?:now|immediately|today)\b|\bimmediately\b|\bthis week\b|\btime is running out\b|\bbefore it is too late\b|जुर्माने से बच|जुर्माना लग|देर न करें|तुरंत|इसी सप्ताह|जल्दी करें/i;
/** A section of an Act or a rule ("s.10A", "section 248", "ss.92(4)", "rule 12", "धारा 248"): the number itself is the fact. */
const SECTION_RX = /\b(?:ss?|r)\.\s?(\d+[A-Z]{0,2}(?:\(\d+[a-z]?\))*)|\b(?:sec|section|sections|rule|rules)\.?\s(\d+[A-Z]{0,2}(?:\(\d+[a-z]?\))*)|धारा\s?(\d+[A-Z]{0,2}(?:\(\d+[a-z]?\))*)/gi;
const sectionOf = (m) => (m[1] ?? m[2] ?? m[3]).toUpperCase();
/** An amount of money: "₹20 lakh", "Rs. 50,000", "INR 2,000", "10 lakh", "₹2 करोड़". */
const AMOUNT_RX = /(?:₹|\brs\.?|\binr)\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:lakh|crore|लाख|करोड़))?|\b\d[\d,]*(?:\.\d+)?\s?(?:lakh|crore)\b|\d[\d,]*(?:\.\d+)?\s?(?:लाख|करोड़)/gi;
/** A link written without http or www ("offers.example/pricing"); an email address is not one. */
const BARE_DOMAIN_RX = /(?<![@\w.-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:[a-z]{2,24})(?:\/[^\s<>()"]*)?(?![\w@-])/gi;
/** A company's name with its legal form: any in the text must be this company's. */
const COMPANY_FORM_RX = /([A-Z][\w&.'-]*(?:\s+(?:[A-Z][\w&.'-]*|&|and|of|AND|OF))*)\s+(?:Private Limited|PRIVATE LIMITED|Pvt\.?\s?Ltd\.?|PVT\.?\s?LTD\.?|Limited|LIMITED|LLP)\b/g;
/** A date written the American way ("December 13, 2026"): never the house style, so never trusted. */
const US_DATE_RX = new RegExp(`\\b(?:${'January|February|March|April|May|June|July|August|September|October|November|December'})\\s+\\d{1,2},?\\s+\\d{4}\\b`);
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const token = (needle, hay) => new RegExp(`(?<![A-Za-z0-9])${escapeRx(needle)}(?![A-Za-z0-9])`).test(hay);
const amountKey = (a) => a.toLowerCase().replace(/\binr\b|\brs\.?/g, '₹').replace(/लाख/g, 'lakh').replace(/करोड़/g, 'crore').replace(/[\s,]/g, '');
const DEVANAGARI = /[ऀ-ॿ]/g;
/** An opt-out sentence in words, in English or Hindi: the unsubscribe link alone is not one. */
const OPT_OUT_RX = /unsubscribe|stop (?:all )?e-?mails|not (?:to )?(?:hear from|write)|ईमेल बंद/i;
const LETTERS = /[\p{L}]/gu;

const count = (s, needle) => s.split(needle).length - 1;
const words = (s) => s.split(/\s+/).filter(Boolean).length;

/**
 * Runs every rule. Returns { passed, checks: [{ id, ok, detail }], checker }. `cfg` is
 * config/outreach.json; `org` is { website } (the one link besides the page and unsubscribe links).
 */
export function qualityCheck(draft, pack, { kind, language, cfg, org = {}, names = [] }) {
  const subject = String(draft?.subject ?? '');
  const body = String(draft?.body ?? '');
  const text = `${subject}\n${body}`;
  const facts = packFacts(pack);
  const q = cfg.quality;
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail: ok ? null : detail });

  // ---- facts -----------------------------------------------------------------------------------
  const dates = text.match(DATE_RX) ?? [];
  const strayDates = dates.filter((d) => !facts.dates.has(d.replace(/\s+/g, ' ').trim()));
  add('facts.dates', !strayDates.length && !NUMERIC_DATE_RX.test(text) && !US_DATE_RX.test(text),
    strayDates.length ? `dates not in the evidence pack: ${strayDates.join(', ')}` : 'write dates as "13 November 2026", not in figures');
  let rest = text;
  for (const d of dates) rest = rest.replace(d, ' ');
  for (const u of text.match(URL_RX) ?? []) rest = rest.replace(u, ' ');
  rest = rest.replaceAll(PAGE_URL, ' ').replaceAll(UNSUBSCRIBE_URL, ' ');
  const forms = rest.match(FORM_RX) ?? [];
  // a whole form name, not part of one: INC-20 is not INC-20A
  const strayForms = forms.filter((f) => !facts.forms.has(f) && !token(f, facts.text));
  add('facts.forms', !strayForms.length, `form names not in the evidence pack: ${strayForms.join(', ')}`);
  const packSections = new Set([...facts.text.matchAll(SECTION_RX)].map(sectionOf));
  const straySections = [...rest.matchAll(SECTION_RX)].map(sectionOf).filter((n) => !packSections.has(n));
  add('facts.sections', !straySections.length, `sections not in the evidence pack: ${[...new Set(straySections)].join(', ')}`);
  // an amount is a fact of its own: its figure being somewhere else in the pack (a date's day, say) is not enough
  const packAmounts = new Set((facts.text.match(AMOUNT_RX) ?? []).map(amountKey));
  const strayAmounts = (rest.match(AMOUNT_RX) ?? []).filter((a) => !packAmounts.has(amountKey(a)));
  add('facts.amounts', !strayAmounts.length, `amounts not in the evidence pack: ${[...new Set(strayAmounts)].join(', ')}`);
  // a date next to a deadline is that deadline's own date (two deadlines' dates swapped is two wrong facts)
  const misdated = [];
  // the first email's date (a follow-up mentions it) may stand beside any deadline
  const sentOn = pack.thread?.first_sent_on ? [formatDate(pack.thread.first_sent_on, 'en'), formatDate(pack.thread.first_sent_on, 'hi')] : [];
  for (const sentence of body.split(/\n|(?<=[.;।])\s+/)) {
    const lower = sentence.toLowerCase();
    const named = (pack.deadlines ?? []).filter((d) => (d.title && lower.includes(String(d.title).toLowerCase())) || (d.form && token(d.form, sentence)));
    if (named.length !== 1 || !named[0].due) continue;
    const own = new Set([formatDate(named[0].due, 'en'), formatDate(named[0].due, 'hi'), ...sentOn]);
    for (const d of sentence.match(DATE_RX) ?? []) if (!own.has(d.replace(/\s+/g, ' ').trim())) misdated.push(`${named[0].title}: ${d}`);
  }
  add('facts.dates_match_deadlines', !misdated.length, `a date given for the wrong deadline: ${misdated.join('; ')}`);
  // likewise an amount beside a scheme is that scheme's own (a real amount moved to another scheme is wrong)
  const misplaced = [];
  for (const sentence of body.split(/\n|(?<=[.;।])\s+/)) {
    const lower = sentence.toLowerCase();
    const named = (pack.schemes ?? []).filter((x) => x.name && lower.includes(String(x.name).toLowerCase()));
    if (named.length !== 1) continue;
    const own = new Set((JSON.stringify(named[0]).match(AMOUNT_RX) ?? []).map(amountKey));
    for (const a of sentence.match(AMOUNT_RX) ?? []) if (!own.has(amountKey(a))) misplaced.push(`${named[0].name}: ${a}`);
  }
  add('facts.amounts_match_schemes', !misplaced.length, `an amount given for the wrong scheme: ${misplaced.join('; ')}`);
  const ids = rest.match(ID_RX) ?? [];
  const strayIds = ids.filter((id) => id !== facts.companyId && !facts.forms.has(id) && !facts.text.includes(id));
  add('facts.identifiers', !strayIds.length, `identifiers that are not this company's: ${strayIds.join(', ')}`);
  const numbers = (rest.match(/\d+(?:[.,]\d+)*/g) ?? []).filter((n) => !facts.numbers.has(n));
  add('facts.numbers', !numbers.length, `numbers not in the evidence pack: ${[...new Set(numbers)].join(', ')}`);
  add('facts.company_named', facts.companyName && text.includes(facts.companyName), `the company's name (${facts.companyName}) does not appear`);
  // any company named with its legal form is this one (or the sender): never another company
  const ours = [facts.companyName, org.legal_name, org.name].filter(Boolean).map((n) => n.toLowerCase());
  const otherCompanies = [...text.matchAll(COMPANY_FORM_RX)].map((m) => m[0]).filter((n) => !ours.some((o) => n.toLowerCase().endsWith(o)));
  add('facts.no_other_company', !otherCompanies.length, `names another company: ${[...new Set(otherCompanies)].join(', ')}`);

  // ---- links and opt-out -------------------------------------------------------------------------
  add('links.page_once', count(body, PAGE_URL) === 1, `the page link must appear exactly once (found ${count(body, PAGE_URL)})`);
  add('links.unsubscribe_once', count(body, UNSUBSCRIBE_URL) === 1, `the unsubscribe link must appear exactly once (found ${count(body, UNSUBSCRIBE_URL)})`);
  const allowed = new Set([org.website].filter(Boolean).map((u) => u.replace(/\/+$/, '')));
  const otherLinks = (text.match(URL_RX) ?? []).filter((u) => !allowed.has(u.replace(/[.,;:]+$/, '').replace(/\/+$/, '')));
  // a link written as a bare domain counts too; the sender's website and the company's own domain (the why line) are allowed
  const hosts = new Set([org.website, pack.contact?.domain].filter(Boolean).map((u) => String(u).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')));
  const bare = (rest.match(BARE_DOMAIN_RX) ?? []).filter((d) => !hosts.has(d.toLowerCase().replace(/^www\./, '').replace(/\/.*$/, '')));
  const extra = [...otherLinks, ...bare];
  add('links.no_others', !extra.length && !/\{\{(?!page_url\}\}|unsubscribe_url\}\})[^}]*\}\}/.test(text),
    extra.length ? `links other than the page, unsubscribe and website: ${extra.join(', ')}` : 'an unknown {{placeholder}}');
  add('opt_out.words', OPT_OUT_RX.test(body.replaceAll(UNSUBSCRIBE_URL, ' ')), 'the opt-out sentence is missing (the unsubscribe link alone is not enough)');

  // ---- language -----------------------------------------------------------------------------------
  const letters = (text.match(LETTERS) ?? []).length || 1;
  const deva = (text.match(DEVANAGARI) ?? []).length;
  if (language === 'hi') add('language', deva / letters >= 0.4, 'a Hindi draft must be mostly in Hindi');
  else add('language', deva === 0, 'an English draft must not contain Hindi script');

  // ---- tone -----------------------------------------------------------------------------------------
  const lower = text.toLowerCase();
  const banned = (q.banned_phrases ?? []).filter((p) => lower.includes(p.toLowerCase()));
  add('tone.banned_phrases', !banned.length, `banned phrases: ${banned.join(', ')}`);
  add('tone.no_missed_claim', !MISSED_RX.test(text), 'says or implies that a filing was missed; the engine cannot see filings');
  add('tone.no_pressure', !PRESSURE_RX.test(text), 'threatens or hurries the founder in other words ("avoid penalties", "do not delay", "this week")');
  add('tone.exclamations', count(text, '!') <= q.max_exclamation_marks, `more than ${q.max_exclamation_marks} exclamation mark(s)`);
  const subjectLetters = subject.replace(/[^A-Za-z]/g, '');
  add('subject.not_shouted', subjectLetters.length < 8 || subjectLetters.replace(/[^A-Z]/g, '').length / subjectLetters.length <= 0.6, 'the subject is in capitals');
  add('subject.honest', kind === 'follow_up' || !/^\s*(re|fwd?|fw)\s*:/i.test(subject), 'a first email must not pretend to be a reply or a forward');

  // ---- privacy and length -------------------------------------------------------------------------
  add('privacy.no_contacts', !EMAIL_RX.test(text) && !PHONE_RX.test(rest) && !LONG_NUMBER_RX.test(rest.replace(AMOUNT_RX, ' ')),
    'an email address or phone number is in the text');
  // the people the engine knows at the company (its directors): a company-level email never names them
  const companyLower = facts.companyName.toLowerCase();
  const nameParts = [...new Set(names.filter((n) => typeof n === 'string').flatMap((n) => [n.trim(), ...n.trim().split(/\s+/)])
    .filter((n) => n.replace(/[^\p{L}]/gu, '').length >= 4 && !companyLower.includes(n.toLowerCase())))];
  const named = nameParts.filter((n) => new RegExp(`(?<![\\p{L}])${escapeRx(n)}(?![\\p{L}])`, 'iu').test(text));
  add('privacy.no_person_named', !named.length, `names a person at the company: ${named.join(', ')}`);
  add('length.subject', subject.trim().length > 0 && subject.length <= q.subject_max_chars, `the subject must be 1 to ${q.subject_max_chars} characters`);
  const maxWords = maxWordsFor(cfg, kind, language);
  add('length.body', words(body) <= maxWords, `the body has ${words(body)} words; at most ${maxWords}`);

  return { passed: checks.every((c) => c.ok), checks, checker: QC_VERSION };
}

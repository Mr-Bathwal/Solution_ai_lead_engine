import { PAGE_URL, UNSUBSCRIBE_URL } from './templates.js';
import { packFacts } from './evidence.js';

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
const MISSED_RX = /\b(?:missed|overdue|defaulted|in default|non-?compliant|you (?:have )?failed|late fee|you are late)\b|चूक गए|देर हो चुकी|डिफ़ॉल्ट/i;
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
export function qualityCheck(draft, pack, { kind, language, cfg, org = {} }) {
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
  add('facts.dates', !strayDates.length && !NUMERIC_DATE_RX.test(text),
    strayDates.length ? `dates not in the evidence pack: ${strayDates.join(', ')}` : 'write dates as "13 November 2026", not in figures');
  let rest = text;
  for (const d of dates) rest = rest.replace(d, ' ');
  for (const u of text.match(URL_RX) ?? []) rest = rest.replace(u, ' ');
  rest = rest.replaceAll(PAGE_URL, ' ').replaceAll(UNSUBSCRIBE_URL, ' ');
  const forms = rest.match(FORM_RX) ?? [];
  const strayForms = forms.filter((f) => !facts.forms.has(f) && !facts.text.includes(f));
  add('facts.forms', !strayForms.length, `form names not in the evidence pack: ${strayForms.join(', ')}`);
  const ids = rest.match(ID_RX) ?? [];
  const strayIds = ids.filter((id) => id !== facts.companyId && !facts.forms.has(id) && !facts.text.includes(id));
  add('facts.identifiers', !strayIds.length, `identifiers that are not this company's: ${strayIds.join(', ')}`);
  const numbers = (rest.match(/\d+(?:[.,]\d+)*/g) ?? []).filter((n) => !facts.numbers.has(n));
  add('facts.numbers', !numbers.length, `numbers not in the evidence pack: ${[...new Set(numbers)].join(', ')}`);
  add('facts.company_named', facts.companyName && text.includes(facts.companyName), `the company's name (${facts.companyName}) does not appear`);

  // ---- links and opt-out -------------------------------------------------------------------------
  add('links.page_once', count(body, PAGE_URL) === 1, `the page link must appear exactly once (found ${count(body, PAGE_URL)})`);
  add('links.unsubscribe_once', count(body, UNSUBSCRIBE_URL) === 1, `the unsubscribe link must appear exactly once (found ${count(body, UNSUBSCRIBE_URL)})`);
  const allowed = new Set([org.website].filter(Boolean).map((u) => u.replace(/\/+$/, '')));
  const otherLinks = (text.match(URL_RX) ?? []).filter((u) => !allowed.has(u.replace(/[.,;:]+$/, '').replace(/\/+$/, '')));
  add('links.no_others', !otherLinks.length && !/\{\{(?!page_url\}\}|unsubscribe_url\}\})[^}]*\}\}/.test(text),
    otherLinks.length ? `links other than the page, unsubscribe and website: ${otherLinks.join(', ')}` : 'an unknown {{placeholder}}');
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
  add('tone.exclamations', count(text, '!') <= q.max_exclamation_marks, `more than ${q.max_exclamation_marks} exclamation mark(s)`);
  const subjectLetters = subject.replace(/[^A-Za-z]/g, '');
  add('subject.not_shouted', subjectLetters.length < 8 || subjectLetters.replace(/[^A-Z]/g, '').length / subjectLetters.length <= 0.6, 'the subject is in capitals');
  add('subject.honest', kind === 'follow_up' || !/^\s*(re|fwd?|fw)\s*:/i.test(subject), 'a first email must not pretend to be a reply or a forward');

  // ---- privacy and length -------------------------------------------------------------------------
  add('privacy.no_contacts', !EMAIL_RX.test(text) && !PHONE_RX.test(rest), 'an email address or phone number is in the text');
  add('length.subject', subject.trim().length > 0 && subject.length <= q.subject_max_chars, `the subject must be 1 to ${q.subject_max_chars} characters`);
  const maxWords = maxWordsFor(cfg, kind, language);
  add('length.body', words(body) <= maxWords, `the body has ${words(body)} words; at most ${maxWords}`);

  return { passed: checks.every((c) => c.ok), checks, checker: QC_VERSION };
}

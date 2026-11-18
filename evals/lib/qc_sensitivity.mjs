/**
 * Eval 2: how sensitive is the engine's quality check (services/src/outreach/qc.js)?
 *
 * Two parts. First the engine's own known-fault set (services/src/eval/qc.js, `eval:qc`), run as it
 * ships. Then this file's own mutations, applied to every clean draft from eval 1 (drafts the QC
 * passed): the faults a model or a hurried edit could plausibly make, including paraphrases of the
 * faults the QC does know about. A mutation is caught when the QC fails the mutated draft for any
 * reason. Here the QC is the thing measured, so calling it is the point.
 */
import { engine } from './common.mjs';
import { formatForCheck as fmt, gradeDraft } from './drafts.mjs';

const UNSUB = '{{unsubscribe_url}}';
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const usDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]} ${d}, ${y}`;
};
/** Puts a sentence in its own paragraph after the greeting. */
const insert = (d, sentence) => {
  const parts = d.body.split('\n\n');
  return { ...d, body: [parts[0], sentence, ...parts.slice(1)].join('\n\n') };
};
const shownDeadlines = (c) => (c.pack.deadlines ?? []).filter((x) => c.draft.body.includes(fmt(x.due, c.language)));
const firstRupee = (text) => /₹\s?(\d[\d,]*(?:\.\d+)?)\s*(lakh|crore)?/.exec(text ?? '');

/** Each mutation: { id, name, apply(clean) -> mutated draft or null when it does not apply }. */
export const MUTATIONS = [
  { id: 'date.shifted', name: 'a deadline one day off', apply: (c) => {
    const [x] = shownDeadlines(c);
    return x ? { ...c.draft, body: c.draft.body.replace(fmt(x.due, c.language), fmt(addDays(x.due, 1), c.language)) } : null;
  } },
  { id: 'date.us_format_wrong', name: 'a wrong date written "Month D, YYYY"', apply: (c) => {
    const [x] = shownDeadlines(c);
    return x && c.language === 'en' ? { ...c.draft, body: c.draft.body.replace(fmt(x.due, 'en'), usDate(addDays(x.due, 1))) } : null;
  } },
  { id: 'date.swapped', name: 'two deadlines\' dates swapped', apply: (c) => {
    const xs = shownDeadlines(c).filter((x, i, a) => a.findIndex((y) => y.due === x.due) === i);
    if (xs.length < 2) return null;
    const [a, b] = xs.map((x) => fmt(x.due, c.language));
    return { ...c.draft, body: c.draft.body.replaceAll(a, '\u0000').replaceAll(b, a).replaceAll('\u0000', b) };
  } },
  { id: 'section.invented', name: 'an invented section number', apply: (c) => ({ ...insert(c.draft, c.language === 'hi'
    ? 'यह कंपनी अधिनियम 2013 की धारा 248 के अंतर्गत भी आता है।' : 'This also falls under section 248 of the Companies Act 2013.') }) },
  { id: 'section.near_miss', name: 'a section one letter off (s.10A as s.10B)', apply: (c) => (c.draft.body.includes('s.10A')
    ? { ...c.draft, body: c.draft.body.replace('s.10A', 's.10B') } : null) },
  { id: 'form.truncated', name: 'a form code cut short (INC-20A as INC-20)', apply: (c) => (c.draft.body.includes('INC-20A')
    ? { ...c.draft, body: c.draft.body.replace('INC-20A', 'INC-20') } : null) },
  { id: 'link.extra_https', name: 'an extra https link', apply: (c) => insert(c.draft, 'Our plans are at https://offers.solutionai.example/new') },
  { id: 'link.extra_bare_domain', name: 'an extra link written as a bare domain', apply: (c) => insert(c.draft, 'Our plans are at solutionai-offers.example/pricing') },
  { id: 'link.no_unsubscribe', name: 'the unsubscribe link removed', apply: (c) => ({ ...c.draft, body: c.draft.body.replace(UNSUB, '') }) },
  { id: 'subject.shouted', name: 'the subject in capitals', apply: (c) => ({ ...c.draft, subject: c.draft.subject.toUpperCase() }) },
  { id: 'amount.invented', name: 'an invented scheme amount', apply: (c) => insert(c.draft, c.language === 'hi'
    ? 'इसके साथ ₹7,50,000 का अनुदान भी मिलता है।' : 'It also comes with a grant of ₹7,50,000.') },
  { id: 'amount.figure_from_a_date', name: 'an invented amount whose figure appears in a date of the pack', apply: (c) => {
    const x = (c.pack.deadlines ?? [])[0];
    const day = x ? Number(x.due.slice(8, 10)) : null;
    return day ? insert(c.draft, c.language === 'hi' ? `इसके साथ ₹${day} लाख का अनुदान भी मिलता है।` : `It also comes with a grant of ₹${day} lakh.`) : null;
  } },
  { id: 'amount.misattributed', name: 'a scheme amount from the pack given to the wrong scheme', apply: (c) => {
    const withAmount = (c.pack.schemes ?? []).find((s) => firstRupee(s.benefit));
    const other = (c.pack.schemes ?? []).find((s) => s !== withAmount) ?? null;
    if (!withAmount || !other) return null;
    const m = firstRupee(withAmount.benefit);
    return insert(c.draft, `${other.name} brings up to ₹${m[1]}${m[2] ? ` ${m[2]}` : ''}.`);
  } },
  { id: 'phone.standard', name: 'a personal mobile, 98765 43210', apply: (c) => insert(c.draft, 'You can also call Meera on 98765 43210.') },
  { id: 'phone.plus91_dashes', name: 'a personal mobile, +91-98765-43210', apply: (c) => insert(c.draft, 'You can also call Meera on +91-98765-43210.') },
  { id: 'phone.grouped_4_3_3', name: 'a personal mobile, +91 9876 543 210', apply: (c) => insert(c.draft, 'You can also call Meera on +91 9876 543 210.') },
  { id: 'phone.landline', name: 'a landline, 0522 4012345', apply: (c) => insert(c.draft, 'You can also call Meera on 0522 4012345.') },
  { id: 'email.personal', name: 'a personal email address', apply: (c) => insert(c.draft, 'You can also write to meera.saxena@mail.example.') },
  { id: 'person.director_named', name: 'a director named', apply: (c) => insert(c.draft, c.language === 'hi'
    ? `हमने आपके निदेशक ${c.company.directors[0]} को भी लिखा है।` : `We have also written to your director, ${c.company.directors[0]}.`) },
  { id: 'company.other_in_greeting', name: 'another company\'s name in the greeting', apply: (c) => {
    const other = c.others[0];
    const lines = c.draft.body.split('\n');
    lines[0] = c.language === 'hi' ? `नमस्ते ${other} टीम,` : `Hello ${other} team,`;
    return { ...c.draft, body: lines.join('\n') };
  } },
  { id: 'opt_out.words_removed', name: 'the opt-out sentence removed, the link kept', apply: (c) => {
    const parts = c.draft.body.split('\n\n');
    const i = parts.findIndex((p) => p.includes(UNSUB));
    if (i < 0) return null;
    parts[i] = UNSUB;
    return { ...c.draft, body: parts.join('\n\n') };
  } },
  { id: 'tone.penalty_paraphrase', name: 'a penalty threat in other words', apply: (c) => insert(c.draft, c.language === 'hi'
    ? 'जुर्माने से बचने के लिए कृपया समय पर फ़ाइल करें।' : 'Please file on time to avoid penalties.') },
  { id: 'tone.urgency_paraphrase', name: 'urgency in other words', apply: (c) => insert(c.draft, c.language === 'hi'
    ? 'कृपया देर न करें; इस पर इसी सप्ताह ध्यान दें।' : 'Please do not delay; this needs your attention this week.') },
  { id: 'tone.missed_paraphrase', name: 'a claim that a filing was not made, in other words', apply: (c) => insert(c.draft, c.language === 'hi'
    ? 'हमारे रिकॉर्ड के अनुसार यह फ़ाइलिंग समय पर नहीं की गई।' : 'Our records show this filing was not made on time.') },
];

export async function runQcSensitivity(cfg, clean) {
  const { evalQc } = await engine('src/eval/qc.js');
  const { qualityCheck } = await engine('src/outreach/qc.js');
  const builtIn = evalQc(cfg);
  const o = cfg.outreach;
  const rows = {};
  const missed = {};
  for (const m of MUTATIONS) {
    const row = { name: m.name, applied: 0, caught: 0, fired: {}, grader_caught: 0 };
    for (const c of clean) {
      const broken = m.apply(c);
      if (!broken || (broken.subject === c.draft.subject && broken.body === c.draft.body)) continue;
      row.applied += 1;
      // this suite's own grader (Eval 1) on the same mutated draft: a check of the grader itself
      // a new failure, or a check that already failed (the signature link) now failing for more
      const before = new Set(c.checks.filter((x) => !x.ok).map((x) => `${x.id}|${x.detail}`));
      if (gradeDraft({ ...c, draft: broken }, o).some((x) => !x.ok && !before.has(`${x.id}|${x.detail}`))) row.grader_caught += 1;
      // the engine hands the quality check the people it knows at the company (sequence.js, messages.js): so does this
      const qc = qualityCheck(broken, c.pack, { kind: c.kind, language: c.language, cfg: o, org: o.org, names: c.company.directors ?? [] });
      if (!qc.passed) {
        row.caught += 1;
        for (const k of qc.checks.filter((x) => !x.ok)) row.fired[k.id] = (row.fired[k.id] ?? 0) + 1;
      } else (missed[m.id] ??= []).push(c.id);
    }
    rows[m.id] = row;
  }
  const applied = Object.values(rows).reduce((n, r) => n + r.applied, 0);
  const caught = Object.values(rows).reduce((n, r) => n + r.caught, 0);
  const graderCaught = Object.values(rows).reduce((n, r) => n + r.grader_caught, 0);
  return {
    builtIn: builtIn.summary,
    builtInMisses: builtIn.misses,
    mutations: { applied, caught, grader_caught: graderCaught, by_mutation: rows, missed },
  };
}

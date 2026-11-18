import { buildEvidencePack } from '../outreach/evidence.js';
import { qualityCheck } from '../outreach/qc.js';
import { PAGE_URL, UNSUBSCRIBE_URL, templateDraft } from '../outreach/templates.js';

/**
 * The quality-check test set (design 7.10: "at least 100 labelled drafts per failure type"). Real
 * labelled drafts come from the approval queue as reviewers reject and edit; until there are enough,
 * this set is generated: 60 fictional companies, each drafted by the reviewed templates in English
 * and Hindi as a first email, a follow-up and a new-need message (360 clean drafts), and every clean
 * draft broken in one known way per fault (20 faults across the 17 checks, up to 360 cases each; a
 * fault that does not apply to a draft, such as a fake "Re:" on a follow-up, is skipped). A fault is
 * caught when the check it belongs to fails.
 *
 * It measures the rules, which are code: a regression test for them, run by `lead-engine eval:qc`
 * and by the test suite. When the AI review is switched from advice to a gate, the same set measures
 * how often it agrees.
 */

const FIRST = ['Aarohan', 'Bhoomi', 'Chandra', 'Dhruv', 'Ekam', 'Falak', 'Gagan', 'Hriday', 'Ishaan', 'Jyoti', 'Kaveri', 'Lakshya', 'Mitra', 'Nakshatra', 'Ojas'];
const SECOND = ['Agritech', 'Infotech', 'Foods', 'Healthcare'];
const DISTRICTS = ['Lucknow', 'Kanpur Nagar', 'Gautam Buddha Nagar', 'Varanasi', 'Prayagraj', 'Agra', 'Ghaziabad', 'Gorakhpur'];
const AS_OF = '2026-11-20';
const ORG = { name: 'SolutionAI', legal_name: 'SolutionAI Private Limited', website: 'https://solutionai.in' };
const SENDER = { name: 'Asha Verma', title: 'Founder support' };
const DAY = 86_400_000;
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

function fixture(i) {
  const name = `${FIRST[i % FIRST.length]} ${SECOND[Math.floor(i / FIRST.length) % SECOND.length]} Private Limited`.toUpperCase();
  const incorporated = addDays('2026-07-01', (i * 37) % 130);
  const cin = `U${String(10000 + i * 17).padStart(5, '0')}UP2026PTC${String(900000 + i).padStart(6, '0')}`;
  const company = { _id: cin, kind: 'company', name, attrs: { incorporation_date: { value: incorporated }, company_type: { value: 'Private Limited Company' },
    district: { value: DISTRICTS[i % DISTRICTS.length] } } };
  const deadlines = [
    { id: 'first_board_meeting', title: 'Hold the first board meeting', form: 'Minutes (no MCA form)', due: addDays(incorporated, 30), law: 'Companies Act 2013 s.173(1)' },
    { id: 'first_auditor', title: 'Appoint the first auditor', form: 'Board resolution', due: addDays(incorporated, 30), law: 'Companies Act 2013 s.139(6)' },
    { id: 'inc_20a', title: 'File the declaration for commencement of business', form: 'INC-20A', due: addDays(incorporated, 180), law: 'Companies Act 2013 s.10A' },
    { id: 'adt_1', title: 'Tell the registrar about the auditor', form: 'ADT-1', due: addDays(incorporated, 45), law: 'Companies Act 2013 s.139(1)' },
  ].map((d) => ({ ...d, status: d.due >= AS_OF ? 'upcoming' : 'was_due' }));
  const schemes = [
    { scheme_id: 'udyam_registration', name: 'Udyam (MSME) registration', verdict: 'eligible', benefit: 'Free registration.', missing: [] },
    { scheme_id: 'dpiit_recognition', name: 'DPIIT startup recognition', verdict: 'check_required', benefit: 'Tax benefits for recognised startups.', missing: ['innovation'] },
  ].slice(0, 1 + (i % 2));
  const lead = { company_id: cin, needs: { rules_confirmed: true, rules_version: 'test', deadlines, schemes } };
  return { company, lead };
}

/** The faults: each breaks one rule, which is the check that must catch it. */
export const FAULTS = [
  { check: 'facts.dates', name: 'an invented date', apply: (d, l) => ({ ...d, body: d.body.replace('\n\n', `\n\n${l === 'hi' ? '3 जनवरी 2025 तक भी एक फ़ाइलिंग थी।' : 'There was also a filing due by 3 January 2025.'}\n\n`) }) },
  { check: 'facts.dates', name: 'a date in figures', apply: (d) => ({ ...d, body: d.body.replace('\n\n', '\n\nSee you on 28/12/2026.\n\n') }) },
  { check: 'facts.forms', name: 'a form not in the pack', apply: (d) => ({ ...d, body: d.body.replace('\n\n', '\n\nMGT-7 is due as well.\n\n') }) },
  { check: 'facts.numbers', name: 'an invented amount', apply: (d) => ({ ...d, body: d.body.replace('\n\n', '\n\nThe fee is 4999 only.\n\n') }) },
  { check: 'facts.identifiers', name: 'another company\'s CIN', apply: (d) => ({ ...d, body: d.body.replace('\n\n', '\n\nRef U74999DL2019PTC123456.\n\n') }) },
  { check: 'facts.company_named', name: 'the company not named', apply: (d, l, p) => ({ subject: d.subject.replaceAll(p.company.name, 'Your company'), body: d.body.replaceAll(p.company.name, l === 'hi' ? 'आपकी कंपनी' : 'your company') }) },
  { check: 'links.page_once', name: 'no page link', apply: (d) => ({ ...d, body: d.body.replace(PAGE_URL, '') }) },
  { check: 'links.page_once', name: 'the page link twice', apply: (d) => ({ ...d, body: `${d.body}\n${PAGE_URL}` }) },
  { check: 'links.unsubscribe_once', name: 'no unsubscribe link', apply: (d) => ({ ...d, body: d.body.replace(UNSUBSCRIBE_URL, '') }) },
  { check: 'links.no_others', name: 'another link', apply: (d) => ({ ...d, body: d.body.replace('\n\n', '\n\nMore at https://example.com/offer\n\n') }) },
  { check: 'opt_out.words', name: 'no opt-out sentence', apply: (d) => ({ ...d, body: d.body.split('\n\n').filter((b) => !/unsubscribe/i.test(b)).join('\n\n') + `\n\n${UNSUBSCRIBE_URL}` }) },
  { check: 'language', name: 'the wrong language', apply: (d, l) => ({ ...d, body: l === 'hi' ? d.body.replace(/[ऀ-ॿ]+/g, 'word') : d.body.replace('\n\n', '\n\nधन्यवाद।\n\n') }) },
  { check: 'tone.banned_phrases', name: 'urgency', apply: (d) => ({ ...d, body: d.body.replace('\n\n', '\n\nAct now, this is your last chance.\n\n') }) },
  { check: 'tone.no_missed_claim', name: 'a claim that a filing was missed', apply: (d) => ({ ...d, body: d.body.replace('\n\n', '\n\nYou have missed the deadline for this filing.\n\n') }) },
  { check: 'tone.exclamations', name: 'exclamation marks', apply: (d) => ({ ...d, body: d.body.replace('\n\n', '\n\nGreat news!! Read on!\n\n') }) },
  { check: 'subject.not_shouted', name: 'a subject in capitals', apply: (d, l, p) => ({ ...d, subject: `${p.company.name.toUpperCase()}: IMPORTANT FILING DATES` }) },
  { check: 'subject.honest', name: 'a fake "Re:"', applies: (k) => k !== 'follow_up', apply: (d) => ({ ...d, subject: `Re: ${d.subject}` }) },
  { check: 'privacy.no_contacts', name: 'a phone number', apply: (d) => ({ ...d, body: d.body.replace('\n\n', '\n\nCall 98765 43210.\n\n') }) },
  { check: 'privacy.no_contacts', name: 'an email address', apply: (d) => ({ ...d, body: d.body.replace('\n\n', '\n\nWrite to asha.verma@gmail.com.\n\n') }) },
  { check: 'length.body', name: 'too long', apply: (d) => ({ ...d, body: d.body.replace('\n\n', `\n\n${'We help with filings. '.repeat(70)}\n\n`) }) },
];

/** The clean drafts: { kind, language, pack, draft }. */
export function cleanDrafts(cfg, { companies = 60 } = {}) {
  const out = [];
  for (let i = 0; i < companies; i += 1) {
    const { company, lead } = fixture(i);
    for (const language of ['en', 'hi']) {
      for (const kind of ['first_touch', 'follow_up', 'new_need']) {
        const built = buildEvidencePack(company, lead, cfg, { asOf: AS_OF });
        if (!built.pack) continue;
        const pack = built.pack;
        pack.thread = { first_sent_on: '2026-11-12', first_subject: `${pack.company.name}: your next filing dates` };
        if (kind === 'new_need') {
          const d = pack.deadlines.find((x) => x.status === 'upcoming') ?? pack.deadlines[0];
          pack.deadlines = [{ ...d, ref: 'D1' }];
          pack.schemes = [];
          pack.need = { type: 'deadline', id: `d:${d.id}:${d.due}`, ref: 'D1' };
        }
        const draft = templateDraft(pack, { kind, language, sender: SENDER, org: ORG, firstSubject: pack.thread.first_subject, firstSentOn: pack.thread.first_sent_on });
        out.push({ kind, language, pack, draft });
      }
    }
  }
  return out;
}

/** Runs the set. `cfg`: loadConfig() (its outreach part is used). Returns { summary, misses }. */
export function evalQc(cfg, { companies = 60 } = {}) {
  const o = cfg.outreach ?? cfg;
  const clean = cleanDrafts(o, { companies });
  let falsePositives = 0;
  const fpChecks = {};
  for (const c of clean) {
    const qc = qualityCheck(c.draft, c.pack, { kind: c.kind, language: c.language, cfg: o, org: ORG });
    if (!qc.passed) {
      falsePositives += 1;
      for (const k of qc.checks.filter((x) => !x.ok)) fpChecks[k.id] = (fpChecks[k.id] ?? 0) + 1;
    }
  }
  const byFault = {};
  const misses = [];
  for (const f of FAULTS) {
    const key = `${f.check}: ${f.name}`;
    const row = { cases: 0, caught: 0 };
    for (const c of clean) {
      if (f.applies && !f.applies(c.kind)) continue;
      const broken = f.apply(c.draft, c.language, c.pack);
      if (broken.subject === c.draft.subject && broken.body === c.draft.body) continue;   // the fault does not apply to this draft
      row.cases += 1;
      const qc = qualityCheck(broken, c.pack, { kind: c.kind, language: c.language, cfg: o, org: ORG });
      if (qc.checks.some((x) => x.id === f.check && !x.ok)) row.caught += 1;
      else if (misses.length < 50) misses.push({ fault: key, kind: c.kind, language: c.language, failed: qc.checks.filter((x) => !x.ok).map((x) => x.id) });
    }
    byFault[key] = row;
  }
  const cases = Object.values(byFault).reduce((n, r) => n + r.cases, 0);
  const caught = Object.values(byFault).reduce((n, r) => n + r.caught, 0);
  return {
    summary: { clean_drafts: clean.length, false_positives: falsePositives, false_positive_checks: fpChecks, fault_types: FAULTS.length,
      broken_drafts: cases, caught, missed: cases - caught, by_fault: byFault },
    misses,
  };
}

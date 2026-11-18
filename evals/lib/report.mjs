/**
 * Turns the evals' results into findings (ranked, each with file:line, the failing case and why it
 * matters) and the human report, evals/REPORT.md. A finding appears only when this run observed it,
 * so a fixed engine loses the finding on the next run; the file:line citations are looked up in the
 * current source each time.
 */
import { cite, pct } from './common.mjs';

const SEV = { 1: 'High', 2: 'Medium-high', 3: 'Medium', 4: 'Low' };
const list = (xs, n = 8) => (xs.length > n ? `${xs.slice(0, n).join(', ')} and ${xs.length - n} more` : xs.join(', '));

export function buildFindings(r) {
  const f = [];
  const add = (sev, title, where, failing, why) => f.push({ severity: sev, title, where, failing, why });

  // ---- privacy -------------------------------------------------------------------------------------
  const leaks = r.privacy?.leaks ?? [];
  const replyLeaks = leaks.filter((l) => l.service === 'llm:reply_classify');
  if (replyLeaks.length) {
    const what = [...new Set(replyLeaks.flatMap((l) => l.leaked))];
    add(1, 'Reply classification sends a founder\'s name and phone numbers to the LLM gateway',
      [cite('services/src/inbound/parse.js', 'const sig = t.search'), cite('services/src/inbound/classify.js', "'[phone]'")],
      replyLeaks.map((l) => `${l.step}: ${l.leaked.join(', ')}`),
      `When the rules are unsure, the reply's new text goes to the gateway's small model (an outside service, possibly outside India, per the legal pack's processor question). newText() drops the signature only after a "-- " line, which most people never type, so "Regards, <name>, Director" goes out; scrub() removes emails and mobiles written 98765 43210, but not a mobile grouped +91 9876 543 210 nor a landline such as 0522 4012345. Leaked here: ${what.join(', ')}. The design's rule is never a person's data to an outside service, and classify.js says the model sees the reply "with every address and number taken out".`);
  }
  const otherLeaks = leaks.filter((l) => l.service !== 'llm:reply_classify');
  if (otherLeaks.length) {
    add(1, 'Canary personal data reached another outside service', ['see Eval 4'], otherLeaks.map((l) => `${l.step} -> ${l.service}: ${l.leaked.join(', ')}`),
      'Any person\'s data leaving the engine breaks the design\'s first privacy rule.');
  }
  if (r.matching?.search_egress?.leaked?.length) {
    add(1, 'The web search query carries personal data', [cite('ingest/src/leadengine/enrich/websites.py', 'q = f\'"{short_name(name)}"')], r.matching.search_egress.queries,
      'Search queries go to a third-party search API.');
  }

  // ---- the gate ------------------------------------------------------------------------------------
  const dis = Object.fromEntries((r.gate?.disagreements ?? []).map((d) => [d.id, d]));
  if (dis['stop.website_address_switch_turned_off']) {
    add(2, 'The gate does not re-check recipient.use_website_email: a website address drafted while the switch was on is still sent after it is turned off',
      [cite('services/src/outreach/gate.js', 'legal_bases.includes(r.legal_basis)'), cite('config/outreach.json', '"use_website_email"')],
      [`stop.website_address_switch_turned_off: ${dis['stop.website_address_switch_turned_off'].outcome} (gate: ${dis['stop.website_address_switch_turned_off'].gate?.code})`],
      'The switch exists because the lawyer has not yet approved writing to website addresses (legal pack, question 2). If the answer is no and the switch goes off, every approved draft to a website address still in the queue is sent anyway, because the gate accepts the basis published_by_company whatever the switch says. A one-line check at the gate closes it.');
  }
  if (dis['stop.consent_label_without_consent']) {
    add(3, 'The gate accepts a recipient labelled "consent" without looking in the consent ledger',
      [cite('services/src/outreach/gate.js', 'legal_bases.includes(r.legal_basis)')],
      [`stop.consent_label_without_consent: ${dis['stop.consent_label_without_consent'].outcome}`],
      'config/outreach.json lists consent as a legal basis for email, and the gate checks only the label on the message. No drafting path creates such a recipient today (recipientFor gives only published_under_law or published_by_company), so this is defence in depth: the day a consented address is used for email, the gate should confirm the consent is in the ledger and not withdrawn, as the WhatsApp and call paths already do.');
  }
  if (dis['stop.cin_says_not_up']) {
    add(3, 'A company whose CIN was issued outside UP is emailed if its record says state UP',
      [cite('services/src/outreach/gate.js', 'async check({ message, lead })'), cite('schema/collections.json', '"state"')],
      [`stop.cin_says_not_up (CIN U62099DL2026PTC300102): ${dis['stop.cin_says_not_up'].outcome}`],
      '"UP only" is enforced by the database on the state field alone. The CIN carries the state of registration (characters 7-8); a record mislabelled upstream is contacted. A cheap cross-check in the validator or the gate would hold the promise even when an ingest step is wrong.');
  }
  for (const d of r.gate?.disagreements ?? []) {
    if (['stop.website_address_switch_turned_off', 'stop.consent_label_without_consent', 'stop.cin_says_not_up'].includes(d.id)) continue;
    add(d.expect.includes('send') ? 3 : 2, `Gate case ${d.id}: expected ${d.expect.join(' or ')}, got ${d.outcome}`, ['services/src/outreach/gate.js'], [`${d.id}: ${d.detail}`], d.why);
  }

  // ---- QC sensitivity -------------------------------------------------------------------------------
  const q = r.qc?.mutations;
  if (q) {
    const missedRows = Object.entries(q.by_mutation).filter(([, v]) => v.applied && v.caught < v.applied);
    const factual = missedRows.filter(([id]) => /^(date|section|form|amount)\./.test(id));
    const sumd = r.drafts?.summary;
    const templateFactErrors = sumd ? ['facts.dates_in_pack', 'facts.dates_attributed', 'facts.forms_in_pack', 'facts.sections_in_pack', 'facts.rupees_in_pack']
      .reduce((n, k) => n + (sumd.by_check[k].total - sumd.by_check[k].passed), 0) : null;
    if (factual.length) {
      add(2, 'The quality check misses wrong facts whose digits appear elsewhere in the evidence pack',
        [cite('services/src/outreach/qc.js', 'const numbers = (rest.match'), cite('services/src/outreach/qc.js', 'const strayForms'), cite('config/outreach.json', '"mode": "all"')],
        factual.map(([id, v]) => `${id} (${v.name}): caught ${v.caught}/${v.applied}`),
        `facts.numbers checks each number in a draft against the set of every digit string in the pack, without context, and facts.forms accepts any form that is a substring of the pack\'s text. So "₹13 lakh" passes when a date in the pack is the 13th, two deadlines\' dates can be swapped, "INC-20A" can become "INC-20" and "s.10A" "s.10B". ${templateFactErrors === 0 ? 'The templates make none of these mistakes (Eval 1: no factual error in any draft), but the AI drafter could,' : `Eval 1 found ${templateFactErrors} factual error(s) in the templates' own drafts, and the AI drafter could add more,`} and once approval.mode becomes "sample" (HANDOVER, design 7.5) 80% of drafts that pass this check are sent without a person reading them.`);
    }
    const words = missedRows.filter(([id]) => /^(tone\.|link\.extra_bare|person\.|company\.|phone\.|email\.)/.test(id));
    if (words.length) {
      add(3, `The quality check misses ${list(words.map(([, v]) => v.name), 10)}`,
        [cite('services/src/outreach/qc.js', 'const MISSED_RX'), cite('services/src/outreach/qc.js', 'const URL_RX'), cite('config/outreach.json', '"banned_phrases"')],
        words.map(([id, v]) => `${id} (${v.name}): caught ${v.caught}/${v.applied}`),
        'The tone rules are fixed phrase lists, so "Please file on time to avoid penalties" or "this filing was not made on time" pass; links are found only after http(s):// or www.; nothing checks names. A person reading every draft catches these, which is why they rank below the factual misses; under sample approval they would reach founders.');
    }
  }
  if (r.qc?.builtIn && r.qc.builtIn.missed) {
    add(2, 'The engine\'s own known-fault set (eval:qc) has misses', [cite('services/src/eval/qc.js', 'export const FAULTS')], [`${r.qc.builtIn.missed} of ${r.qc.builtIn.broken_drafts} broken drafts passed`], 'HANDOVER says eval:qc must catch every fault before any change to what an email may say.');
  }

  // ---- drafts -----------------------------------------------------------------------------------------
  const d = r.drafts?.summary;
  if (d) {
    const fails = (id) => (r.drafts.failing ?? []).filter((x) => x.failed.some((c) => c.id === id));
    const len = [...fails('length.subject'), ...fails('length.body')];
    if (len.length) {
      add(4, 'Long company names make the reviewed templates fail their own length limits',
        [cite('services/src/outreach/templates.js', 'firstSubject: (p) =>'), cite('services/src/outreach/templates.js', 'followSubject:'), cite('config/outreach.json', '"subject_max_chars"')],
        [...new Set(len.map((x) => `${x.id}: ${x.failed.filter((c) => c.id.startsWith('length')).map((c) => c.detail).join('; ')}`))],
        'The first subject is "<name>: your next filing dates" and a follow-up adds "Re: ", so a name over 66 characters (62 for a follow-up) breaks the 90-character limit, and a long name repeated in a full pack pushes the body past 250 words. Such a draft is stored as qc_failed: a person must shorten it by hand before it can be approved, every time, and under sample approval it never goes by the engine\'s route. MCA allows names this long; the templates could shorten the subject instead (for example without "Private Limited").');
    }
    const links = fails('links.no_other_links');
    if (links.length) {
      const sample = links[0].failed.find((c) => c.id === 'links.no_other_links')?.detail ?? '';
      add(4, 'Every template email carries a third link (the sender\'s website in the signature)',
        [cite('services/src/outreach/templates.js', 'function signature(sender, org)'), cite('services/src/outreach/draft.js', 'as the only link')],
        [`${links.length}/${d.drafts} drafts: ${sample}`],
        'templates.js promises "one link to the company\'s page and one to unsubscribe", and the AI prompt says the page link is "the only link", yet the signature it must copy word for word holds https://solutionai.in. qc.js deliberately allows it. Harmless in itself, but the promise, the prompt and the code disagree; decide which is meant.');
    }
    const why = fails('why.matches_basis');
    if (why.length) {
      const kinds = [...new Set(why.map((x) => x.id.split('/')[1]))];
      add(4, `${kinds.join(' and ')} emails do not say why the founder is getting them`,
        [cite('services/src/outreach/templates.js', 'followStop:')],
        [`${why.length} drafts: ${list(why.map((x) => x.id))}`],
        'First and new-need emails end with where the address came from (the MCA register or the company\'s own website); follow-ups end with the unsubscribe link only. A founder who sees only the follow-up (the first went to spam) is never told the source, which matters most for a website address, the basis the lawyer has not yet approved.');
    }
    const factualFails = ['facts.dates_in_pack', 'facts.dates_attributed', 'facts.forms_in_pack', 'facts.sections_in_pack', 'facts.rupees_in_pack', 'company.name_right',
      'company.no_other_company', 'privacy.no_person', 'opt_out.words', 'lawful.no_conditional_obligation', 'lawful.no_threat_or_urgency', 'links.one_page_link', 'links.one_unsubscribe_link']
      .flatMap((id) => fails(id).map((x) => `${x.id}: ${id}`));
    if (factualFails.length) add(1, 'Template drafts state facts or details the evidence pack does not support', ['services/src/outreach/templates.js'], factualFails, 'A wrong date, form, section or amount in an email to a founder is the failure the whole design is built to prevent.');
  }

  // ---- matching and websites -----------------------------------------------------------------------------
  const m = r.matching?.matching;
  if (m && !m.error) {
    const run = m.runs[m.main_run];
    if (run.wrong_links) add(1, 'The matcher made wrong automatic links', [cite('ingest/src/leadengine/kb/match.py', 'def decide(')], run.wrong_links_list, 'A wrong link puts one company\'s facts into another company\'s email.');
    const translit = (run.misses ?? []).filter((x) => x.category.startsWith('Hindi') && x.outcome === 'not linked');
    if (translit.length) {
      add(4, 'Transliteration variants of the same name are not even put in front of a reviewer',
        [cite('ingest/src/leadengine/names.py', 'def typo_of'), cite('ingest/src/leadengine/kb/match.py', 'NAME_LEVELS = [')],
        translit.map((x) => `${x.id}: ${x.outcome} (${x.why ?? ''})`),
        'Laxmi/Lakshmi, Shri/Shree, a name typed in Devanagari: the founder\'s company is in the universe but no candidate reaches the review queue, so the startup stays unlinked and its facts never join the company record. Precision is unharmed; recall on Hindi-belt names is.');
    }
    const nl = m.name_level;
    if (nl?.wrong) {
      add(4, 'Name normalisation calls two different one-letter-apart names "the same but for a slip"',
        [cite('ingest/src/leadengine/names.py', 'def typo_of')], nl.wrong_list,
        'typo_of treats Hiranyo and Hiranya as one name misspelt. In this run the matcher still did not link them automatically (the probability stayed under the threshold), but the name rule alone offers no protection; it relies on the other conditions.');
    }
  }
  const w = r.matching?.websites;
  if (w) {
    if (w.wrong_accepts.length) {
      add(4, 'Website confirmation takes a free site-builder subdomain for the company\'s own site',
        [cite('ingest/src/leadengine/web.py', 'SHARED_HOSTS = (')], w.wrong_accepts.map((x) => `${x.id}: ${x.url}`),
        'wixsite.com, blogspot.com and godaddysites.com are refused as shared hosts, but other builders (weebly.com here; similarly jimdo, webnode, myshopify) are not. The contact step then looks for role addresses on that subdomain, so the practical harm is small, but the rule should be a list of kinds, not a handful of names.');
    }
    if (w.wrong_rejects.length) {
      add(4, 'Website confirmation rejects real company sites whose names are initials or whose domains drop "Shri"',
        [cite('ingest/src/leadengine/enrich/websites.py', 'def distinctive'), cite('ingest/src/leadengine/enrich/websites.py', 'def domain_fits')],
        w.wrong_rejects.map((x) => `${x.id}: ${x.url}`),
        'distinctive() drops words under three letters and domain_fits() requires the first distinctive word in the domain, so "VN Agro" has no distinctive word at all and "Shri Ganesh Agro" at ganeshagro.* fails. Safe (nothing wrong is accepted) but those companies never get a website address.');
    }
  }

  // ---- docs ----------------------------------------------------------------------------------------------
  const docs = r.docs;
  if (docs && !docs.error) {
    const items = [
      ...docs.commands.missing.map((x) => `command "${x.cmd}" (${x.where}): ${x.why}`),
      ...docs.openapi.problems.map((x) => `${x.path} (${x.where}): ${x.why}`),
      ...docs.env.not_in_env_example.map((x) => `${x.name} is read (${x.where}) but not in .env.example`),
      ...docs.env.never_read.filter((x) => !x.read_by_ops_only).map((x) => `${x.name} (${x.where}) is never read`),
      ...docs.configs.problems.map((x) => `${x.file} (${x.where}): ${x.why}`),
      ...docs.tests.mismatches.map((x) => `${x.where} says ${x.quoted} ${x.what} tests; there are ${x.real}`),
    ];
    if (items.length) {
      add(4, 'Docs and code disagree', ['.env.example', 'docs/HANDOVER.md', 'docs/platform-openapi.yaml'], items,
        `The handover is what the team runs the engine from after 25 November; a variable missing from .env.example is a setting nobody will know to set${docs.env.not_in_env_example.some((x) => x.name === 'DKIM_SELECTOR') ? ' (DKIM_SELECTOR changes what preflight checks)' : ''}${docs.tests.mismatches.length ? ', and stale test counts make a missing test hard to notice' : ''}.`);
    }
  }
  return f.sort((a, b) => a.severity - b.severity);
}

// ---- the markdown report ------------------------------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n');

export function scorecard(r) {
  const rows = [];
  const d = r.drafts?.summary;
  if (d) {
    const facts = ['facts.dates_in_pack', 'facts.dates_attributed', 'facts.forms_in_pack', 'facts.sections_in_pack', 'facts.rupees_in_pack'];
    const ok = facts.every((k) => d.by_check[k].passed === d.by_check[k].total);
    const noLink = (r.drafts.failing ?? []).filter((x) => x.failed.every((c) => c.id === 'links.no_other_links')).length;
    rows.push(['1. Draft factuality and lawfulness', `${d.drafts} drafts from ${d.coverage.companies} companies: facts ${ok ? '100%' : 'NOT 100%'} from the pack; every check passed by ${d.all_checks_passed}/${d.drafts} (${d.all_checks_passed + noLink}/${d.drafts} if the signature's website link is allowed)`]);
  } else rows.push(['1. Draft factuality and lawfulness', `not run: ${r.drafts?.error ?? ''}`]);
  const q = r.qc;
  if (q?.builtIn) {
    rows.push(['2. QC sensitivity', `eval:qc ${q.builtIn.caught}/${q.builtIn.broken_drafts} (${pct(q.builtIn.caught, q.builtIn.broken_drafts)}), ${q.builtIn.false_positives} false positives; this suite's mutations ${q.mutations.caught}/${q.mutations.applied} (${pct(q.mutations.caught, q.mutations.applied)}); ${Object.values(q.mutations.by_mutation).filter((v) => v.applied && v.caught === 0).length} of ${Object.keys(q.mutations.by_mutation).length} mutation types never caught`]);
  } else rows.push(['2. QC sensitivity', `not run: ${q?.error ?? ''}`]);
  const g = r.gate;
  rows.push(['3. Compliance gate', g?.cases ? `${g.agree}/${g.cases} cases agree (${pct(g.agree, g.cases)}); ${g.cases - g.agree} disagreement(s), ${g.errors} harness error(s)` : `not run: ${g?.error ?? ''}`]);
  const p = r.privacy;
  rows.push(['4. Privacy egress', p?.paths ? `${p.outside_calls} outside calls over ${p.services.length} services; ${p.leaks.length ? `LEAKS on ${p.leaks.length} path(s): ${p.leaks.map((l) => `${l.service} (${l.leaked.join(', ')})`).join('; ')}` : 'no canary left the engine'}` : `not run: ${p?.error ?? ''}`]);
  const m = r.matching?.matching;
  if (m && !m.error) {
    const run = m.runs[m.main_run];
    const w = r.matching.websites;
    rows.push(['5. Matching and websites', `${m.pairs} pairs: precision ${run.precision == null ? 'n/a' : pct(run.correct_links, run.links)}, recall ${pct(run.correct_links, m.same)} (linked or sent to review ${run.same_pairs_linked_or_sent_to_review}); websites ${w.correct}/${w.cases}, directories and social networks rejected ${w.directories_social_rejected}; web search egress ${r.matching.search_egress.leaked.length ? 'LEAK' : 'clean'}`]);
  } else rows.push(['5. Matching and websites', r.matching?.skipped ?? `not run: ${r.matching?.error ?? m?.error ?? ''}`]);
  const docs = r.docs;
  rows.push(['6. Docs agree with the code', docs?.items ? `${docs.items} items checked; ${docs.problems} mismatch(es)` : `not run: ${docs?.error ?? ''}`]);
  return rows;
}

export function markdown(r, findings, meta) {
  const out = [];
  const push = (...x) => out.push(...x);
  push('# Lead engine evals: report', '', `Run ${meta.at} (IST ${meta.ist}), ${meta.seconds} s, by \`node evals/run.mjs\`. What each eval measures and how to read it: \`evals/README.md\`. Machine-readable: \`evals/report.json\`.`, '');
  push('## Scorecard', '', table(['Eval', 'Headline'], scorecard(r)), '');
  if (meta.harnessErrors.length) push('**The harness itself failed on:** ' + meta.harnessErrors.map((e) => `${e.name} (${e.error.split('\n')[0]})`).join('; '), '');
  push('## Findings', '', 'Most severe first. Each was observed in this run; the file:line points at the code responsible, as it reads today.', '');
  findings.forEach((x, i) => {
    push(`### ${i + 1}. [${SEV[x.severity]}] ${x.title}`, '', `- **Where:** ${x.where.join(', ')}`, `- **Failing cases:** ${list(x.failing, 12)}`, `- **Why it matters:** ${x.why}`, '');
  });
  if (!findings.length) push('None observed.', '');

  const d = r.drafts?.summary;
  if (d) {
    push('## 1. Draft factuality and lawfulness', '', `${d.drafts} drafts written by the engine (the reviewed templates, as in production until the LLM gateway has a key) for ${d.coverage.companies} fictional companies: ${Object.entries(d.coverage.by_kind).map(([k, v]) => `${v} ${k}`).join(', ')}; ${Object.entries(d.coverage.by_language).map(([k, v]) => `${v} in ${k === 'hi' ? 'Hindi' : 'English'}`).join(', ')}; ${Object.entries(d.coverage.by_basis).map(([k, v]) => `${v} to ${k === 'published_by_company' ? 'a website address' : 'a registered address'}`).join(', ')}; ${d.coverage.with_schemes} with schemes; ${d.coverage.llp} LLP drafts; ${d.coverage.was_due_lines} with a "was due" line. Graded by this suite's own checker, not the engine's.`, '');
    push(table(['Check', 'Passed', 'Rate'], Object.entries(d.by_check).map(([k, v]) => [k, `${v.passed}/${v.total}`, pct(v.passed, v.total)])), '');
    const byCheck = {};
    for (const x of r.drafts.failing) for (const c of x.failed) (byCheck[c.id] ??= []).push(`${x.id}${c.detail && c.id !== 'links.no_other_links' ? ` (${c.detail})` : ''}`);
    push('**Every failing draft, by check:**', '');
    for (const [k, v] of Object.entries(byCheck)) push(`- \`${k}\` (${v.length}): ${v.join('; ')}${k === 'links.no_other_links' ? ` — each one: ${r.drafts.failing.find((x) => x.failed.some((c) => c.id === k)).failed.find((c) => c.id === k).detail}` : ''}`);
    push('', `The engine's own quality check failed ${d.engine_qc_failed.length} of these drafts: ${d.engine_qc_failed.map((x) => `${x.id} (${x.failed.join('; ')})`).join('; ') || 'none'}.`, '');
  }

  const q = r.qc;
  if (q?.builtIn) {
    push('## 2. QC sensitivity', '', `**The engine's own set** (\`eval:qc\`, services/src/eval/qc.js): ${q.builtIn.clean_drafts} clean drafts, ${q.builtIn.false_positives} false positives; ${q.builtIn.broken_drafts} broken drafts over ${q.builtIn.fault_types} fault types, ${q.builtIn.caught} caught (${pct(q.builtIn.caught, q.builtIn.broken_drafts)}).`, '');
    push(`**This suite's mutations**, each applied to every clean draft from Eval 1 where it applies (${q.mutations.applied} mutated drafts, ${q.mutations.caught} caught, ${pct(q.mutations.caught, q.mutations.applied)}). "Caught by" is which QC check failed; a catch by facts.numbers for a phone or a date is a catch for the wrong reason, and would be missed if the digits happened to be in the pack.`, '');
    push(table(['Mutation', 'Engine QC caught', 'Rate', 'Caught by', 'This suite\'s grader caught'], Object.entries(q.mutations.by_mutation).map(([k, v]) => [`${k}: ${v.name}`, `${v.caught}/${v.applied}`, pct(v.caught, v.applied), Object.entries(v.fired).map(([a, b]) => `${a} ${b}`).join(', ') || '—', `${v.grader_caught}/${v.applied}`])), '');
    push(`The last column checks the checker: Eval 1's grader, run on the same mutated drafts, caught ${q.mutations.grader_caught}/${q.mutations.applied} (${pct(q.mutations.grader_caught, q.mutations.applied)}), so its clean bill for the templates' facts is not for want of looking. Where it misses too, it is because the mutation is outside what it grades (tone in other words is checked only by a phrase list here as well).`, '');
    const missed = Object.entries(q.mutations.missed);
    if (missed.length) {
      push('**Missed mutations (every draft):**', '');
      for (const [k, ids] of missed) push(`- \`${k}\` (${ids.length}): ${ids.join(', ')}`);
      push('');
    }
  }

  const g = r.gate;
  if (g?.results) {
    push('## 3. Compliance gate', '', `Each case runs the engine's real path on a throwaway MongoDB: plan, draft (with the address check), a person's approval, then the send job and its gate, with a transport that keeps the email and sends nothing. Outcome: send (the transport was handed the email), wait, stop, or no_message (nothing reached the gate). ${g.agree}/${g.cases} agree.`, '');
    push(table(['Case', 'Expected', 'Outcome', 'Gate', 'Agrees'], g.results.map((x) => [x.id, x.expect.join(' or '), x.outcome, x.gate ? `${x.gate.decision}: ${x.gate.code}` : '—', x.agree ? 'yes' : '**NO**'])), '');
    if (g.disagreements.length) {
      push('**Disagreements:**', '');
      for (const x of g.disagreements) push(`- \`${x.id}\`: ${x.why}. Expected ${x.expect.join(' or ')}, got **${x.outcome}**${x.gate ? ` (gate: ${x.gate.decision}, ${x.gate.code}: ${x.gate.reason})` : ''}. Trail: ${x.detail}`);
      push('');
    }
  }

  const p = r.privacy;
  if (p?.paths) {
    push('## 4. Privacy egress', '', 'Canary personal data (fixtures/canaries.json) planted in the company record, the vendor profile, the portal team and the founder\'s reply; every outside call captured.', '');
    const rows = [];
    for (const s of p.paths) for (const [svc, v] of Object.entries(s.by_service)) rows.push([s.step, svc, v.calls, v.leaked.length ? `**${v.leaked.join(', ')}**` : 'nothing']);
    push(table(['Path', 'Service', 'Calls', 'Canaries in the request'], rows), '');
    push(`- Email verification service: called ${p.verification.calls} time(s), for ${p.verification.addresses.join(', ') || 'no address'}; the director's own registered address got the free checks only.`);
    const cw = p.claims.campaign;
    if (cw) push(`- Campaign claim before its email confirmation: ${cw.waiting.outside_calls} outside call(s), ${cw.waiting.consents} consent(s) recorded, ${cw.waiting.claimed} claim(s) recorded; the confirmation went only to ${cw.waiting.confirmation_to.join(', ')}. After confirmation: ${cw.confirmed ? `${cw.confirmed.onboarding_calls} onboarding call, claim recorded ${cw.confirmed.claimed}` : 'not reached'}.`);
    push(`- What reached the platform's onboarding: only what the claimant typed (${p.claimant_sent_to_platform.map((c) => Object.keys(c).join('/')).join('; ')}), which is the point of claiming; none of the planted canaries.`);
    for (const [k, v] of Object.entries(p.notes)) if (v) push(`- ${k}: ${v}`);
    push('');
  }

  const mm = r.matching;
  if (mm?.matching && !mm.matching.error) {
    const m = mm.matching;
    push('## 5. Matching on hard name pairs, and websites', '', `${m.pairs} labelled pairs (${m.same} same, ${m.different} different), ${m.startups} startups against ${m.companies} companies (the pairs' own and invented distractors). Thresholds: automatic link at probability ${m.thresholds.LINK_P} with a ${m.thresholds.MARGIN_BITS}-bit margin, review from ${m.thresholds.REVIEW_P} (${m.thresholds.model}). Precision and recall are of automatic links; a pair sent to review is not a link.`, '');
    push(table(['Run', 'Links', 'Wrong links', 'Precision', 'Recall', 'Same pairs linked or sent to review', 'Seconds'], Object.entries(m.runs).map(([k, v]) => [k, v.links, v.wrong_links, v.precision == null ? 'n/a' : pct(v.correct_links, v.links), pct(v.correct_links, m.same), v.same_pairs_linked_or_sent_to_review, v.seconds])), '');
    const run = m.runs[m.main_run];
    push(`**Every miss (${m.main_run}):**`, '');
    push(table(['Pair', 'Category', 'Label', 'Outcome', 'Name level', 'Why'], run.misses.map((x) => [x.id, x.category, x.label, x.outcome, x.name_agreement, x.why ?? ''])), '');
    const nl = m.name_level;
    push(`**Name level alone** (names.py and match.name_agreement, over the ${nl.pairs} pairs where the name is the question): precision ${pct(nl.correct, nl.predicted_same)}, recall ${nl.recall == null ? 'n/a' : `${(nl.recall * 100).toFixed(1)}%`}. Called the same but different: ${nl.wrong_list.join(', ') || 'none'}. Same but not recognised: ${nl.missed_list.join(', ') || 'none'}.`, '');
    if (m.notes?.length) push(`Notes: ${m.notes.join('; ')}`, '');
    const w = mm.websites;
    push(`**Website confirmation** (enrich/websites.py's search step with a fake search API and fetcher): ${w.correct}/${w.cases} right; directories, marketplaces, social networks and shared builders rejected ${w.directories_social_rejected}; the company's own sites accepted ${w.own_sites_accepted}.`, '');
    push(table(['Case', 'URL', 'Expected', 'Got'], w.rows.map((x) => [x.id, x.url, x.expect, x.ok ? x.got : `**${x.got}**`])), '');
    push(`**Web search egress:** the query sent was ${mm.search_egress.queries.map((x) => `\`${x}\``).join(', ')}; pages fetched: ${mm.search_egress.fetched.join(', ')}; canaries in them: ${mm.search_egress.leaked.join(', ') || 'none'}.`, '');
  } else if (mm) push('## 5. Matching on hard name pairs, and websites', '', mm.skipped ?? `Not run: ${mm.error ?? mm.matching?.error}`, '');

  const docs = r.docs;
  if (docs?.items) {
    push('## 6. Docs agree with the code', '');
    push(`- **CLI commands:** ${docs.commands.checked} distinct commands named in README.md, docs/HANDOVER.md and ops/ (against ${docs.commands.node_commands} Node commands and ${docs.commands.python_commands} ingest commands): ${docs.commands.missing.length ? docs.commands.missing.map((x) => `\`${x.cmd}\` at ${x.where} (${x.why})`).join('; ') : 'all exist'}.`);
    push(`- **OpenAPI:** ${docs.openapi.paths} paths (${docs.openapi.engine_paths} served by the engine): ${docs.openapi.problems.length ? docs.openapi.problems.map((x) => `${x.path}: ${x.why}`).join('; ') : 'every engine path is served and every platform path has a client'}. Admin JSON routes not in the contract (informational): ${docs.openapi.undocumented_api_routes.join(', ') || 'none'}.`);
    push(`- **.env.example:** ${docs.env.documented} variables documented, ${docs.env.read_in_code} read by the code. Read but not documented: ${docs.env.not_in_env_example.map((x) => `${x.name} (${x.where})`).join(', ') || 'none'}. Documented but never read by the code: ${docs.env.never_read.map((x) => `${x.name}${x.read_by_ops_only ? ' (read by ops/deploy scripts only)' : ''}`).join(', ') || 'none'}.`);
    push(`- **Config files:** ${docs.configs.referenced} referenced, ${docs.configs.parsed} parsed: ${docs.configs.problems.length ? docs.configs.problems.map((x) => `${x.file} (${x.where}): ${x.why}`).join('; ') : 'all exist and parse'}.`);
    push(`- **Test counts:** real ${docs.tests.real.node} Node (${docs.tests.real.node_how}) and ${docs.tests.real.python} Python (${docs.tests.real.python_how}). Quoted: ${docs.tests.quoted.map((x) => `${x.where} ${['node', 'python', 'total'].filter((k) => x[k] != null).map((k) => `${k} ${x[k]}`).join(', ')}`).join('; ')}. ${docs.tests.mismatches.length ? `Off by more than 2% or 5: ${docs.tests.mismatches.map((x) => `${x.where} ${x.what} ${x.quoted} (real ${x.real})`).join('; ')}.` : 'All close.'}`);
    push('');
  }
  push('## Limits of this run', '', '- The drafts are the reviewed templates\'. The AI drafter is not exercised (no model runs offline); Eval 2 measures what would stop its mistakes.', '- The gate cases change the database directly where a real path would (a holdout flag, a message field) to reach the gate; each case says why.', '- Matching runs on a universe of a few dozen companies; Splink\'s prior and u are fitted on it, so its probabilities, and the recall, are indicative of production rather than equal to it. Precision is the number that matters most, and the pairs were written to be hard.', `- Network: ${meta.blocked.length ? `the guard refused ${meta.blocked.length} attempt(s): ${meta.blocked.map((b) => `${b.kind} ${b.target}`).join(', ')}` : 'nothing tried to leave the machine (the guard refused nothing)'}.`, '');
  return out.join('\n');
}

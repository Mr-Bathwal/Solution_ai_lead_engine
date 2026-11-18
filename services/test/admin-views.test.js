import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { approvalPage, approvalsPage, companiesPage, companyPage, healthPage, layout, loginPage, pipelinePage, reviewPage, shortlistPage } from '../src/admin/views.js';

/**
 * The Admin pages' markup contracts: what keyboard and screen-reader users rely on (skip link, named
 * navigation, current page, labels, table header scope), what an empty list says, which links are
 * allowed, and that personal data the pages are not given cannot appear. These render the views
 * directly, without a server or a database.
 */

const at = new Date('2026-10-26T06:00:00Z');
const ctx = (role = 'admin') => ({ user: { email: `${role}@solutionai.in`, role }, csrf: 'tok', notice: null, reviewWaiting: 3 });
const attr = (value, source = 'mca_monthly', extra = {}) => ({ value, source, confidence: 'high', seen_at: at, ...extra });

function pipelineData(extra = {}) {
  return {
    month: '2026-10',
    companies: { company: 10, llp: 2 },
    funnel: { discovered: 6, shortlisted: 3, contacted: 0, engaged: 0, claimed: 0, customer: 0, closed: 0 },
    holdout: 1,
    cohorts: [{ _id: '2026-09', total: 10, eligible: 9, shortlisted: 3, contacted: 0, engaged: 0, claimed: 0, customer: 0, holdout: 1 }],
    themes: [{ _id: 'SaaS, IT & Cloud', n: 4 }],
    districts: [{ _id: 'Lucknow', n: 2 }],
    links: { linked: 5, review: 1, unlinked: 7 },
    shortlist: [
      { rank: 1, company_id: 'U62099UP2026PTC100001', name: 'VEZRAS TECHNOLOGIES PRIVATE LIMITED', fit: 60, fit_at_rank: 66, ranked_at: at,
        theme: 'SaaS, IT & Cloud', district: 'Lucknow', holdout: false, stage: 'shortlisted', next_deadline: { title: 'Hold the first board meeting', due: at } },
      { rank: 2, company_id: 'U62099UP2026PTC100002', name: 'HELD BACK PRIVATE LIMITED', fit: 58, fit_at_rank: 58, ranked_at: at,
        theme: 'SaaS, IT & Cloud', district: null, holdout: true, stage: 'discovered', next_deadline: null },
    ],
    runs: [{ source: 'mca_monthly', status: 'ok', started_at: at, finished_at: at, notes: ['period 2026-09'] },
      { source: 'kb', status: 'partial', started_at: at, finished_at: at, notes: [] }],
    usage: [],
    rules: { rules_confirmed: false, verdicts_by: 'provisional_rules', rules_version: 't' },
    ...extra,
  };
}

function companyData(extra = {}, leadExtra = {}) {
  return {
    company: {
      _id: 'U62099UP2026PTC100001', kind: 'company', name: 'VEZRAS TECHNOLOGIES PRIVATE LIMITED', cohort: '2026-09',
      attrs: { legal_name: attr('VEZRAS TECHNOLOGIES PRIVATE LIMITED'), incorporation_date: attr('2026-09-10'),
        state_evidence: attr('UP', 'startup_portals', { confidence: 'medium' }), brand: attr('Vezras', 'startinup', { confidence: 'medium' }) },
    },
    lead: {
      stage: 'shortlisted', holdout: false, eligible: true, shortlist: { month: '2026-10', rank: 1 },
      score: { fit: 66, components: [{ points: 20, reason: 'new' }], version: 'fit-v1', theme: { name: 'SaaS, IT & Cloud', sub_sector: 'saas', confidence: 'high' } },
      next_action: { type: 'confirm_rules', why: 'deadline and scheme rules await a CA confirmation' },
      needs: {
        rules_confirmed: false, verdicts_by: 'provisional_rules', rules_version: 't',
        deadlines: [
          { title: 'File the annual return', form: 'MGT-7', law: 'Companies Act 2013 s.92', source_url: 'javascript:alert(1)', due: at, days_left: 3, status: 'due_soon', penalty: '₹100 a day' },
          { title: 'Hold the first board meeting', form: 'Minutes', law: 'Companies Act 2013 s.173', source_url: 'https://www.mca.gov.in/x', due: at, days_left: 0, status: 'upcoming' },
        ],
        schemes: [
          { name: 'Seed Fund', verdict: 'check_required', benefit: 'Up to ₹20 lakh', reason: 'needs DPIIT', source_url: 'data:text/html,x', checked_on: '2026-10-01' },
          { name: 'Startup in UP recognition', verdict: 'held', benefit: 'Incentives', reason: 'listed', source_url: 'https://invest.up.gov.in/policy.pdf', checked_on: '2026-10-01' },
        ],
      },
      ...leadExtra,
    },
    links: [], candidate_of: [], startups: [], personal_fields: [], personal_shown: false, directors: [],
    timeline: [
      { at, what: 'startinup record', detail: 'UPLC_00000001' },
      { at, what: 'Company record created', detail: 'mca_monthly, startinup' },
      { at, what: 'Linked to portal startup UPLC_00000001', detail: 'exact_name' },
    ],
    ...extra,
  };
}

function reviewData(extra = {}) {
  return {
    waiting: 1, decided: 0,
    items: [{
      entity_key: 'UPLC_00000009', evidence: { why_review: 'no year to confirm the name' }, probability: 0.9,
      // An older query shape carried team names; the page must never print them, whatever it is given.
      startup: { legal_name: 'Vezras Tech', entity_type: 'Private Limited', year: 2026, since: '2026-09-01', district: 'Lucknow',
        team_count: 2, team: [{ name: 'Priya Sharma', role: 'Founder' }, { name: 'Kabir Rao', role: 'CTO' }] },
      candidates: [{ company_id: 'U62099UP2026PTC100001', name: 'VEZRAS TECHNOLOGIES PRIVATE LIMITED', incorporated: at, method: 'splink', probability: 0.9 }],
    }],
    ...extra,
  };
}

/** Every visible form field sits inside a <label> (the pages always wrap fields in their label). */
function unlabelledFields(page) {
  const out = [];
  const re = /<(input|select|textarea)\b[^>]*>/g;
  let m;
  while ((m = re.exec(page))) {
    if (/type="hidden"/.test(m[0])) continue;
    const before = page.slice(0, m.index);
    if (before.lastIndexOf('<label') <= before.lastIndexOf('</label>')) out.push(m[0]);
  }
  return out;
}
const headersWithoutScope = (page) => (page.match(/<th\b[^>]*>/g) ?? []).filter((t) => !/scope="(col|row)"/.test(t));

describe('admin views: page frame', () => {
  test('a skip link leads to the main landmark, before anything else that takes focus', () => {
    const page = String(layout({ ...ctx(), title: 'x', active: 'pipeline', body: '' }));
    assert.match(page, /<html lang="en">/);
    const skip = page.indexOf('<a class="skip" href="#main">Skip to content</a>');
    assert.ok(skip > 0, 'skip link present');
    assert.ok(skip < page.indexOf('<a class="brand"'), 'skip link comes first');
    assert.match(page, /<main class="wrap" id="main">/);
  });

  test('the main navigation is named and marks the current page, and only that page', () => {
    const page = String(layout({ ...ctx(), title: 'x', active: 'review', body: '' }));
    assert.match(page, /<nav aria-label="Main">/);
    assert.equal(page.match(/aria-current="page"/g).length, 1);
    assert.match(page, /<a href="\/admin\/review" class="on" aria-current="page">Review <span class="count">3<span class="vh"> waiting<\/span><\/span><\/a>/);
    assert.ok(!/<script/i.test(page), 'no script, ever');
  });

  test('signed out, the sign-in field has a label and there is no navigation', () => {
    const page = String(loginPage({ error: 'That token is not recognised.' }));
    assert.deepEqual(unlabelledFields(page), []);
    assert.ok(!page.includes('<nav'));
    assert.match(page, /role="alert"/);
  });
});

describe('admin views: labels and table headers', () => {
  test('every visible form field on every page has a label', () => {
    const pages = {
      pipeline: pipelinePage(pipelineData(), ctx()),
      companies: companiesPage({ total: 1, page: 1, size: 50, rows: [{ id: 'U1', name: 'A', cohort: '2026-09', lead: null }] }, { q: 'a', stage: '', cohort: '' }, ctx()),
      review: reviewPage(reviewData(), ctx('reviewer')),
    };
    for (const [name, page] of Object.entries(pages)) assert.deepEqual(unlabelledFields(String(page)), [], name);
    const companies = String(pages.companies);
    assert.match(companies, /<label>Search <input type="search" name="q"/);
    assert.match(companies, /<label>Stage <select name="stage">/);
    assert.match(companies, /<label>Cohort <input name="cohort"/);
  });

  test('each review decision is a named group, so "Same" and "Different" say which pair they decide', () => {
    const page = String(reviewPage(reviewData(), ctx('reviewer')));
    assert.match(page, /<fieldset class="decide"><legend class="vh">Is Vezras Tech the same business as VEZRAS TECHNOLOGIES PRIVATE LIMITED\?<\/legend>/);
    assert.match(page, /<label class="note"><span class="vh">Note about this match \(optional\)<\/span><input name="note"/);
    assert.match(page, /Why it needs you: no year to confirm the name/);
    assert.match(page, /probabilistic match/, 'the matcher method in words, not "splink"');
    assert.ok(!String(reviewPage(reviewData(), ctx('viewer'))).includes('<fieldset'), 'viewers see no decision controls');
  });

  test('every table header says whether it heads a column or a row', () => {
    const pages = {
      pipeline: pipelinePage(pipelineData(), ctx()),
      shortlist: shortlistPage(pipelineData(), ctx()),
      companies: companiesPage({ total: 1, page: 1, size: 50, rows: [{ id: 'U1', name: 'A', cohort: '2026-09', lead: null }] }, {}, ctx()),
      company: companyPage(companyData(), ctx()),
      health: healthPage(pipelineData({ usage: [{ meter: 'infyner', period: '2026-10', count: 3, cap: 100 }] }), ctx()),
    };
    for (const [name, page] of Object.entries(pages)) assert.deepEqual(headersWithoutScope(String(page)), [], name);
  });
});

describe('admin views: empty states', () => {
  test('a search with no match says so and offers to clear the filters, instead of an empty table', () => {
    const page = String(companiesPage({ total: 0, page: 1, size: 50, rows: [] }, { q: 'nothing', stage: '', cohort: '' }, ctx()));
    assert.match(page, /No companies match these filters\. <a href="\/admin\/companies">Clear the filters<\/a>/);
    assert.ok(!page.includes('<table'));
    assert.ok(!page.includes('class="pager"'), 'no "Page 1 of 1"');
    assert.match(String(companiesPage({ total: 0, page: 1, size: 50, rows: [] }, {}, ctx())), /No companies match yet\./);
  });

  test('the pager is a named navigation, shown only when there is more than one page', () => {
    const rows = [{ id: 'U1', name: 'A', cohort: '2026-09', lead: null }];
    assert.match(String(companiesPage({ total: 120, page: 2, size: 50, rows }, {}, ctx())), /<nav class="pager" aria-label="Pages">/);
    assert.ok(!String(companiesPage({ total: 1, page: 1, size: 50, rows }, {}, ctx())).includes('class="pager"'));
  });

  test('a company without deadlines, schemes, facts or history says so in each place', () => {
    const v = companyData({ timeline: [] }, { needs: { deadlines: [], schemes: [] } });
    v.company.attrs = {};
    const page = String(companyPage(v, ctx()));
    for (const text of ['No deadlines worked out for this company yet', 'No scheme verdicts for this company yet', 'No registry facts yet',
      'Not linked to a portal startup', 'Nothing recorded yet']) assert.ok(page.includes(text), text);
    assert.ok(!page.includes('<table class="dense deadlines"'));
  });

  test('empty queue, empty shortlist, no runs', () => {
    assert.match(String(reviewPage({ waiting: 0, decided: 4, items: [] }, ctx('reviewer'))), /Nothing waiting\./);
    assert.match(String(shortlistPage(pipelineData({ shortlist: [] }), ctx())), /No shortlist for 2026-10 yet/);
    assert.match(String(healthPage(pipelineData({ runs: [] }), ctx())), /No runs recorded yet\./);
    assert.match(String(pipelinePage(pipelineData({ themes: [], cohorts: [] }), ctx())), /Nothing to show yet\./);
  });
});

describe('admin views: links and data', () => {
  test('only http(s) URLs become links; anything else is plain text', () => {
    const page = String(companyPage(companyData(), ctx()));
    assert.ok(!/href="(javascript|data):/i.test(page), 'no script or data URL in an href');
    assert.ok(!/javascript:|data:text/i.test(page), 'and not printed either');
    assert.match(page, /<a href="https:\/\/www\.mca\.gov\.in\/x" rel="noreferrer noopener" target="_blank">Companies Act 2013 s\.173<\/a>/);
    assert.match(page, /MGT-7 · Companies Act 2013 s\.92<\/div>/, 'the unsafe law link stays as its text');
    assert.match(page, /<a href="https:\/\/invest\.up\.gov\.in\/policy\.pdf" rel="noreferrer noopener" target="_blank">Source<span class="vh"> for Startup in UP recognition<\/span><\/a>/);
    assert.match(page, /No source link/);
  });

  test('the review page never prints team names, whatever it is given', () => {
    const page = String(reviewPage(reviewData(), ctx('admin')));
    assert.ok(!page.includes('Priya Sharma') && !page.includes('Kabir Rao'));
  });

  test('outside data is escaped, never executed', () => {
    const v = companyData();
    v.company.name = '<script>alert(1)</script> PRIVATE LIMITED';
    const page = String(companyPage(v, ctx()));
    assert.ok(!page.includes('<script>'));
    assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  test('stored keys read as words: sources, run statuses, methods and next actions', () => {
    const company = String(companyPage(companyData(), ctx()));
    assert.match(company, /<span class="what">Startup in UP record<\/span>/);
    assert.match(company, /MCA monthly file, Startup in UP/);
    assert.match(company, /exact name match/);
    assert.match(company, /<p class="next-action">Wait for the rules to be confirmed<\/p>/);
    assert.match(company, /<span class="muted small">today<\/span>|<div class="muted small">today<\/div>/);
    const health = String(healthPage(pipelineData(), ctx()));
    assert.match(health, /<th scope="row" class="nowrap">MCA monthly file<\/th>/);
    assert.match(health, /<th scope="row" class="nowrap">Knowledge-base build<\/th>/);
    assert.match(health, /<span class="badge run-ok">OK<\/span>/);
    assert.match(health, /<span class="badge run-partial">Partial<\/span>/);
  });

  test('facts say their common source once and only exceptions carry their own', () => {
    const page = String(companyPage(companyData(), ctx()));
    assert.match(page, /From MCA monthly file, high confidence, seen 26 Oct 2026, unless noted\./);
    assert.match(page, /<th scope="row">State<\/th><td>UP<span class="prov">UP startup portals · medium · 26 Oct 2026<\/span>/);
    assert.match(page, /<th scope="row">Legal name<\/th><td>VEZRAS TECHNOLOGIES PRIVATE LIMITED<\/td>/);
  });

  test('a shortlisted company shows one badge with its rank', () => {
    const page = String(companyPage(companyData(), ctx()));
    assert.match(page, /<span class="badge stage-shortlisted">Shortlisted · #1 for 2026-10<\/span>/);
    assert.ok(!page.includes('badge soft'), 'no second, identical pill');
  });
});

describe('admin views: shortlist and funnel', () => {
  test('the fit column shows the fit the rank was decided on, and today\'s where it moved', () => {
    const page = String(pipelinePage(pipelineData(), ctx()));
    assert.match(page, /<th scope="col" class="r">Fit at ranking<\/th>/);
    assert.match(page, /<strong>66<\/strong><div class="muted small">now 60<\/div>/);
    assert.match(page, /ranked 26 Oct 2026/);
    const old = pipelineData();
    for (const r of old.shortlist) { delete r.fit_at_rank; delete r.ranked_at; }
    assert.match(String(pipelinePage(old, ctx())), /<th scope="col" class="r">Fit now<\/th>/);
  });

  test('holdout rows are marked, and the shortlist page does not repeat its own heading', () => {
    const page = String(shortlistPage(pipelineData(), ctx()));
    assert.match(page, /<tr class="dim">/);
    assert.match(page, /<h1>Shortlist for 2026-10<\/h1>/);
    assert.ok(!page.includes('<h2 id="shortlist">Shortlist for 2026-10</h2>'));
    assert.match(page, /<h2 id="shortlist">All 2 ranks<\/h2>/);
    assert.match(String(pipelinePage(pipelineData(), ctx())), /<h2 id="shortlist">Shortlist for 2026-10<\/h2>/);
  });

  test('a funnel step nobody has reached draws no bar, and each step shows its conversion', () => {
    const page = String(pipelinePage(pipelineData(), ctx()));
    assert.match(page, /<span class="f-label">Contacted<\/span><span class="f-bar"><span style="width:0\.0%"><\/span><\/span>/);
    assert.match(page, /<small>30%<span class="vh"> of All companies<\/span><\/small>/);
  });

  test('scrollable tables are focusable, named regions', () => {
    const page = String(pipelinePage(pipelineData(), ctx()));
    assert.match(page, /<div class="scroll" role="region" aria-labelledby="cohorts" tabindex="0">/);
    assert.match(page, /<div class="scroll" role="region" aria-labelledby="shortlist" tabindex="0">/);
  });
});

describe('admin views: approvals (Phase 3)', () => {
  const pack = {
    company: { id: 'U62099UP2026PTC300001', name: 'Vezras <b>Tech</b>', legal_form: 'Private Limited Company', incorporated: '2026-10-14', district: 'Lucknow' },
    deadlines: [{ ref: 'D1', title: 'File the declaration for commencement of business', form: 'INC-20A', due: '2027-03-12', status: 'upcoming', law: 'Companies Act 2013 s.10A' }],
    schemes: [{ ref: 'S1', name: 'DPIIT startup recognition', verdict: 'check_required', missing: ['turnover'] }],
    rules: { confirmed: false, version: 't' },
  };
  const message = (status = 'awaiting_approval', extra = {}) => ({
    id: '65f0c0ffee0000000000abcd', company_id: 'U62099UP2026PTC300001', company_name: 'Vezras <b>Tech</b>', kind: 'first_touch', language: 'en', status,
    mailbox: 'mailbox-1', recipient: { address: 'i•••@vezras.in', personal: true },
    draft: { subject: 'Vezras: your next filing dates', body: 'Hello <script>alert(1)</script>\n{{page_url}}', drafter: 'template', model: null, tries: [] },
    qc: { passed: true, checker: 'qc-rules-v1', checks: [{ id: 'facts.dates', ok: true, detail: null }, { id: 'tone.exclamations', ok: false, detail: 'too many' }] },
    evidence: pack, approval: null, gate: null, send: null, history: [{ at, status, by: 'engine', note: 'template draft' }], ...extra,
  });
  const queue = {
    counts: { awaiting_approval: 1, sent: 2 },
    waiting: [{ id: '65f0c0ffee0000000000abcd', company_id: 'U62099UP2026PTC300001', company_name: 'Vezras', kind: 'first_touch', language: 'en', subject: 'S', drafter: 'template', qc_passed: true, rules_confirmed: false, created_at: at }],
    recent: [{ id: '65f0c0ffee0000000000abce', company_id: 'U1', company_name: 'Other', status: 'blocked', subject: 'S2', updated_at: at, gate: { reasons: ['the address is on the suppression list'] } }],
  };

  test('the queue and a message: labels, header scope, the count in the navigation, nothing executed', () => {
    const list = String(approvalsPage(queue, { ...ctx('reviewer'), approvalsWaiting: 1 }));
    const one = String(approvalPage(message(), ctx('reviewer')));
    for (const [name, page] of Object.entries({ list, one })) {
      assert.deepEqual(unlabelledFields(page), [], name);
      assert.deepEqual(headersWithoutScope(page), [], name);
      assert.ok(!/<script>alert/.test(page), `${name}: outside text is escaped`);
    }
    assert.match(list, /aria-current="page">Approvals <span class="count">1<span class="vh"> waiting/);
    assert.match(list, /the address is on the suppression list/);
    assert.match(one, /<label>Subject <input type="text" name="subject"/);
    assert.match(one, /<textarea name="body" required>Hello &lt;script&gt;/);
    assert.match(one, /Rules awaiting a CA/);
    assert.match(one, /a person&#39;s address/);
    assert.match(one, /tone exclamations<div class="small warn-text">too many/);
  });

  test('viewers see the text but no decision controls; a sent message offers to record what came back', () => {
    const viewer = String(approvalPage(message(), ctx('viewer')));
    assert.ok(!viewer.includes('name="decision"'));
    assert.match(viewer, /<pre class="mail">/);
    const sent = String(approvalPage(message('sent'), ctx('reviewer')));
    assert.ok(!sent.includes('name="decision"'), 'a sent message cannot be decided again');
    assert.match(sent, /<legend class="vh">What came back from Vezras &lt;b&gt;Tech&lt;\/b&gt;\?<\/legend>/);
    assert.deepEqual(unlabelledFields(sent), []);
  });
});

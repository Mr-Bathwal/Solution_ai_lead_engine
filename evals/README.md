# Evals: the lead engine against what it promises

The tests (`services/test`, `ingest/tests`) check units: a function, a page, a job. These evals check
outcomes across many cases, the way an outside auditor would: given dozens of companies, does every
email say only what is true and lawful? Given every way a send can go wrong, does the gate stop it?
Does any person's data leave the engine? They print rates, not pass or fail, and a score that looks
bad is kept as it is: the point is to know.

## Running them

From the repository root (any working directory works):

```bash
node evals/run.mjs                                   # all six evals, about 20-30 seconds
ingest/.venv/Scripts/python evals/ingest_matching.py # eval 5 alone (Windows; ingest/.venv/bin/python on the server)
```

`run.mjs` prints the scorecard and the findings and writes `evals/REPORT.md` (for people) and
`evals/report.json` (everything, for machines). It needs `services/node_modules` (`npm install` in
`services/`), a `mongod` (the one the tests use; set `MONGOD_PATH` or `TEST_MONGODB_URI` as for the
tests) and, for eval 5, the ingest virtual environment; without the venv eval 5 is skipped with a note.

- **Exit code:** 0 whatever the scores; 1 only when the harness itself broke (an eval could not run),
  so a bad score never looks like a broken build and a broken build never looks like a good score.
- **Offline, always:** a guard refuses every connection that is not to this machine (fetch, TCP, DNS),
  and every outside service is a fake that records what it was sent. The report says if the guard
  ever had to refuse anything. `loadConfig()` is always given an explicit environment, so the real
  `.env` and its keys are never read. Nothing is sent: the mail transport is a fake.
- **One mongod:** the gate and privacy evals share one throwaway mongod
  (`services/test/helpers/mongod.js`, as the tests use it), emptied between cases and stopped before
  the Python eval starts.
- **How modules are found:** the evals import the engine from `services/src` by file URL; the engine's
  own imports find `mongodb` in `services/node_modules`, and `evals/lib/common.mjs` has a `require`
  rooted at `services/package.json` for anything the evals need from there.

## The six evals

| # | File | What it measures | Why it matters |
|---|---|---|---|
| 1 | `lib/drafts.mjs` | 71 drafts from 37 fictional companies (`fixtures/draft_companies.json`): every sequence step and template (first email, follow-up, new need about a deadline and about a scheme), English and Hindi, with and without schemes, companies and LLPs, a registered address and a website address. Each is graded by this suite's own checker: every date, form code, section number and rupee figure is in the evidence pack, each deadline carries its own date, the company's name is right and no other company's is there, one page link, one unsubscribe link and no other link, the "why you are getting this" line matches where the address came from, opt-out words, no person's name, email or phone, nothing that may not apply, no threat or urgency, and the length limits. | The emails are the only thing a founder sees. A wrong date or a false claim is what the design is built to prevent. |
| 2 | `lib/qc_sensitivity.mjs` | The engine's own known-fault set (`eval:qc`) as it ships, then 24 kinds of mutation applied to every clean draft from eval 1: wrong dates (shifted, US format, swapped), invented or near-miss sections, a cut-short form code, extra links (https and bare domain), a missing unsubscribe, a shouted subject, invented and misattributed amounts, phones in four formats, a personal email, a director's name, another company's name, a removed opt-out sentence, paraphrased threats, urgency and missed-filing claims. A mutation is caught when the QC fails the draft for any reason. | The QC is the line between the AI drafter and a founder. Under sample approval (design 7.5) 80% of drafts that pass it are sent with no person reading them. |
| 3 | `lib/gate.mjs` | 39 cases (`fixtures/gate_cases.json`) run through the engine's real path on a throwaway database: plan, draft with the address check, a person's approval, send job and compliance gate. Suppressed address or domain, opted out, complained, replied, claimed, bounced, holdout, ineligible, outside UP, already contacted, a person's own or a consent-labelled address, the website-address switch, throwaway, no-MX and accept-all domains, text changed after approval, expired, stale facts, rules not confirmed, weekend, outside hours, the UTC/IST day boundary, daily cap, warm-up, a paused mailbox, and cases that must be allowed. | Every promise in "Rules the code keeps" is enforced here or nowhere. |
| 4 | `lib/privacy.mjs` | Canary personal data (`fixtures/canaries.json`) planted where real personal data sits (a director's own registered email, the vendor profile, the portal team, a reply's signature). Every path that calls out runs with a capturing fetch: the LLM gateway's draft, quality_check, match_check and reply_classify tasks, the email verification service, and the platform's onboarding on a direct claim and on a campaign claim with its email confirmation. Each request is searched for the canaries. | The design's first rule: nothing personal to an outside service. Any leak is a top finding. |
| 5 | `ingest_matching.py` | 48 labelled name pairs (`fixtures/name_pairs.json`) through the knowledge base's own matcher (exact, Splink, the link rules at the configured thresholds), scored as precision and recall of automatic links, and the name normalisation alone; 30 search results (`fixtures/website_cases.json`) through `enrich/websites.py`'s search step; and what the web search sends out for a company carrying canary data. | A wrong link puts one company's facts in another's email; a directory taken for a website gives a wrong address. |
| 6 | `lib/docs.mjs` | Every CLI command named in README.md, docs/HANDOVER.md and ops/ exists; every OpenAPI path tagged `engine` is served and every `platform` path has a client; every `.env.example` variable is read and every variable read is documented; every config file referenced exists and parses; the test counts quoted are within 2% (or 5) of the real counts (Node: a static count; Python: `pytest --collect-only`, which runs nothing). | The handover is how the team runs the engine after 25 November. |

## Reading the scores

- **Eval 1** is graded by checks written from the engine's promises (README, templates.js, config),
  not from `qc.js`: its own date reader (four formats, Hindi month spellings, Devanagari digits), whole
  form codes ("INC-20" is not "INC-20A"), canonical section numbers and rupee values. The engine's own
  QC verdict on each draft is shown beside it for comparison only. Read the per-check table: a check
  failed by every draft usually has one cause (the report names it).
- **Eval 2** reports two numbers on purpose. `eval:qc` measures the faults the QC was built for (and
  should be 100%); this suite's mutations measure faults it was not told about. A mutation "caught by
  facts.numbers" for a phone number is caught for the wrong reason: change the digits to ones that
  appear in the pack and it passes.
- **Eval 3** compares the outcome with a list of acceptable outcomes (a suppressed address may be
  stopped at the gate or never drafted; it must never be sent). "Agrees" is the rate; every
  disagreement is listed with the gate's own reason and the trail of what happened.
- **Eval 4** is a table of path, service and which canaries were in the request. What a founder types
  on the claim form reaching the platform's sign-up is the purpose of claiming, not a leak; the
  canaries are the data the founder did not hand over.
- **Eval 5:** precision is of automatic links only (a pair sent to a person's review queue is neither
  right nor wrong); recall counts only automatic links, with "linked or sent to review" beside it.
  The company universe is small, so Splink's fitted prior and probabilities are indicative of
  production, not equal to it; precision is the number the design targets (95%).
- **Findings** are generated from what the run observed, ranked High, Medium-high, Medium, Low, each
  with the file and line responsible (looked up in the current source, so they stay right as files
  change). Fix the code and the finding disappears on the next run.

## Adding a case

Each table is plain JSON in `fixtures/`; the format is described in its `_comment`. All data must be
fictional: invented names, `.example` domains, numbers like 98765 43210. A new gate case needs only a
line in `gate_cases.json`; a new mutation is one entry in `MUTATIONS` (`lib/qc_sensitivity.mjs`); a
new name pair is one entry in `name_pairs.json`. Do not tune a case until the engine passes it: a case
is right when it describes what the engine promises.

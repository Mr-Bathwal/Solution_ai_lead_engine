# SolutionAI Lead Engine

This engine finds every new company in Uttar Pradesh as it is registered. It works out what each one needs and when, and reaches out with something useful: a company's own deadlines and the schemes it may qualify for, with consent and the law built in from the first line of code.

- **Design:** `design/SolutionAI_Lead_Engine_Architecture_v1.1.pdf`
- **Build:** one month, 26 October – 25 November 2026, in four weekly phases.

| Phase | Dates | Status |
|---|---|---|
| 1. Set-up and data | 26 Oct – 1 Nov | **Code done, reviewed and tested** (18 defects found in review and fixed). Owner actions in `ops/WEEK1_ACTIONS.md` |
| 2. Knowledge base and need engine | 2 – 8 Nov | **Code done and tested on the real data.** A second, seven-reviewer review of Phases 1 and 2 followed, and its findings are fixed. Report in `docs/WEEK2_REPORT.md`, owner actions in `ops/WEEK2_ACTIONS.md` |
| 3. Outreach and the company page | 9 – 15 Nov | **Code done and tested** (built 1 Nov). Nothing reaches a founder before the CA's sign-off, the end of the warm-up (18 Nov) and the owner actions. Report in `docs/WEEK3_REPORT.md`, owner actions in `ops/WEEK3_ACTIONS.md` |
| 4. Voice, attribution and launch | 16 – 25 Nov | **Code done and tested** (built 2 Nov). Voice stays switched off until the DLT number and the script sign-off. Report in `docs/WEEK4_REPORT.md`, owner actions in `ops/WEEK4_ACTIONS.md`, the runbook and walkthrough in `docs/HANDOVER.md`, the lawyer's pack in `docs/legal/`, the server kit in `ops/deploy/`. 535 tests pass (261 Node, 274 Python) |

**Not in the public repository:** the architecture documents (`design/`, marked internal), the lawyer's review pack (`docs/legal/`, `ops/legal/`), the data (`data/`), secrets (`.env`), founder interview notes, and the Week 2 screenshots, which show real companies. The code, schema, configuration, tests, runbooks and reports are all here. Every push runs both test suites (`.github/workflows/ci.yml`).

**How well it works:** `node evals/run.mjs` (15 seconds, offline) scores the engine as an outside auditor would: drafts traced to their evidence, the quality check against deliberately broken drafts, the compliance gate on hard cases, planted personal data that must never leave, matching on hard name pairs, and docs against code (`evals/REPORT.md`). `docs/REFLECTION.md` says plainly what has been shown and what has not.

## Layout

```
schema/collections.json   every MongoDB collection: validator and indexes (one file, used by both languages)
config/caps.json          hard monthly and daily caps, warm-up ramp, contact budget and crawl limits (every cap,
                          voice included, is enforced in code)
config/outreach.json      what a message may say and when: evidence windows, quality rules, send days, reminders
config/llm.json           the LLM gateway tasks, models and prices
config/whatsapp_templates.json  the WhatsApp utility templates, in the shape Meta takes them
config/voice.json         the call-back agent: on or off, calling hours inside TRAI's, the signed-off script
config/monitor.json       alert thresholds and the fixed monthly costs
config/rules/             the deadline calendar and the provisional scheme rules, as data, each with its law and source
config/fit.json           the fit score's weights and the eligibility rules
ingest/                   Python. Collectors -> raw store -> source_records; the knowledge base (kb/),
                          enrichment (enrich/), the need engine (need/), the extraction test set and Parquet exports
services/                 Node.js. Database set-up, job table and worker, consent ledger, suppression list,
                          outreach (outreach/: budget, evidence, drafting, quality check, gate, email, WhatsApp,
                          reminders), the mailbox reader (inbound/), call backs (voice/), attribution, monitoring,
                          MCP tools, erasure, the test-set runners (eval/), Admin pages and API (admin/), the
                          founders' company pages (public/)
docs/                     phase reports, the handover, the contracts with the platform team, and the legal review pack
                          (docs/legal/, rebuilt from the code by ops/legal/)
ops/                      what people do: weekly actions, email DNS check, warm-up plan, founder interviews, schedule
design/  research/        the architecture document and the research behind it
data/                     local raw store, logs and exports (S3 in production; not committed); data/testsets/ holds the
                          reply, extraction and labelling test sets
```

## What Week 1 delivers

**A database that enforces the rules itself.** `schema/collections.json` gives every collection (the nine of design section 7.8, the run log, and those added in Phase 2) a validator that MongoDB checks on every write:

- a company outside UP, a malformed CIN, or an attribute without a source and date is refused;
- a source record with a legal basis other than "published under law", "published by the company" or "public statistics" is refused;
- the application role can only **find and insert** on `consents`, `activities`, `source_records` and `audit_log`.

**A job table instead of a queue.** It lives in `services/src/jobs/`:

- jobs are claimed atomically, with no Redis;
- each job has an idempotency key, so enqueueing the same step twice creates one job;
- a crashed worker's job comes back when its lock expires;
- fencing tokens stop a slow worker from overwriting a newer attempt;
- retries use exponential backoff with jitter, and a job is marked dead after its last attempt;
- a heartbeat keeps long steps locked, and a worker that cannot reach the database stops its step before the lock runs out; lock times come from the database server's clock, not each machine's;
- a step that hangs is aborted after 15 minutes, and a running job can be cancelled;
- shutdown is graceful: jobs in hand get 30 seconds, then are aborted and retried.

**A tamper-evident consent ledger** in `services/src/consent/`:

- entries are append-only, and each carries the hash of the previous one, so `ledger:verify` detects any edit, reordering or deletion inside the chain;
- every day `ledger:anchor` copies the chain's head to a file outside the database, so a ledger cut short, or rewritten with every hash recomputed, is caught too;
- writers on several machines take turns (a transaction on a replica set), so the chain never forks under load;
- each entry stores the exact wording the person saw;
- an erasure request blanks the address without breaking the chain, because the hash covers only the address's key.

**One suppression list for every channel** in `services/src/suppression/`:

- entries are keyed by a keyed hash (HMAC, with a secret kept outside the database) of the normalised email, phone (E.164) or domain, so a stored key cannot be reversed by trying every phone number;
- a domain entry blocks every address at that domain and its subdomains; `name+tag@` and Gmail's dotted spellings count as the same address;
- an erasure request blanks the stored address and note and keeps only the key, even on an entry that already existed;
- an address that cannot be read counts as blocked, never as "not on the list";
- the application cannot delete an entry: lifting a suppression is an admin's job, by hand;
- one query checks a whole batch.

**Polite ingestion** in `ingest/`:

- every request checks robots.txt first, with the stricter reading set out in `ingest/src/leadengine/net/robots.py`;
- only public addresses are fetched: a redirect into a private or cloud-metadata address is refused, and hosts on the never-crawl list (the Startup India API) are refused whatever their robots.txt says;
- the crawler identifies itself honestly, waits at least 2 seconds between requests to a host (longer if the site sets a Crawl-delay), retries with backoff, and stops at a per-run request budget that counts robots.txt fetches too;
- raw pages are stored by URL and content hash, with email addresses and phone numbers removed first, and only real changes become new record versions.

**Five sources:**

| Source | What it gives | Key |
|---|---|---|
| MCA monthly report (manual download) | every UP company registered in the month | CIN |
| Startup in UP | recognised startup profiles | UPLC number |
| UP Startup Mission | the district directory (only allow-listed, company-level fields are stored) | UPLC number |
| Startup India (DPIIT) | Not crawled: the API's robots.txt forbids all automated access, and the host is on the never-crawl list in `config/caps.json`. Re-enabling it is a deliberate edit there. | — |
| Incubators | recognised UP incubators, their portfolios, SISFS incubators in UP | name and host |

**Data loaded (development database, after the live refresh of 26 October):**

- 12,713 UP companies registered May–September 2026;
- 4,001 distinct UP startups from the two portals, 2,338 of which appear on both and join exactly on their UPLC number;
- 88 incubators with 2,917 incubator-to-startup links;
- 12 SISFS incubators in UP.

Details and the live-run results are in `docs/WEEK1_REPORT.md`.

## What Week 2 delivers

**One record per company** (`ingest/src/leadengine/kb/`). The portal startups (3,965 once duplicate cards are dropped) carry no CIN. The engine finds which company each one is:
- exactly, on the registered name, which MCA keeps unique;
- with Splink for misspellings, linking only when the year agrees and every distinctive word is accounted for;
- with a person in the Admin review queue for the rest.

UP LLPs are found from the LLP sheet of the MCA files already held. On the real data:
- 152 startups are linked, all on the exact registered name (21 of them UP LLPs);
- 13 wait for review;
- 3,800 have no CIN in our data yet: 77 are partnerships, which have none, and most of the rest are older companies, which the MCA back files or the vendor's free name search will find.

Two tests measure the matcher without labels, and both find 0 wrong links. A misspelling self-test runs 718 misspelt names, then again with the true company removed. A leave-one-out test asks whether 4,000 real company names, each with its own company removed, get linked to a sibling with a similar name. Precision comes first: a changed generic word or an added "India" always goes to a person, because MCA registers such names as different companies.

**The need engine** (`ingest/src/leadengine/need/`):
- a first-year deadline calendar (18 obligations, each with its law and penalty);
- scheme verdicts (the platform's rules engine when connected, provisional rules until then);
- a fit score explained point by point, reusing the UP Startup Atlas classifier;
- a holdout group drawn by keyed hash;
- the month's top-200 shortlist.

Nothing is used in a message until a CA confirms the rules.

**Enrichment** (`ingest/src/leadengine/enrich/`), cheapest first:
1. free portal facts;
2. the vendor's free daily lookups and name searches;
3. ₹5 full profiles for the shortlisted 200 only.

Every call sits under a hard cap and every answer is cached.

**The contact budget** (`services/src/outreach/budget.js`): one first email and one follow-up within 21 days, then only new needs, nothing during mailbox warm-up, only inside the send window, and a mailbox pauses itself if its bounces or complaints rise. A send reserves its place first, so ten senders racing for the last place in a mailbox's day get one place between them, and only one message to a company is ever in progress.

**Admin pages and API** (`services/src/admin/`): pipeline, shortlist, company view, review queue and data health, with roles, masked personal data and an audit log.

## What Week 3 delivers

**A sequence for each shortlisted company** (`services/src/outreach/`), on the job table. Every day:
- a first email is drafted for each shortlisted company whose registered email is known;
- a follow-up is drafted seven days after a first email with no reply.

Each draft is written only from the company's **evidence pack**: its next firm deadlines and the schemes it may qualify for, each with its law. The **AI drafter** (the platform's LLM gateway, once it has a key) or the **reviewed templates** in English or Hindi write it.

**A quality check** of 18 rules in code. Every date, number and form name must come from the evidence pack. Also checked:
- one page link and one unsubscribe link;
- no urgency, threats or claims that a filing was missed;
- no personal contact details.

**A person approves every email** in the Admin approval queue, beside its evidence and checks. An edit is checked again before it can be approved.

**A compliance gate** at the moment of sending:
- the approved text, unchanged;
- the rules confirmed by a CA;
- the recipient's legal basis;
- the suppression list;
- the contact budget, the warm-up, the send window (weekdays, 10:00–17:30 IST) and the daily caps.

It answers send, wait (without using up a retry) or stop.

**Email**: plain text, one-click unsubscribe headers, and a small SMTP client for the Zoho mailboxes, or the outbox, which writes files and sends nothing. Sending happens at most once. A refused address is suppressed and counted as a hard bounce at once, and mailboxes pause themselves when bounces or complaints rise.

**The company page** (`services/src/public/`, served by `node src/cli.js pages`): each email links to the company's own page, with its dates and schemes once the rules are confirmed. A founder can claim the page and choose what to hear about; each choice is written to the consent ledger with the exact words shown. They are then handed to the platform's sign-up. Unsubscribing takes one click and stops everything at once.

**WhatsApp and reminders**: four utility templates ready for Meta, and the Cloud API client, which sends only templates Meta has approved. Reminders go 7 days and 1 day before each confirmed deadline, only to founders who asked, inside 09:00–21:00 IST and the month's cap.

## What Week 4 delivers

**Replies come back.** `inbox:read` reads the outreach mailboxes every ten minutes, read-only (`services/src/inbound/`). Each email is matched to the email it answers, then:
- a bounce suppresses the address and counts against the mailbox at once;
- a complaint stops everything for that company;
- an out-of-office changes nothing;
- a reply ends cold outreach to the company and waits in the Admin **Inbox**, classified (interested, question, not now, opt-out, wrong address) by rules in English, Hindi and Hinglish, with the small AI model only when the rules are unsure. Only a clear opt-out or a clear wrong address acts by itself.

**New-need messages**: when a deadline or scheme that no email mentioned starts to apply, one message about it, at most once and 30 days after the last.

**Call backs** (`services/src/voice/`):
- A founder can tick "call me back" on the claim form, with a time of day and a language.
- Sarvam's voice agent calls only then, from a DLT-registered number, inside TRAI's hours and the month's caps, with a signed-off opening that says it is an AI and offers a person.
- Until the agent is live, the Admin **Calls** page lists the calls for a person to make.

**Attribution and results.** The platform sends signed sign-ups, service requests and payments (`/api/events`), each linked to its lead. The **Results** page shows:
- the month's shortlist against its holdout, with an honest interval;
- the cost per shortlisted company, per engaged company and per paying client;
- the health of each channel.

**Monitoring.** Hourly alert checks, a CloudWatch metric line, and a daily summary email to the team.

**MCP tools**: `search_leads`, `company_profile` and `deadline_calendar`, for Mr. AI and the team. They are read-only and company-level, and never return a holdout company in search.

**Erasure and retention.** `lead-engine erase` removes a person everywhere and keeps only a keyed hash, so they are never contacted again. `leadengine privacy retention` deletes bought data on companies never contacted after 12 months.

**Every promise kept in code**: STOP on WhatsApp (Meta's webhook), scheme alerts for founders who asked, and taking someone off the list when they ask (`lead-engine unsuppress`).

**The four test sets**, re-run after any change:
- matching, from Phase 2;
- 200 extraction pages;
- 7,080 broken drafts for the quality check;
- 161 labelled replies, plus the real ones people label in the inbox.

**Parquet exports** for DuckDB, nightly, with no personal data.

## Running it

Requirements: Python 3.11+, Node.js 20+, MongoDB 6+ (8.0 tested). Copy `.env.example` to `.env` and fill it in; both the Node services and the Python side read it (secrets included, so a cron line needs nothing extra). On a development laptop set `LEADENGINE_ENV=development`; in production set `HOLDOUT_SALT` and `CONTACT_KEY_SECRET` once and never change them.

The Python commands below use the virtual environment's interpreter directly: `.venv/Scripts/python` on Windows, `.venv/bin/python` on the server.

```bash
# settings: copy .env.example to .env and fill it in. On a laptop, LEADENGINE_ENV=development and any
# 32+ character CONTACT_KEY_SECRET will do; production values are set once (ops/WEEK2_ACTIONS.md, item 2)
cp .env.example .env

# database (once, and after any schema change)
cd services && npm install && npm run migrate

# ingestion
cd ../ingest && python -m venv .venv && .venv/Scripts/pip install -e ".[dev]"   # or: uv pip install -e ".[dev]"
.venv/Scripts/python -m leadengine ingest mca ../data/mca/Incorporation-Report-20261105.xlsx
.venv/Scripts/python -m leadengine ingest startinup --details new
.venv/Scripts/python -m leadengine ingest upsm
.venv/Scripts/python -m leadengine ingest incubators
.venv/Scripts/python -m leadengine status

# knowledge base, enrichment and need engine (all three run nightly: `leadengine nightly`)
.venv/Scripts/python -m leadengine kb build
.venv/Scripts/python -m leadengine kb eval
.venv/Scripts/python -m leadengine enrich plan --month 2026-11
.venv/Scripts/python -m leadengine need run --month 2026-11

# Admin pages (sign-ins made with `node src/cli.js admin:user <email> <role>`)
cd ../services && node src/cli.js admin        # http://127.0.0.1:8790/admin

# outreach (Phase 3): plan the day's drafts and reminders, run the worker, serve the company pages
node src/cli.js outreach:plan                  # drafts appear in /admin/approvals
node src/cli.js reminders:plan
node src/cli.js worker                         # OUTREACH_TRANSPORT=outbox (the default) sends nothing
node src/cli.js pages                          # http://127.0.0.1:8791/c/<token>

# Phase 4: the mailboxes, monitoring, results, MCP, erasure and the test sets
node src/cli.js inbox:read                     # replies appear in /admin/inbox
node src/cli.js monitor
node src/cli.js summary                        # --send mails it to SUMMARY_TO
node src/cli.js results --month 2026-11
node src/cli.js mcp                            # MCP on stdin/stdout
node src/cli.js erase email <address> --by <admin email>
node src/cli.js eval:qc && node src/cli.js eval:replies
LEAD_DB=solutionai_leads_staging node src/cli.js staging:seed --email <our address>   # the end-to-end run on staging
node src/cli.js preflight --live               # the go/no-go check before real sending
node src/cli.js platform:check                 # the platform's endpoints against docs/platform-openapi.yaml
node src/cli.js whatsapp:templates --submit    # send Meta the templates, once verification is through
node src/cli.js demo:seed && node src/cli.js demo:serve   # the walkthrough on fictional data (<LEAD_DB>_demo)
node src/cli.js backup [--critical]           # cron does this nightly and hourly; restore <folder> --into <new db>
node src/cli.js approval:agreement            # whether the quality check agrees with the reviewers enough for sample approval
node src/cli.js verify:email <address>        # the check a first email's address gets
node src/cli.js kb:ai-check                   # the AI model's advice on unsure matches (needs the LLM gateway)
node src/cli.js admin:service portal reviewer   # a service token for the platform's portal (or admin:platform-headers)
cd ../ingest && .venv/Scripts/python -m leadengine ingest inbox   # load an uploaded MCA file now (the nightly does it at 05:00)
.venv/Scripts/python -m leadengine enrich websites   # shortlisted companies' websites and the role address each publishes (nightly)
.venv/Scripts/python -m leadengine ingest news --dry-run   # funding news matched to UP companies, for a person to confirm (daily, 07:15)
cd ../services
cd ../ingest && .venv/Scripts/python -m leadengine eval extraction && .venv/Scripts/python -m leadengine export parquet

# tests (each suite starts its own throwaway mongod; set TEST_MONGODB_URI to use another server)
cd ../services && npm test
cd ../ingest && .venv/Scripts/python -m pytest
```

The database tests skip themselves when no `mongod` is installed, and a few Python tests read the October 2026 crawl caches and MCA files from `~/Downloads` and skip when those are absent, so the full count is only reached on a machine that has them.

The server schedule (weekly and monthly runs, the worker as a service) is in `ops/SCHEDULE.md`.

## Rules the code keeps

- **UP only.** The database refuses companies from any other state.
- **Company-level data.** Only allow-listed fields of API rows are stored, and email addresses and phone numbers are removed from every page before it reaches the raw store. Founder names published on Startup in UP profiles, and the names left on stored pages, are kept only as flagged personal data, so retention and erasure can find them. Pages stored before this rule existed are found with `leadengine privacy redact-raw` and cleaned with `--apply`.
- **No LinkedIn, no bought director contact lists, no logins, no CAPTCHA handling.** The ₹5 vendor profile carries directors' names and DINs as filed with MCA, never their contact details.
- **Consent before WhatsApp and calls.** A WhatsApp message or a call goes only to a number whose owner agreed on the company page, and the consent is checked again at the moment of sending. A call says at once that it is an AI and offers a person; "stop" on a call withdraws the consent.
- **Mailboxes are only read, never changed,** and only an opt-out or a wrong address acts without a person. The engine never writes back to a reply.
- **A person approves every email**, and a compliance gate in code checks it again at the moment of sending. Sending happens at most once, and one click unsubscribes for good.
- **Never the holdout group.** 10% of companies are drawn by keyed hash and never contacted, so the engine's real effect can be measured.
- **No rule reaches a founder unconfirmed.** Deadline and scheme rules carry `confirmed_by`; until a CA fills it in, they are shown in the Admin pages only.
- **Personal data is hidden by default.** Only an admin can reveal it in the Admin pages; a reply's text and a call's transcript only to reviewers and admins. Every reveal is logged, and replies and calls are removed after 400 days.
- **Erasure means everywhere.** One command removes a person from contacts, consents, messages, replies and calls; only a keyed hash stays, so they are never contacted again.

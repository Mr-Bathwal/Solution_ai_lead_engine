# Phase 2: what needs a person (2 – 8 November)

The code for Phase 2 is built, reviewed twice and tested (`docs/WEEK2_REPORT.md`). These items need a person, a vendor or a decision. None of them blocks the nightly run; each one makes the results more complete. The Week 1 actions continue: warm-up from 28 October, Meta, DLT, and the October MCA file on 1–5 November.

| # | Action | Who | By | Cost | Done when |
|---|---|---|---|---|---|
| 1 | Get a free sandbox key from the MCA data vendor and run the probe | Gourav | Mon 2 Nov | free | `leadengine enrich probe <CIN>` prints a company |
| 2 | Generate the production secrets, once | Gourav with Murari's team | before the first production nightly | free | `HOLDOUT_SALT` and `CONTACT_KEY_SECRET` are in the server's secrets, and `LEDGER_ANCHOR_FILE` points at append-only storage |
| 3 | A partner CA reviews the deadline and scheme rules | Sujas asks a partner CA; Gourav sends the files | Thu 12 Nov | about an hour of the CA's time | `confirmed_by` and `confirmed_on` are filled in both rule files |
| 4 | Download the MCA monthly back files | a team member | Fri 6 Nov | free | the files are in `data/mca/` and loaded |
| 5 | Label the matcher's pairs | Gourav and one reviewer | Sat 7 Nov | about an hour | `leadengine kb eval` shows a precision figure |
| 6 | Create Admin sign-ins | Gourav | Mon 2 Nov | free | each person can open `/admin` |
| 7 | Platform: rules-engine endpoint and Admin sign-in | Murari's team | Mon 9 Nov | — | agreed shape in `docs/PLATFORM_CONTRACTS.md` |
| 8 | ~~Decide whether the shortlist should lean less to technology~~ | Gourav | **done 1 Nov** | free | no sector theme takes more than 40% of the shortlist (`shortlist_theme_cap_pct` in `config/fit.json`) |
| 9 | Apply the upgraded schema and role wherever the engine's database already exists | Murari's team | with the first deployment | free | `npm run migrate` reports nothing to create; the role has no remove on `suppressions` |
| 10 | ~~Clean the raw pages stored before the second review~~ | Gourav | **done 1 Nov** | free | 867 pages cleaned; `leadengine privacy redact-raw` reports 0 |
| 11 | ~~Decide how strict the complaint pause is~~ | Gourav | **done 1 Nov** | free | kept at 0.1% (`config/caps.json`) |

## 1. Vendor sandbox key

The engine uses one MCA data vendor (Infyner):

| Call | Price |
|---|---|
| Company lookup | free, up to 500 a day |
| Name search | free, up to 500 a day |
| Full profile | about ₹5, and only for the month's 200 shortlisted companies |

1. Sign up at infyner.com and create a **sandbox** key (`pk_test_...`). It is free.
2. Put it in `.env` as `INFYNER_API_KEY=pk_test_...` (the engine reads `.env` itself, in a shell and under cron alike).
3. From `ingest/`, run `.venv/Scripts/python -m leadengine enrich probe U62099UP2026PTC254264 --op lookup`, then the same with `--op profile`, and `enrich probe "VEZRAS TECHNOLOGIES" --op search`; send the output to Gourav. The vendor publishes its paths but not its response fields, so one call per operation confirms how the adapter reads them. A sandbox key's answers are cached apart and never written onto company records.
4. When the probe looks right, buy the smallest credit pack. About ₹1,000 a month covers 200 full profiles. Then switch to the live key (`pk_live_...`).

The caps in `config/caps.json` (500 lookups a day, 200 profiles a month) stop the engine from spending past the budget, whatever happens.

## 2. Production secrets

Three values are set **once**, before the first nightly run on the production database, and never changed. Store them in the server's secrets (AWS Parameter Store, written into the server's `.env`), never in the repository or the database.

| Secret | What it does | Make it with |
|---|---|---|
| `HOLDOUT_SALT` | Decides which 10% of companies are never contacted, so we can measure what the engine really adds. Changing it would redraw the holdout. | `python -c "import secrets; print(secrets.token_urlsafe(32))"` |
| `CONTACT_KEY_SECRET` | The key behind every suppression entry and consent record's contact key, so a copy of the database cannot be turned back into phone numbers. Changing it needs a re-keying migration. | `openssl rand -hex 32` |
| `LEDGER_ANCHOR_FILE` | A file on append-only storage (an object-locked S3 bucket mounted on the server, or a `chattr +a` file) where the daily `ledger:anchor` copies the consent ledger's head. | a path, agreed with Murari's team |

Without `HOLDOUT_SALT` the need engine refuses to run, and without `CONTACT_KEY_SECRET` the consent ledger and suppression list refuse to start; neither falls back to a default. The development database used development values; production starts clean.

## 3. CA review of the rules

Send these two files to a partner CA, with the Week 2 report's sections on deadlines and schemes:

- `config/rules/deadlines.json`: 18 first-year obligations for private companies, OPCs and LLPs, each with its section of law and its penalty;
- `config/rules/schemes.json`: eight scheme rules, and why each gives "check required", "not eligible" or "closed".

Ask the CA to correct anything wrong, especially:
- the OPC dates;
- directors' KYC, now triennial;
- the first income-tax year of a company incorporated between January and March.

When the CA is satisfied, set `confirmed_by` (the CA's name and membership number) and `confirmed_on` in both files. Until then, the engine computes everything but uses none of it in a message.

## 4. MCA monthly back files

The matcher can only link a portal startup to a company it holds. Today that means companies incorporated from May to September 2026, while most portal startups were incorporated between 2018 and 2025. MCA publishes the same monthly file for every month back to 2016.

1. In a normal browser, open mca.gov.in → Data and Reports → Company/LLP Info → "Incorporated / Closed during the month". The site blocks scripts, so this has to be done by hand.
2. Download "Companies and LLPs registered in …" for **November 2023 to April 2026** (30 files). With the five months already loaded, that covers about half the portal startups, going by the year founders give. If there is time, go back to October 2016 (about 120 files in all), which covers about 96% of them and every company still young enough to be a startup. The full set adds roughly 290,000 UP companies: they become leads but are never shortlisted, the free lookups reach the older ones only after months, and the nightly run takes longer, so the 30 files to November 2023 are the better first step.
3. Save the files in `data/mca/` and run:

```bash
cd ingest
.venv/Scripts/python -m leadengine ingest mca ../data/mca/*.xlsx
.venv/Scripts/python -m leadengine nightly
```

The nightly run links every startup whose registered name now has a match, and reads the files' LLP sheets for UP LLPs. The older companies become leads but are never shortlisted, because the shortlist takes only the latest cohort. The free vendor lookups go to the newest companies first.

## 5. Labelling

The design's target is matching precision of at least 95%, measured on pairs labelled by people.

1. Open `data/labels/match-pairs-2026-10-27.csv` (190 pairs, re-exported after the second review: all 152 links the matcher made, 22 candidate pairs for the 13 startups it was unsure about, and 16 near-misses).
2. In the `label` column write `same`, `different` or `unsure`. Use the MCA name, the incorporation date and the portal entry; a quick web search of the company settles most doubts.
3. Import the file:

```bash
.venv/Scripts/python -m leadengine kb import-labels ../data/labels/match-pairs-2026-10-27.csv --by you@solutionai.in
.venv/Scripts/python -m leadengine kb eval
```

Decisions made in the Admin review queue count as labels too. An import never overwrites a reviewer's decision (a clash is counted and shown), and each import is written to the audit log. Precision is measured on the matcher's own decisions, so it stays measurable after later rebuilds; one labelled startup in five is held out of training, so the figure is honest. The 190 pairs give a first figure; the design's 300–500 come as the review queue is decided and later months are labelled.

## 6. Admin sign-ins

```bash
cd services
node src/cli.js admin:user you@solutionai.in admin
node src/cli.js admin:user reviewer@solutionai.in reviewer
```

1. Each command prints a token, once. Give it to the person privately.
2. Add the printed entries to `ADMIN_USERS` in `.env`, separated by `;`.
3. Set `ADMIN_SESSION_SECRET` to 32 or more random characters.
4. Start the pages with `node src/cli.js admin` and open http://127.0.0.1:8790/admin.

| Role | Can |
|---|---|
| viewer | see everything except personal data |
| reviewer | also decide matches |
| admin | also reveal personal data; every reveal is logged |

## 9. Schema and role upgrade

The second review added two collections (`revoked_sessions` and `locks`), new indexes (among them the one that lets only one nightly run at a time) and a stricter application role. Wherever the engine's database already exists:

```bash
cd services
npm run migrate
npm run migrate -- --role
```

On MongoDB Atlas the second command prints the role as JSON in the Atlas Admin API's format; apply it to the `leadEngineApp` custom role by hand. Sign-in sessions made before the upgrade no longer work, so everyone signs in to the Admin pages once more.

## 10. Raw pages stored before the review

From the second review on, email addresses and phone numbers are removed from a page before it is stored. The 3,936 pages stored before that were not. A dry run found 867 that hold 2,097 addresses or numbers: on 690 Startup in UP pages it is the portal's own helpline and `info@` address in the footer; on 175 incubator portfolio pages it is incubators' named representatives; 2 are incubator profiles.

```bash
cd ingest
.venv/Scripts/python -m leadengine privacy redact-raw            # report only
.venv/Scripts/python -m leadengine privacy redact-raw --apply    # rewrite those pages in place
```

`--apply` rewrites the files in place and cannot be undone. Nothing the engine uses is lost: the company records were built from the parsed fields, not from these addresses.

**Done on 1 November.** 867 pages cleaned (2,097 addresses and numbers removed); a second check finds 0, and every cleaned page still parses.

## 11. Complaint pause

A mailbox pauses itself while its spam complaints over the last 30 days pass 0.1% of its sends, never dividing by fewer than 50 sends. At warm-up volume that means a single complaint pauses the mailbox. That is the safe default for a new domain, and Google's own guidance treats 0.1% as the level to stay under. **Decided on 1 November: keep it.** If it proves too strict in practice, the threshold can be changed in `config/caps.json`.

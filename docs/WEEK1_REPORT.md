# Phase 1 report: set-up and data

**Period:** 26 October – 1 November 2026. **Prepared by:** Gourav Bathwal. **Status:** code complete and tested. Owner actions are under way (`ops/WEEK1_ACTIONS.md`).

## What was planned

From the design document, section 12, Phase 1 covers:

- the outreach domain and mailboxes, with warm-up started;
- Meta verification and DLT registration;
- the new MongoDB database with the consent ledger, suppression list and job table;
- ingestion from MCA, Startup India, Startup in UP and incubators;
- the October MCA file loaded;
- the first founder conversations.

## What was built

| Item | Where | Tests |
|---|---|---|
| Ten collections with database-enforced validators and 35 indexes, from one shared schema file | `schema/collections.json`, `services/src/db/migrate.js` | 5 |
| Application role: insert-only on consent, activity and source records | `services/src/db/migrate.js`, `ops/mongodb-access.md` | 1 |
| Job table and worker: atomic claim, idempotency keys, lock expiry and recovery, fencing tokens, backoff with jitter, heartbeat, graceful stop | `services/src/jobs/` | 14 |
| Consent ledger: append-only, hash-chained, exact wording stored, erasure without breaking the chain | `services/src/consent/ledger.js` | 8 |
| Suppression list: one list for all channels, hashed keys, domain-wide blocks, batch check | `services/src/suppression/list.js` | 9 |
| Polite fetcher: robots.txt (strict reading), per-host gap and Crawl-delay, honest user agent, retries, request budget | `ingest/src/leadengine/net/` | 18 |
| Raw store keyed by URL and content hash (local folder or S3) | `ingest/src/leadengine/rawstore.py` | 3 |
| Sources: MCA monthly report, Startup in UP, UP Startup Mission, Startup India, incubators | `ingest/src/leadengine/sources/` | 12 |
| Writer: insert-only source records with versioning, company records with per-attribute provenance, run log | `ingest/src/leadengine/sink.py`, `pipeline.py` | 5 |
| Indian identifiers and company-name cleaning | `ingest/src/leadengine/ids.py`, `names.py` | 6 |

**81 automated tests (37 Node.js, 44 Python), all passing.** They run against a real MongoDB 8.0 that each suite starts and throws away.

> **Update, 27 October.** A line-by-line review before Phase 2 found 18 defects in this code. Among them, robots.txt rules were matched first-match rather than longest-match, redirects were not re-checked, and the job worker could crash on a database error. All 18 are fixed and tested; see `docs/WEEK2_REPORT.md`, Part 1. LLPs are no longer only counted: the UP ones are found from the portals (Phase 2).
>
> **Update, 31 October.** A second, seven-reviewer audit of everything built so far is in `docs/WEEK2_REPORT.md`, Part 3. Two plans below were superseded in Phase 2: UP LLPs are found by the knowledge base from the portals and the MCA LLP sheets, not by the basic lookup; and there is no AI check on unsure matches yet (a person decides them in the Admin review queue).

## Data loaded

The first load came from the UP Startup Atlas files and crawl caches (1–8 October). Nothing that was already fetched had to be fetched again.

| Source | Records | Check |
|---|---|---|
| MCA, UP companies registered May–Sep 2026 | **12,713** (2,638 / 2,189 / 2,829 / 2,381 / 2,676) | Identical to the Atlas count. For the September file, the engine's set of CINs equals the Atlas set exactly (automated test). |
| Startup in UP profiles | **2,318** (2,282 with a full profile) | |
| UP Startup Mission directory | **3,944** | Identical to the Atlas count |
| Startups on both portals | **2,280** join exactly on the UPLC number | 98% of Startup in UP startups |
| Distinct UP startups across both portals | **3,982** | |
| Recognised UP incubators | **88**, with **2,779** incubator–startup links | Every linked startup is found in the directories |
| SISFS incubators in UP | **12** | |

UP registers about 2,200–2,800 companies a month. The engine splits them by registrar: ROC Uttar Pradesh-I (the former Kanpur office) and ROC Uttar Pradesh-II, created on 16 February 2026.

## Problems found by testing, and fixed

1. **Startup IDs with 9 digits.** Newer Startup in UP profiles pad the application number to 9 digits (`UPLC_000010082`), and the first version read only 8. Different startups would have merged into one record. Numbers are now compared by value, and a test checks that 40 real profiles all get distinct, correct keys.
2. **Incubators that share a name.** STPI runs incubators in several UP cities under the same name, and they collapsed into one record. Incubators are now keyed on name plus host institution, with a test.
3. **Excel date cells.** Some MCA files store dates as Excel dates rather than text. Both forms are now read.
4. **One slow page could lose a whole run.** The Startup in UP crawler kept every page in memory until the end. It now stores and processes each page as it arrives. Both portal crawlers skip a page that fails instead of stopping (tested).
5. **DNS lookups blocked on some networks.** The email DNS checker now falls back to the system resolver when DNS-over-HTTPS is blocked.

## Live run on the portals (26 October)

The full weekly refresh ran live against the portals on 26 October, using the engine's own polite crawler: robots.txt checked, at least 2 seconds between requests, honest user agent.

| Source | Result | Detail |
|---|---|---|
| Startup in UP | **OK** in 28 min | 237 directory pages and 2,368 cards. **57 startups new since 8 October**; their profiles were fetched and stored. 16 dropped connections, all recovered by retries. |
| UP Startup Mission | **Partial** in 18 min | 75 districts and 3,859 startups: 20 new, 79 with changed details (stored as new versions), the rest unchanged. One Prayagraj page timed out, and the run went on without it. The crawler now skips only the failed page (tested). |
| Incubators | **OK**, with one sub-source down | 88 recognised incubators, 88 profiles, **2,911 incubator–startup links** (138 new). The Seed Fund (SISFS) endpoint now answers 404, so its address has probably moved; the 12 UP SISFS incubators from 8 October remain stored. Such a failure now marks the run partial. |
| Startup India (DPIIT) | **Not crawled, by design** | `api.startupindia.gov.in/robots.txt` now says `User-agent: * / Disallow: /`. The engine refused both requests before sending them. See the decision below. |

**After the live run:**

- **4,001** distinct UP startups across both portals;
- **2,338** of them on both portals, joined exactly on the UPLC number;
- **2,917** incubator links;
- **12,713** UP companies from MCA (May–September).


## Decisions taken in the code

- **UP only, enforced by the database**, not just by the code: a company record outside UP is refused.
- **LLPs are counted, not stored, for now.** An LLPIN carries no state, so UP LLPs (about 9,000–12,000 LLPs register across India each month) are identified with the free basic lookup in Phase 2.
- **Portal records are not linked to companies by guessing.** Startup in UP and UP Startup Mission records carry no CIN. They are linked to company records by matching in Phase 2 (Splink, plus an AI check for unsure pairs).
- **Stricter than the robots standard.** A robots.txt that answers 401 or 403 is treated as "do not crawl". The standard would allow crawling in that case, but a server that refuses us should not be crawled.
- **Startup India is not scraped.** Its API's robots.txt forbids all automated access, and the engine obeys it. The Atlas pipeline used that API in early October, before this check existed. DPIIT recognition will come from permitted routes:
  - what founders declare when they claim their company page;
  - the UP portals, which already list state-recognised startups;
  - an official data request if we need the full list.
  The source stays in the code and runs again if the site changes its rules, but it is off the weekly schedule.
- **Founder names published on Startup in UP** are kept only inside the raw record, flagged as personal fields, until Phase 2 decides how they are used. No emails or phone numbers are read from any portal.

## Owner actions (status to be filled in during the week)

| Action | Status |
|---|---|
| Outreach domain bought | |
| Two Zoho Mail Lite mailboxes, DNS checked | |
| Warm-up started (28 Oct) | |
| Meta business verification submitted | |
| DLT application and 140-series quotes | |
| MongoDB room and app user (Murari's team) | |
| Server decision | |
| October MCA file loaded | expected 1–5 Nov |
| Founder conversations | 0 of 10–15 |

## Next: Phase 2 (2–8 November)

- One record per company, with Splink matching.
- The enrichment waterfall: free basic lookups, which also resolve UP LLPs, and full profiles for the top 200.
- The deadline calendar, scheme verdicts from the rules engine, fit score, contact budget and holdout.
- Admin pages for the pipeline and the company view.

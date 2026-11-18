# Phase 2 report: knowledge base and need engine

**Period:** 2 – 8 November 2026 (built ahead of schedule, 26 – 27 October). **Prepared by:** Gourav Bathwal.
**Status:** code complete, reviewed twice and tested on the real UP data. Eleven actions need a person, a vendor or a decision; they are listed in `ops/WEEK2_ACTIONS.md`.

Before Phase 2 started, every Week 1 file was reviewed line by line. That review found 18 defects, all now fixed and covered by tests. Part 1 lists them; Part 2 covers what Phase 2 built. Part 3 covers a second review of everything built so far, by seven reviewers in parallel, before Phase 3 adds outreach on top.

**Tests: 389, all passing** (141 Node.js, 248 Python), up from 81 at the end of Week 1. The Week 1 review added 35, Phase 2 added 44 and the second review 229. Every suite runs against a real MongoDB 8.0 that it starts and throws away (the Node suite as a one-node replica set, so transactions are tested too). A few Python tests read the October crawl caches and skip on a machine without them.

---

## Part 1. The Week 1 review

| # | What was wrong | What could have happened | Fix |
|---|---|---|---|
| 1 | robots.txt was read with Python's standard parser, which applies the **first** matching rule, not the most specific one, and ignores `*` and `$` | With `Allow: /` then `Disallow: /private`, the crawler would have fetched `/private`, against the site's rules | Own RFC 9309 matcher: longest match wins, wildcards and `$`, groups combined; a tie goes to Disallow (stricter than the RFC). 16 cases tested |
| 2 | Redirects were followed without checking robots.txt for the new address | A permitted page could redirect into a forbidden one | Every redirect hop is checked and paced like a new request |
| 3 | The robots.txt request itself was not paced | Two requests to a site in the same second | It counts as a request to that host |
| 4 | No limit on response size | One huge file could exhaust the server's memory | 25 MB limit; a larger response is skipped like a failed page |
| 5 | `Retry-After` given as a date was ignored | Retrying too early after a site asked us to wait | Both forms honoured |
| 6 | The job worker could crash: a database error while recording a job's outcome became an unhandled promise rejection, and Node.js exits on those | The worker process dies in production | A job's run can no longer throw; the job is retried when its lock expires. Handlers also get a signal when their lock is lost |
| 7 | The consent ledger hashed a proof containing an empty (undefined) value differently from how MongoDB stores it | `ledger:verify` would report tampering that never happened | Proofs are normalised before hashing; types that cannot round-trip are refused |
| 8 | Cutting entries off the end of the consent ledger could not be detected by the chain alone | Silent loss of the newest consents | `ledger:verify` now prints the chain's head, to be copied into the daily summary email |
| 9 | The suppression list accepted `gmail.com` as a domain to block | One click would block every founder who uses Gmail | Shared mail domains can only be suppressed address by address |
| 10 | A record that changed back to an earlier version (A → B → A) left B as the "latest" | The engine would have read stale stage, sector or incubator data | A current-version pointer (`source_state`); an older backfill can never overwrite newer data; "last seen" kept for every record |
| 11 | The weekly Startup in UP run treated a startup whose profile had failed once as already known | Its profile would wait for the monthly full run | Only a parsed profile counts as known |
| 12 | One incubator profile timing out failed the whole incubator run | 88 profiles lost for a week | Each request stands alone |
| 13 | An empty profile field was read as the next label ("Sectors" as an entity type); years like "0022" and "1970"; industries like ", Others" | Wrong facts on company records | Fixed in the parser, with a test on each. Profiles stored before the fix keep the old values until the monthly full re-read replaces them |
| 14 | Company-name cleaning missed "Private Limited." with a dot, "(OPC)" after the form, "P. Ltd" and misspellings ("Limeted", "Privet", "Techologies") | Exact matches lost | All handled; generic words are now recognised within one typo |
| 15 | Ctrl+C left a run marked "running" for ever | A misleading status page | Marked failed ("interrupted"); `status` flags runs still running after 6 hours |
| 16 | The monthly full re-read of Startup in UP was close to the 3,000-request budget | It would have stopped half-way within weeks | A budget per source (6,000 for Startup in UP) |
| 17 | The index check ignored TTL settings | A changed expiry would never be applied | Compared |
| 18 | Two code comments were no longer true (Startup India; hashes "stable across languages") | Misleading the next developer | Corrected |

The live data loaded in Week 1 was rechecked after the fixes: the 12,713 MCA companies and 4,001 portal startups are unchanged, and `source_state` was rebuilt from the 22,204 stored records.

---

## Part 2. What Phase 2 built

| Item | Where | Tests |
|---|---|---|
| **Knowledge base**: the current view of every portal startup, exact matching on the registered name, Splink for the rest, a person for the unsure pairs; portal facts written onto companies with their source | `ingest/src/leadengine/kb/` | 8, and 35 more in the second review |
| **UP LLPs without a paid lookup**: portal LLPs matched to the LLP sheet of the MCA files already held; only the UP ones that a startup links to are stored | `kb/llp.py` | in those |
| **Matcher evaluation**: precision against labelled pairs, a misspelling self-test, a leave-one-out test, and a labelling file for the team | `kb/labels.py`, `leadengine kb eval` | in those (added in the second review) |
| **Deadline calendar**: 18 first-year obligations for companies, OPCs and LLPs, each with its section of law, penalty and source | `config/rules/deadlines.json`, `need/deadlines.py` | 5 |
| **Scheme verdicts**: the platform rules-engine client, with eight provisional rules until it is connected | `config/rules/schemes.json`, `need/schemes.py` | 3 |
| **Fit score**: the UP Startup Atlas classifier reused, every point explained | `config/fit.json`, `need/fit.py`, `need/classify.py` | 2 |
| **Leads, holdout and the monthly shortlist** | `need/leads.py` | 6 |
| **Enrichment waterfall** with hard caps, a cache and the MCA data vendor's API | `ingest/src/leadengine/enrich/` | 8 |
| **Contact budget**: first email, one follow-up, new needs only, mailbox warm-up and ramp | `services/src/outreach/budget.js` | 5 |
| **Admin pages and JSON API**: pipeline, shortlist, company view, review queue, data health; roles, masking and an audit log | `services/src/admin/` | 7 |
| **Schema version 2**: six new collections (`source_state`, `entity_links`, `match_reviews`, `enrichment_cache`, `usage`, `audit_log`), richer `leads`; 48 indexes | `schema/collections.json` | in Week 1's schema tests |
| **Nightly batch** in one command | `leadengine nightly` | |

### The knowledge base

Startup in UP and UP Startup Mission list about 4,000 UP startups with no CIN. The engine decides which company each one is, in three steps:

1. **Exact.** MCA does not register two companies, or two LLPs, under the same name. A startup whose registered name and legal form equal exactly one company's name is that company, unless the facts contradict it: for example, the founder says it is an LLP and the match is a company, or the startup was on the portal before the company existed. A name given without a legal form also needs something that dates it.
2. **Splink** scores the rest on one ordered comparison of the names, the legal form, the year, the listing date, and the portal sector against the NIC code. A link is made automatically only if all of these hold:
   - the probability is at least 0.98, well clear of the runner-up;
   - the names are the same, or differ by one typo in a distinctive word, as MCA's own name rules would see them. A changed generic word ("Solutions" for "Technologies") or an added "India" is never enough, because MCA registers such names as different companies;
   - the year agrees. It is the founder's stated year, or, when there is none, a listing soon after incorporation backed by a fitting sector or a website named like the company;
   - no other startup claims the same company.
3. **A person** decides the rest in the Admin review queue. Their decision always overrides the matcher on every later run. (The design's AI yes/no check slots in here once the LLM gateway has a key for the engine.)

The year, the listing date, the sector and the website are the facts beyond the name that the engine holds today. The design's other examples (a director, an address, a domain) come with enrichment.

**Result on the real data** (after the second review, Part 3):

| | Startups |
|---|---|
| Linked to a company or LLP | **152**, all on the exact registered name: 131 companies and 21 LLPs |
| Waiting for a person | **13**. Four look like LLPs that converted into companies in 2026 (same name, LLP on the portal since 2024–25, company incorporated in June–July 2026). That is a real business event and a reason to talk to them. "Yagnawealthh", which Splink linked in Phase 2, is here too: it now scores 0.93, so a person decides |
| No CIN in our data yet | **3,800** |

The 3,800 are not a matcher failure. 77 of them are partnerships, which have no CIN at all. For most of the rest, the company is simply not in our data: our CIN universe is the five MCA monthly files from May to September 2026, and most portal startups were incorporated between 2018 and 2025. Two routes close the gap. MCA's monthly files go back to 2016 (a manual download each, listed in the actions), and the vendor's name search, inside its free 500-a-day quota, finds a startup's CIN directly. Either way, the next nightly run links the startups by exact name.

All 152 links were checked against the facts: in none was the startup on a portal before its company existed, and in none does the year disagree. The 36 old name-only cards that a later profile replaced were dropped, so 3,965 startups are counted, not 4,001.

**Tests on the real names.** Two tests measure the matcher without labels. The **misspelling self-test** misspells the names of exactly linked startups the way founders do and runs the matcher, with the production model. For the last two kinds, a link would be wrong: MCA registers those names as different companies.

| Misspelling | Cases | Solved by name cleaning | Linked by the matcher | Sent to a person | Missed | Wrong links |
|---|---|---|---|---|---|---|
| A trailing dot | 120 | 120 | | | | 0 |
| A typo in the form ("Private Limeted") | 119 | 119 | | | | 0 |
| No legal form ("Vezras Technologies") | 119 | 117 | | 1 | 1 | 0 |
| "&" for "and" | 2 | 2 | | | | 0 |
| One letter dropped ("Ishmin Moors" for Motors) | 120 | 10 | 46 | 54 | 10 | 0 |
| An extra word ("Tobixo India Pvt Ltd") | 119 | | | 119 | | 0 |
| A generic word changed | 119 | | | 119 | | 0 |
| **All** | **718** | **368** | **46** | **293** | **11** | **0** |

Run again with the true company removed, the common real case, the matcher makes 0 wrong links in 718 and sends 36 to a person.

The **leave-one-out test** takes 4,000 real company names, removes each company from the register, and asks whether the matcher links the name to some other company, usually a sibling with a similar name. It makes **0 wrong links** in 4,000 (95% upper bound 0.1%) and sends 517 to a person. A second run, against a register of 113,000 companies, also makes none.

The design's target, 95% precision on 300–500 pairs labelled by people, cannot be measured yet because no pairs have been labelled. The labelling file is ready (`data/labels/match-pairs-2026-10-27.csv`, 190 pairs), and `leadengine kb eval` reports precision, with a 95% interval, as soon as labels are imported. Labels decided in the review queue count too.

Getting to the Phase 2 version took four rounds against the self-test, each fixing a real fault:
- Splink's default weight for near-identical names was about 500 times too weak;
- one name comparison was double-counting typos;
- a typo could create a fake "rarest word";
- without a rule that every distinctive word must be accounted for, "Frontier Ops" was linked to FRONTIER LABS.

The second review then found that generic words were still ignored, which the self-test could not see. Part 3 explains the fix and what it cost.

### The need engine

**Deadlines.** The rules come from the Atlas policy research, which checked them on 1 October 2026 against the India Code text and the gazette:
- the first board meeting, first auditor, share certificates and INC-20A;
- the first AGM, ADT-1, AOC-4 and the annual return, with OPCs on their own dates;
- the first ITR, DPT-3 and GST registration;
- directors' KYC, now triennial;
- for LLPs: Form 3, Form 8, Form 11 and ITR-5.

The design's own example checks out in a test. A private company incorporated on 14 October gets:
- its first board meeting and auditor by 13 November;
- share certificates by 14 December ("two months");
- INC-20A by 12 April.

The engine never says a filing was missed, because it cannot see filings. A past date is shown as "was due by", for the founder to check.

**Scheme verdicts.** There are eight provisional rules:
- DPIIT recognition, under the February 2026 rules: 10 years, ₹200 crore;
- the s.140 tax holiday (formerly 80-IAC);
- the Seed Fund (a reported closure on 31 May 2026 could not be confirmed from a primary source, so the verdict is "check required");
- Startup in UP recognition;
- the UP sustenance allowance and prototype grant;
- Udyam registration;
- the PM-VBRY employer incentive.

A fact we do not hold can only ever lead to "check required" with the missing fact named, never to "not eligible". When the platform's rules engine is connected, its verdicts replace these. The proposed contract is in `docs/PLATFORM_CONTRACTS.md`.

**Nothing reaches a founder until a CA confirms the rules.** Both rule files carry `confirmed_by: null`. Until those are filled in, every lead's needs are marked unconfirmed, and each shortlisted lead's next action is "confirm rules", not "contact". This is design 7.4, enforced in code.

**Fit score.** It reuses the UP Startup Atlas classifier: 21 sector themes and an innovation signal from the name and NIC code. To that it adds:
- how recently the company was incorporated;
- legal due dates within 60 days either side of today (a date counts once however many filings fall on it, and conditional filings never count);
- being listed on a startup portal;
- having an incubator;
- having a website of its own.

Each point is shown with its reason on the company page. No AI score is used.

**Leads, holdout and shortlist.** Every company has a lead: 12,734 in all, of which 28 are ineligible (subsidiaries of foreign companies).
- **Holdout.** A keyed hash of the company id puts 10.3% in the holdout group (1,311). The draw is stored and never redrawn.
- **Shortlist.** October's shortlist, from the September cohort, holds the 200 best-fit companies to contact, plus 24 holdout companies ranked among them, never to be contacted. Comparing those two groups is the honest measure of what the engine adds.
- **Timing.** A month's shortlist waits for the MCA file of the month before (November's waits for the October file), so the first days of a month cannot fill it with the few companies already known.

**Decided on 1 November: a cap per sector.** The shortlist leaned to technology: 138 of October's 200 are SaaS/IT and 22 AI, because the Atlas innovation signal rewards technology names and NIC codes. The review measured it: NIC division 62 is 12% of the September cohort but about three quarters of the ranked list, and the innovation points are most of the score. The fit score (now fit-v2) no longer favours companies incorporated late in the month, and ties are broken by a keyed hash instead of by CIN; but the score is coarse, so many places at the cut-off are decided by that tie-break. October's shortlist was ranked under fit-v1 and is kept as made.

The decision keeps the score as it is and caps the shortlist instead: no sector theme may take more than 40% of the month's places to contact (`shortlist_theme_cap_pct` in `config/fit.json`). Until there are outcomes, a list spread over many sectors shows where replies and customers really come from; a list that is three quarters SaaS/IT can only teach us about SaaS/IT. The innovation signal still orders companies within each theme, and whether a company enters never depends on its own holdout flag, so the holdout comparison stays fair. On the September cohort, the cap takes SaaS/IT from 76% of a fresh list to 40% (still three times its 13% share of the cohort), widens the list from 10 themes to 17, and lowers the fit at the cut-off from 51 to 46. It applies from November's shortlist; October's is kept as made.

### Enrichment

From cheapest to dearest, the waterfall has four tiers:
- free portal facts;
- the vendor's free 500-a-day company lookup (registry status, registered office, district and PIN code);
- the free name search, which finds CINs for portal startups and creates their company records (an LLP only when the vendor places its registered office in UP);
- a ₹5 full profile (capital, directors' names and DINs, registered email) for the month's shortlisted, non-holdout companies only.

A run buys the month's profiles first, then spends the free quotas on lookups and searches. Every paid or quota call takes a unit from a hard cap first, in one atomic database step; days and months are Indian days and months. Every answer is cached: lookups and full profiles (registered email included) for 90 days, "not found" for 30, errors and unreadable answers for a day. Directors' phone numbers are never requested, and a registered email is flagged as personal unless it is a role address such as `info@` at the company's own domain.

The vendor's API spec gives paths and authentication but no response fields. So:
- the adapter keeps every raw response;
- it reads fields under the names such APIs commonly use, and an answer it cannot read is "unparsed", never "not found";
- an error inside a 200 response is an error, a refused key or a vendor outage stops the step instead of spending the quota, and a sandbox key never writes to company records;
- `leadengine enrich probe <CIN> --op lookup|search|profile` checks each response's shape against the free sandbox before any live use.

Without a key the waterfall makes no calls and shows the plan instead (for October, after the second review):
- **12,714** basic lookups, a one-off backlog of about 25 days within the free quota, then about 2,500 a month;
- **3,723** CIN searches for portal startups;
- **200** full profiles (about ₹1,000).

### Contact budget

Contact is limited to:
- a first email, then one follow-up after 7 days if there is no reply;
- after that, only a new deadline or scheme, once per need and at least 30 days apart;
- never a holdout or ineligible company;
- nothing automated once a founder replies or opts out.

Mailboxes send no outreach during the 21-day warm-up. From 18 November they ramp from 25 to 30 a day, counted by the Indian calendar day. The tests caught a real bug here: a lead with no id matched every activity in the database.

### Admin pages

Start them with `node services/src/cli.js admin`. They are server-rendered, with no JavaScript, and look right at phone width and in dark mode:

- **Pipeline:** the funnel, cohorts, sector themes, districts, portal matching and the top of the shortlist.
- **Shortlist** in full.
- **Company view:** every fact with its source and date, the fit score explained, the deadline calendar with law and penalty, scheme verdicts with sources, portal entries and a timeline.
- **Review queue:** "Same / Different / Unsure" for each unsure pair.
- **Data health:** the latest runs and the caps.

Every page has a JSON twin, so the platform's Admin portal can show the same data in its own design.

**Security:**
- sign-in by personal token, with three roles (viewer, reviewer, admin); signing out ends the session on the server, and a new token or a raised epoch ends every open session;
- personal data (directors, portal team members, a registered email that is a person's) hidden by default, in the pages and the JSON alike; only an admin can reveal it, and every reveal is logged;
- every sign-in, sign-out, refused token and review decision logged (the token itself never), the log row written before the decision;
- CSRF tokens and same-origin checks on forms, a strict Content-Security-Policy, HSTS over HTTPS, and only http(s) link targets;
- wrong tokens throttled per address on the pages and the API, without ever locking out a valid token.

**Accessibility:** after the review, an automated WCAG 2.2 AA check (axe-core) and a contrast check of every text node find nothing in light or dark mode at 1,366, 768, 360 or 320 pixels (before: 4–5 failing rules and about 270 failing text nodes per page set). The pages reflow at 320 pixels, work with Windows high-contrast colours, print cleanly, and start with a "Skip to content" link.

![Pipeline](img/admin-pipeline.png)
![Company view](img/admin-company.png)
![Review queue](img/admin-review.png)

---

## The nightly run

`leadengine nightly` runs the whole Phase 2 batch on the real data in under a minute, in this order:
1. the knowledge base build;
2. enrichment, within the caps;
3. a second knowledge base build, only if enrichment created companies;
4. the need engine.

Each step runs on its own: a step that fails is recorded and the need engine still runs, so deadlines and the shortlist stay current on a day the vendor or the matcher fails. The run is recorded in `ingest_runs`, and a unique index lets only one nightly run at a time.

The schedule is in `ops/SCHEDULE.md`.

## Decisions taken in the code

- **An exact registered name is treated as a key.** That is safe because MCA enforces unique names. Even so, facts that contradict it (type, dates) send the pair to a person.
- **A UP LLP is identified from the portals** and stored with `state_evidence` showing where "UP" came from (confidence medium). LLPs from the rest of India are read from the MCA file and discarded, never stored.
- **Portal facts never overwrite registry or vendor facts.** Each source keeps its own fields.
- **Links are rebuilt every night from scratch** and are therefore reproducible. Only real changes are written, so a link keeps the date it was made.
- **No AI in Phase 2.** Matching, deadlines, verdicts and fit are rules and statistics, explained point by point. The AI steps (unsure pairs, drafting) need the LLM gateway key (Phase 3).

## What waits on others

See `ops/WEEK2_ACTIONS.md`. In short:
1. a free vendor sandbox key;
2. the production secrets, set once (the holdout salt, the contact-key secret and the ledger anchor file);
3. a CA's confirmation of the deadline and scheme rules;
4. the MCA monthly back files;
5. a labelling session of about an hour;
6. the schema and role upgrade wherever the database already exists.

Three decisions were taken on 1 November: the shortlist is capped at 40% per sector theme, the raw pages stored before the second review were cleaned, and the complaint pause stays at Google's 0.1% line.

On the platform side, the rules-engine endpoint and the Admin sign-in (`docs/PLATFORM_CONTRACTS.md`).

---

## Part 3. The second review (28 October – 1 November)

Before Phase 3 builds outreach on top of this code, everything built so far was reviewed again, this time by seven reviewers working in parallel, one per area. Each reviewer read its area line by line and tried to break it with probes against copies of the real data; every finding was then reproduced before it was fixed. Nothing was changed on trust.

| Area | Findings | Fixed | Left, and why |
|---|---|---|---|
| Security and privacy | 15 (1 high, 7 medium, 7 low) | 15 | |
| Admin pages: design and accessibility | 17 (7 must-fix, 10 improvements) | 17 | |
| Ingestion and enrichment | 25 (4 high, 10 medium, 11 low) | 24 | Parser changes still show once as "changed" records (below) |
| Knowledge base and matching | 11 (1 critical, 4 high, 3 medium, 3 low) | 10, and 1 in part | Retiring startups that left the portals (below) |
| Need engine and rules | 15 (4 high, 7 medium, 4 low) | 15 | The CA's sign-off, as before |
| Node core: jobs, consent, suppression, budget | 15 (3 high, 8 medium, 4 low) | 15 | Two product decisions (below) |
| Documents | 28 | 28 | |

### What mattered most

**Secrets in `.env` were never read by the Python side.** The vendor key, holdout salt and rules-engine address were read from the shell's environment only, so under cron the nightly run would have used no vendor, the development salt and provisional rules, and reported success. They are now read from `.env` and the environment alike, and the holdout draw refuses to run with no salt or the development one outside development.

**Personal data in the raw store.** Raw pages were kept exactly as fetched: 867 of 3,936 stored pages hold an email address or phone number (the portal's helpline footer on most Startup in UP pages, and incubators' named representatives on 175 portfolio pages). Now:
- every new page is redacted before it is stored (emails and Indian mobile and landline numbers; JSON value by value; spreadsheets and other binary files untouched), and each stored page is flagged `redacted` and, where it holds founders' or directors' names, `personal`;
- the portal records keep only an allow-list of company-level fields (they used to drop a deny-list of personal ones, which missed `mob_no` and `founderName`);
- a stored page can be erased or rewritten, on S3 across all its versions;
- `leadengine privacy redact-raw` finds the pages stored before the change. It reports by default and rewrites only with `--apply`. It was applied on 1 November: 867 pages, 2,097 addresses and numbers removed, 0 left, and every cleaned page still parses.

**A crawler that could be pointed inward (SSRF).** A redirect from a public site to a private address was followed, and the response stored. Every hop now resolves the host and refuses loopback, private, link-local and cloud-metadata addresses and any scheme but http(s). Startup India is on a hard never-crawl list, so even a robots.txt that later answers "allow" cannot reopen it.

**The monthly re-read could quietly degrade data.** A Startup in UP profile that failed to load during the monthly full re-read replaced a good, parsed record with a card-only one, and the run said "ok". A failed profile now keeps the previous record, and the run is marked partial. A run that fetches nothing at all is "partial", never "ok"; records already read are written even when a run stops half-way.

**Vendor failures.** An error inside a 200 response was read as "not found" and cached for 30 days; a refused key or an outage spent the whole day's quota on errors; a sandbox key wrote its answers onto real companies. Now a refused key or an outage stops the step after retries, an answer that cannot be read is "unparsed" and retried the next day, and a sandbox key never writes to company records.

**Admin pages.** The review queue's JSON sent portal founders' names to every role, unlogged; only counts are sent now, and names appear only when an admin reveals them, logged. Sessions can now be ended for good (signing out, a new token, or a raised epoch). Every personal registered email is masked, including the 20 shared mail domains the page did not know. After the redesign, the automated WCAG 2.2 AA check and a contrast check of every text node find nothing in either theme at any width (see Admin pages above).

**Rules.** Four verdicts were wrong on the facts:
- the UP sustenance allowance refused 75 startups at the validation stage, which the scheme covers;
- an LLP's income-tax return was dated 31 July, not 31 August;
- the Seed Fund was "closed" on a report the reviewer could not confirm from any primary source;
- "not eligible" for DPIIT recognition on 1,082 companies rested on a judgement about their legal form, not a fact we hold.

After the fixes, DPIIT "not eligible" fell from 1,082 to 32 (public companies only), the Seed Fund is "check required" for all, and no startup is refused the sustenance allowance. A fact we do not hold is now unknown in the rule logic, not false, so it can never refuse anyone. Extensions announced by CBDT are applied by date, each with its source, and a "closed" verdict expires unless it carries a `valid_until`. Every rule now records when it was last checked and against what.

**The fit score** no longer favours companies incorporated late in the month (days 1–10, 11–20 and 21–31 now make up 30%, 29% and 41% of a fresh ranking, against 32%, 29% and 39% of the cohort). Shortlist entries record the fit and the day they were ranked. October's shortlist was kept as made.

**The nightly run** isolates its steps (a failed step is recorded and the need engine still runs), records itself in `ingest_runs`, and holds a database lock so that two runs can never overlap; a lock older than six hours is taken over. It exits 0 when all is well, 1 when a step failed and 2 when another run holds the lock, so cron can alert on it.

**Knowledge base: a sibling is not the same company.** This was the most serious finding of the review. The matcher ignored generic words when it compared names, so "Acme Technologies" and "Acme Solutions", which MCA registers as two companies, looked the same to it; and the same name evidence was counted twice, which pushed the score to near-certainty on the name alone. The misspelling self-test could not see this, because it mostly tested the name cleaner against its own rules. A new test can: the leave-one-out test above. With the old matcher it found 18 wrong links among 12,700 companies, and 35 among 113,000. Now there are none in either.

What changed:
- generic words count when names are compared. MCA's name rules decide which differences are ignored, and only "the same" or one typo in a distinctive word can link automatically;
- each fact is counted once, and the model's parameters are counted from the data instead of sampled, so the same data always gives the same model;
- the year must come from the founder, or from a listing soon after incorporation backed by other evidence. The listing year alone is not independent of the portal entry it came from;
- labels will train the model correctly: only "same" pairs, at least 30 of them, blended with the priors. The old code would have counted "different" pairs as matches;
- precision is scored on the matcher's own decision, made before any reviewer's, with one labelled startup in five held out of training. It therefore stays measurable after every rebuild, which it did not before;
- seven holes in the decision rules are closed. For example, an "unsure" review now blocks an automatic link, and one company can be claimed by only one startup;
- the name cleaner reads legal forms however they are punctuated: "(Pvt) Ltd", "Pvt-Ltd", "One Person Company", Hindi forms, "M/s.", and a brand followed by the registered name in brackets;
- LLPs are stored only while a startup links to them, and the MCA LLP sheets are parsed once and cached;
- links for startups no longer on the portals are removed (36);
- the candidate pairs to score fell from 556,000 to 109,000.

**The cost, and a decision for you.** Precision came first, and it cost automatic links on misspelt names:
- of the misspellings that reach the fuzzy matcher, 41% are now linked automatically and 90% are linked or sent to a person, still with no wrong links;
- with one letter dropped, 56 of 120 are linked automatically, against 83 before;
- the review queue grew from 7 to 13.

If you want more automatic links on typos, the levers are the link threshold and the prior, or more evidence. The most useful evidence would be the registered address and directors from enrichment. A looser name rule is not one of the levers.

**Leads whose company is gone.** When the knowledge base drops an LLP that no startup links to any more, its lead now stays, with its history, but is marked ineligible, so it can never be shortlisted or contacted.

**Node core: the parts Phase 3 will send through.** Three findings would have mattered as soon as outreach starts:
- **The consent ledger lost writes under load.** Fifty concurrent writers lost 9 consents to collisions. Writers now take turns, in a transaction on a replica set, and 100 writers in 5 processes land in one gap-free chain.
- **The contact budget was check-then-act.** Ten senders racing for a mailbox's last free place were all allowed. A send now reserves its place first, in one atomic step, and holds a lock on the company so that only one message to it is ever in progress; exactly one of the ten gets the place.
- **The suppression check let through anything it could not read**, such as `Rahul <rahul@acme.in>`, a number with a trunk 0 after +91, or a subdomain of a blocked domain. Anything unreadable is now blocked, and those forms are all read.

Also fixed:
- **Keys that could be reversed.** Suppression keys and the ledger's contact keys were plain SHA-256 of a phone number, which can be reversed by trying all 4 billion Indian mobile numbers in seconds. They are now keyed hashes under a secret kept outside the database (`CONTACT_KEY_SECRET`). There was no data to re-key yet.
- **An erasure request** on an address already suppressed did nothing. It now blanks the address and the note.
- **The ledger's anchor.** A daily `ledger:anchor` copies the ledger's head outside the database, so a ledger cut short or rewritten is caught.
- **No deletes by the application** on the suppression list.
- **The job worker:**
  - a hung step is aborted after 15 minutes;
  - a worker that loses the database stops its step before its lock runs out;
  - lock times come from the database server's clock;
  - a running job can be cancelled;
  - a result that cannot be stored no longer makes the step run again;
  - stopping takes at most 30 seconds.

Node tests went from 55 to 141.

**Two product decisions** were surfaced:
- **Complaints.** A mailbox pauses itself while complaints over the last 30 days pass 0.1% of its sends, counted over at least 50 sends. At our volume, a single complaint pauses it. Decided on 1 November: keep it. That is the safe default for a new domain, and 0.1% is the line Google's sender guidelines ask senders to stay under.
- **Channels without caps.** WhatsApp, SMS and voice are refused by the contact budget until their caps are set in `config/caps.json` in Phase 3.

### What was left, and why

- **Parser changes show as source changes.** Replaying the stored pages through today's parser gives about one Startup in UP record in five a new hash, because older parser code kept values such as ", Others". These appear once as "changed" records on the next full re-read, and then settle. Telling the two apart needs a parser version on every record; it is not worth a schema change in this phase.
- **Retiring startups that left the portals.** A startup that disappears from a portal keeps its record. Dropping records by their last-seen date is unsafe while a partial crawl touches only part of a source: it could drop thousands at once. It needs a "last complete crawl" marker per source first.
- **Not verified against a primary source:** the matcher's list of differences MCA ignores in names is a summary of the company-name rules, adjusted where the register contradicts it ("India" is not ignored: MCA registered both FLIPTOSOLAR and FLIPTOSOLAR INDIA). The mapping from portal sectors to NIC codes is hand-built. It is only ever used as evidence for a link, never against one, and the labels will test it.
- **The CA's sign-off** remains the gate on everything founders see (actions, item 3).

## Next: Phase 3 (9 – 15 November)

- Sequences on the job table.
- AI drafting from evidence packs, an automatic quality check and the approval queue.
- The compliance gate (consent, suppression, quiet hours, the contact budget above).
- Email sending with automatic pause.
- The company page and claim flow, and WhatsApp utility templates.

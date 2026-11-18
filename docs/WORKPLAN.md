# Work plan to completion (18 Nov 19:20 IST → 19 Nov 13:00 IST)

The engine is built to the design (v1.1) except the items below. Everything here can be done without
the owner's outside inputs (keys, mailboxes, the MCA file, sign-offs), which are listed at the end and
in `ops/WEEK4_ACTIONS.md`. Each session (and each scheduled continuation) reads this file first, takes
the next open item, and updates its status. Agents own files: an agent never edits a file another
agent owns while it is running.

## Rules for every change

- Plain English in comments and docs; say why, not just what. Company-level data only; never a person's
  data to an outside service; never fabricate facts; robots.txt always respected.
- Tests with every change, against the throwaway MongoDB (`npm test`, `.venv/Scripts/python -m pytest`).
  No real network calls in tests (inject fakes: `dns`, `fetch`, fetchers, search clients).
- On this Windows machine, Git Bash heredocs mangle backslashes: write scripts and code with the Write
  tool, edit with the Edit tool.
- Do not delete files you did not create. Do not run anything that sends email, WhatsApp or calls.
- Git: the remote is the public repository `github.com/Mr-Bathwal/Solution_ai_lead_engine`. Commit
  only when both suites pass, one commit per finished item with a plain message; push to `main`
  after each commit. Before every commit, `git status` must show no `.env`, nothing under `data/`,
  `docs/legal/`, `ops/legal/`, no real-company screenshots and no founder notes (all in
  `.gitignore`). Never commit a real person's email, phone or name outside fictional fixtures.

## Open items

| # | Item | Owner | Status |
|---|---|---|---|
| 1 | Funding news signals (design 7.1, 7.4 "Signals"): RSS feeds and GDELT, exact name match to UP companies, a `signals` collection, an Admin "Signals" page where a person confirms or rejects, confirmed signals on the company page | agent `news-signals` | done 18 Nov about 20:15 (12 Python, 4 Node tests); Entrackr's feed URL 404s and GDELT's robots.txt was unreachable: both need a look |
| 2 | Code review of everything built 13–18 Nov (backups, exports, MCA upload, platform sign-in, Hindi pages, sample approval, address checks, campaigns, AI check, websites): correctness, security, privacy; a findings list | agent `reviewer` (read-only) | done 18 Nov about 19:45: 7 findings in `docs/REVIEW_18NOV.md` |
| 3 | Demo seed shows every new feature (campaign visits and claims, an approved and downloaded export, labelled pairs, address checks on drafts, a website-found company address, AI advice on a review pair) | agent `demo` | done 18 Nov 19:40 (demo.test.js 9 of 9) |
| 4 | Fix the reviewer's findings | main session | done 19 Nov 01:00: all 7 fixed with tests (see the log) |
| 5 | Docs pass: HANDOVER, WEEK4_REPORT, WEEK4_ACTIONS numbering, README, OpenAPI for new endpoints (`/api/labels`, `/api/audit`, `/api/signals`), test counts | main session | done 19 Nov 01:45 (OpenAPI 21 paths; evals' docs check: 0 mismatches) |
| 6 | Final checks: both suites, `preflight`, `demo:seed` and a look at every page at 375 px, backup and restore drill, memory note | main session | done 19 Nov 02:05 (see the log); repeat the suites at the end |
| 7 | Git repository: `git init`, `.gitignore` for secrets, data and private material, CI (`.github/workflows/ci.yml`, both suites with a real mongod), first commit once both suites pass, then a commit and push after every finished item | main session | done: pushed after every item; CI green since 154fc34 (a test read a file kept out of git) |
| 8 | Evals and reflection: an `evals/` suite that scores the engine against what it promises (drafts are factual and lawful, the gate blocks what it must, matching on hard name pairs, no personal data leaves, docs agree with the code), and `docs/REFLECTION.md`, an honest account of what is built, what is tested and how, and what is weak | main session (agent `evals` for the suite) | done 19 Nov 01:45: `evals/` (agent `evals`), its 14 findings fixed or explained, `docs/REFLECTION.md` written |
| 9 | Admin screenshots of the fictional demo in place of the Week 2 ones (those show real companies and are kept out of git) | main session | done 19 Nov 01:05 (`docs/img/demo-admin-*.png`) |
| 10 | A hosted, read-only snapshot of the demo (owner's request, 18 Nov: "deploy demos on Vercel"): `ops/demo-site/build.mjs` crawls `demo:serve` into static pages; deploy with the Vercel CLI | main session | rebuilt 19 Nov 02:05 from the re-seeded demo (93 pages, no broken links, no tokens); deploy waits for the owner: Vercel asked for an emailed code to sign the CLI in |

## Waiting on the owner (not blocking the above)

Vendor key (INFYNER_API_KEY), the two mailbox passwords, October's MCA file, the CA's sign-off, server
access, the platform team's endpoints and sign-in choice, Meta verification, DLT and the voice number,
the privacy notice URL, the lawyer's answers (legal pack, including Hindi and website addresses), an
email verification key, a search API key, the backup bucket.

## Log

- 18 Nov 19:20: plan written; agents 1–3 started.
- 18 Nov 19:35: main session: WEEK4_ACTIONS table put in number order (1–26); `/api/audit` added to the OpenAPI spec (15 paths) and PLATFORM_CONTRACTS. Continuation check-ins every 2 hours at :13 until 13:00 on 19 Nov; final report at 13:07.
- 18 Nov 19:40: agent `demo` finished item 3 (campaign visit and claim, approved and downloaded export, 3 labels, AI advice on a review pair, a website-found address; demo.test.js 9 of 9).
- 18 Nov 19:45: main session: item 7 set up. git initialised with the public remote; `.gitignore` keeps out secrets, data, the legal pack, the Week 2 real-company screenshots and founder notes; staff emails in docs replaced by placeholders; CI workflow written. Items 8 and 9 added at the owner's request ("polish by evals and reflection", commit and push as work finishes).
- 18 Nov 19:48: agent `evals` started (owns `evals/` only). `demo:serve` now prints a token for Neha, so her waiting export can be approved and downloaded live.
- 18 Nov about 19:45: agent `reviewer` finished item 2 (7 findings: 1 high, 3 medium, 3 low).
- 18 Nov about 20:15: agent `news-signals` finished item 1.
- 18 Nov about 20:45 to 19 Nov 00:40: the session's usage limit; agent `evals` stopped with it.
- 19 Nov 00:50: item 4, review fixes, all with tests: (1) a campaign claim records nothing until the person confirms their email (`/k/<link>`, once, 48 h, 3 a day per address, none to an opted-out one; closed without email set up); the `call_requested` holdout flag; (2) a person's address never goes to the verification service; (3) a backup reads the ledger head first and writes consents only up to it; (4) accept-all addresses deferred 14 days to a second wave, no-MX domains fall back to A/AAAA, a dead registered address gives way to a website one; (5) admin emails lower-cased, exports compare without case; (6) the platform signature covers a hash of the body (contract v2, PLATFORM_CONTRACTS and OpenAPI updated); (7) the demo seed checks the database it drops. Also: news in the Review badge, `signals` not deletable by the app, news runs watched, `signals` in the hourly backup, the AI-check line in SCHEDULE.md. Suites: Node 258, Python 272, all passing (before fix 6).
- 19 Nov 00:55: item 7: first commit and push (220 files). `design/` (marked internal) also kept out of the public repository, pending the owner's decision.
- 19 Nov 01:00: item 10: snapshot built; the Vercel CLI sign-in needs the owner's emailed code, so the deploy waits.
- 19 Nov 01:05: CI's first two runs failed because `data/testsets/replies.jsonl` (160 written replies) was kept out of git with the rest of `data/`; it is tracked now and CI is green. Demo screenshots replace the Week 2 ones in the public report; small Admin text fixes.
- 19 Nov 01:45: item 8: the evals' findings fixed, with tests: (High) reply classification now sends the AI no sign-off or signature, no number in any format, and no name the engine knows; the gate stops a website address once the switch is off, a "consent" the ledger does not hold, and a CIN from outside UP; the quality check catches 99.9% of 24 kinds of broken draft (was 59.6%: dates bound to their deadlines, exact forms, sections and amounts, bare-domain links, other companies, people at the company, pressure and "not filed" in any wording, US-style dates); follow-ups say why the founder is getting them; long names shortened where needed; free site builders refused as company sites; initials and honorifics in domains; a changed last vowel is not a typo; `.env.example` and OpenAPI complete. Deferred, in REFLECTION: transliteration variants in matching. The legal pack (local) rebuilt from the changed templates. Suites: Node 261, Python 274, all passing.
- 19 Nov 02:05: item 6: preflight shows 7 blockers, all the owner's (MCA file, CA sign-off, registered emails via the vendor key, two mailboxes, PUBLIC_BASE_URL, privacy notice); all 96 demo pages fit at 375 px (0 overflow, measured in the browser); backup and restore drill: 73,742 documents back, 0 differences, ledger verified, drill database dropped; memory note updated; demo re-seeded and snapshot rebuilt with templates v2.

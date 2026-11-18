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
| 1 | Funding news signals (design 7.1, 7.4 "Signals"): RSS feeds and GDELT, exact name match to UP companies, a `signals` collection, an Admin "Signals" page where a person confirms or rejects, confirmed signals on the company page | agent `news-signals` | in progress |
| 2 | Code review of everything built 13–18 Nov (backups, exports, MCA upload, platform sign-in, Hindi pages, sample approval, address checks, campaigns, AI check, websites): correctness, security, privacy; a findings list | agent `reviewer` (read-only) | in progress |
| 3 | Demo seed shows every new feature (campaign visits and claims, an approved and downloaded export, labelled pairs, address checks on drafts, a website-found company address, AI advice on a review pair) | agent `demo` | done 18 Nov 19:40 (demo.test.js 9 of 9) |
| 4 | Fix the reviewer's findings | main session | waiting on 2 |
| 5 | Docs pass: HANDOVER, WEEK4_REPORT, WEEK4_ACTIONS numbering, README, OpenAPI for new endpoints (`/api/labels`, `/api/audit`, `/api/signals`), test counts | main session | after 1–4 |
| 6 | Final checks: both suites, `preflight`, `demo:seed` and a look at every page at 375 px, backup and restore drill, memory note | main session | last |
| 7 | Git repository: `git init`, `.gitignore` for secrets, data and private material, CI (`.github/workflows/ci.yml`, both suites with a real mongod), first commit once both suites pass, then a commit and push after every finished item | main session | set up 18 Nov; first push after 1–3 |
| 8 | Evals and reflection: an `evals/` suite that scores the engine against what it promises (drafts are factual and lawful, the gate blocks what it must, matching on hard name pairs, no personal data leaves, docs agree with the code), and `docs/REFLECTION.md`, an honest account of what is built, what is tested and how, and what is weak | main session (agent `evals` for the suite) | agent `evals` running since 19:48; REFLECTION.md after it and the review |
| 9 | Admin screenshots of the fictional demo in place of the Week 2 ones (those show real companies and are kept out of git) | main session | with 6 |

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

# Reflection: what is built, how we know it works, and what is still weak

Written 19 November 2026, at the end of the build (design v1.1, 26 October to 25 November). It is meant
to be read before launch, by the owner and by whoever runs the engine. It says plainly what has been
shown and what has not.

## What is built

Everything in the design except the parts that need someone outside the code: a vendor key, two
mailboxes, the CA's sign-off, the lawyer's answers, the platform's endpoints, DLT for voice, and a
server. Those are listed, with how to check each, in `ops/WEEK4_ACTIONS.md`.

- **Data side (`ingest/`):** polite ingestion of the MCA monthly file and the two UP startup portals
  (robots.txt, pacing, budgets), the company knowledge base with matching of portal startups to
  companies, enrichment within monthly caps, the need engine (first-year deadlines and schemes),
  website discovery, and funding news.
- **Engine (`services/`):** the shortlist, drafted emails (templates, or an AI draft held to the same
  check), a quality check, a person's approval (with sample approval once agreement is shown), the
  compliance gate, sending, the inbox (replies, bounces, opt-outs), founder pages with a hash-chained
  consent ledger, reminders, WhatsApp and voice (both off until registered), attribution with a
  holdout group, campaigns, exports, backups, monitoring, the Admin pages, the MCP tools, and a
  demonstration database of 36 invented companies that shows every feature.

## How we know it works

- **Tests.** Both suites run against a real, throwaway MongoDB, never mocks of the database: Node
  (services) and Python (ingest), on this laptop and, on every push, on Linux in GitHub Actions. No
  test touches the network. The counts are in `docs/HANDOVER.md`.
- **Two code reviews.** The first (Phases 1 and 2, seven reviewers) and the second (everything built
  13 to 18 November, `docs/REVIEW_18NOV.md`). The second found seven defects, one serious: a campaign
  page let anyone claim any company and have the engine contact a stranger's phone. All seven are
  fixed with tests; a campaign claim now waits for the person to confirm their own email address.
- **Evals (`evals/`).** An outside-auditor scorecard, graded by checkers that do not reuse the
  engine's own code. The first run, and after the fixes it led to:

  | Eval | First run | After fixes |
  |---|---|---|
  | Facts in 71 drafts traced to their evidence | 100% | 100% |
  | Quality check catches deliberately broken drafts (24 kinds) | 59.6% | 99.9% |
  | Compliance gate decides 39 hard cases as expected | 36/39 | 39/39 |
  | Planted personal data reaching an outside service | 2 leaks (reply classification) | none |
  | Matching on 48 hard name pairs: wrong links; same-company pairs a person gets to see | 0; 29 of 34 | 0; 33 of 34 |
  | Websites confirmed right (30 cases); directories and social networks refused | 27/30; 22/23 | 30/30; 23/23 |
  | Docs agree with the code | 4 mismatches | 0 |

  The quality check matters most here: once sample approval is on, it is what stands between an
  AI draft and a founder. It now checks that each date belongs to its own deadline, that form names,
  sections and rupee amounts are exactly the ones in the evidence, that no other company or person
  is named, and that the email neither hurries nor threatens in any wording.
- **Seeing it.** The demo seed runs every feature through the engine's own code; the Admin and
  founder pages were checked by screenshots and at 375 pixels; `preflight` lists what is missing
  before launch.

## What has not been shown, and why it matters

- **Nothing has run against the real world yet.** No email has been sent through the real mailboxes,
  no vendor profile fetched, no reply read over IMAP, no platform sign-up received, no call placed.
  Every one of those is tested against a faithful stand-in, and `staging:smoke` will test the email
  loop end to end once a mailbox exists. The first week live should be watched closely, with sample
  approval off.
- **The reply classifier is only a regression test.** Its 160 test replies were written for the build
  and the rules were tuned on them. The measure that counts is real replies labelled in the Admin
  inbox (`eval:replies --real`), which only exist after launch.
- **No AI draft has been measured.** There is no LLM key yet, so every draft so far is a reviewed
  template. The quality check's 99.9% is the protection; the AI drafter itself should be judged on
  its first few hundred drafts before sample approval is switched on.
- **Matching links only what it is sure of.** It never linked two different businesses in the eval,
  and links about half of the deliberately hard pairs on its own; the rest go to a person. Spelling
  variants of the same name (Laxmi and Lakshmi, Shri and Shree, doubled vowels) now reach the review
  queue, never an automatic link, so 33 of the 34 same-company pairs are either linked or put to a
  person. The one still missed is a name written in Devanagari against its registered English
  spelling: that needs a transliteration step, the next improvement here.
- **The rules are provisional.** Deadlines and schemes are shown to founders only after the CA confirms
  them; until then nothing about them is sent.
- **Legal questions are open.** The Hindi wording, writing to addresses on companies' own websites, and
  the follow-up's new "why you are getting this" line wait for the lawyer (the review pack is rebuilt
  from the templates, so it shows the current text). Both switches stay off until then.
- **Two news sources do not answer.** Entrackr's feed address returned 404 and GDELT's robots.txt was
  unreachable from the laptop (owner action 27).
- **Small things the evals still show.** One mutated draft in 1,333 (a real amount moved from one scheme
  to another) still passes the check. Every template email carries the sender's website in its
  signature, a third link the evals count; it is kept on purpose, so a founder can check who is writing,
  and the quality check allows that one link and no other.

## What I would do next

1. Launch the email loop on staging (`staging:smoke`) the day a mailbox exists, then the first real
   week with every draft approved by a person.
2. Label the first 100 real replies and run `eval:replies --real`; tune nothing on them.
3. Transliterate Devanagari portal names before matching, and re-run `evals/ingest_matching.py`.
4. Re-run `node evals/run.mjs` after every change to drafting, the quality check or the gate; it
   takes 15 seconds.

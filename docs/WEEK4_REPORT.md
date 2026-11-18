# Phase 4 report: replies, voice, attribution and launch

**Period:** 16 – 25 November 2026 (built ahead of schedule, 2 November). **Prepared by:** Gourav Bathwal.
**Status:** code complete and tested. No founder has been contacted, by design. What holds every message until people say otherwise:
- the CA's sign-off on the rules;
- the mailboxes' warm-up, which ends on 18 November;
- the outbox, which writes emails to files until the mailboxes are configured for sending.

Voice is built and tested but switched off (`config/voice.json`, `enabled: false`) until the DLT registration, the 140-series number and a signed-off call script are in place. Until then, a founder who asks for a call is called back by a person.

The owner actions are in `ops/WEEK4_ACTIONS.md`; the handover notes and the walkthrough in `docs/HANDOVER.md`.

**Tests: 449, all passing** (196 Node.js, 253 Python), up from 411. Phase 4 adds 34 Node.js tests, 4 Python tests and four test sets. Among the new tests is one journey through the whole engine over HTTP: email, reply, inbox, claim, call back, payment, results, MCP and monitor.

---

## What was planned

From the design document, section 12, Phase 4 covers:
- the Sarvam voice agent for opted-in call backs;
- reply classification;
- payment and service-request attribution;
- monitoring, alerts and the four test sets;
- an end-to-end test on staging;
- the first approved emails to October's UP companies from 18 November, at warm-up volume;
- handover notes and a walkthrough.

Phase 3 also left three things for this phase: reading replies and bounces from the mailboxes, new-need messages, and the MCP tools of design 7.5.

## What was built

| Item | Where | Tests |
|---|---|---|
| **Reading the mailboxes**: a small read-only IMAP client (EXAMINE and BODY.PEEK, so the mailbox never changes); replies, bounces, complaints and automatic replies told apart and acted on | `services/src/inbound/` (`imap.js`, `parse.js`, `process.js`) | 9 |
| **Reply classification**: rules in English, Hindi and Hinglish, then the small AI model only when the rules are unsure; only a clear opt-out or a clear "wrong address" acts by itself | `inbound/classify.js` | 4 and the reply set |
| **The Admin inbox**: replies waiting for a person, ordered by what they asked for, with the engine's label and next step; a person relabels and marks each one dealt with | `admin/inbox.js`, `admin/views.js` | in the page and journey tests |
| **New-need messages**: when a deadline or scheme that no email mentioned starts to apply, one message about it, at most once, 30 days after the last | `outreach/sequence.js`, `templates.js` | 1 |
| **Call backs by the AI voice agent**: the claim form's "call me back", the call gate, the Sarvam call, its signed outcome, one retry, "stop" withdraws the consent | `services/src/voice/`, `public/` | 4 |
| **Platform events and attribution**: signed sign-ups, service requests and payments, each linked to its lead and to what the engine did before it | `services/src/attribution/events.js` | 1 |
| **Results**: the month's shortlist against its holdout with an honest interval, cost per result, channel health | `attribution/results.js`, the Results page | 1 |
| **Monitoring**: hourly checks with alerts that open, last and resolve; a CloudWatch metric line; the team's daily summary | `services/src/monitor/` | 2 |
| **MCP tools** for Mr. AI and the team: lead search, company profile, deadline calendar; read-only and company-level | `services/src/mcp/server.js` | 1 and the journey |
| **Erasure**: one command removes a person everywhere and keeps only the hashed key | `services/src/privacy/erase.js` | 1 |
| **The four test sets** | `data/testsets/`, `services/src/eval/`, `ingest/src/leadengine/evalsets.py` | 4 |
| **Parquet exports** for DuckDB, with no personal data | `ingest/src/leadengine/export.py` | 1 |
| **The staging run**: a fictional test company addressed to our own inbox, in a database of its own, with the warm-up skipped there only | `services/src/ops/staging.js` (`staging:seed`, `staging:clear`) | 1 |
| **The legal review pack**: every text founders will see and hear, taken from the code, with what we keep and nine questions for the lawyer | `ops/legal/`, `docs/legal/` | built and checked against the quality check |
| **WhatsApp webhook**: STOP, replies, delivery reports, template pauses | `outreach/whatsapp_hooks.js`, `public/server.js` | 1 |
| **Scheme alerts** for founders who asked | `outreach/reminders.js` | 1 |
| **Unsuppress** at the owner's request, and **retention** of bought data | `privacy/unsuppress.js`, `ingest/src/leadengine/retention.py` | 2 |
| **Schema**: three new collections (`inbound`, `calls`, `alerts`), now 24 collections and 68 indexes | `schema/collections.json` | in the schema tests |

## How a reply is read

Every ten minutes `lead-engine inbox:read` opens each mailbox read-only and fetches the emails after the last one it read. Each one is matched to the email it answers:
1. by its In-Reply-To or References header;
2. for a bounce, by the original Message-ID inside the delivery report;
3. otherwise by the sender's address.

Then:

| It is… | What happens |
|---|---|
| a **hard bounce** (status 5.x.x) | the address is suppressed, the message marked bounced, and the bounce counts against the mailbox at once |
| a **soft bounce** (4.x.x) | counted, nothing more |
| a **complaint** (an abuse report) | the address is suppressed, outreach to the company stops, the lead is closed |
| an **automatic reply** | kept, and nothing else: an out-of-office does not stop the follow-up |
| a **reply** | a "replied" activity ends cold outreach to the company; queued drafts and sends are cancelled; the reply is classified and waits in the Admin inbox |
| **anything else** (warm-up mail, newsletters) | listed as "Other mail" with its subject and masked sender; its text is not kept |

A bounce or complaint about mail the engine did not send (warm-up mail) never counts against a mailbox.

**What acts by itself.** Only two labels act without a person, and only at 80% confidence or more: an opt-out ("unsubscribe", "not interested", "मेल मत भेजो") and a wrong address ("I am the CA who incorporated it"). Both suppress the address. Every other reply waits for a person, whatever its label; the label only orders the queue and suggests the next step.

A reply's text and the sender's address are personal data:
- viewers see neither;
- reviewers see them on the reply's own page, and each view is written to `audit_log`;
- everything is removed after 400 days.

## Call backs

The claim form has a fourth choice:

> "Call me back at the number above about {company}'s filings. The call may come from SolutionAI's AI assistant, which will say so at the start; I can ask for a person at any time."

The founder chooses a time of day and Hindi or English. The consent is written to the ledger with those exact words (claim wording `claim-v2`), and a call is queued for the next calling window.

Before every call, the gate checks:
1. **Consent:** still granted, and the number not suppressed.
2. **The agent is live:**
   - switched on in `config/voice.json`;
   - Sarvam configured;
   - the caller number a DLT 140- or 1600-series number;
   - the script signed off, and its opening line saying, as whole words, that it is an "AI" from "SolutionAI".
3. **The time:** inside the founder's chosen time and the calling window (10:00–19:00 IST, Monday to Saturday). The engine refuses any configured window outside TRAI's 09:00–21:00.
4. **The caps:** one of the month's 50 calls and the longest call's minutes are reserved.

If check 2 or 4 fails, the founder is not left waiting: the call goes on the Admin Calls page for a person to make.

**Sarvam.** The call goes out through Sarvam's instant-outbound API, with Exotel as the telephone line behind it. Sarvam does not sign its webhook, so the engine signs each call itself: the call's id and an HMAC go into the call's metadata, and a report whose signature or attempt id does not match a call the engine placed is refused.

**After the call:**
- the minutes and the cost are settled from the real duration;
- no answer or busy: one more attempt the next day;
- "stop": the consent is withdrawn in the ledger;
- the founder asked for a person, or was interested: the call goes to the Calls page.

## Attribution and results

The platform sends sign-ups, service requests and payments to `POST /api/events`, signed with `PLATFORM_EVENTS_SECRET` (`docs/PLATFORM_CONTRACTS.md`, section 4). Each one:
- is recorded once, whatever the platform resends;
- is linked to the company's lead and its holdout flag, and to what the engine did before it (contacted or not, the first and last touch, the days since the first email);
- makes the lead a customer when it is a payment, holdout or not.

Only the fields in the contract are kept; nothing about the person who paid.

The **Results** page compares a month's shortlist with its holdout: the companies that would have been on it but were drawn into the holdout and never contacted. For each group it shows how many companies:
- were contacted, opened their page, replied and claimed it;
- signed up, raised a service request and paid.

It also shows the difference in the paying rate, with a 95% interval by Newcombe's method, which behaves at small numbers. Until the holdout has 30 companies and the two groups 10 paying clients between them, the page says "Too early to tell". The design expects the holdout to grow by about 20 companies a month, so that is two or three months away.

Beside it:
- **the month's cost:** AI, WhatsApp and voice from their meters, vendor profiles at ₹5, and the fixed costs in `config/monitor.json`, divided per shortlisted company, per engaged company and per paying client;
- **channel health:** bounces and complaints per mailbox against the pause limits, today's sends against the cap, WhatsApp template status and quality, calls and their outcomes, replies by label.

## Monitoring

`lead-engine monitor` runs every hour. It opens an alert for:
- jobs that failed for good, or are overdue (the worker is not running);
- a draft, a reply or a call back waiting too long for a person;
- bounce or complaint rates near the pause limits, or a mailbox paused;
- an email whose send was interrupted;
- a WhatsApp template paused or falling in quality;
- a monthly cap 80% used;
- the nightly batch or a weekly portal crawl stale, partial or failed;
- failed AI calls;
- a consent ledger that does not verify.

A problem that lasts is one alert, not one an hour; it resolves itself when the problem goes. Each run also prints one JSON line; the CloudWatch agent ships the log, and a metric filter on it turns open critical alerts into a metric and an alarm, with no AWS call from the engine (`ops/deploy/README.md`).

Open alerts show at the top of Data health. `lead-engine summary --send` mails the team, every morning at 08:00:
- yesterday's numbers;
- what waits for a person;
- the month's spending against the caps;
- the open alerts.

On the development data the monitor raised one real alert at once: the last UP Startup Mission crawl (26 October) was partial.

## MCP tools

The design (7.5) asks for a few tools so Mr. AI and the team can use the same data. There are three, over the Model Context Protocol: `lead-engine mcp` on stdin/stdout for a desktop client, or `POST /mcp` on the Admin server with an access token.

| Tool | What it returns |
|---|---|
| `search_leads` | UP companies by name, district, stage or shortlist month. Holdout companies are never returned: they must not be approached |
| `company_profile` | one company's public facts, stage, fit score with its reasons, schemes, and whether the engine may contact it |
| `deadline_calendar` | the filing calendar with the law and source of each date, and a warning not to state the dates as fact until a CA has confirmed the rules |

All three are read-only and company-level: no director, contact detail, consent or message is ever returned. Which tools Mr. AI gets is for the platform team to agree (section 14 of the design).

## The four test sets

| Set | What | Result |
|---|---|---|
| **Matching** (Phase 2) | 718 self-test cases and 4,000 leave-one-out cases; 190 pairs waiting for a person to label | 0 wrong links |
| **Extraction** | 200 stored pages: 60 Startup in UP directory pages, 60 profiles, 50 UPSM API pages, 30 incubator pages. Each parser's output is recorded as hashes of each field, never the values | 200 of 200 unchanged. A regression test: it says when a parser change alters what is read |
| **Quality check** | 360 clean drafts (60 fictional companies × first email, follow-up and new-need × English and Hindi), each broken in 20 known ways | 7,080 of 7,080 faults caught, 0 clean drafts refused (after the two fixes below) |
| **Reply classification** | 161 replies written for the build, in English, Hindi and Hinglish, each labelled | 100% on the set the rules were tuned on. **57.5% on 40 replies the rules had not seen** (rules v2), with 0 wrong suppressions |

The honest reading of the last row:
- The rules alone recognise about half of the replies they have not seen. Almost every miss falls to "unclear", which a person reads anyway, so a miss costs a person's time, not a founder's trust.
- No reply that wanted to hear from us was ever suppressed, in either set.
- The AI classifier is asked whenever the rules are unsure; it is measured with `eval:replies --ai` once the gateway has a key.
- The number that counts comes from real replies: people label them in the inbox, `inbox:export-labels` writes them to `replies_real.jsonl`, and `eval:replies --real` measures against them. Those replies are never used to tune the rules.

## Defects found and fixed during the build

| Defect | Where | Fix |
|---|---|---|
| The quality check's opt-out rule was satisfied by the unsubscribe link alone (its placeholder contains the word "unsubscribe"): a draft with no opt-out sentence passed. Phase 3 had this | `outreach/qc.js` | the sentence must be there in words; 360 of 360 such drafts now caught |
| A full first email (three dates, two schemes) from the reviewed template is 237 words in English and 260 in Hindi; the 230-word limit sent it to "failed the check". Phase 3 had this | `config/outreach.json` | limits per kind and per language (250 and 285 for a first email) |
| The call script check counted "SolutionAI" as saying "AI", so an opening that never said it was an AI would have passed | `voice/calls.js` | whole words only |
| An email with only "unsubscribe" in the subject, which is exactly what the List-Unsubscribe mailto in every email sends, was read as "unclear" | `inbound/classify.js` | an opt-out, at once |
| "Please call me after 3 pm" was read as "not now" (a rule took "after 3" for a date), found on the screenshots | `inbound/classify.js` | a date needs a date ("after the 15th"); stronger interest wins |
| The MCP server closed the database when its input ended, before answering what was still in flight | `mcp/server.js` | it finishes every pending answer first |
| The monitor watched a run called "need", which does not exist (the need engine runs inside "nightly") | `config/monitor.json` | it watches the nightly batch and the weekly crawls by their real names |
| With eight links, the Admin menu widened every page by 77 px at 360 px (hidden "waiting" text escaped the menu's scroll box), and wrapped on laptops | `admin/style.css` | contained; one line on laptops |
| There was no single way to honour an erasure request, and Phase 4 adds reply text and call transcripts | `privacy/erase.js` | `lead-engine erase` |
| A worker that died while handing a call to Sarvam would have left it "calling" for ever, with its outcome report refused | `voice/calls.js` | marked "check with the provider" for a person, and never placed again (like an email's interrupted send) |

## Every promise to a founder, checked against the code

Before launch, each thing the pages, emails, templates and notice tell a founder was traced to the code that keeps it. Four were not kept, and are now:

| What founders are told | What was missing | Now |
|---|---|---|
| "Reply STOP to stop these reminders" (every WhatsApp template), "reply STOP on WhatsApp" (the claim form) | nothing read WhatsApp messages: a STOP would have been ignored | Meta's webhook (`/hooks/whatsapp`, signed with the app secret): STOP in English, Hindi or Hinglish withdraws every WhatsApp consent for the number, cancels queued reminders and confirms in one line; any other message goes to the Admin inbox; a template Meta pauses stops at once |
| "Email me when {company} may qualify for a government scheme" (a claim-form choice) | nothing ever sent it | scheme alerts: one email per scheme that starts to apply after the claim, at most two a month, through the platform's mail (`PLATFORM_CONTRACTS.md` 3.2) |
| "If this was a mistake, reply to any of our emails and a person will put it right" (the unsubscribe page) | no one could: the list has no remove, by design | `lead-engine unsuppress`, by an admin, with the owner's words as its note; never for an erasure request, a complaint or a hard bounce; it does not restart cold email |
| Design 7.7: bought data on companies never contacted is deleted after 12 months; erasure removes a person "everywhere" | neither was built, and the vendor's raw answers (kept exactly, so they can hold a person's own email) were outside the erasure | `leadengine privacy retention [--apply]`, monthly; `leadengine privacy erase-raw <CIN>` after an erasure that names a company |

## Ready for launch day (13 November)

| Tool | What it does |
|---|---|
| `lead-engine preflight [--live]` | the go/no-go check: every setting, secret and outside service. With `--live` it also signs in to SMTP and IMAP (nothing is sent), looks up MX, SPF, DMARC and DKIM, and calls the pages' health check and Meta's API. Each line says what to fix |
| `ops/deploy/` | the server kit: setup script, three systemd services, the schedule, log rotation, CloudWatch, secrets from Parameter Store, a ship script from the laptop, a proxy example |
| `docs/platform-openapi.yaml` and `lead-engine platform:check` | the platform contracts as an OpenAPI spec, and a command that tests Murari's endpoints against it; events with an id starting `test_` are checked but never recorded |
| `lead-engine whatsapp:templates --submit` | sends Meta the four templates with the real address and full example links, as Meta requires |

On this laptop today the check says NOT READY, with 8 blockers, all outside items: October's MCA file, the CA's sign-off, the vendor key, the warm-up (ends 18 November), the two mailboxes, the pages' address and the privacy notice.

## Built while the outside items are pending (13 to 16 November)

Everything that does not wait on a key, a mailbox, an approval or the platform team:

| What | How it works | Tested by |
|---|---|---|
| `staging:smoke` | the whole email loop between the two real mailboxes in one command on a staging database: draft, the 18 checks, approval, the gate, the real SMTP send, delivery with its headers, links and DKIM, a reply, the engine reading and labelling it, the page and the one-click unsubscribe | a run with stand-in mailboxes; the live run waits on the mailbox passwords |
| Admin sign-in through the platform | either the platform's proxy signs who the person is on each request (method, path and query, user, role, time; good for two minutes), or the portal's backend uses a service token and names the person in `X-Acting-User`, never above the token's role. Either way the audit log records the person | 6 tests: wrong path, query, method, role, secret and an old time are all refused and throttled; CSRF and origin checks on proxied forms |
| The MCA inbox and upload page | an admin uploads the month's file; the nightly loads it first, by SHA-256 never twice, refuses a workbook with no companies, and files it under `loaded/<month>/` or `failed/` with the reason | 3 Python and 5 Node tests, including a binary multipart body and a 40 MB upload refused |
| Bulk export with a second admin | design 7.11: asked for with a reason, approved by another admin, downloaded by the person who asked within 24 hours, every download logged. Company-level only, never the holdout; a company email only when it is not a person's and has not opted out; spreadsheet formulas neutralised | 4 tests |
| Label pairs | the matcher's own links (held-out fold first, by the same SHA-1 rule as `kb eval`) and 100 near misses, decided in the Admin pages; precision with its 95% interval shown as labels come in | 2 tests; the fold checked against Python on 200 keys |
| The founder pages in Hindi | the company page, the claim form and the thank-you page in Hindi, with a link between the languages. A draft for the lawyer: until `claim.hindi` is approved in `config/outreach.json`, Hindi is only a preview marked as a draft whose form cannot be sent, and the server refuses a Hindi claim. A consent given in Hindi is recorded with the Hindi words exactly as shown and the version `claim-v2-hi`. The legal pack shows the Hindi beside the approved English | 2 tests; English output unchanged (every earlier test of the wording passes) |
| Funding news | design 7.1 and 7.4, "Signals": startup news feeds and a GDELT search read daily through the polite fetcher; a funding headline that names exactly one UP company becomes a proposed signal; a reviewer confirms or rejects it (logged first); confirmed news on the company page; only link, headline, publisher and date kept. First live run: 44 items, 18 funding headlines, none yet about a UP company in the knowledge base; Entrackr's feed and GDELT need a look (actions item 27) | 12 Python tests, 4 Node tests |
| Company websites and the addresses on them | design 7.1 and 7.3: shortlisted companies with no known website are searched through a search API's free tier (Google Programmable Search or Brave), again at day 7, 30 and 90; a result is the company's site only if its domain carries the company's distinctive name and its home page names the company; directories and social networks never count. The site's contact pages are read through the polite fetcher for a role address on the company's own domain and a contact form; a person's address is never kept. Using those addresses for a first email is a switch, off until the lawyer has seen the changed last paragraph (legal pack, section 2 and question 2) | 4 Python tests, 3 Node tests |
| Sample approval | design 7.5: the agreement between the quality check and the reviewers is measured on their real decisions; sample mode (20% still to a person, at random) takes effect only with 100 decisions at 95% agreement and a person's recorded switch-on, and falls back to every draft by itself | 4 tests |
| Address checks before a first email | design 7.3: format, throwaway domains, MX, and an optional verification service (ZeroBounce or MillionVerifier, within the monthly cap); accept-all domains held out of the first wave; results cached 30 days under a keyed hash, never the address | 6 tests |
| Campaign landing pages | design 3, item 5: `/j/<code>` lets a founder find their company by name or CIN and open its page; only signed search results can be opened; visits, claims, sign-ups, payments and revenue per campaign on Results. After the 18 Nov review, a claim from a campaign page is completed only once the person confirms the email address they gave (the link works once, 48 hours), so nobody can claim a stranger's company or give a stranger's number for a call back | 2 end-to-end tests |
| AI check on unsure matches | design 7.2: the model's yes, no or unsure with a reason, beside each candidate on the review queue; advice only; company facts only (never a team member's name); every call logged within the AI cap | 1 test |
| Backups and restore | the engine's own: every collection nightly and, hourly, what cannot be rebuilt (consents, opt-outs, audit log, people, emails, replies, calls, decisions), as gzipped Extended JSON with a manifest of counts, checksums and the consent ledger's head, copied to an encrypted S3 bucket that expires them after 35 days. Restore only into a new, empty database, checking every file, the counts and the ledger's hash chain. The monitor alerts when backups stop | 5 tests; a drill on this laptop's database: 73,742 documents backed up and restored, all checks passed |
| The audit log page | Data health, Audit log (admins only): every sign-in, refusal, view of personal data, decision, export, upload and erasure, filtered by action, person and day. Reading it is itself logged | 1 test |
| Monitor and summary | alerts when last month's MCA file is not in by the 6th, when an uploaded file could not be read, and when an export waits 48 hours; the daily summary lists exports waiting | 2 tests |
| `demo:seed` and `demo:serve` | the walkthrough on 36 invented companies taken through the engine's own code, with stand-ins for mail, voice and the platform; every page under a "Demonstration data" banner | 5 tests: every Admin page shows something, every address is on `.example` |

Every new page was checked at 375 px wide: none scrolls sideways (a hidden label inside a table could push the page out; scroll boxes now contain their contents).

## Accessibility

Eight new or changed pages were checked in Chrome with axe-core (WCAG 2.2 AA):
- the claim form with the call-back choice;
- Inbox and a reply;
- Calls, a call and a call waiting for a person;
- Results;
- Data health with alerts.

Each was checked in light mode, dark mode and at 360 px wide. Result: 0 violations and no sideways scrolling. A claim with a call back was also made end to end in the browser, and its call was queued for the founder's chosen afternoon.

Screenshots of a fictional company: `docs/img/phase4-inbox-reply.png`, `phase4-call.png`, `phase4-results.png` and `phase4-claim-callback-phone.png`.

## On the real data

On the development database:
- **`outreach:plan`** for October: 200 shortlisted companies, 0 with a registered email. The emails come with the vendor profiles, which still wait for the vendor key.
- **`results`** for October: 200 shortlisted against 24 holdout companies, nothing contacted yet, "too early to tell".
- **`monitor`:** one real alert (the partial UPSM crawl).
- **`mcp`:** answers lead searches and calendars for the real shortlist.
- **`export parquet`:** writes 12,734 leads and companies, which DuckDB reads.
- **`eval extraction`:** 200 of 200 pages unchanged.

## Decisions taken in the code

- **Mailboxes are only read, never changed.** IMAP EXAMINE and BODY.PEEK leave every email unread for the person who answers it in Zoho.
- **Only an opt-out or a wrong address acts by itself.** Interested founders, questions and "not now" always go to a person. The engine never writes back.
- **Calls are never cold.** A call goes only to a founder who ticked "call me back", inside their chosen time, with an opening line that says it is an AI and offers a person. "Stop" on a call withdraws the consent.
- **When the agent cannot call, a person does.** A founder who asked for a call is never left waiting because DLT is late.
- **Holdout companies are never returned by lead search,** so no one approaches them through another door.
- **Exports carry no personal data:** each column is listed on purpose, so a field added later cannot leak.

## What waits on others

See `ops/WEEK4_ACTIONS.md`. In short:
1. the IMAP passwords (the same Zoho app passwords) so replies are read;
2. Sarvam and Exotel accounts, the DLT registration and 140-series number, and the script sign-off, before voice is switched on;
3. the platform's events and `PLATFORM_EVENTS_SECRET`;
4. the team's summary addresses (`SUMMARY_TO`), the CloudWatch agent and the export bucket;
5. the legal review, now with a ready pack (`docs/legal/SolutionAI_Lead_Engine_Legal_Review_Pack.pdf` and `.docx`) that also covers the call-back wording and the call script;
6. the Week 2 and Week 3 items that still hold the first email: the vendor key, the CA's sign-off and the mailbox set-up.

## After 25 November

The engine runs every month, as the design says (section 12):
- the MCA file is uploaded;
- the nightly batch builds the shortlist;
- people approve drafts and answer the inbox and the calls;
- the Results page grows.

`docs/HANDOVER.md` is the runbook.

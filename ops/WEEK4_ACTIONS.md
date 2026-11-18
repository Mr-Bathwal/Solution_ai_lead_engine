# Phase 4: what needs a person (16 – 25 November)

The code for Phase 4 is built and tested (`docs/WEEK4_REPORT.md`). The items below switch it on. The Week 2 and Week 3 items continue, and three of them still hold the first email:
- the vendor key and profiles;
- the CA's sign-off on the rules;
- the mailboxes, configured for sending.

| # | Action | Who | By | Cost | Done when |
|---|---|---|---|---|---|
| 1 | Let the engine read the two outreach mailboxes | Gourav | Mon 16 Nov | free | `node src/cli.js inbox:read` shows `read` for both mailboxes, not `skipped` |
| 2 | Platform: send sign-ups, service requests and payments to the engine | Murari's team | Fri 20 Nov | — | a signed test event returns `{"received": 1, "failed": 0}` (`docs/PLATFORM_CONTRACTS.md`, section 4) |
| 3 | The daily summary, the monitor and the exports on the server | Gourav | Mon 16 Nov | free (CloudWatch free tier, a few MB in S3) | the first summary arrives at 08:00; `lead-engine monitor` appears in CloudWatch |
| 4 | An end-to-end run on staging, to our own addresses | Gourav and one reviewer | Tue 17 Nov | free | the checklist in section 4 is ticked |
| 5 | The first approved emails, at warm-up volume | Gourav and one reviewer | from Wed 18 Nov, after the Week 3 items | free | the approval queue and the inbox are empty each evening |
| 6 | Voice: Sarvam and Exotel accounts, DLT registration and a 140-series number | Sujas (company documents), Gourav | as soon as DLT allows | number rental and DLT fees to confirm before committing (design 10) | `VOICE_CALLER_NUMBER` is the registered number |
| 7 | Sign off the call-back wording and the call script | Sujas, with the lawyer of Week 3 item 6 | before voice goes live | part of the same review: the legal review pack covers it | `script.approved_by` and `approved_on` are set in `config/voice.json` |
| 8 | Switch the voice agent on | Gourav | after items 6 and 7 | about ₹3.90 a minute, at most 50 calls and 150 minutes a month | `enabled: true`, and a test call to our own number connects and reports back |
| 9 | Agree which MCP tools Mr. AI gets, and register them | Murari's team | Wed 25 Nov | free | Mr. AI answers "what are the next dates for <CIN>?" from `deadline_calendar` |
| 10 | Label the real replies | the reviewers | ongoing, from the first reply | free | each reply is marked dealt with; `inbox:export-labels` once there are 100 |
| 11 | The walkthrough | Gourav with Sujas and Murari's team | Wed 25 Nov | about 45 minutes | `docs/HANDOVER.md`, section "The walkthrough" |
| 12 | Point Meta's webhook at the engine, before the first WhatsApp message | Gourav | with Week 3 item 4 | free | a test "STOP" from our own phone shows on `/admin/inbox` as handled, and its confirmation arrives |
| 13 | Run the monthly retention | Gourav | from 1 December | free | `privacy retention` dry run read, then `--apply` (section 13) |
| 14 | Put the engine on the server | Gourav, with server access from Murari's team | as soon as access is given | free | `ops/deploy/ship.sh` has run and `preflight --live` lists only outside items |
| 15 | Build the platform endpoints to the spec | Murari's team | Fri 20 Nov | — | `platform:check` passes for each (`docs/platform-openapi.yaml`) |
| 16 | Download October's MCA incorporation file | Gourav | now | free | uploaded on Admin, Data health, MCA file (or copied into `data/mca/inbox`); the next nightly loads it and makes November's shortlist |
| 17 | Choose how the Admin pages sit inside the platform: signed headers from the proxy, or a service token | Murari's team, with Gourav | Fri 20 Nov | free | `docs/PLATFORM_CONTRACTS.md`, section 2: `admin:platform-headers` gives a request that their proxy's headers must match, or `admin:service` makes their token |
| 18 | Label the 190 match pairs | the reviewers | before 25 Nov | free | Admin, Review, Label pairs: precision on the held-out links shown with its interval; `leadengine kb eval` agrees |
| 19 | Rehearse the walkthrough on the demonstration database | Gourav | Tue 24 Nov | free | `demo:seed`, then `demo:serve`; section 11 below |
| 20 | Review the Hindi company page and claim form | the lawyer of Week 3 item 6, with a native Hindi reader | with the legal review pack | part of the same review | the pack's section 5, "The claim form in Hindi", answered; then `claim.hindi.approved_by` and `approved_on` set in `config/outreach.json`, and English pages show "हिन्दी में पढ़ें" |
| 21 | Make the backup bucket, and restore a backup once | Gourav, with server access | with item 14 | under ₹50 a month | `ops/deploy/README.md` step 7; `preflight` shows both backup lines as PASS; one restore into a scratch database says `"ok": true` (`docs/HANDOVER.md`, "The database is lost") |
| 22 | Choose an email verification service and give its key | Gourav | before the first wave grows past warm-up | free credits, then about ₹0.30 an address, at most 200 a month (`caps.json`) | `EMAIL_VERIFY_PROVIDER` and `EMAIL_VERIFY_API_KEY` set; `node src/cli.js verify:email <our own address>` answers `deliverable`; `preflight` shows "address checks" as PASS |
| 23 | Make the first campus campaign | the campus team, with Gourav | when the first E-Cell or fest is agreed | free | a campaign in `config/outreach.json` (`campaigns`), its link `PUBLIC_BASE_URL/j/<code>` on the poster or QR code, and its row on Results |
| 24 | After 100 reviewer decisions: look at the agreement, and decide on sample approval | Sujas and Gourav | from about mid-December | free | `node src/cli.js approval:agreement`; if 95% or more, set `approval.mode` to `sample` with `switched_on_by` and `switched_on_on` (`docs/HANDOVER.md`, "Approving a sample") |
| 25 | A search API key for finding company websites | Gourav | any time | free tier (Google Programmable Search or Brave), at most 1,000 searches a month (`caps.json`) | `WEB_SEARCH_PROVIDER` and `WEB_SEARCH_KEY` set; `leadengine enrich search-probe "<a company>"` answers; the nightly's `websites` step reports `searched` |
| 26 | Approve (or not) writing to addresses on companies' own websites | the lawyer, then Sujas | with the legal review pack | part of the same review | question 2 of the pack answered; if yes, `recipient.use_website_email` set to `true` in `config/outreach.json` |

## 1. Reading the mailboxes

The Zoho app-specific passwords made for SMTP (Week 3, item 1) also work for IMAP. Nothing more is needed unless you want separate passwords:
```
IMAP_HOST=imap.zoho.in
IMAP_PORT=993
MAILBOX_1_IMAP_PASSWORD=<optional, a separate app password>
```
- In Zoho Mail settings, make sure IMAP access is on for both mailboxes (Settings → Mail Accounts → IMAP).
- The engine only reads: emails stay unread for whoever answers them in Zoho.
- If the warm-up tool files its mail into a folder of its own, leave it there. The engine reads only `INBOX` (`inbound.folder` in `config/outreach.json`).

## 2. Platform events

Murari's team sends `POST https://<admin host>/api/events`, signed with `PLATFORM_EVENTS_SECRET`. The shape is in `docs/PLATFORM_CONTRACTS.md`, section 4.
1. Make the secret: `openssl rand -hex 32`.
2. Put it in both `.env` files: the engine's and the platform's.
3. The engine needs the company's CIN or LLPIN in each event. The claim hands it to the platform at sign-up (section 3.1), so a founder who came through the engine already has it on their profile.

## 3. Summary, monitor and exports

In `.env`:
```
SUMMARY_TO=owner@solutionai.in,you@solutionai.in
EXPORT_S3_URI=s3://<bucket>/lead-engine/exports
```
The schedule is in `ops/SCHEDULE.md`:
- `inbox:read` every 10 minutes;
- `monitor` hourly;
- `summary --send` at 08:00;
- `export parquet` at 05:30, then `aws s3 sync`.

**CloudWatch:** install the CloudWatch agent with `ops/deploy/cloudwatch-agent.json`, then create the metric filter and the alarm with the two commands in `ops/deploy/README.md`. The alarm emails the team when a critical alert is open, or when the monitor stops reporting.

## 4. Staging, end to end

On the server, in a database of its own, with a fictional test company whose registered email is one of our own addresses:
```bash
cd /opt/ai-lead-engine/services
export LEAD_DB=solutionai_leads_staging          # must end in _staging: the commands refuse anything else
node src/cli.js staging:seed --email staging@solutionai.in
export CAPS_FILE=data/staging/caps.json          # written by staging:seed: today's caps with the warm-up over
OUTREACH_TRANSPORT=smtp node src/cli.js worker   # in one terminal; and pages and admin in two more
node src/cli.js outreach:plan
```
The warm-up holds every real email until 18 November; the staging caps let the test email through on the 17th. `CAPS_FILE` is refused for any database that does not end in `_staging`, so the real engine can never send with the warm-up skipped. Then, with `PUBLIC_BASE_URL` set:
- [ ] `outreach:plan` drafts the email; approve it in `/admin/approvals`.
- [ ] It arrives in our inbox, with the From name, the company page link and a working unsubscribe link.
- [ ] Gmail's "Show original" says SPF, DKIM and DMARC pass.
- [ ] Reply "What are your charges?": within 10 minutes it is in `/admin/inbox` as Interested, and the follow-up is cancelled.
- [ ] Open the page and claim it with a call back: the call is on `/admin/calls` for a person (voice is still off).
- [ ] Send a test event from the platform: `/admin/results` counts the payment.
- [ ] Click unsubscribe on a second test email: `lead-engine check email <address>` says BLOCKED.
- [ ] Erase the test person: `lead-engine erase email <address> --by <you>` with an admin `MONGODB_URI`.
- [ ] `lead-engine monitor` shows no critical alert, and the summary arrives the next morning.
- [ ] `node src/cli.js staging:clear` drops the staging database.

`services/test/phase4.test.js` ("one journey through the engine") runs the same steps against a throwaway database on every test run.

## 5. The first emails

From 18 November, each working day:
1. **Morning:** open `/admin/approvals`. Read each draft beside its evidence pack and approve, edit or reject it. Approved emails go out from 10:00 at warm-up volume: 25 a day per mailbox, 30 from 25 November.
2. **Afternoon:** open `/admin/inbox`.
   - Answer each reply from the mailbox itself.
   - Then mark it dealt with, correcting the label if the engine got it wrong. Your labels become the real test set.
3. **Calls:** open `/admin/calls` and make the calls listed there, or follow them up.
4. **Before leaving:** the summary and Data health should show no critical alert.

## 6–8. Voice

1. Open a Sarvam account and build the call-back agent in Sarvam's dashboard from `script.agent_brief` in `config/voice.json`:
   - it must set the variable `outcome` at the end of each call;
   - publish it, and note the app id and version.
2. Connect Exotel to Sarvam as the telephone line, with the DLT-registered 140-series number (Exotel handles the DLT and operator paperwork). Note the connection id.
3. In `.env`: `SARVAM_API_KEY`, `SARVAM_ORG_ID`, `SARVAM_WORKSPACE_ID`, `SARVAM_APP_ID`, `SARVAM_APP_VERSION`, `SARVAM_CONNECTION_ID`, `VOICE_CALLER_NUMBER`.
4. After the review, set `script.approved_by` and `approved_on`, then `enabled: true`. The engine refuses to call if any of these is missing, and says why on the Calls page.
5. Make one test call to our own number:
   - the opening line must say it is SolutionAI's AI assistant;
   - the call must appear on `/admin/calls` with its outcome and transcript within a minute.

If the DLT fees are high for our volume, leave `enabled: false`. Founders who ask for a call are then called by a person, from the Calls page (design 7.6).

## 12. Meta's webhook

Every WhatsApp template and the claim form tell founders to reply STOP to stop. The engine reads those replies through Meta's webhook:
1. In the Meta app (App Dashboard → WhatsApp → Configuration → Webhook), set the callback URL to `https://<PUBLIC_BASE_URL>/hooks/whatsapp`.
2. Set the verify token to the value of `WHATSAPP_VERIFY_TOKEN` (`openssl rand -hex 16`).
3. Subscribe to the fields `messages`, `message_template_status_update` and `message_template_quality_update`.
4. Put the app secret (App Dashboard → Settings → Basic) in `WHATSAPP_APP_SECRET`. The engine refuses any event not signed with it.

What it does:
- **STOP** (or "unsubscribe", "बंद करें", "band karo") withdraws every WhatsApp consent for that number at once, cancels its queued reminders, and sends a one-line confirmation.
- **Any other message** waits in `/admin/inbox`, labelled like an email reply.
- **A paused template** stops being sent at once, and the monitor raises an alert.

## 13. Retention

Design 7.7: bought company data on companies we never contacted is deleted after 12 months.
- On the 1st of each month, run `.venv/bin/python -m leadengine privacy retention` and read the count, then run it again with `--apply`.
- It removes the vendor's registered email and office address, the directors' link to the company, and the vendor's raw answers.
- The district and the MCA register's own facts stay.
- A contacted company keeps its data with its outreach record.

## 11. The walkthrough, on demonstration data

Until real emails have gone out, the walkthrough runs on `solutionai_leads_demo`: 36 invented companies (CIN serials from 990001, which MCA has not reached; addresses on the reserved `.example` domain) taken through the engine's own code. Nothing in it is real, and nothing is sent: the mail transport, the voice provider and the platform are stand-ins, and `.env`'s mailboxes and keys are never read.

```bash
cd services
node src/cli.js demo:seed     # empties and fills <LEAD_DB>_demo (about 20 seconds)
node src/cli.js demo:serve    # prints one-time sign-in tokens for viewer, reviewer, admin and a second admin
```

Every Admin page shows the banner "Demonstration data". What there is to show: the shortlist of 24 (3 held out), 8 emails waiting for approval, 9 sent, replies labelled interested, question, not now and opt-out plus an automatic reply, a founder who claimed the company page and asked for a call back, the call (connected, "wants a person"), a sign-up and a payment from the platform, 3 pairs in the review queue, 8 links to label, an export waiting for a second admin, and the MCA file page. An email approved during the walkthrough shows as sent a few seconds later. `demo:serve` also prints a link to one company page as a founder sees it. Seeded outside the calling window (10:00 to 19:00 IST, Monday to Saturday), the demo is dated from the last moment a call could be placed, because the voice code never places a call outside it.

## 9. MCP

- **For the team in Claude Desktop or another MCP client:** add a server that runs `node /opt/ai-lead-engine/services/src/cli.js mcp`.
- **For Mr. AI over HTTP:** `POST https://<admin host>/mcp` with an access token made by `lead-engine admin:user mr-ai@solutionai.in viewer`.

The tools are read-only and company-level.

## Commands

```bash
cd services
npm run migrate                                  # the three new collections
node src/cli.js inbox:read                        # every 10 minutes
node src/cli.js monitor                           # hourly
node src/cli.js summary --send                    # 08:00
node src/cli.js results --month 2026-11
node src/cli.js erase email <address> --by <admin email>    # then: leadengine privacy erase-raw <CIN> if it names one
node src/cli.js unsuppress email <address> --by <admin email> --note "<what the owner asked, and when>"
node src/cli.js eval:replies                      # after any change to the reply rules or the AI
node src/cli.js eval:qc                           # after any change to the quality check or the templates
cd ../ingest
.venv/bin/python -m leadengine eval extraction    # after any change to a portal parser
.venv/bin/python -m leadengine export parquet
```

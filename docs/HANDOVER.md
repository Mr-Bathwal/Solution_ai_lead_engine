# Handover: running the lead engine

For Sujas, Murari's team and whoever approves emails. The engine finds every new company in Uttar Pradesh, works out what it needs and when, and reaches out with something useful, with consent and the law built in. After 25 November it simply runs every month; this page is what a person does to keep it running.

- **Design:** `design/SolutionAI_Lead_Engine_Architecture_v1.1.pdf`
- **What each phase built:** `docs/WEEK1_REPORT.md` to `docs/WEEK4_REPORT.md`
- **Owner actions still open:** `ops/WEEK1_ACTIONS.md` to `ops/WEEK4_ACTIONS.md`

## What runs where

| Part | Command | Where | Who reaches it |
|---|---|---|---|
| Nightly data batch | `leadengine nightly` (Python) | cron, 05:00 | nobody |
| Job worker: drafts, sends, reminders, calls | `lead-engine worker` | systemd, always on | nobody |
| Company pages, claim form, unsubscribe, call webhook | `lead-engine pages` | systemd, 127.0.0.1:8791 | founders, through the platform's HTTPS proxy at `PUBLIC_BASE_URL` |
| Admin pages, JSON API, platform events, MCP | `lead-engine admin` | systemd, 127.0.0.1:8790 | the team, through the proxy or an SSH tunnel; never open to the internet |
| Mailbox reader, monitor, summary, plans | `inbox:read`, `monitor`, `summary --send`, `outreach:plan`, `reminders:plan` | cron | nobody |

Everything is in one MongoDB database (`solutionai_leads`) and one `.env` file. The times are in `ops/SCHEDULE.md`; the database users and roles in `ops/mongodb-access.md`.

## Putting it on the server, and the go/no-go check

Everything for the server is in `ops/deploy/` (its README is the step-by-step). From the laptop, `bash ops/deploy/ship.sh ubuntu@<server>` copies the code and sets everything up. On the server, `node src/cli.js preflight --live` checks every setting, secret, mailbox sign-in, DNS record and web address, and prints what is missing; "READY to send" is the signal to switch to real sending. When the platform team says an endpoint is ready, `node src/cli.js platform:check` tests it against `docs/platform-openapi.yaml`.

## The routine

**Every working day** (about 20 minutes at warm-up volume):
1. **Approvals** (`/admin/approvals`): approve, edit or reject each draft beside its evidence. Reject anything you would not sign yourself.
2. **Inbox** (`/admin/inbox`): answer each reply from the mailbox, then mark it dealt with, correcting the label if it is wrong.
   - Interested founders first, then questions.
   - Glance at "Other mail" for a founder writing from another address.
3. **Calls** (`/admin/calls`): make the calls listed, or follow up the ones that asked for a person. Mark each one dealt with, with a note.
4. **The summary email** (08:00): any critical alert is handled the same day (playbooks below).

**Every Monday:**
- look at **Results** (`/admin/results`) and **Data health**;
- run `node src/cli.js whatsapp:templates --sync` if WhatsApp is live.

**Each month, between the 1st and the 5th:**
1. Run `leadengine privacy retention`, read the count, then run it with `--apply` (design 7.7).
2. Download the previous month's MCA incorporation file and load it (`ops/WEEK1_ACTIONS.md`, item 9). The month's shortlist waits for it.
3. The next morning the shortlist is on the Pipeline page; the first drafts follow once the vendor profiles give the registered emails.
4. Once there are 100 labelled real replies: run `inbox:export-labels` and `eval:replies --real`, and write the number down.

### Monthly and as needed, in the Admin pages

- **MCA's monthly file** (1st to 5th): download it from MCA's page and upload it on Data health, MCA file (admin role). The nightly run loads it and files it under `data/mca/inbox/loaded/<month>/`; a file that is not the report goes to `failed/` with the reason, and the nightly ends "partial", which raises an alert. The same file twice is refused.
- **Exports:** a reviewer asks for a list on Companies, Export a list, and says why; an admin who is not that person approves it; the person who asked downloads the CSV within 24 hours. Company-level only, never the holdout; each download is in `audit_log` as `export`.
- **Audit log** (Data health, admins only): who signed in, viewed personal data, decided, exported, uploaded or erased what, and every refused attempt.
- **Label pairs** (Review, Label pairs): the matcher's own links and a sample of near misses, held-out links first. The precision shown there is the number for the design's 95% target.

### Approving a sample instead of every draft (design 7.5)

Every draft goes to a person until the quality check has proved it agrees with the reviewers. `node src/cli.js approval:agreement` shows how often it does, over the last 60 days of reviewer decisions. With at least 100 decisions at 95% or more, Sujas may switch sample approval on: in `config/outreach.json`, `approval.mode` becomes `sample` and `switched_on_by` and `switched_on_on` record who and when. Then 20% of the drafts that pass the check still come to a person, picked at random, and the rest are approved by `engine:sample` (logged like any approval; the compliance gate still checks every send). If agreement drops below 95% or the decisions below 100, every draft goes back to people by itself, and the monitor says why. The Approvals page always says which mode is in force.

### Addresses, campaigns and the AI check

- **Address checks:** before a first email, every address is checked (format, throwaway domains, the domain receives mail, and the verification service if configured). Accept-all domains are held out of the first wave and written to 14 days later (`verification.second_wave_after_days`); dead addresses are never used, and a company whose registered address is dead gets its own chance at a website address found later. A person's address (a founder's own Gmail, say) only ever gets the free checks: it is never sent to the verification service. A domain with no MX record still counts as receiving mail when it has an address record (RFC 5321). The company's timeline shows "address not used" with the reason.
- **Funding news:** each morning at 07:15, `leadengine ingest news` reads the startup news feeds in `config/news.json` (Inc42, YourStory, Entrackr) and a GDELT news search, through the polite fetcher. A headline counts only if it is about money or a round, and only if the company it names matches exactly one UP company in the knowledge base; then it is proposed, never acted on. A reviewer confirms or rejects it on Admin, "Signals" (linked from Review); a confirmed item shows on the company's page. Only the link, headline, publisher and date are kept, never the article. The first live run (18 Nov) found Entrackr's feed address answering 404 and GDELT's robots.txt unreachable: see `ops/WEEK4_ACTIONS.md` item 27.
- **Websites:** each night the shortlisted companies with no known website are searched for (through a search API's free tier, once a key is set; again at day 7, 30 and 90 if not found), and a site counts only when its domain and home page name the company. The site's contact page is read, within its robots.txt, for a role address on the company's own domain and a contact form. Those addresses are used for a first email only once `recipient.use_website_email` is on (after the lawyer's answer), and only in place of a missing or personal registered email.
- **Campaigns:** a campus or event campaign is a line in `config/outreach.json` (`campaigns`) with a code. Its landing page, `PUBLIC_BASE_URL/j/<code>`, lets a founder find their company and open its page; visits, claims, sign-ups and payments from it show on Results, "Campaigns". Because anyone can open a page this way, a claim made from it records nothing, contacts nobody and stops nothing until the person opens the link emailed to the address they gave (`/k/<link>`, once, within 48 hours; at most three such emails a day to one address, none to an address that opted out). Without a sending mailbox and `PUBLIC_BASE_URL` set, claims from campaign pages stay closed.
- **AI check on unsure matches:** once the LLM gateway has the engine's key, `kb:ai-check` (daily at 05:45) puts the model's advice beside each candidate on the review queue. It never decides.

## Changing what the engine does

Every rule is configuration, reviewed like code. Nothing here needs a programmer, but each change should be read by a second person.

| To change… | Edit | Then |
|---|---|---|
| the deadline calendar or the scheme rules | `config/rules/*.json` (with the CA; `confirmed_by` is their sign-off) | the next nightly |
| caps, warm-up, send window, contact budget | `config/caps.json` | restart the worker |
| what an email may say: evidence windows, banned phrases, word limits | `config/outreach.json` | `eval:qc` must still catch every fault |
| the email templates | `services/src/outreach/templates.js` | `npm test` and `eval:qc` |
| the reply rules | `services/src/inbound/classify.js` | `eval:replies`: wrong suppressions must stay 0 |
| models, prompts, AI prices | `config/llm.json` | `eval:replies --ai` |
| the call script, calling hours, call caps | `config/voice.json` (the script needs a new sign-off) | restart the worker |
| alert thresholds, fixed costs | `config/monitor.json` | the next hourly run |
| WhatsApp templates | `config/whatsapp_templates.json` and Meta | `whatsapp:templates --sync` |

## Secrets

All live in `.env` on the server (from AWS Parameter Store), never in the repository:
- **Database:** `MONGODB_URI`.
- **Required:** `CONTACT_KEY_SECRET`, `PAGE_SECRET`, `HOLDOUT_SALT` (set once, never changed).
- **Admin pages:** `ADMIN_USERS`, `ADMIN_SESSION_SECRET`.
- **Mailboxes:** `MAILBOX_n_*`.
- **Accounts:** `INFYNER_API_KEY`, `LLM_GATEWAY_KEY`, `WHATSAPP_TOKEN`, `SARVAM_API_KEY`.
- **Platform:** `PLATFORM_API_KEY`, `PLATFORM_EVENTS_SECRET`.
- **Ledger anchor:** `LEDGER_ANCHOR_FILE`.

`.env.example` lists every one with a line on what it is. Losing `CONTACT_KEY_SECRET` means the suppression list can no longer be checked: keep two copies.

## When something goes wrong

| Alert or event | What it means | What to do |
|---|---|---|
| A mailbox is **paused for bounces** | more than 2% hard bounces in 30 days | Nothing is sent from it until the rate falls. Look at the bounced addresses on the Inbox's Recent list: usually stale registered emails. Do not raise the limit. |
| A mailbox is **paused for complaints** | more than 0.1% | Stop and read the complaint. Check the last emails' wording with the approver; the pause lifts only as the 30-day window moves on. |
| **A WhatsApp template is paused** or its quality is red | Meta paused it | Its reminders stop by themselves. Read Meta's reason in WhatsApp Manager, fix the template, resubmit, `--sync`. |
| **Jobs overdue** | the worker is not running | `systemctl status leadengine-worker`, then the log. Jobs resume where they stopped; nothing is sent twice. |
| **Check the mailbox** on a message | a send was interrupted | Look in that mailbox's Sent folder and press "It was sent" or "It was not sent" on the message's page. |
| **The nightly failed** or is stale | a step or the whole batch failed | `/var/log/leadengine/nightly.log`. Each step can be re-run alone (`leadengine kb build`, `enrich run`, `need run`). |
| **The consent ledger does not verify** | someone changed or removed consent records | Stop sending (`OUTREACH_TRANSPORT=outbox`), keep the anchor file safe, and tell Gourav and Sujas the same day. |
| **A founder asks how we got their email** | — | It is the company's registered email, published in the MCA register under the Companies Act. Offer to stop at once, and suppress it. |
| **An erasure request** | DPDP | `node src/cli.js erase email <address> --by <you>` (and `erase phone <number>`), with an admin `MONGODB_URI`. If it names a company (the address was its registered email), finish with `leadengine privacy erase-raw <CIN>`. Reply that it is done. Only a keyed hash stays, so we never contact them again. |
| **"I unsubscribed by mistake"** | the unsubscribe page promises a person will put it right | `node src/cli.js unsuppress email <address> --by <you> --note "<their words, and the date>"`, with an admin `MONGODB_URI`. It never lifts an erasure request, a complaint or a hard bounce, and it does not restart cold email: it lets through what they then ask for (reminders, a call back). |
| **A founder replied STOP on WhatsApp** | — | Nothing to do: the engine withdrew the consent and confirmed it. It shows as handled in the Inbox. |
| **DLT approval is late** | — | Leave voice off. Founders who ask for a call are listed on the Calls page; a person calls them. |
| **A rule was wrong in a sent email** | — | Fix it in `config/rules`, get the CA's sign-off, and email the affected founders a correction from the same mailbox. `messages` shows exactly what each one was sent. |
| **A backup is stale** | the hourly or nightly backup stopped | `/var/log/leadengine/backup.log`; usually the disk is full or the database password changed. Run `node src/cli.js backup` by hand to see the error. |

### The database is lost or damaged

The engine keeps its own backups (`ops/backup.js`): everything every night at 04:15, and every hour what can never be rebuilt (consents, the do-not-contact list, the audit log, people, emails, replies, calls, match decisions, exports). Both are on the server in `data/backups/` and in S3 (`BACKUP_S3_URI`) for 35 days.

1. **Stop sending.** Set `OUTREACH_TRANSPORT=outbox` and stop the worker: `sudo systemctl stop leadengine-worker`.
2. **Pick the newest good backup.** The newest full one, and the newest critical one after it. If the server is gone: `aws s3 sync <BACKUP_S3_URI>/<folder> data/backups/<folder>`.
3. **Restore into a new database**, never over the old one:
   ```bash
   node src/cli.js restore data/backups/<full folder> --into solutionai_leads_r1
   ```
   It checks every file against its checksum, then the counts and the consent ledger's hash chain, and says `"ok": true` or refuses.
4. **Bring the hourly records forward**, if the critical backup is newer than the full one: restore it into a second new database and copy its collections over the first, or ask Gourav to do it (it is a few commands in `mongosh`).
5. **Check it:** `LEAD_DB=solutionai_leads_r1 node src/cli.js ledger:verify` (it also checks the ledger against `LEDGER_ANCHOR_FILE`, which lives outside the database), then `preflight`.
6. **Switch:** set `LEAD_DB=solutionai_leads_r1` in Parameter Store, run `env_from_ssm.sh`, restart the three services.
7. **What may be missing:** anything after the last hourly backup. Opt-outs made in that hour come back as replies or complaints: suppress them by hand (`node src/cli.js suppress email <address> --reason unsubscribe`). An erasure made after the backup was taken must be run again; the audit log of the lost database is gone, so keep a note of every erasure request in the privacy inbox as well.

Once a month, do steps 3 and 5 into a scratch database and drop it afterwards: a backup that has never been restored is not a backup.

## How we judge success

From the design (section 12), to be reset after the first full month:
- every new UP company from the MCA file is in the engine within three days;
- matching precision of at least 95% on labelled pairs (190 wait for labels);
- bounces below 2% and complaints below 0.1%, with no outreach domain blocklisted;
- WhatsApp quality green;
- at least 8% of contacted companies open their page, and 3% claim it;
- paying clients traced to the engine each month, and a clear lift over the holdout: the Results page says "too early" for the first two or three months;
- a known, falling cost per paying client: on the Results page.

## The walkthrough

About 45 minutes, with Sujas and Murari's team, on 25 November. Bring the server open and one approver. Until real emails have gone out, run it on the demonstration database: `node src/cli.js demo:seed`, then `demo:serve` (`ops/WEEK4_ACTIONS.md`, section 11).

1. **(5 min) The idea:** why a company's own deadlines rather than a sales email, and why the holdout is the only honest measure (design 4 and 7.4).
2. **(10 min) The data:** the Pipeline page, a company's page (its facts, sources, needs and fit), the October shortlist and its sector cap, and Data health.
3. **(10 min) An email from start to end:** a draft in Approvals beside its evidence and the 18 checks; an edit that fails the check; approval; the compliance gate's answer; the email in the outbox or Sent folder; the company page and unsubscribe link.
4. **(5 min) The founder's side:** the company page, the claim with its consent choices and the call back, and the thank-you page, on a phone.
5. **(5 min) What comes back:** a reply in the Inbox with its label and next step; a bounce handled by the engine; a call on the Calls page.
6. **(5 min) Results and money:** the Results page (lift, cost per result, mailbox health) and the daily summary.
7. **(5 min) Who does what from tomorrow:** the routine above, the open owner actions (`ops/WEEK*_ACTIONS.md`), and where the playbooks are.

## Tests

- **`services`:** `npm test`, 263 tests against a throwaway MongoDB.
- **`ingest`:** `.venv/bin/python -m pytest`, 275 tests.
- **On every push:** GitHub Actions runs both suites on Linux with a real mongod (`.github/workflows/ci.yml`).
- **The four test sets:** `eval:qc`, `eval:replies`, `leadengine eval extraction` and `leadengine kb eval`.

Run all of them after any change.

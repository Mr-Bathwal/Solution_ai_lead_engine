# Running the engine on the server

Times are IST. Runs are at night, at a low request rate, so they fit on a small or shared machine.

| When | What | Why |
|---|---|---|
| Every Monday 01:30 | `ingest startinup --details new`, `ingest upsm`, `ingest incubators` | Weekly refresh of the startup portals (design 7.1). Startup India is left out: its API's robots.txt forbids automated access. |
| 1st of each month 00:30 | `ingest startinup --details all` | Re-reads every profile, so changes to stage, incubator or website are caught. About 2,600 requests: about four hours at the pace seen on 26 October (5.4 s a request), so it ends around 04:30. If it overruns, the 05:00 nightly simply works from what is stored so far. A profile that fails to load keeps its previous record. |
| 1st–5th of each month | upload the file on Admin, Data health, MCA file, after the manual download; the 05:00 nightly loads it (`ingest inbox` loads it at once) | New UP companies (`WEEK1_ACTIONS.md`, item 9) |
| Every day 04:15, and at :10 past every hour | `node services/src/cli.js backup`, and `backup --critical` hourly; both then `aws s3 sync` to `BACKUP_S3_URI` | The engine's own backups (`docs/HANDOVER.md`, "The database is lost"): everything nightly, and hourly what can never be rebuilt (consents, opt-outs, audit log, people, emails, replies, calls). 7 nightly and 48 hourly kept on the server, 35 days in S3. The monitor alerts when either stops. |
| Every day 05:00 | `nightly` | The MCA inbox, then the knowledge base (LLPs, matching, portal facts), enrichment within the caps, the websites of shortlisted companies and the role addresses they publish, then leads, needs and the month's shortlist (design 7.2–7.4). Under a minute on today's data. Each step runs on its own: a failed step is recorded and the need engine still runs. Only one nightly runs at a time. A month's shortlist waits for the previous month's MCA file (November's shortlist waits for the October file). |
| Every day 05:45 | `node services/src/cli.js kb:ai-check` | The AI model's advice on the unsure matches the nightly left, beside each candidate on the review queue (design 7.2). Does nothing until the LLM gateway has the engine's key. |
| Every day 06:00 | `node services/src/cli.js ledger:anchor` | Checks the consent ledger and appends its head to `LEDGER_ANCHOR_FILE`, outside the database. A ledger that does not verify is not anchored, and the command exits 2. |
| Every day 06:30 | `node services/src/cli.js outreach:plan` | Queues the day's drafts: a first email for each company on this month's shortlist whose registered email is known, and a follow-up where the first went out 7 days ago with no reply. Also retires drafts older than 14 days. Nothing is sent without a person's approval (design 7.5). |
| Every day 07:15 | `leadengine ingest news` | Funding news (design 7.1, 7.4): the feeds in `config/news.json` and one GDELT query, through the polite fetcher. A headline that names exactly one UP company becomes a proposed signal on Admin, Review, "News to check"; a person confirms or rejects it, and confirmed ones show on the company's page. Nothing acts on a signal by itself, and unmatched news is not kept. A feed that fails is counted and the rest are read; the run is `partial` then, and the command exits 1 only when every source failed. |
| Every day 08:30 | `node services/src/cli.js reminders:plan` | Queues deadline reminders (7 days and 1 day before) for founders who claimed their page and asked for them. |
| Every 10 minutes | `node services/src/cli.js inbox:read` | Reads the outreach mailboxes (read-only): replies to the Admin inbox, bounces and complaints handled at once (Phase 4) |
| Every hour | `node services/src/cli.js monitor` | The alert checks; a CloudWatch metric filter turns its JSON line into a metric and an alarm (`ops/deploy/README.md`). Exits 1 while a critical alert is open |
| Every day 08:00 | `node services/src/cli.js summary --send` | The team's summary email to `SUMMARY_TO` |
| Every day 05:30 | `leadengine export parquet`, then `aws s3 sync` | Parquet exports for DuckDB, with no personal data, after the nightly batch |
| 1st of each month, by a person | `leadengine privacy retention`, then `--apply` | Deletes bought data on companies never contacted after 12 months (design 7.7). Run by hand: read the count first |
| Always on | `node services/src/cli.js worker` | Job worker: drafting, sending approved emails through the compliance gate, reminders and call backs. Approved emails wait for the send window (10:00–17:30 IST, Monday to Friday) and the caps; calls for the founder's chosen time within 10:00–19:00, Monday to Saturday. |
| Always on | `node services/src/cli.js pages` | The company pages, claim form and unsubscribe links on 127.0.0.1:8791, reached by founders at `PUBLIC_BASE_URL` through the platform's HTTPS proxy. Also receives the voice provider's call reports at `/hooks/voice/sarvam` |
| Always on | `node services/src/cli.js admin` | Admin pages on 127.0.0.1:8790, reached through the platform's proxy or an SSH tunnel; never exposed directly |

## crontab (Linux server, user `leadengine`)

```cron
CRON_TZ=Asia/Kolkata
TZ=Asia/Kolkata
30 1 * * 1  cd /opt/ai-lead-engine/ingest && for s in "startinup --details new" upsm incubators; do .venv/bin/python -m leadengine ingest $s; done >> /var/log/leadengine/weekly.log 2>&1
30 0 1 * *  cd /opt/ai-lead-engine/ingest && .venv/bin/python -m leadengine ingest startinup --details all >> /var/log/leadengine/monthly.log 2>&1
10 * * * *  cd /opt/ai-lead-engine/services && node src/cli.js backup --critical >> /var/log/leadengine/backup.log 2>&1 && . /opt/ai-lead-engine/.env && aws s3 sync /opt/ai-lead-engine/data/backups "$BACKUP_S3_URI" --sse AES256 --only-show-errors
15 4 * * *   cd /opt/ai-lead-engine/services && node src/cli.js backup >> /var/log/leadengine/backup.log 2>&1 && . /opt/ai-lead-engine/.env && aws s3 sync /opt/ai-lead-engine/data/backups "$BACKUP_S3_URI" --sse AES256 --only-show-errors
0 5 * * *   cd /opt/ai-lead-engine/ingest && .venv/bin/python -m leadengine nightly >> /var/log/leadengine/nightly.log 2>&1
45 5 * * *  cd /opt/ai-lead-engine/services && node src/cli.js kb:ai-check >> /var/log/leadengine/ai-check.log 2>&1
0 6 * * *   cd /opt/ai-lead-engine/services && node src/cli.js ledger:anchor >> /var/log/leadengine/anchor.log 2>&1
30 6 * * *  cd /opt/ai-lead-engine/services && node src/cli.js outreach:plan >> /var/log/leadengine/outreach.log 2>&1
15 7 * * *  cd /opt/ai-lead-engine/ingest && .venv/bin/python -m leadengine ingest news >> /var/log/leadengine/news.log 2>&1
30 8 * * *  cd /opt/ai-lead-engine/services && node src/cli.js reminders:plan >> /var/log/leadengine/reminders.log 2>&1
*/10 * * * * cd /opt/ai-lead-engine/services && node src/cli.js inbox:read >> /var/log/leadengine/inbox.log 2>&1
5 * * * *   cd /opt/ai-lead-engine/services && node src/cli.js monitor >> /var/log/leadengine/monitor.log 2>&1
0 8 * * *   cd /opt/ai-lead-engine/services && node src/cli.js summary --send >> /var/log/leadengine/summary.log 2>&1
30 5 * * *  cd /opt/ai-lead-engine/ingest && .venv/bin/python -m leadengine export parquet >> /var/log/leadengine/export.log 2>&1 && . /opt/ai-lead-engine/.env && aws s3 sync /opt/ai-lead-engine/data/exports "$EXPORT_S3_URI" --only-show-errors
```

`CRON_TZ` sets when cron fires; `TZ` sets the time zone the jobs see. The engine counts days and months in IST whatever the server's zone is, so `TZ` only keeps the log timestamps readable. Secrets (`INFYNER_API_KEY`, `HOLDOUT_SALT`, `RULES_ENGINE_URL`/`KEY`, `CONTACT_KEY_SECRET`, `LEDGER_ANCHOR_FILE`) are read from `/opt/ai-lead-engine/.env` by the engine itself, Python and Node alike, so the cron lines need nothing more.

`nightly` exits 0 when every step succeeded, 1 when a step failed (the run is recorded as `partial`, or `failed` if the need engine itself failed), and 2 when another nightly was still running and this one did not start.

## systemd unit for the worker

```ini
# /etc/systemd/system/leadengine-worker.service
[Unit]
Description=SolutionAI lead engine job worker
After=network-online.target

[Service]
User=leadengine
WorkingDirectory=/opt/ai-lead-engine/services
EnvironmentFile=/opt/ai-lead-engine/.env
ExecStart=/usr/bin/node src/cli.js worker
Restart=always
RestartSec=10
KillSignal=SIGTERM
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
```

The worker stops cleanly on SIGTERM: it takes no new jobs and gives the ones in hand 30 seconds to finish, then aborts them; an aborted job is retried. If the machine dies mid-job, the job's lock expires and another worker (or the restarted one) picks it up. A step that runs longer than 15 minutes is aborted the same way, so a hung step can never hold its job for ever.

## systemd unit for the Admin pages

```ini
# /etc/systemd/system/leadengine-admin.service
[Unit]
Description=SolutionAI lead engine Admin pages
After=network-online.target

[Service]
User=leadengine
WorkingDirectory=/opt/ai-lead-engine/services
EnvironmentFile=/opt/ai-lead-engine/.env
ExecStart=/usr/bin/node src/cli.js admin
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

It listens on 127.0.0.1 only. Put it behind the platform's HTTPS proxy (and set `ADMIN_SECURE_COOKIES=1`), or reach it with `ssh -L 8790:127.0.0.1:8790 server`.

## systemd unit for the company pages

```ini
# /etc/systemd/system/leadengine-pages.service
[Unit]
Description=SolutionAI lead engine company pages
After=network-online.target

[Service]
User=leadengine
WorkingDirectory=/opt/ai-lead-engine/services
EnvironmentFile=/opt/ai-lead-engine/.env
ExecStart=/usr/bin/node src/cli.js pages
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Unlike the Admin pages, these face the internet: founders open them from emails. The platform's HTTPS proxy forwards `PUBLIC_BASE_URL` (for example `https://pages.<outreach domain>`) to 127.0.0.1:8791; set `PUBLIC_TRUST_PROXY=1` so rate limits see the founder's address, not the proxy's. They serve no JavaScript, send no Referer (the links are capabilities), and tell search engines not to index them.

The worker refuses to start with `OUTREACH_TRANSPORT=smtp` until `PUBLIC_BASE_URL` is https, both mailboxes have an address, a name and an SMTP password, and `PAGE_SECRET` is set. In the default outbox mode it starts, and each approved email is written to `data/outbox/` instead of being sent.

## After each run

`.venv/bin/python -m leadengine status` shows the counts, the matching results, leads by stage and the latest runs. In the Admin pages, the Pipeline page shows the counts and leads by stage; Data health shows the latest run of every source and job, the caps and the matching.

- A run is `partial` when a source was unavailable or read less than it should (a portal page timed out, a profile failed to load, the SISFS endpoint moved).
- A run is `failed` when a parser broke or the run was interrupted. A failed run is a signal that a portal changed its layout. Records read before the failure are kept.
- A run still `running` after six hours means its process died; `status` flags it, and the next nightly closes a dead nightly run by itself.

`node services/src/cli.js ledger:verify` checks the consent ledger's hash chain against every anchor in `LEDGER_ANCHOR_FILE` and prints its head; it exits 2 if anything does not match. The daily `ledger:anchor` line is what makes a ledger cut short, or rewritten with recomputed hashes, detectable. Copy its output into the daily summary email as a second, independent record.

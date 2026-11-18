# Putting the lead engine on the server

One small Linux server runs everything: the existing one if it has room, or an AWS t4g.small in Mumbai (design 9). Written for Ubuntu 22.04 or 24.04; Amazon Linux 2023 works with the same script. About 30 minutes the first time.

| File | What it is |
|---|---|
| `setup.sh` | installs or updates everything, idempotent: packages, the `leadengine` user, Node and Python dependencies, the three services, the schedule, log rotation, the database schema, then the go/no-go check |
| `ship.sh` | from the laptop: copies the code to the server and runs `setup.sh` there (never the data, `.env` or packages) |
| `env_from_ssm.sh` | writes `/opt/ai-lead-engine/.env` from AWS Parameter Store |
| `leadengine-worker.service`, `-pages.service`, `-admin.service` | the three always-on services |
| `leadengine.cron` | the schedule (`ops/SCHEDULE.md` explains each line) |
| `logrotate.conf` | keeps 90 days of logs |
| `cloudwatch-agent.json` | ships the logs to CloudWatch |
| `nginx-leadengine.conf` | an example for the platform's proxy: the company pages, and the Admin pages behind an address allow-list |

## First time

1. **Secrets.** Put every setting from `.env.example` in Parameter Store as a SecureString under `/leadengine/prod/` (for example `/leadengine/prod/CONTACT_KEY_SECRET`). Give the server's instance role `ssm:GetParametersByPath` and `kms:Decrypt` on that prefix.
2. **Database.** Create the application user with the `leadEngineApp` role (`ops/mongodb-access.md`), and put its connection string in `MONGODB_URI`. Keep an admin connection string apart, for `erase` and `unsuppress` only.
3. **Ship and set up**, from the laptop's repository folder:
   ```bash
   bash ops/deploy/ship.sh ubuntu@<server> --no-start
   ssh ubuntu@<server> 'sudo bash /opt/ai-lead-engine/ops/deploy/env_from_ssm.sh /leadengine/prod ap-south-1'
   ssh ubuntu@<server> 'sudo bash /opt/ai-lead-engine/ops/deploy/setup.sh'
   ```
   The last step migrates the database, starts the services and prints the go/no-go check.
4. **Data.** Upload the month's MCA file on the Admin pages (Data health, MCA file) and let the nightly load it, or load it and rebuild at once:
   ```bash
   sudo -u leadengine bash -c 'cd /opt/ai-lead-engine/ingest && .venv/bin/python -m leadengine ingest mca <file> && .venv/bin/python -m leadengine nightly'
   ```
5. **Proxy.** Point `pages.<outreach domain>` at 127.0.0.1:8791 and the Admin host at 127.0.0.1:8790 (`nginx-leadengine.conf`). Set `PUBLIC_BASE_URL`, `PUBLIC_TRUST_PROXY=1` and `ADMIN_TRUST_PROXY=1`.
6. **CloudWatch.** Install the agent with `cloudwatch-agent.json`, then make the alert metric and its alarm (replace the SNS topic):
   ```bash
   aws logs put-metric-filter --log-group-name /leadengine/monitor --filter-name open-critical-alerts \
     --filter-pattern '{ $.OpenAlertsCritical = * }' \
     --metric-transformations metricName=OpenAlertsCritical,metricNamespace=LeadEngine,metricValue='$.OpenAlertsCritical'
   aws cloudwatch put-metric-alarm --alarm-name leadengine-critical-alert --namespace LeadEngine --metric-name OpenAlertsCritical \
     --statistic Maximum --period 3600 --evaluation-periods 1 --threshold 0 --comparison-operator GreaterThanThreshold \
     --treat-missing-data breaching --alarm-actions arn:aws:sns:ap-south-1:<account>:<topic>
   ```
   With missing data counted as breaching, the alarm also fires when the monitor itself stops running.
7. **Backups.** Make a private bucket in Mumbai with default encryption and a rule that expires objects after 35 days, and let the instance role write to it:
   ```bash
   aws s3api create-bucket --bucket solutionai-leadengine-backups --region ap-south-1 --create-bucket-configuration LocationConstraint=ap-south-1
   aws s3api put-public-access-block --bucket solutionai-leadengine-backups --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
   aws s3api put-bucket-encryption --bucket solutionai-leadengine-backups --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
   aws s3api put-bucket-lifecycle-configuration --bucket solutionai-leadengine-backups --lifecycle-configuration '{"Rules":[{"ID":"expire-35-days","Status":"Enabled","Filter":{},"Expiration":{"Days":35}}]}'
   ```
   The instance role needs `s3:ListBucket` on the bucket and `s3:PutObject` on `solutionai-leadengine-backups/prod/*` (no delete: the expiry rule deletes). Set `BACKUP_S3_URI=s3://solutionai-leadengine-backups/prod`. The cron takes the first backups within the hour; the monitor alerts if they stop. A few MB a night: well under ₹50 a month.

## Every update

```bash
bash ops/deploy/ship.sh ubuntu@<server>
```
It copies the new code, reinstalls what changed, migrates the database, restarts the services and prints the go/no-go check. Workers finish the jobs in hand before they stop; nothing is sent twice.

## The go/no-go check

```bash
sudo -u leadengine bash -c 'cd /opt/ai-lead-engine/services && node src/cli.js preflight --live'
```
It checks every setting, secret and outside service:
- it signs in to SMTP and IMAP, but sends nothing;
- it looks up MX, SPF, DMARC and DKIM;
- it calls the pages' health check and Meta's API.

Each line says what to fix. "READY to send" at the bottom is the signal to set `OUTREACH_TRANSPORT=smtp`.

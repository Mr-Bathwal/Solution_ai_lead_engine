# Phase 3: what needs a person (9 – 15 November)

The code for Phase 3 is built and tested (`docs/WEEK3_REPORT.md`). Nothing can reach a founder until all of the following hold:
- these items are done;
- the Week 2 items that feed them are done (vendor key and profiles, CA sign-off);
- the mailboxes' warm-up ends on 18 November.

The Week 1 and Week 2 actions continue.

| # | Action | Who | By | Cost | Done when |
|---|---|---|---|---|---|
| 1 | Configure the two outreach mailboxes for sending | Gourav | Mon 16 Nov | free | `MAILBOX_1_*`, `MAILBOX_2_*` and the SMTP app passwords are in the server's secrets |
| 2 | Put the company pages behind the platform's HTTPS proxy | Murari's team | Thu 12 Nov | free | `https://<PUBLIC_BASE_URL>/healthz` answers "ok" |
| 3 | Publish a privacy notice and a contact for withdrawals | Sujas | Thu 12 Nov | free | `PRIVACY_NOTICE_URL` and `PRIVACY_CONTACT` are set |
| 4 | Submit the four WhatsApp templates to Meta | Gourav, once Meta verification is through | Fri 13 Nov | free | `lead-engine whatsapp:templates --sync` shows them APPROVED |
| 5 | Platform: onboarding and notification endpoints, LLM gateway key | Murari's team | Mon 16 Nov | — | shapes agreed in `docs/PLATFORM_CONTRACTS.md`, section 3 |
| 6 | A short legal review before the first email | Sujas asks a technology lawyer | Tue 17 Nov | about an hour of their time | the lawyer has read the first-email template, the claim form and the privacy notice |
| 7 | Approve the first emails | Gourav and one reviewer | from Wed 18 Nov | free | the approval queue is empty each day |
| 8 | Switch from the outbox to real sending | Gourav | Wed 18 Nov, after items 1–7 | free | `OUTREACH_TRANSPORT=smtp`, and the worker starts without complaints |

## 1. The outreach mailboxes

In `.env` on the server (from AWS Parameter Store), for each of the two mailboxes made in Week 1:

```
MAILBOX_1_ADDRESS=gourav@<outreach domain>
MAILBOX_1_NAME=Gourav Bathwal
MAILBOX_1_TITLE=<their title>
MAILBOX_1_SMTP_PASSWORD=<a Zoho app-specific password>
```

and the same with `MAILBOX_2_`.
- **The password:** make an app-specific password in Zoho (My Account → Security → App Passwords), never the account password.
- **What founders see:** the name and title appear in the signature and the From line, so use the real person's.
- **Before switching:** keep `OUTREACH_TRANSPORT=outbox` until item 8.

## 2. The company pages

`node services/src/cli.js pages` serves the pages on 127.0.0.1:8791 (systemd unit in `ops/SCHEDULE.md`). Founders reach them from the links in each email.

1. Choose the address. A subdomain of the outreach domain, such as `https://pages.<outreach domain>`, keeps the links on the domain the email came from.
2. Point it at the server and have the platform's proxy forward it, over HTTPS, to 127.0.0.1:8791.
3. In `.env`, set:
   - `PUBLIC_BASE_URL` to that address;
   - `PUBLIC_TRUST_PROXY=1`;
   - `PAGE_SECRET` to 32 or more random characters (`openssl rand -hex 32`).
4. When a founder claims a page, they continue to `PLATFORM_SIGNUP_URL`, the platform's sign-up page, until the pre-filled onboarding endpoint exists.

## 3. Privacy notice

The claim form tells the founder what is kept and how to withdraw. It links to the privacy notice and names a contact.
- The notice should cover the lead engine's use of company data and of what a founder gives on the claim form, under the DPDP Act.
- The contact can be a role address such as `privacy@solutionai.in` that someone reads.

## 4. WhatsApp templates

Once Meta business verification is through (Week 1, item 5):
1. In `config/whatsapp_templates.json`, replace `https://pages.example.in` with `PUBLIC_BASE_URL`.
2. Submit the four templates in WhatsApp Manager (or with the Graph API), as category **Utility**: two reminders and two confirmations, each in English and Hindi.
3. Set `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_WABA_ID` and `WHATSAPP_TOKEN` in `.env`.
4. Run `node services/src/cli.js whatsapp:templates --sync`. Only APPROVED templates are ever sent.

Until then, WhatsApp reminders are written to the outbox and nothing is sent.

## 5. Platform

See `docs/PLATFORM_CONTRACTS.md`, section 3:
- the pre-filled sign-up after a claim;
- reminders for signed-up founders through the platform's own mail and in-app notifications;
- a key for the LLM gateway, with which models "small" and "strong" mean and their prices.

None of them blocks the first emails. Without them:
- founders go to the normal sign-up;
- email reminders wait;
- the reviewed templates write every email.

## 6. Legal review

The design (section 11) recommends a short review by an Indian technology lawyer before the first emails on 18 November, mainly on the DPDP points. Send them the **legal review pack**, `docs/legal/SolutionAI_Lead_Engine_Legal_Review_Pack.pdf` (and the `.docx` for their tracked changes). It has, taken from the engine's own code:
- nine questions for the lawyer;
- the first email in English and Hindi, the follow-up and a new-need email;
- the claim form's notice and its four consent lines, word for word (claim-v2);
- the four WhatsApp templates;
- the call back: hours, attempts, the opening lines and the agent's brief;
- what is kept, from where, on what basis and for how long;
- a first draft of the privacy notice for them to correct.

Rebuild it after any change to these texts: `node ops/legal/build_pack.mjs`, `python ops/legal/build_pack.py`, `node ops/legal/pdf.mjs`.

## 7. The approval queue

From 18 November, open `/admin/approvals` each working day. For each email:
1. Read it beside its evidence pack and the quality check.
2. Approve it, edit and approve it, or reject it.

Approved emails go out inside the send window as the caps allow (25 a day per mailbox from 18 November, 30 from 25 November).

When a founder replies, or an email bounces, record it on the message's page until Phase 4 reads the mailboxes:
- a reply hands the company to a person;
- a bounce suppresses the address.

A message marked "check the mailbox" had its send interrupted. Look in that mailbox's Sent folder and press "It was sent" or "It was not sent".

## 8. Real sending

When items 1–7 are done, the warm-up is over and the CA has signed off the rules:
1. Set `OUTREACH_TRANSPORT=smtp`.
2. Restart the worker. It refuses to start, and says why, if a mailbox, the pages' address or `PAGE_SECRET` is missing.
3. Look at the first day's emails in each mailbox's Sent folder.
4. Watch Data health for bounces. Sending pauses by itself if bounces pass 2% or complaints pass 0.1%.

## Commands

```bash
cd services
npm run migrate                              # the three new collections
node src/cli.js outreach:plan                # daily at 06:30 (ops/SCHEDULE.md)
node src/cli.js reminders:plan               # daily at 08:30
node src/cli.js worker                       # always on
node src/cli.js pages                        # always on
node src/cli.js whatsapp:templates --sync
```

# Week 1 actions outside the code (26 October – 1 November 2026)

The code for Week 1 is built and tested. These items need a person, a company document or a payment, so they cannot be done from code. Several have outside waiting times (warm-up, Meta verification, DLT), which is why they all start this week.

| # | Action | Owner | Start by | Cost | Done when |
|---|---|---|---|---|---|
| 1 | Buy the outreach domain | Sujas (company card) | Mon 26 Oct | about ₹700–1,000 a year | The domain is in the company's registrar account |
| 2 | Two Zoho Mail Lite mailboxes on it | Gourav | Tue 27 Oct | about ₹60–90 per mailbox a month | Both mailboxes send and receive |
| 3 | Email DNS records | Gourav | Tue 27 Oct | free | `python ops/check_email_dns.py <domain>` shows all OK |
| 4 | Start warm-up (runs to 17 Nov) | Gourav, Sujas, team | Wed 28 Oct | free | Daily rows filled in `warmup_plan.csv` |
| 5 | Meta business verification, WhatsApp number, INR billing | Sujas (documents), Gourav | Wed 28 Oct | free; messages are paid per use later | Verification submitted; status checked daily |
| 6 | DLT registration, and written quotes for a 140-series number | Sujas | Fri 30 Oct | one-time operator fee, to be confirmed | Application number received; two quotes in writing |
| 7 | MongoDB: room for a new database, and an app user | Murari's team | Thu 29 Oct | free | Connection string shared through the secret store |
| 8 | Server: room on the existing server, or approve one t4g.small | Murari, Sujas | Thu 29 Oct | ₹0–900 a month | Decision recorded |
| 9 | October MCA file | Gourav | 1–5 Nov (when MCA posts it) | free | `leadengine ingest mca <file>` finishes OK |
| 10 | Talk to 10–15 recently incorporated UP founders | Gourav, Sujas | Wed 28 Oct | free | Notes in `founder_conversations.csv` (guide: `FOUNDER_CONVERSATIONS.md`) |

---

## 1. Outreach domain

Outreach is never sent from `solutionai.in`. If outreach mail ever hurts a domain's reputation, it must not be the domain our platform mail, invoices and OTPs depend on.

- Choose a name founders will recognise as us, for example `getsolutionai.in`, `trysolutionai.in` or `solutionaihq.in`. Check availability at the registrar.
- Point the new domain's website to `https://solutionai.in` (a simple redirect). A founder who checks the sender's domain should land on the real company.
- Register it in the company's name, on the company's registrar account.

## 2 and 3. Zoho Mail Lite and DNS

1. Sign up for **Zoho Mail Lite** on the India data centre (zoho.in), add the new domain and verify it with the TXT record Zoho shows.
2. Create two mailboxes in real people's names (for example `gourav@` and `sujas@`). A named sender is honest and gets better replies than `sales@`.
3. Add these DNS records at the registrar. **Zoho's admin console shows the exact values during set-up; if they differ from this table, use Zoho's.**

| Type | Host | Value | Notes |
|---|---|---|---|
| MX | @ | `mx.zoho.in` | priority 10 |
| MX | @ | `mx2.zoho.in` | priority 20 |
| MX | @ | `mx3.zoho.in` | priority 50 |
| TXT | @ | `v=spf1 include:zoho.in ~all` | exactly one SPF record |
| TXT | `zmail._domainkey` | the key Zoho generates | choose **2048-bit**; the selector name is your choice |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@<domain>; fo=1` | change to `p=quarantine` after warm-up |

4. Check everything:

```bash
python ops/check_email_dns.py <domain> --selector zmail
```

SMTP access for the engine is set up in Phase 3 with an app-specific password stored in the secret store. It is never written in code or chat.

## 4. Warm-up (28 Oct – 17 Nov)

New mailboxes that suddenly send to strangers land in spam. For three weeks, each mailbox sends real emails to people who will open and reply: team members, mentors, partner CAs, incubator contacts and friends. `warmup_plan.csv` has the daily volume per mailbox and a column to tick.

- Write real messages and hold real conversations. Replies matter most.
- No links or attachments in the first week, and no tracking pixels at any time.
- Paid warm-up networks are not used. They fake engagement, cost money every month and are against Google's guidance.
- The first approved outreach goes out from 18 November at warm-up volume. The engine caps each mailbox at 25 a day from 18 November and 30 a day from 25 November (`config/caps.json`), and sends nothing during warm-up.

## 5. Meta WhatsApp Business

WhatsApp is used only for founders who opt in on their company page. This week is only about getting verified, because verification can take days.

- In Meta Business Suite, create (or use) the business portfolio under the company's **legal name exactly as on MCA**, and start **business verification**. Keep these ready: Certificate of Incorporation or GST certificate (name and address must match), the website on the company domain, and a business email or phone that can receive a code.
- **Phone number:** a number that is not registered on the WhatsApp app (a new SIM, or a landline that can receive a voice code). Never a personal number. Agree with Murari's team which number and WhatsApp account the platform will use (design document, section 8).
- **Display name:** "SolutionAI", matching the website.
- **Billing:** add the payment method in **INR**. The currency usually cannot be changed afterwards, and Indian accounts must bill in INR by 31 December 2026.
- Message templates are submitted in Phase 3, not now.

## 6. DLT and the 140-series number

AI calls happen only for founders who ask for a call. The registration still starts now, because it is the slowest item.

- Register SolutionAI as a **Principal Entity** on one operator's DLT portal (Jio, Airtel, Vi or BSNL; one registration is recognised by all). Keep these ready: company PAN, Certificate of Incorporation or GST certificate, an authorisation letter on the letterhead, and the authorised signatory's ID.
- The operator charges a **one-time registration fee**. Confirm it on the portal before paying.
- Ask **Exotel** and **Plivo** in writing for:
  - the monthly rental of a 140-series number;
  - the per-minute rate;
  - any set-up fee;
  - whether they file the header and consent templates on DLT and send the operator notice that automated calls need;
  - the timeline.
- **Decision rule (design document, 7.6):** if the fixed cost is high for our 50 calls a month, the voice agent is still built and tested by 25 November, but stays switched off until founders ask for calls.

## 7 and 8. Database and server (for Murari's team)

- **MongoDB.** A new database (`solutionai_leads`) on the existing cluster, a few GB in the first year. Please confirm the tier has room.
  - Create an application user with the custom role in `ops/mongodb-access.md`. On the append-only collections it can only find and insert, so even a bug cannot rewrite consent records or history.
- **Server.** The engine needs about 2 vCPU and 2 GB RAM, and runs mostly at night. If the existing server cannot spare that, one AWS t4g.small in Mumbai (about ₹900 a month).

## 9. October MCA file

MCA posts the month's report in the first days of the next month (September's came on 5 October). Its site blocks scripted downloads, so this stays a ten-minute manual step.

1. mca.gov.in → Data & Reports → Company/LLP Info → Incorporated/Closed during the month.
2. Download "Companies and LLPs registered in October 2026" and save it in `ai-lead-engine/data/mca/`.
3. Run:

```bash
cd ai-lead-engine/ingest
.venv/Scripts/python -m leadengine ingest mca ../data/mca/Incorporation-Report-202611XX.xlsx
```

The run reports how many UP companies are new. It is safe to run twice.

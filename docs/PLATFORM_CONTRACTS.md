# What the lead engine needs from the platform, and what it offers

**For:** Murari and the platform team. **From:** Gourav Bathwal. **Date:** 27 October 2026, updated 1 November 2026 for Phase 3.

The design document (section 8) lists the touch points between the engine and the SolutionAI platform. Two of them matter in November, and this note proposes their exact shape so both sides can build to it. Nothing here changes the platform's own data; the engine keeps its own database.

## 1. Scheme verdicts from the platform's rules engine (needed by 9 November)

The engine shows each company the schemes it may qualify for. The design says these verdicts must be the same ones Mr. AI shows, so they should come from the platform's rules engine. Until that endpoint exists, the engine uses a small set of provisional rules (`config/rules/schemes.json`, eight schemes), marks every verdict "provisional", and never uses them in a message.

**Proposed endpoint**

```
POST {RULES_ENGINE_URL}/v1/verdicts
Authorization: Bearer {RULES_ENGINE_KEY}          one key for the engine, with its own rate limit
Content-Type: application/json

{
  "company": {
    "kind": "company",                 "company" or "llp"
    "type_code": "PTC",                from the CIN: PTC, OPC, PLC, NPL ... or "LLP"
    "state": "UP",
    "incorporated": "2026-10-14",
    "as_of": "2026-11-09",
    "district": "Lucknow",             may be null
    "sector": "Food & Beverage",       the engine's sector theme
    "stage": "Prototype",              from the startup portals, may be null
    "startinup_listed": false,
    "incubated": false,
    "dpiit_recognised": null           null means unknown
  }
}
```

**Expected answer**

```
200 OK
{
  "rules_version": "2026-11-01",
  "verdicts": [
    {
      "scheme_id": "dpiit_recognition",
      "name": "DPIIT startup recognition",
      "verdict": "check_required",       eligible | check_required | not_eligible | closed | held
      "reason": "Eligible by type and age; needs an innovative business and turnover under ₹200 crore.",
      "missing": ["innovation or scalability", "turnover"],
      "source_url": "https://..."
    }
  ]
}
```

- Only public, company-level facts are sent; nothing about any person.
- If the endpoint is slow or down, the engine falls back to its provisional rules and labels the verdicts as such. A timeout of 10 seconds is assumed.
- **Volume:** the engine asks once per company per night: about 12,700 calls today, growing by about 2,500 a month (and by roughly 290,000 at once if the MCA back files to 2016 are loaded). A batch endpoint (many companies per call) is strongly preferred; with a single-company endpoint the engine will stop calling for the night after a few consecutive failures, so an outage cannot hold the nightly up for hours.
- An unknown fact must never produce "not eligible". It should produce "check required" with the fact listed under `missing`.
- A "closed" verdict should carry the date until which it holds (`valid_until`): the engine's own rules downgrade a closed verdict to "check required" once that date passes, because a wrong "closed" stops a founder applying.

## 2. The Admin pages and their JSON API (available now)

The engine serves its own Admin pages today (`node services/src/cli.js admin`): the pipeline, the shortlist, a company view, the match review queue, the outreach approval queue and data health. The design wants them inside the platform's Admin portal, with the same sign-in. For that, every page has a JSON twin the portal can render in its own design:

| Endpoint | What it returns |
|---|---|
| `GET /api/pipeline?month=YYYY-MM` | Funnel counts, holdout size, cohorts, sector themes, districts, the month's shortlist, latest runs, cap usage, rules status |
| `GET /api/companies?q=&stage=&cohort=&page=` | A page of companies with stage and fit |
| `GET /api/companies/{CIN or LLPIN}` | One company: every fact with its source and date, fit score explained, deadline calendar, scheme verdicts, portal entries, timeline. Personal data is hidden. |
| `GET /api/companies/{id}?personal=1` | The same with directors' names and portal team members. Admin role only, and logged. |
| `GET /api/review` | Portal startups the matcher was not sure about, with candidates. Team members are given as a count only. |
| `POST /api/review` | `{"entity": "UPLC_...", "company": "CIN", "decision": "same" or "different" or "unsure", "note": "..."}`. Reviewer role or higher; logged. |
| `GET /api/approvals` | Outreach emails waiting for a person, with their quality-check result, and what happened to recent ones (Phase 3) |
| `GET /api/approvals/{id}` | One email: the text, its evidence pack, every quality check, the compliance gate's last answer and its history |
| `POST /api/approvals/{id}` | `{"decision": "approve" or "reject", "subject": "...", "body": "...", "note": "..."}`; subject and body only when edited. An edit that fails the quality check is refused (422). Reviewer role or higher; logged. |
| `POST /api/approvals/{id}/outcome` | `{"outcome": "replied" or "bounced" or "complained"}` for a sent email, until replies are read automatically; a bounce or complaint also suppresses the address |
| `POST /api/approvals/{id}/resolve` | `{"sent": "yes" or "no"}` for an email whose send was interrupted, after a person has checked the mailbox's Sent folder |
| `GET /api/labels` | Pairs to label to measure the matcher (held-out links first), with the precision so far and its 95% interval |
| `POST /api/labels` | `{"entity": "UPLC_...", "company": "CIN", "decision": "same" or "different" or "unsure"}`. Reviewer role or higher; logged |
| `GET /api/audit?action=&actor=&from=&to=&page=` | The audit log, newest first, 100 a page (admin role only; reading it is itself logged) |
| `GET /api/exports` | Export requests and their status |
| `POST /api/exports` | `{"reason": "...", "stage", "cohort", "shortlist_month", "district", "max_rows", "include_contacts"}`. Reviewer role or higher; an admin who is not the person asking must approve |
| `POST /api/exports/{id}` | `{"decision": "approve" or "reject", "note": "..."}`. Admin role; never the person who asked |
| `GET /api/exports/{id}/download` | The CSV, for the person who asked, for 24 hours after approval; every download logged |
| `GET /api/mca` | The MCA files waiting, failed (with the reason) and loaded |
| `POST /api/mca` | The month's workbook as the raw body, its name in `X-File-Name`. Admin role, with a token |

**Sign-in today:** each person has a token (`node services/src/cli.js admin:user email role`), and the API takes it as `Authorization: Bearer <token>`. The roles are viewer, reviewer and admin. Every sign-in, sign-out, refused token, reveal of personal data and review decision is written to `audit_log`; wrong tokens are throttled per address, and signing out ends the session on the server, not just in the browser. Link targets in the JSON (`source_url`) are always http(s) or null.

**Inside the platform (built 13 November): both ways are ready; pick one or use both.**

1. *Your proxy signs who the person is* (best when the portal shows the engine's own pages). On every request it forwards, the proxy adds five headers, made with a secret we share (`PLATFORM_SSO_SECRET`, 32+ characters):

   | Header | Value |
   |---|---|
   | `X-Platform-User` | the person's email |
   | `X-Platform-Role` | `viewer`, `reviewer` or `admin` |
   | `X-Platform-Time` | Unix seconds now (we accept 2 minutes either way) |
   | `X-Platform-Body-SHA256` | hex SHA-256 of the request body exactly as forwarded (for a request with no body, of nothing: `e3b0c442…b855`) |
   | `X-Platform-Signature` | `sha256=` + hex HMAC-SHA256 of `v2`, time, METHOD, request target, user, role, body hash, joined by newlines (`\n`) |

   The request target is the path and query exactly as the engine receives it (`/api/companies?q=agra`), and the body's hash is signed too (the engine checks the body it reads against it), so a captured set of headers works for that one request, with that body, for two minutes and nothing else. In Node:

   ```js
   const time = String(Math.floor(Date.now() / 1000));
   const bodyHash = crypto.createHash('sha256').update(body ?? '').digest('hex');
   const sig = crypto.createHmac('sha256', SECRET).update(['v2', time, method, target, email, role, bodyHash].join('\n')).digest('hex');
   // X-Platform-User: email, X-Platform-Role: role, X-Platform-Time: time, X-Platform-Body-SHA256: bodyHash, X-Platform-Signature: `sha256=${sig}`
   ```

   `node services/src/cli.js admin:platform-headers <email> <role> --target /api/pipeline` prints a worked example as `curl`, to check your implementation against. The proxy should remove any `X-Platform-*` headers the browser sent. Give the engine its own host name behind the proxy (its pages use paths from the root, `/admin/...`). If your proxy rewrites the `Host` header, tell us your origin (`ADMIN_ALLOWED_ORIGINS`) so that form posts pass the origin check. The engine's forms keep their own CSRF token, and "Sign out" goes to your sign-out page (`PLATFORM_SIGNOUT_URL`).

2. *Your backend calls the JSON API with a service token* (best when the portal renders the data in its own design). We make the token with `admin:service portal <max-role>` and give it to you privately. Every call sends `Authorization: Bearer <token>`, `X-Acting-User: <the person's email>` (required) and `X-Acting-Role` (default `viewer`; refused if above the token's maximum).

Either way, the audit log records the person and their role, never the portal. The first request of each person in 12 hours is logged as a sign-in. A bad platform signature is refused, logged and throttled per address, like a wrong token. The `/mcp` tools accept both.

**What we need from you:** which way you want, the shared secret (or we send you a service token), your portal's origin, and its sign-out URL.

## 3. Phase 3: three endpoints the engine now calls (built 1 November)

The engine's side of each is built and tested against a stand-in, and falls back safely while the endpoint does not exist. Each takes one key for the engine (`PLATFORM_API_KEY`, as a bearer token), and only company-level facts, plus what a founder typed on the claim form, ever cross.

### 3.1 Pre-filled sign-up when a founder claims a company page

When a founder claims their company's page and agrees to what they want to hear about, the engine asks the platform for a sign-up link with the business profile already filled in (design 7.6).

```
POST {PLATFORM_ONBOARDING_URL}
Authorization: Bearer {PLATFORM_API_KEY}

{
  "company": { "id": "U62099UP2026PTC254264", "name": "Vezras Technologies Private Limited", "kind": "company",
               "legal_form": "Private Limited Company", "incorporated": "2026-10-14", "district": "Lucknow", "state": "UP" },
  "contact": { "name": "Asha Verma", "role": "Director", "email": "asha@vezras.in", "whatsapp": "+919876543210" },
  "consents": [ { "channel": "email", "purpose": "deadline_reminders",
                  "wording": "Email me reminders of Vezras Technologies Private Limited's filing deadlines.", "wording_version": "claim-v1" } ],
  "source": { "engine": "lead-engine", "claimed_at": "2026-11-20T06:00:00.000Z" }
}

200 OK
{ "signup_url": "https://app.solutionai.in/signup?prefill=..." }      must be https
```

- `whatsapp` is null when the founder gave no number. `consents` lists exactly what they ticked, with the words they saw; the engine keeps the authoritative record in its consent ledger.
- **If the endpoint is not set, slow (10 seconds) or answers anything else**, the founder is sent to the plain sign-up (`PLATFORM_SIGNUP_URL`) instead. A founder who claims is never left on an error.

### 3.2 Reminders for signed-up founders

A founder who agreed to email reminders gets them through the platform's own mail (ZeptoMail) and in-app notifications, never through the engine's outreach mailboxes (design 7.6, "Notifications").

```
POST {PLATFORM_NOTIFY_URL}
Authorization: Bearer {PLATFORM_API_KEY}

{
  "channel": "email",
  "to": "asha@vezras.in",
  "type": "deadline_reminder",
  "company": { "id": "U62099UP2026PTC254264", "name": "Vezras Technologies Private Limited" },
  "title": "Vezras Technologies Private Limited: File the declaration for commencement of business is due by 12 March 2027",
  "deadline": { "id": "inc_20a", "title": "File the declaration for commencement of business", "form": "INC-20A", "due": "2027-03-12",
                "law": "Companies Act 2013 s.10A; Companies (Incorporation) Rules 2014 r.23A" },
  "link": "https://pages.solutionai.in/c/<token>"
}

200 OK
{ "id": "..." }
```

- The engine sends a reminder 7 and 1 days before each confirmed, firm deadline, at most 6 a month per channel, and only while the founder's consent stands and the address is not suppressed.
- Until the endpoint exists, email reminders are not sent (WhatsApp reminders go through Meta directly).
- **Scheme alerts** use the same endpoint, with `"type": "scheme_alert"`, for a founder who ticked "email me when the company may qualify for a scheme". They are sent once per scheme, only for a scheme that started to apply after the founder claimed the page, and at most two a month. Until the endpoint exists, they wait rather than being dropped:

```
{ "channel": "email", "to": "asha@vezras.in", "type": "scheme_alert",
  "company": { "id": "U62099UP2026PTC254264", "name": "Vezras Technologies Private Limited" },
  "title": "Vezras Technologies Private Limited may qualify for DPIIT startup recognition",
  "scheme": { "id": "dpiit_recognition", "name": "DPIIT startup recognition", "verdict": "check_required",
              "benefit": "...", "to_check": ["innovation or scalability"], "source_url": "https://..." },
  "link": "https://pages.solutionai.in/c/<token>" }
```

### 3.3 The LLM gateway

The engine drafts first emails with the gateway's strong model and can run an advisory AI review with the small one (design 7.5). It speaks the OpenAI-compatible chat-completions format, which most gateways offer; please confirm, or tell us the shape yours uses.

```
POST {LLM_GATEWAY_URL}/chat/completions
Authorization: Bearer {LLM_GATEWAY_KEY}

{ "model": "strong", "messages": [ ... ], "max_tokens": 900, "temperature": 0.3, "response_format": { "type": "json_object" } }

200 OK
{ "model": "...", "choices": [ { "message": { "content": "{\"subject\": \"...\", \"body\": \"...\"}" } } ],
  "usage": { "prompt_tokens": 900, "completion_tokens": 300 } }
```

- **What we need from you:** a key for the engine with its own budget, and which models "small" and "strong" should mean (`LLM_MODEL_SMALL`, `LLM_MODEL_STRONG`), plus their prices so `config/llm.json` costs each call correctly.
- The engine caps its own spending before every call (₹400 a month, `config/caps.json`) and per company, and logs every call with its tokens and cost in `llm_calls`.
- Only the company's evidence pack (company-level facts, deadlines and schemes with their law) is sent. Nothing about any person.
- **Without the gateway**, drafts come from reviewed templates, which pass the same quality check. Nothing waits on this.

### 3.4 Still to agree

- **The Admin portal's sign-in** for the engine's pages (section 2).
- **Platform events** and **MCP**: section 4.

## 4. Phase 4: events from the platform, and the engine's MCP tools (built 2 November)

### 4.1 Sign-ups, service requests and payments (platform → engine)

So the engine can show which paying clients it brought, and compare them with the holdout (design 7.9), the platform sends three kinds of event. They can go one at a time or in batches of up to 100, as they happen or every few minutes.

```
POST https://<admin host>/api/events
Content-Type: application/json
X-Signature: sha256=<hex HMAC-SHA256 of the raw request body, keyed with PLATFORM_EVENTS_SECRET>

{ "events": [
  { "id": "evt_8d1f", "type": "signed_up",       "at": "2026-11-24T10:00:00+05:30", "company_id": "U62099UP2026PTC254264" },
  { "id": "evt_8d20", "type": "service_request", "at": "2026-11-24T10:05:00+05:30", "company_id": "U62099UP2026PTC254264", "service": "inc_20a" },
  { "id": "evt_8d21", "type": "paid",            "at": "2026-11-24T11:00:00+05:30", "company_id": "U62099UP2026PTC254264",
    "amount_paise": 499900, "currency": "INR", "service": "inc_20a", "reference": "pay_N7xY..." }
] }

200 OK
{ "received": 3, "failed": 0, "results": [ { "id": "evt_8d1f", "ok": true, "duplicate": false, "known_company": true }, ... ] }
```

- **`id`** is yours and unique: a resent event is recorded once.
- **`company_id`** is the CIN or LLPIN. The claim handed it to the platform at sign-up (section 3.1). For a founder who came another way, send it if their business profile has one; the engine still records the event, with no lead.
- **`at`** is when it happened, with its time zone.
- **`amount_paise`** applies to payments only, in whole paise. `reference` is the Razorpay payment id, kept for reconciliation.
- **Nothing about the person** (name, email, phone, user id) is to be sent; anything beyond these fields is dropped.
- **A wrong or missing signature** gets 401 and is logged. After ten in a minute from one address, the engine answers 429 for a minute.
- **One bad event in a batch** comes back with `"ok": false` and the reason; the rest are recorded.

Signing it in Node.js:
```js
const body = JSON.stringify({ events });
const signature = 'sha256=' + crypto.createHmac('sha256', process.env.PLATFORM_EVENTS_SECRET).update(body).digest('hex');
await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': signature }, body });
```

### 4.2 The engine's MCP tools (engine → Mr. AI and the team)

Design 7.5 and section 8: the engine offers a few tools so Mr. AI and our team use the same data. They speak the Model Context Protocol (JSON-RPC 2.0, protocol versions 2025-06-18, 2025-03-26 and 2024-11-05):
- **For Mr. AI:** `POST https://<admin host>/mcp`, with an Admin access token as a bearer token (`lead-engine admin:user mr-ai@solutionai.in viewer`). Streamable HTTP without a stream: one JSON-RPC message in, one JSON answer out.
- **For the team's desktop clients:** `node services/src/cli.js mcp`, on stdin/stdout.

| Tool | Arguments | Returns |
|---|---|---|
| `search_leads` | `query` (part of the name), `district`, `stage`, `shortlist_month`, `limit` (at most 25) | UP companies with their stage, fit and theme. Holdout companies are never returned |
| `company_profile` | `company_id` | public facts, stage, fit with its reasons, schemes, and `outreach`: whether the engine may contact the company |
| `deadline_calendar` | `company_id`, `include_past` | each date with its form, law and source, and `rules_confirmed`. Until a CA confirms the rules, a `caveat` says not to state the dates to a founder as fact |

- Read-only, and company-level only: no director, contact detail, consent or message.
- **To agree:** whether Mr. AI should have all three, and how it should word a date that is not yet confirmed (design section 14).

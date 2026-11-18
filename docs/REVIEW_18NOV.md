# Code review of the 13–18 November work (WORKPLAN item 2)

Read-only review, 18 Nov 2026. Most severe first. Each finding was checked against the surrounding
code; finding 5 was also reproduced with a small script against `auth.js` (no database). Line numbers
are as read on 18 Nov evening; `server.js`, `views.js`, `queries.js` and `demo.js` were being edited
by other agents at the time.

---

## 1. HIGH: campaign pages let anyone claim any company, and make the engine call or WhatsApp any number

**Where:** `services/src/public/server.js:126-152` (`handleCampaign`), `:157-241` (`handleClaim`);
`services/src/public/campaigns.js:35-47` (`findCompanies`).

**What goes wrong:** before campaigns, the claim form was reachable only through a company-page token
sent to the company's registered address, so whoever claimed had at least received that email. A
campaign landing page (`/j/<code>`) issues a company-page token for any company that a name search finds
(`server.js:150`), to anyone on the internet. The claim itself checks nothing about the person:
- **Calls and WhatsApp to any number.** A visitor searches any company, opens it, and claims it with
  any email and **someone else's mobile number**, ticking "call me back" and "WhatsApp reminders". The
  engine records consents in the ledger for a person who never gave them (`:203-207`), sends the
  `reminders_confirmation` WhatsApp template to that number (`:219-222` → `reminders.js:186`), and
  queues an AI voice call to it from the DLT caller number (`:230-232`, `voice/calls.js:98`). Nothing
  verifies the number. The only limit is 10 claims per hour per IP address (`:68`). Each fake claim also
  uses up the month's voice-call cap and WhatsApp spend, and can lower the template's quality rating
  at Meta.
- **Outreach to a real company stops for good.** The same claim moves the lead to `claimed` (`:217`) and
  cancels its open drafts, approved messages and pending send jobs (`:218` → `outreach/stop.js`).
  `planOutreach` only takes leads that are `shortlisted`, so that company is never emailed. The
  mistake is easy to make in good faith: search results show at most 5 rows with only the name, the
  year and the district, and similar names are common ("SHREE BALAJI ... PRIVATE LIMITED").
- **The platform gets a pre-filled account for the wrong person.** `platform.onboard` (`:234-240`)
  receives the company together with the stranger's name, email and phone.

**Fix:** for a claim that comes from a campaign token (`doc.campaign` set), record nothing that acts
until the claimant proves they control the contact:
- email a confirmation link to the address given, or accept the claim at once only when the email is
  the company's registered or website address or is on its domain;
- leave the lead stage alone and do not call `stopQueued` or `platform.onboard` until the claim is
  confirmed;
- never queue a call or WhatsApp to a number that has not been confirmed (an OTP, or the WhatsApp
  confirmation template answered "yes" before any call);
- keep campaigns switched off (`active: false`) until this is in place.

Related small bug: the `call_requested` activity hard-codes `holdout: false` (`server.js:225`). A holdout
company claimed through a campaign is then counted as "engaged" in `costs()` (`attribution/results.js:111`).
Use the same `doc.campaign ? view.lead?.holdout === true : false` as the `claimed` row.

---

## 2. MEDIUM: personal registered emails go to the outside verification service

**Where:** `services/src/outreach/sequence.js:155-156`; `services/src/outreach/verify.js:131`
(`callProvider`); `services/src/outreach/evidence.js:79-81`.

**What goes wrong:** `recipientFor` returns the registered email even when it is a person's (it sets
`personal: true`). This is the usual case for new UP companies, whose registered email is often a
founder's Gmail address, and also happens whenever `use_website_email` is off. `draftStep` then calls
`deps.verifier.verify(recipient.address)` without looking at `personal`. Once
`EMAIL_VERIFY_PROVIDER`/`EMAIL_VERIFY_API_KEY` are set (WEEK4_ACTIONS item 22), each such address goes
to ZeroBounce or MillionVerifier, both outside services abroad. The project's rule is "never a person's
data to an outside service". `ai_check.js` holds back names for exactly this reason, and the privacy
notice does not name a verification processor.

**Fix:** in `draftStep` (or inside `verify()`, with a `personal` flag passed in), run only the free
checks (format, throwaway domain, MX) for `recipient.personal === true` and give the result
`unverified`. Call the paid provider only for role addresses. If the owner decides personal addresses
should be checked too, the privacy notice and the legal pack must name the processor first.

---

## 3. MEDIUM: a backup taken while consents are written fails its own restore check

**Where:** `services/src/ops/backup.js:68-71` and `:162-167`.

**What goes wrong:** `backupDb` writes the collections one at a time in alphabetical order and reads the
consent ledger's head **after all of them**. A full backup writes `consents` early and then the large
`enrichment_cache`, `entity_links`, `leads` and `source_records`, which takes minutes. A claim, a
WhatsApp STOP or a call outcome that adds a ledger entry in that window gives a manifest with
`ledger_head.seq = N+1`, while the file holds entries only up to N. `restoreDb` then reports
`ledger.ok = false`, and `cli.js:503-505` prints "The restore does not match the backup: do not use
this database." and exits with 1. A consistent backup is rejected, during a disaster or a drill. The
hourly critical backup has the same window (`consents` comes before `messages`, `people` and
`suppressions`).

**Fix:** take the head from the consents actually written. Track the highest `seq` and its `hash` while
`writeCollection('consents')` streams, or read `head()` immediately before dumping `consents` and check
in `restoreDb` that the restored chain *contains* that entry (seq ≥ head and the hash at that seq
matches) rather than *ends* at it.

---

## 4. MEDIUM-LOW: "held back from the first wave" means never; a later website address is never tried

**Where:** `services/src/outreach/sequence.js:155-161`, `:62`; `services/src/jobs/queue.js:98`;
`services/src/outreach/verify.js:90-91`.

**What goes wrong:**
- **Accept-all addresses are never written to.** When the check says `hold` or `never`, `draftStep`
  returns `{ skipped }` and the job ends `done`. `planOutreach` re-enqueues every day with the same
  `idemKey` (`draft:<cid>:first_touch`), but `enqueue` upserts on `idem_key` with `$setOnInsert`, so no
  new job is ever created. The comments, `config/outreach.json` and HANDOVER say accept-all addresses
  are "kept out of the first wave"; in fact they are never written to, and nothing lists them for a
  later wave. The `address_not_used` idem key carries the date, as if a daily retry had been intended.
- **A website address found later is never used.** If the registered email is judged `never`, and
  `enrich websites` later finds a role address (or `use_website_email` is switched on), the company is
  still never drafted.
- **Domains without an MX record are wrongly ruled out.** `hasMx` treats `ENODATA` (the domain exists
  but has no MX record) as `no_mx` → `never`. Under RFC 5321 §5.1, mail then goes to the domain's A
  record, so such addresses can be delivered.

**Fix:** for `hold`, and for `never` results that a new address can change, either do not complete the
job (throw a `DeferError` with a retry date), or include the result in the idem key
(`draft:<cid>:first_touch:<address hash>`) so that a new address or a later wave gets a new job. Add an
explicit "second wave" rule for accept-all addresses, or reword the docs to say they are never used.
Treat `ENODATA` as `null` (unknown) or do an A/AAAA lookup before saying `no_mx`.

---

## 5. LOW: the two-admin rule on exports can be passed by the same person (email case)

**Where:** `services/src/admin/auth.js:28-32` (personal-token emails kept as typed) versus `:153` and
`:166` (platform and service emails lower-cased); `services/src/admin/exports.js:105` and `:132`.

**What goes wrong:** `decideExport` refuses only when `requested_by === user.email`, compared exactly.
Reproduced with a script:

- An admin listed in `ADMIN_USERS` as `Gourav@SolutionAI.in` asks for an export with their personal
  token, which records `requested_by = "Gourav@SolutionAI.in"`.
- The same person, reaching the engine through the platform proxy, arrives as `gourav@solutionai.in`.
- The equality check is false, so they approve their own export.

The reverse case also happens: someone who asked through the platform gets 403 when they download
with their personal token.

**Fix:** lower-case `email` in `parseUsers`, and compare `requested_by` and `user.email`
case-insensitively in `decideExport` and `downloadExport`. Storing every identity in lower case
everywhere is the simplest way.

---

## 6. LOW: the platform signature does not cover the request body

**Where:** `services/src/admin/auth.js:60-63` (the contract) and `:96-98`, `:162`.

**What goes wrong:** the HMAC covers time, method, target, user and role, but not the body. The
comment promises "a captured header set is good for that one request for two minutes, nothing
else". In fact a captured header set for a POST works for **any body** sent to the same path in those
two minutes. For example, the headers of a reviewer's `POST /api/review` can be replayed with a
different `entity`/`company`/`decision`, and those of `POST /api/exports` with
`include_contacts=yes`. An attacker needs to see traffic between the proxy and the engine, so the risk
is limited, but the contract is not what the comment says.

**Fix:** add `sha256(body)` as a seventh line of the signed string (`v2`), checked after the body is
read and before it is used. The platform team's proxy must send it. Otherwise, correct the comment and
PLATFORM_CONTRACTS.md so that nobody relies on it.

---

## 7. LOW: the demo seed's guard checks the config's database name, not the database it drops

**Where:** `services/src/ops/demo.js:223-225`.

**What goes wrong:** `seedDemo(db, { cfg })` calls `assertDemo(cfg.dbName)` and then
`db.dropDatabase()` on the `db` it was given. A caller that passes a demo `cfg` with a non-demo `db`
(a test, or a later refactor of `cli.js:510-512`) drops that database, which can be the live one. The
two callers today pass matching values, so nothing is wrong yet, but the guard does not protect what
its message says it protects.

**Fix:** `assertDemo(db.databaseName)`, and also check that `db.databaseName === cfg.dbName`, before
`dropDatabase()`.

---

## Checked and found sound

- **Auth and roles:** the order of checks in `identify`; service-token role caps; constant-time
  comparisons; the clock-skew check after the signature; CSRF on browser forms (session and platform);
  `sameOrigin` with `Origin: null`; logout for platform users.
- **MCA upload:** multipart parsing; file names (basename plus `safeName`, so no path traversal); the
  atomic `.part` → rename; the duplicate check. The Python inbox never overwrites and files failures
  with a reason. Nightly step status and the `data.mca_failed` alert are recorded.
- **Exports:** filters are validated and regexes escaped; holdout companies are excluded; personal and
  suppressed emails are dropped; CSV formula injection is prefixed with `'`; every download is logged.
- **Labels, audit and AI check:** the held-out fold matches `match.holdout`; precision uses
  `entity_links.matcher`; the audit page is admin-only and its own viewing is logged; the AI check
  sends no team names.
- **Public pages:** every value is escaped; links pass through `safeHref`. The Hindi gate refuses a
  Hindi claim until approved and records the Hindi wording version. Campaign search is a regex on
  `[a-z0-9]` only.
- **Websites:** the fetcher blocks private and metadata addresses on every redirect hop; only role
  addresses on the company's own domain are kept; stored pages are redacted.
- **Demo:** uses stand-in transport, DNS, voice and platform, and an explicit env (no `.env` and no
  real keys).
- **Sampling:** engine approvals go through the same `decide` path, the same quality check and the
  same compliance gate, and are logged.

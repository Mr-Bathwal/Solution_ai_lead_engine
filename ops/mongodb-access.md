# MongoDB access for the lead engine

The engine uses its own database, `solutionai_leads`, on the existing cluster. It never reads or writes the platform's databases.

## Create the collections

```bash
cd services
npm install
MONGODB_URI="<admin connection string>" npm run migrate
```

This creates the 24 collections with their validators and 68 indexes (schema version 2; Phase 4 added `inbound`, `calls` and `alerts`). It is safe to run again: it updates validators, creates missing indexes, and reports any index whose definition changed or that the schema does not name, without dropping anything. A changed index is rebuilt only with `--rebuild-indexes`, and a unique one only with `--allow-unique-gap` as well, after every worker and writer has been stopped; if the rebuild fails, the old index is put back.

## The application role

The application user gets the role `leadEngineApp`:

- **find and insert only** on `consents`, `activities`, `source_records` and `audit_log`, so consent records, history and the audit trail can never be edited by the application;
- **find, insert and update, but no remove,** on `suppressions` and `locks`, so a bug cannot lift a suppression or drop the lock that keeps the consent ledger in order;
- find, insert, update and remove on the working collections (`companies`, `people`, `leads`, `jobs`, `ingest_runs`, `llm_calls`, `source_state`, `entity_links`, `match_reviews`, `enrichment_cache`, `usage`, `revoked_sessions`, from Phase 3 `messages`, `page_tokens` and `channel_templates`, and from Phase 4 `inbound`, `calls` and `alerts`);
- find only on `_meta`.

The role is built from `schema/collections.json`, so a collection added there is covered the next time the role is applied. After an upgrade, run `npm run migrate -- --role` again (on Atlas, apply the printed JSON again).

**Self-managed MongoDB:** `npm run migrate -- --role` creates the role. Then create the user:

```js
db.getSiblingDB("solutionai_leads").createUser({
  user: "lead_engine_app",
  pwd: passwordPrompt(),
  roles: [{ role: "leadEngineApp", db: "solutionai_leads" }],
})
```

**MongoDB Atlas:** Atlas does not allow `createRole` from a connection.
1. In Database Access → Custom Roles, create `leadEngineApp` with the same privileges. `npm run migrate -- --role` prints them as JSON in the Atlas Admin API's format when it cannot create the role itself.
2. Create the user `lead_engine_app` with that role.

**Erasure needs an admin user.** `lead-engine erase` blanks the address on the consent ledger's entries, which the application role cannot update (it can only find and insert there). Run it with an admin connection string for that one command: `MONGODB_URI=<admin uri> node src/cli.js erase email <address> --by <you>`. Without that privilege it stops before changing anything and says so.

Keep the connection string in AWS Systems Manager Parameter Store, and never in code or chat. The same goes for `CONTACT_KEY_SECRET`: every suppression entry and consent `contact_key` is a keyed hash (HMAC-SHA256) under it, so the database alone cannot be reversed into phone numbers or emails. It must never be stored in the database.

**Transactions.** On a replica set (every Atlas cluster is one), each consent is added to the ledger in a transaction, so writers on several machines can never fork the chain. On a single standalone server the ledger falls back to retrying, which is safe but slower under load.

## Two operations that need an admin, by design

- **Erasure** (`ConsentLedger.redactAddress`) blanks an address inside consent records. The hash chain stays valid. On the suppression list, an erasure request blanks the stored address and note even on an entry that already existed, and keeps only the keyed hash, so the person stays suppressed.
- **Lifting a suppression** is deliberately not in the code. An admin removes the entry by hand and writes a note in `activities`.

## Checks

```bash
node src/cli.js status          # counts per collection, job stats, consent ledger check
node src/cli.js ledger:verify   # exits with code 2 if the consent ledger, or an anchor, does not match
node src/cli.js ledger:anchor   # daily: appends the ledger's head to LEDGER_ANCHOR_FILE
```

The hash chain shows that nothing before its head was edited. The anchors, kept in a file the database's administrators cannot rewrite, show that the head itself was not cut back or recomputed.

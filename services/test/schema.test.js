import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { MongoClient } from 'mongodb';
import { TEST_SECRET, freshDb, startAuthMongo, startMongo } from './helpers/mongod.js';
import { APP_ROLE, appRoleDefinition, atlasCustomRole, ensureAppRole, migrate } from '../src/db/migrate.js';
import { loadSchema } from '../src/config.js';
import { ConsentLedger } from '../src/consent/ledger.js';
import { JobQueue } from '../src/jobs/queue.js';
import { SuppressionList } from '../src/suppression/list.js';

let mongo;
let client;
let db;

before(async () => {
  mongo = await startMongo();
  ({ client, db } = await freshDb(mongo.uri));
});
after(async () => { await client.close(); await mongo.stop(); });

const company = (over = {}) => ({
  _id: 'U62099UW2026PTC259408',
  kind: 'company',
  state: 'UP',
  name: 'ADOZMART ECOM PRIVATE LIMITED',
  ids: { cin: 'U62099UW2026PTC259408' },
  attrs: { incorporation_date: { value: '2026-09-30', source: 'mca_monthly', seen_at: new Date() } },
  sources: ['mca_monthly'],
  first_seen_at: new Date(),
  updated_at: new Date(),
  schema_version: 1,
  ...over,
});

describe('schema', () => {
  test('migrate is safe to run again', async () => {
    const r = await migrate(db, loadSchema());
    assert.equal(r.created.length, 0);
    assert.equal(r.indexes.created, 0);
    assert.deepEqual(r.indexes.conflicts, []);
  });

  test('accepts a valid UP company', async () => {
    await db.collection('companies').insertOne(company());
  });

  test('refuses a company outside Uttar Pradesh', async () => {
    await assert.rejects(
      db.collection('companies').insertOne(company({ _id: 'U62099MH2026PTC000001', state: 'MH' })),
      /validation/i,
    );
  });

  test('refuses a malformed CIN and an attribute without provenance', async () => {
    await assert.rejects(db.collection('companies').insertOne(company({ _id: 'NOT-A-CIN-123' })), /validation/i);
    await assert.rejects(
      db.collection('companies').insertOne(company({ _id: 'U62099UP2026PTC000002', attrs: { district: { value: 'Lucknow' } } })),
      /validation/i,
    );
  });

  test('a source record version is stored once', async () => {
    const rec = {
      source: 'mca_monthly', natural_key: 'U62099UW2026PTC259408', content_hash: 'a'.repeat(64), payload: {},
      legal_basis: 'published_under_law', fetched_at: new Date(), run_id: 'r1', schema_version: 1,
    };
    await db.collection('source_records').insertOne({ ...rec });
    await assert.rejects(db.collection('source_records').insertOne({ ...rec }), /duplicate key/);
  });

  test('the app role is insert-only on append-only collections', () => {
    const role = appRoleDefinition('solutionai_leads', loadSchema());
    const actions = Object.fromEntries(role.privileges.map((p) => [p.resource.collection, p.actions]));
    assert.deepEqual(actions.consents, ['find', 'insert']);
    assert.deepEqual(actions.activities, ['find', 'insert']);
    assert.deepEqual(actions.source_records, ['find', 'insert']);
    assert.deepEqual(actions.audit_log, ['find', 'insert']);
    assert.ok(actions.source_state.includes('update'), 'the current-version pointer moves');
    assert.ok(actions.jobs.includes('update'));
  });

  test('the app role can never delete from the suppression list or the locks, and covers every collection', () => {
    const spec = loadSchema();
    const role = appRoleDefinition('solutionai_leads', spec);
    const actions = Object.fromEntries(role.privileges.map((p) => [p.resource.collection, p.actions]));
    assert.deepEqual(actions.suppressions, ['find', 'insert', 'update']);
    assert.deepEqual(actions.locks, ['find', 'insert', 'update']);
    assert.deepEqual(actions.revoked_sessions, ['find', 'insert', 'update', 'remove']);
    for (const name of Object.keys(spec.collections)) assert.ok(actions[name], `${name} has privileges`);
  });

  test('the Atlas form of the role grants the same actions', () => {
    const atlas = atlasCustomRole('solutionai_leads', loadSchema());
    assert.equal(atlas.roleName, APP_ROLE);
    const on = (action) => atlas.actions.find((a) => a.action === action).resources.map((r) => r.collection);
    assert.ok(on('INSERT').includes('consents'));
    assert.ok(!on('UPDATE').includes('consents'));
    assert.ok(!on('REMOVE').includes('suppressions'));
    assert.ok(on('REMOVE').includes('jobs'));
  });
});

describe('migrate: indexes it did not make', () => {
  test('an index under another name is reported, not fatal, and unknown indexes are listed', async () => {
    const other = client.db(`t_idx_${Date.now().toString(36)}`);
    await other.createCollection('jobs');
    await other.collection('jobs').createIndex({ idem_key: 1 }, { unique: true }); // made by hand: idem_key_1
    await other.collection('jobs').createIndex({ old_field: 1 }, { name: 'obsolete' });
    const r = await migrate(other, loadSchema());
    assert.ok(r.indexes.conflicts.some((c) => c.startsWith('jobs.idem_unique (its key is already indexed as idem_key_1')), r.indexes.conflicts.join('; '));
    assert.deepEqual(r.indexes.extra.sort(), ['jobs.idem_key_1', 'jobs.obsolete']);
    assert.ok(r.created.includes('locks'), 'the collections after it were still migrated');
  });

  test('a unique index is only rebuilt with allowUniqueGap, and a failed rebuild puts the old index back', async () => {
    const other = client.db(`t_rebuild_${Date.now().toString(36)}`);
    await migrate(other, loadSchema());
    const queue = new JobQueue(other);
    await queue.enqueue({ type: 't', idemKey: 'a' }); // two jobs with lead_id and step both null
    await queue.enqueue({ type: 't', idemKey: 'b' });
    const changed = structuredClone(loadSchema());
    changed.collections.jobs.indexes.find((i) => i.name === 'lead_step').options.unique = true;
    const r = await migrate(other, changed, { rebuildIndexes: true });
    assert.ok(r.indexes.conflicts.some((c) => c.startsWith('jobs.lead_step (unique: stop every worker')), r.indexes.conflicts.join('; '));
    await assert.rejects(migrate(other, changed, { rebuildIndexes: true, allowUniqueGap: true }), /old index was restored/);
    const ix = (await other.collection('jobs').indexes()).find((i) => i.name === 'lead_step');
    assert.ok(ix && !ix.unique, 'the old lead_step index is back');
  });
});

describe('the app role on a server with access control', () => {
  test('the application can do its work, but not delete suppressions or rewrite consent', async () => {
    const authd = await startAuthMongo();
    const root = await new MongoClient(authd.rootUri).connect();
    let app;
    try {
      const name = 'role_check';
      await migrate(root.db(name), loadSchema());
      assert.equal(await ensureAppRole(root.db(name), loadSchema()), 'created');
      const password = randomBytes(12).toString('hex');
      await root.db(name).command({ createUser: 'app', pwd: password, roles: [{ role: APP_ROLE, db: name }] });
      app = await new MongoClient(`mongodb://app:${password}@127.0.0.1:${authd.port}/?directConnection=true&authSource=${name}`).connect();
      const adb = app.db(name);
      const queue = new JobQueue(adb);
      await queue.enqueue({ type: 't', idemKey: 'j1' });
      assert.equal(await queue.complete(await queue.claim('w'), 1), true);
      const ledger = new ConsentLedger(adb, { secret: TEST_SECRET });
      await ledger.grant({ subject: { type: 'company', id: 'C1' }, channel: 'email', purpose: 'scheme_alerts', address: 'a@acme.in', wording: 'w', wordingVersion: 'v1', capturedVia: 'admin_entry' });
      const list = new SuppressionList(adb, { secret: TEST_SECRET });
      await list.add({ email: 'x@acme.in' }, { reason: 'unsubscribe' });
      await list.add({ email: 'x@acme.in' }, { reason: 'erasure_request' });
      await adb.collection('locks').updateOne({ _id: 'lead:C1' }, { $set: { holder: 'h', updated_at: new Date() } }, { upsert: true });
      const refused = /not authorized|Unauthorized/;
      await assert.rejects(adb.collection('suppressions').deleteMany({}), refused);
      await assert.rejects(adb.collection('locks').deleteMany({}), refused);
      await assert.rejects(adb.collection('consents').updateOne({ seq: 1 }, { $set: { action: 'withdraw' } }), refused);
      await assert.rejects(ledger.redactAddress({ channel: 'email', address: 'a@acme.in' }), refused);
      assert.equal(await adb.collection('suppressions').countDocuments(), 1);
    } finally {
      await app?.close();
      await root.close();
      await authd.stop();
    }
  });
});

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Decimal128, Long, ObjectId } from 'mongodb';
import { TEST_SECRET, freshDb, startMongo } from './helpers/mongod.js';
import { loadSchema } from '../src/config.js';
import { ConsentLedger } from '../src/consent/ledger.js';
import { SuppressionList } from '../src/suppression/list.js';
import { CRITICAL, backupDb, pruneBackups, restoreDb, verifyBackup } from '../src/ops/backup.js';

let mongo;
let client;
let db;
let root;
const spec = loadSchema();
const at = new Date('2026-11-16T04:15:00Z');

before(async () => {
  mongo = await startMongo();
  ({ client, db } = await freshDb(mongo.uri));
  root = mkdtempSync(path.join(os.tmpdir(), 'lead-engine-backup-'));
  const ledger = new ConsentLedger(db, { secret: TEST_SECRET });
  for (const [i, address] of ['a@x.in', 'b@x.in', 'c@x.in'].entries()) {
    await ledger.grant({ subject: { type: 'person', id: `p${i}` }, channel: 'email', purpose: 'deadline_reminders', address,
      wording: 'Email me reminders.', wordingVersion: 'claim-v2', capturedVia: 'company_page_claim', proof: { n: i } });
  }
  await new SuppressionList(db, { secret: TEST_SECRET }).add({ email: 'gone@x.in' }, { reason: 'unsubscribe', source: { via: 'test' } });
  await db.collection('companies').insertOne({ _id: 'U62099UP2026PTC100001', kind: 'company', state: 'UP', name: 'TYPES PRIVATE LIMITED', ids: { cin: 'U62099UP2026PTC100001', uplc: [] },
    attrs: { incorporation_date: { value: '2026-10-01', source: 'mca_monthly', seen_at: at } }, sources: ['mca_monthly'], first_seen_at: at, updated_at: at, schema_version: 2,
    cohort: '2026-10', former_names: [] });
  await db.collection('usage').insertOne({ _id: 'vendor.full_profile:2026-11', meter: 'vendor.full_profile', period: '2026-11', count: Long.fromNumber(7), cap: 40, updated_at: at });
  await db.collection('llm_calls').insertOne({ at, task: 'draft', model: 'm', prompt_version: 'v1', input_tokens: 10, output_tokens: 5, cost_inr: Decimal128.fromString('0.42'),
    lead_id: new ObjectId(), company_id: null, ok: true });
});
after(async () => {
  await client?.close();
  await mongo.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('backups', () => {
  let full;

  test('a full backup: every collection, counted and checksummed, with the ledger head', async () => {
    full = await backupDb(db, { root, clock: () => at, secret: TEST_SECRET });
    assert.equal(path.basename(full.dir), '20261116T041500Z-full');
    assert.equal(full.collections.consents.count, 3);
    assert.equal(full.collections.suppressions.count, 1);
    assert.equal(full.collections.companies.count, 1);
    assert.equal(full.collections._meta, undefined, 'the schema record is rebuilt by a restore, not copied');
    assert.deepEqual(full.ledger_head.seq, 3);
    const files = readdirSync(full.dir).sort();
    assert.ok(files.includes('manifest.json') && files.includes('consents.ejson.gz'));
    assert.ok(!readdirSync(root).some((n) => n.endsWith('.partial')), 'nothing half-written left');
    if (process.platform !== 'win32') assert.equal(statSync(full.dir).mode & 0o777, 0o700);
    await verifyBackup(full.dir);
  });

  test('a restore fills a new database with the same documents, types and ledger, and checks it', async () => {
    const into = `${db.databaseName}_restored`;
    const r = await restoreDb(client, { dir: full.dir, into, spec, liveDbName: db.databaseName, secret: TEST_SECRET });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.ledger.ok, true);
    assert.deepEqual(r.ledger.head, full.ledger_head);
    const restored = client.db(into);
    for (const name of ['consents', 'suppressions', 'companies', 'usage', 'llm_calls']) {
      assert.deepEqual(await restored.collection(name).find({}).sort({ _id: 1 }).toArray(), await db.collection(name).find({}).sort({ _id: 1 }).toArray(), name);
    }
    const u = await restored.collection('usage').findOne({});
    assert.ok(u.count instanceof Long || typeof u.count === 'number');
    assert.ok((await restored.collection('llm_calls').findOne({})).cost_inr instanceof Decimal128, 'decimals stay decimals');
    assert.ok((await restored.collection('companies').findOne({})).updated_at instanceof Date, 'dates stay dates');
    assert.ok((await restored.collection('consents').indexes()).length > 1, 'the indexes are built');
    // the restored suppression list still blocks the address
    assert.equal((await new SuppressionList(restored, { secret: TEST_SECRET }).check({ email: 'gone@x.in' })).length, 1);
    await restored.dropDatabase();
  });

  test('a restore never touches the live database or one that holds data, and refuses a damaged backup', async () => {
    await assert.rejects(restoreDb(client, { dir: full.dir, into: db.databaseName, spec, liveDbName: db.databaseName }), /never over the live database/);
    const busy = client.db(`${db.databaseName}_busy`);
    await busy.collection('x').insertOne({ a: 1 });
    await assert.rejects(restoreDb(client, { dir: full.dir, into: busy.databaseName, spec, liveDbName: db.databaseName }), /already holds data/);
    await busy.dropDatabase();
    const damaged = path.join(root, 'damaged');
    rmSync(damaged, { recursive: true, force: true });
    const { cpSync } = await import('node:fs');
    cpSync(full.dir, damaged, { recursive: true });
    const f = path.join(damaged, 'consents.ejson.gz');
    const bytes = readFileSync(f);
    bytes[bytes.length - 5] ^= 0xff;
    writeFileSync(f, bytes);
    await assert.rejects(restoreDb(client, { dir: damaged, into: `${db.databaseName}_x`, spec, liveDbName: db.databaseName }), /consents\.ejson\.gz does not match its checksum/);
    await assert.rejects(verifyBackup(path.join(root, 'nowhere')), /no readable manifest/);
  });

  test('the hourly backup holds only what cannot be rebuilt; old backups are pruned', async () => {
    const c = await backupDb(db, { root, critical: true, clock: () => new Date('2026-11-16T05:00:00Z') });
    assert.ok(Object.keys(c.collections).every((n) => CRITICAL.includes(n)));
    assert.ok(c.collections.consents && c.collections.suppressions && !c.collections.companies);
    for (let h = 6; h < 10; h += 1) await backupDb(db, { root, critical: true, clock: () => new Date(`2026-11-16T0${h}:00:00Z`) });
    const r = await pruneBackups(root, { full: 1, critical: 2 });
    assert.equal(r.removed.filter((n) => n.endsWith('-critical')).length, 3);
    const left = readdirSync(root).filter((n) => /-(full|critical)$/.test(n)).sort();
    assert.deepEqual(left, ['20261116T041500Z-full', '20261116T080000Z-critical', '20261116T090000Z-critical']);
  });

  test('a consent recorded while the backup runs waits for the next one: the backup still restores clean', async () => {
    const ledger = new ConsentLedger(db, { secret: TEST_SECRET });
    let raced = null;
    // the database as the backup sees it, with a claim landing while `suppressions` (after `consents`) is written
    const racing = new Proxy(db, {
      get(target, prop) {
        if (prop !== 'collection') {
          const v = Reflect.get(target, prop, target);
          return typeof v === 'function' ? v.bind(target) : v;
        }
        return (name) => {
          const col = target.collection(name);
          if (name !== 'suppressions') return col;
          return { find: (...a) => ({ sort: (s) => ({ async* [Symbol.asyncIterator]() {
            raced ??= ledger.grant({ subject: { type: 'person', id: 'p-late' }, channel: 'email', purpose: 'deadline_reminders', address: 'late@x.in',
              wording: 'Email me reminders.', wordingVersion: 'claim-v2', capturedVia: 'company_page_claim', proof: { n: 9 } });
            await raced;
            yield* col.find(...a).sort(s);
          } }) }) };
        };
      },
    });
    const root2 = mkdtempSync(path.join(os.tmpdir(), 'lead-engine-backup-race-'));
    try {
      const b = await backupDb(racing, { root: root2, clock: () => new Date('2026-11-16T10:00:00Z'), secret: TEST_SECRET });
      assert.ok(raced, 'the claim landed during the backup');
      assert.equal(b.collections.consents.count, b.ledger_head.seq, 'the file ends where the manifest says');
      assert.equal((await ledger.head()).seq, b.ledger_head.seq + 1, 'the late consent is in the database, for the next backup');
      const into = `${db.databaseName}_race`;
      const r = await restoreDb(client, { dir: b.dir, into, spec, liveDbName: db.databaseName, secret: TEST_SECRET });
      assert.equal(r.ok, true, JSON.stringify(r.ledger));
      await client.db(into).dropDatabase();
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  });
});

describe('the monitor watches the backups', () => {
  test('alerts when the newest full or hourly backup is too old, and only where backups are kept', async () => {
    const { checks } = await import('../src/monitor/alerts.js');
    const cfg = JSON.parse(readFileSync(new URL('../../config/monitor.json', import.meta.url), 'utf8'));
    const caps = JSON.parse(readFileSync(new URL('../../config/caps.json', import.meta.url), 'utf8'));
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lead-engine-bk-mon-'));
    const { mkdirSync } = await import('node:fs');
    mkdirSync(path.join(dir, '20261116T041500Z-full'));
    mkdirSync(path.join(dir, '20261116T090000Z-critical'));
    const ids = async (iso, backupDir = dir) => (await checks(db, { caps, cfg, clock: () => new Date(iso), backupDir })).map((a) => a._id).filter((x) => x.startsWith('backups.'));
    assert.deepEqual(await ids('2026-11-16T10:00:00Z'), [], 'both fresh');
    assert.deepEqual(await ids('2026-11-16T13:00:00Z'), ['backups.critical'], 'four hours without an hourly backup');
    assert.deepEqual(await ids('2026-11-17T12:00:00Z'), ['backups.full', 'backups.critical']);
    assert.deepEqual(await ids('2026-11-17T12:00:00Z', path.join(dir, 'not-here')), [], 'a laptop with no backup folder is not alerted');
    rmSync(dir, { recursive: true, force: true });
  });
});

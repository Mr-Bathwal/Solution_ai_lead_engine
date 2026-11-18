import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { once } from 'node:events';
import { createGunzip, createGzip } from 'node:zlib';
import { BSON } from 'mongodb';
import { migrate } from '../db/migrate.js';
import { ConsentLedger } from '../consent/ledger.js';

const { EJSON } = BSON;

/**
 * Backups of the engine's own database (`lead-engine backup`, `lead-engine restore`).
 *
 * The cluster's own backups (if the cluster has them) are the platform team's; these are the
 * engine's, because some of what it holds can never be rebuilt: the consent ledger, the
 * do-not-contact list, the audit log, the people who claimed a page, the emails sent and the replies.
 *
 *   backup              every collection (nightly, before the 05:00 run)
 *   backup --critical   only what cannot be rebuilt (hourly), so at most an hour of it can be lost
 *
 * One folder per backup, data/backups/<UTC stamp>-<full|critical>/: each collection as gzipped
 * canonical Extended JSON (one document a line, every type kept), and manifest.json with each file's
 * document count and SHA-256 and the consent ledger's head. The folder is readable by the service user
 * only; cron copies it to S3 (BACKUP_S3_URI), whose bucket keeps it encrypted and deletes it after
 * 35 days. A backup still holds what was erased after it was taken, until it expires (the privacy
 * notice says so).
 *
 * Restore never writes over a database that holds anything: it fills a new one, after checking every
 * file against the manifest, then checks the counts and the consent ledger's hash chain. Pointing the
 * engine at it (LEAD_DB) is a person's decision (docs/HANDOVER.md, "When something goes wrong").
 */

export const CRITICAL = ['consents', 'suppressions', 'audit_log', 'people', 'activities', 'messages', 'inbound', 'calls', 'match_reviews', 'exports', 'page_tokens', 'locks', 'signals'];
const FORMAT = 'leadengine-backup-v1';
const stampOf = (at) => at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

async function writeCollection(col, file, filter = {}) {
  const hash = createHash('sha256');
  const gz = createGzip();
  const out = createWriteStream(file, { mode: 0o600 });
  gz.on('data', (chunk) => hash.update(chunk));
  gz.pipe(out);
  let count = 0;
  for await (const doc of col.find(filter).sort({ _id: 1 })) {
    if (!gz.write(`${EJSON.stringify(doc, { relaxed: false })}\n`)) await once(gz, 'drain');
    count += 1;
  }
  gz.end();
  await once(out, 'finish');
  return { count, sha256: hash.digest('hex'), bytes: (await stat(file)).size };
}

/** Takes a backup. Returns its manifest (with `dir`). */
export async function backupDb(db, { root, critical = false, clock = () => new Date(), secret = '' }) {
  const at = clock();
  const kind = critical ? 'critical' : 'full';
  const final = path.join(root, `${stampOf(at)}-${kind}`);
  const tmp = `${final}.partial`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true, mode: 0o700 });
  // _meta only says which schema the database was migrated to; a restore migrates afresh
  const present = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith('system.') && n !== '_meta');
  const names = (critical ? CRITICAL.filter((n) => present.includes(n)) : present).sort();
  // The ledger's head is read first and only entries up to it are written: a consent recorded while
  // the backup runs (a claim, a WhatsApp STOP) waits for the next backup instead of making the
  // manifest run ahead of the file, which would make a good backup fail its own restore check.
  const ledger = secret.length >= 32 ? await new ConsentLedger(db, { secret, clock }).head() : null;
  const collections = {};
  for (const name of names) {
    const filter = name === 'consents' && ledger ? { seq: { $lte: ledger.seq } } : {};
    collections[name] = await writeCollection(db.collection(name), path.join(tmp, `${name}.ejson.gz`), filter);
  }
  const manifest = { format: FORMAT, kind, database: db.databaseName, taken_at: at.toISOString(), collections,
    ledger_head: ledger ? { seq: ledger.seq, hash: ledger.hash } : null };
  await writeFile(path.join(tmp, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`, { mode: 0o600 });
  await rename(tmp, final);                                  // a backup folder exists only once it is complete
  await chmod(final, 0o700).catch(() => {});
  return { ...manifest, dir: final };
}

/** Keeps the newest `full` full backups and `critical` critical ones in `root`; removes older ones and any partial folder. */
export async function pruneBackups(root, { full = 7, critical = 48 } = {}) {
  let names;
  try {
    names = await readdir(root);
  } catch (err) {
    if (err.code === 'ENOENT') return { removed: [] };
    throw err;
  }
  const removed = [];
  for (const [kind, keep] of [['full', full], ['critical', critical]]) {
    const mine = names.filter((n) => n.endsWith(`-${kind}`)).sort().reverse();
    for (const n of mine.slice(keep)) {
      await rm(path.join(root, n), { recursive: true, force: true });
      removed.push(n);
    }
  }
  for (const n of names.filter((x) => x.endsWith('.partial'))) {
    await rm(path.join(root, n), { recursive: true, force: true });
    removed.push(n);
  }
  return { removed };
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Checks a backup folder against its manifest. Returns the manifest; throws on any difference. */
export async function verifyBackup(dir) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    throw new Error(`${dir} has no readable manifest.json: not a complete backup`);
  }
  if (manifest.format !== FORMAT) throw new Error(`${dir} is not a ${FORMAT} backup`);
  for (const [name, m] of Object.entries(manifest.collections)) {
    const file = path.join(dir, `${name}.ejson.gz`);
    const got = await sha256File(file).catch(() => null);
    if (got !== m.sha256) throw new Error(`${name}.ejson.gz ${got ? 'does not match its checksum' : 'is missing'}: the backup is damaged`);
  }
  return manifest;
}

/**
 * Restores a backup into `into`, which must be empty (or not exist). Returns
 * { database, collections: { name: { expected, restored } }, ledger }.
 */
export async function restoreDb(client, { dir, into, spec, liveDbName, secret = '', clock = () => new Date(), log = () => {} }) {
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(into ?? '')) throw new TypeError('--into must name a new database (letters, digits, _ and -)');
  if (into === liveDbName) throw new TypeError(`never over the live database (${liveDbName}): restore into a new one, check it, then point LEAD_DB at it`);
  const manifest = await verifyBackup(dir);
  const db = client.db(into);
  const existing = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith('system.'));
  for (const name of existing) {
    if (await db.collection(name).estimatedDocumentCount()) throw new TypeError(`${into} already holds data (${name}): restore into an empty database`);
  }
  await migrate(db, spec);                                    // collections, validators and indexes as the code expects today
  const collections = {};
  for (const [name, m] of Object.entries(manifest.collections)) {
    const col = db.collection(name);
    const lines = readline.createInterface({ input: createReadStream(path.join(dir, `${name}.ejson.gz`)).pipe(createGunzip()), crlfDelay: Infinity });
    let batch = [];
    let restored = 0;
    const flush = async () => {
      if (!batch.length) return;
      // the data was valid when it was written; a validator tightened since must not stop a restore
      await col.insertMany(batch, { ordered: true, bypassDocumentValidation: true });
      restored += batch.length;
      batch = [];
    };
    for await (const line of lines) {
      if (!line) continue;
      batch.push(EJSON.parse(line, { relaxed: false }));
      if (batch.length >= 1000) await flush();
    }
    await flush();
    collections[name] = { expected: m.count, restored };
    log(`${name}: ${restored} of ${m.count}`);
  }
  let ledger = null;
  if (manifest.collections.consents && secret.length >= 32) {
    const l = new ConsentLedger(db, { secret, clock });
    const v = await l.verify({ maxProblems: 5 });
    const head = await l.head();
    ledger = { ok: v.ok && (!manifest.ledger_head || (head.seq === manifest.ledger_head.seq && head.hash === manifest.ledger_head.hash)),
      checked: v.checked, head: { seq: head.seq, hash: head.hash }, expected_head: manifest.ledger_head, problems: v.problems ?? [] };
  }
  return { database: into, kind: manifest.kind, taken_at: manifest.taken_at, collections, ledger,
    ok: Object.values(collections).every((c) => c.expected === c.restored) && (ledger ? ledger.ok : true) };
}

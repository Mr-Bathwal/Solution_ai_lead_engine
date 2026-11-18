/**
 * Test database. Uses TEST_MONGODB_URI if set (CI); otherwise starts a throwaway mongod on a free
 * port with a temporary data folder, so tests never touch a real database.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { MongoClient } from 'mongodb';
import { migrate } from '../../src/db/migrate.js';
import { loadSchema } from '../../src/config.js';

function findMongod() {
  if (process.env.MONGOD_PATH) return process.env.MONGOD_PATH;
  const base = 'C:\\Program Files\\MongoDB\\Server';
  if (existsSync(base)) {
    const versions = readdirSync(base).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) {
      const p = path.join(base, v, 'bin', 'mongod.exe');
      if (existsSync(p)) return p;
    }
  }
  return 'mongod';
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** The contact-key secret the tests use (CONTACT_KEY_SECRET in production). A test value, nothing else. */
export const TEST_SECRET = 'test-only-contact-key-secret-0123456789abcdef';

let shared = null;

/** Spawns a throwaway mongod and waits until it answers. Returns { proc, port, dbpath, stop }. */
async function spawnMongod(extraArgs) {
  const dbpath = mkdtempSync(path.join(os.tmpdir(), 'lead-engine-test-'));
  const port = await freePort();
  const argv = ['--dbpath', dbpath, '--port', String(port), '--bind_ip', '127.0.0.1', '--quiet', ...extraArgs];
  if (process.platform !== 'win32') argv.push('--nounixsocket');
  const proc = spawn(findMongod(), argv, { stdio: 'ignore' });
  const direct = `mongodb://127.0.0.1:${port}/?directConnection=true`;
  for (let i = 0; i < 100; i += 1) {
    const c = new MongoClient(direct, { serverSelectionTimeoutMS: 300 });
    try {
      await c.connect();
      await c.close();
      break;
    } catch {
      await c.close().catch(() => {});
      if (proc.exitCode !== null) throw new Error(`mongod exited with code ${proc.exitCode}`);
      await sleep(100);
    }
  }
  const stop = async () => {
    proc.kill();
    await new Promise((r) => (proc.exitCode !== null ? r() : proc.once('exit', r)));
    rmSync(dbpath, { recursive: true, force: true });
  };
  return { port, direct, stop };
}

/**
 * Starts (once per test file) and returns { uri, replicaSet, stop }. The server is a single-node
 * replica set, like Atlas, so transactions and retryable writes behave in tests as in production.
 */
export async function startMongo() {
  if (process.env.TEST_MONGODB_URI) return { uri: process.env.TEST_MONGODB_URI, replicaSet: null, stop: async () => {} };
  if (shared) return shared;
  const m = await spawnMongod(['--replSet', 'rs0', '--oplogSize', '64']);
  const c = new MongoClient(m.direct);
  try {
    await c.connect();
    try {
      await c.db('admin').command({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: `127.0.0.1:${m.port}` }] } });
    } catch (err) {
      if (err?.codeName !== 'AlreadyInitialized') throw err;
    }
    for (let i = 0; i < 300; i += 1) {
      if ((await c.db('admin').command({ hello: 1 })).isWritablePrimary) break;
      await sleep(100);
    }
  } finally {
    await c.close();
  }
  shared = {
    uri: m.direct,
    replicaSet: true,
    stop: async () => {
      await m.stop();
      shared = null;
    },
  };
  return shared;
}

/**
 * A standalone mongod with access control on, for checking the application role. Returns
 * { uri, rootUri, stop }: `uri` has no credentials, `rootUri` signs in as a root user made for the test.
 */
export async function startAuthMongo() {
  const m = await spawnMongod(['--auth']);
  const password = randomBytes(16).toString('hex');
  const c = new MongoClient(m.direct);
  try {
    await c.connect();
    await c.db('admin').command({ createUser: 'root', pwd: password, roles: ['root'] }); // allowed once, from localhost
  } finally {
    await c.close();
  }
  return {
    uri: m.direct,
    rootUri: `mongodb://root:${password}@127.0.0.1:${m.port}/?directConnection=true&authSource=admin`,
    port: m.port,
    stop: m.stop,
  };
}

/** A fresh, migrated database with a unique name. */
export async function freshDb(uri) {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(`t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
  await migrate(db, loadSchema());
  return { client, db };
}

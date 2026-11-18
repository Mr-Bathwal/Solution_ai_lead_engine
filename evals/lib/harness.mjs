/**
 * The database side of the evals: one throwaway mongod (services/test/helpers/mongod.js, exactly as
 * the tests use it), one migrated database emptied between cases, and the engine's outreach deps
 * built with fakes for everything that would leave the machine (fetch, DNS, the mail transport).
 *
 * loadConfig() is always given an explicit environment: called with none it would read the real
 * .env, which may hold live keys and mailbox passwords.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { engine, quiet } from './common.mjs';

export async function openDb() {
  const { startMongo, freshDb, TEST_SECRET } = await engine('test/helpers/mongod.js');
  const mongo = await startMongo();
  const { client, db } = await freshDb(mongo.uri);
  const outbox = mkdtempSync(path.join(os.tmpdir(), 'lead-engine-evals-'));
  return {
    db, secret: TEST_SECRET, outbox,
    async reset() {
      for (const c of await db.listCollections({ type: 'collection' }).toArray()) await db.collection(c.name).deleteMany({});
    },
    async close() {
      await db.dropDatabase().catch(() => {});
      await client.close().catch(() => {});
      await mongo.stop();
      rmSync(outbox, { recursive: true, force: true });
    },
  };
}

/** The environment the evals run the engine with: fictional mailboxes, no keys unless a case adds one. */
export function evalEnv(h, over = {}) {
  return {
    CONTACT_KEY_SECRET: h.secret, PUBLIC_BASE_URL: 'https://pages.solutionai.example', PAGE_SECRET: 'p'.repeat(40),
    OUTREACH_TRANSPORT: 'outbox', OUTBOX_DIR: h.outbox,
    MAILBOX_1_ADDRESS: 'meera@outreach.solutionai.example', MAILBOX_1_NAME: 'Meera Saxena', MAILBOX_1_TITLE: 'Founder support',
    MAILBOX_2_ADDRESS: 'arjun@outreach.solutionai.example', MAILBOX_2_NAME: 'Arjun Mehrotra',
    ...over,
  };
}

/** A mail transport that keeps what it is given and sends nothing. */
export function fakeTransport() {
  return { kind: 'outbox', sent: [], async send(x) { this.sent.push(x); return { transport: 'eval-fake', response: 'kept by the eval, not sent' }; } };
}

/** DNS for invented domains: every domain receives mail, except those listed. */
export function fakeDns({ noMx = [], aOnly = [] } = {}) {
  const none = new Set(noMx);
  const aRecordOnly = new Set(aOnly);
  const fail = (code) => Object.assign(new Error(code), { code });
  return {
    resolveMx: async (d) => {
      if (none.has(d)) throw fail('ENOTFOUND');
      if (aRecordOnly.has(d)) throw fail('ENODATA');
      return [{ exchange: `mx.${d}`, priority: 10 }];
    },
    resolve4: async (d) => {
      if (aRecordOnly.has(d)) return ['192.0.2.10'];
      throw fail(none.has(d) ? 'ENOTFOUND' : 'ENODATA');
    },
    resolve6: async (d) => { throw fail(none.has(d) ? 'ENOTFOUND' : 'ENODATA'); },
  };
}

/**
 * A fetch that records every request and answers from `routes` ([{ match: RegExp, reply(url, init) }]).
 * Anything unrouted is refused, so a forgotten outside call shows up instead of leaving the machine.
 */
export function capturingFetch(routes = []) {
  const calls = [];
  const fn = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ?? null });
    const r = routes.find((x) => x.match.test(url));
    if (!r) throw new Error(`unrouted outside call refused by the eval: ${new URL(url).origin}`);
    const out = await r.reply(url, init);
    return { ok: (out.status ?? 200) < 400, status: out.status ?? 200, json: async () => out.json, text: async () => JSON.stringify(out.json) };
  };
  return { calls, fetch: fn };
}

export async function buildDeps(h, { env = {}, recipientCfg = null, clock, fetch, transport, dns }) {
  const { loadConfig } = await engine('src/config.js');
  const { buildOutreach } = await engine('src/outreach/index.js');
  const cfg = loadConfig(evalEnv(h, env));
  if (recipientCfg) Object.assign(cfg.outreach.recipient, recipientCfg);
  return { cfg, o: buildOutreach(cfg, h.db, { clock, log: quiet, fetch, transport, dns }) };
}

export const REVIEWER = { email: 'reviewer@solutionai.example', role: 'reviewer' };

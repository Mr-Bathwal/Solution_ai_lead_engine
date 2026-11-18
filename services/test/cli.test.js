import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { MongoClient } from 'mongodb';
import { TEST_SECRET, startMongo } from './helpers/mongod.js';
import { ConsentLedger } from '../src/consent/ledger.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
let mongo;
let client;
let dir;
const dbName = `t_cli_${Date.now().toString(36)}`;

before(async () => {
  mongo = await startMongo();
  client = await new MongoClient(mongo.uri).connect();
  dir = mkdtempSync(path.join(os.tmpdir(), 'lead-engine-cli-'));
});
after(async () => {
  await client.close();
  await mongo.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** Runs the CLI against the test database only; every setting it reads is given explicitly. */
function cli(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, MONGODB_URI: mongo.uri, LEAD_DB: dbName, CONTACT_KEY_SECRET: TEST_SECRET, LEDGER_ANCHOR_FILE: '', ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('cli', () => {
  test('usage mistakes exit with code 2 and a plain message, before touching the database', () => {
    const offline = { MONGODB_URI: 'mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=500' };
    const t0 = Date.now();
    for (const [args, message, env] of [
      [['wroker'], /unknown command: wroker/, offline],
      [['check', 'emial', 'founder@acme.in'], /usage: lead-engine check/, offline],
      [['admin:user', 'a@b.in;x', 'admin'], /usage: lead-engine admin:user/, offline],
      [['status'], /CONTACT_KEY_SECRET must be set/, { ...offline, CONTACT_KEY_SECRET: '' }],
      [['ledger:anchor'], /LEDGER_ANCHOR_FILE must name/, offline],
    ]) {
      const r = cli(args, env);
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.err}`);
      assert.match(r.err, message);
      assert.doesNotMatch(r.err, /\n\s+at /, 'no stack trace');
    }
    assert.ok(Date.now() - t0 < 30_000);
  });

  test('suppress and check read addresses as they arrive, and fail closed on what they cannot read', () => {
    assert.equal(cli(['migrate']).code, 0);
    const s = cli(['suppress', '--reason', 'unsubscribe', 'email', 'founder@acme.in']);
    assert.equal(s.code, 0, s.err);
    assert.match(s.out, /suppressed email/);
    assert.match(cli(['check', 'email', '"Founder" <founder@acme.in>']).out, /BLOCKED \(email:unsubscribe\)/);
    assert.match(cli(['check', 'email', 'founder @acme.in']).out, /BLOCKED \(email:unreadable\)/);
    assert.match(cli(['check', 'email', 'someone@acme.in']).out, /^allowed/);
    const bad = cli(['suppress', 'email', 'not-an-email']);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /not a valid email/);
    assert.match(cli(['suppress', 'email', 'founder@acme.in', '--reason', 'erasure_request']).out, /stored address and note are now erased/);
  });

  test('ledger:anchor appends the head only when the ledger verifies; ledger:verify checks every anchor', async () => {
    const file = path.join(dir, 'anchors.jsonl');
    const env = { LEDGER_ANCHOR_FILE: file };
    const db = client.db(dbName);
    await new ConsentLedger(db, { secret: TEST_SECRET }).grant({
      subject: { type: 'company', id: 'C1' }, channel: 'email', purpose: 'scheme_alerts', address: 'a@acme.in',
      wording: 'Send me scheme alerts', wordingVersion: 'v1', capturedVia: 'admin_entry',
    });
    const a = cli(['ledger:anchor'], env);
    assert.equal(a.code, 0, a.err);
    assert.match(a.out, /anchored: \{"seq":1,/);
    assert.equal(cli(['ledger:verify'], env).code, 0);

    await db.collection('consents').deleteOne({ seq: 1 }); // cut short: invisible without the anchor
    assert.equal(cli(['ledger:verify']).code, 0);
    const v = cli(['ledger:verify'], env);
    assert.equal(v.code, 2);
    assert.match(v.out, /cut short/);
    assert.equal(cli(['ledger:anchor'], env).code, 2);
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1, 'nothing appended for a ledger that does not verify');
    assert.ok(existsSync(file));
  });
});

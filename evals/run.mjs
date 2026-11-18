#!/usr/bin/env node
/**
 * Runs every eval, prints the scorecard, and writes evals/REPORT.md and evals/report.json.
 *
 *   node evals/run.mjs            from the repository root (any working directory works)
 *
 * Offline: a guard refuses every connection that is not to this machine, and every outside service
 * is a fake. One throwaway mongod (services/test/helpers/mongod.js) serves the gate and privacy evals
 * and is stopped before the Python eval starts, so at most one runs at a time.
 *
 * Exit code 0 whatever the scores; 1 only when the harness itself broke (an eval could not run), so a
 * bad score never looks like a broken build and a broken harness never looks like a good score.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EVALS, INGEST, ROOT, blocked, engine, installNetworkGuard } from './lib/common.mjs';

installNetworkGuard();
const started = Date.now();
const results = {};
const harnessErrors = [];

async function step(name, fn) {
  const t = Date.now();
  process.stdout.write(`${name} ... `);
  try {
    results[name] = await fn();
    results[name].seconds = Math.round((Date.now() - t) / 100) / 10;
    console.log(`${results[name].seconds} s`);
  } catch (err) {
    harnessErrors.push({ name, error: String(err?.stack ?? err) });
    results[name] = { error: String(err?.message ?? err) };
    console.log(`FAILED: ${err?.message ?? err}`);
  }
}

const { runDraftEval } = await import('./lib/drafts.mjs');
const { runQcSensitivity } = await import('./lib/qc_sensitivity.mjs');
const { runGateEval } = await import('./lib/gate.mjs');
const { runPrivacyEval } = await import('./lib/privacy.mjs');
const { runDocsEval } = await import('./lib/docs.mjs');
const { openDb } = await import('./lib/harness.mjs');
const { buildFindings, markdown, scorecard } = await import('./lib/report.mjs');

// an explicit environment: with none, loadConfig() would read the real .env and its live keys
const { loadConfig } = await engine('src/config.js');
const cfg = loadConfig({ CONTACT_KEY_SECRET: 'evals-only-contact-key-secret-0123456789' });

let clean = [];
await step('drafts', async () => {
  const r = await runDraftEval(cfg);
  clean = r.clean;
  return { summary: r.summary, failing: r.failing };
});
await step('qc', () => runQcSensitivity(cfg, clean));

let h = null;
try {
  await step('database', async () => {
    h = await openDb();
    return { ok: true };
  });
  if (h) {
    await step('gate', () => runGateEval(h));
    await step('privacy', () => runPrivacyEval(h));
  }
} finally {
  await h?.close().catch((err) => harnessErrors.push({ name: 'database stop', error: String(err) }));
}
await step('docs', () => runDocsEval());

// the Python eval, after mongod has stopped (only one at a time on this laptop)
await step('matching', async () => {
  const exe = path.join(INGEST, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!existsSync(exe)) return { skipped: `skipped: no ingest virtual environment at ${path.relative(ROOT, exe)} (see README "Running it")` };
  const out = path.join(EVALS, '.matching.json');
  rmSync(out, { force: true });
  const r = spawnSync(exe, [path.join(EVALS, 'ingest_matching.py'), '--json', out], { cwd: ROOT, encoding: 'utf8', timeout: 150_000 });
  if (r.status !== 0 || !existsSync(out)) throw new Error(`ingest_matching.py failed (exit ${r.status}): ${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ')}`);
  const j = JSON.parse(readFileSync(out, 'utf8'));
  rmSync(out, { force: true });
  return j;
});

const findings = buildFindings(results);
const seconds = Math.round((Date.now() - started) / 100) / 10;
const at = new Date();
const meta = { at: at.toISOString(), ist: new Date(at.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 16).replace('T', ' '), seconds, harnessErrors, blocked };
writeFileSync(path.join(EVALS, 'REPORT.md'), markdown(results, findings, meta));
writeFileSync(path.join(EVALS, 'report.json'), JSON.stringify({ meta, scorecard: scorecard(results), findings, results }, null, 1));

console.log('\nScorecard');
for (const [k, v] of scorecard(results)) console.log(`  ${k}\n    ${v}`);
console.log(`\nFindings (${findings.length}, most severe first)`);
findings.forEach((f, i) => console.log(`  ${i + 1}. [${['', 'High', 'Medium-high', 'Medium', 'Low'][f.severity]}] ${f.title} (${f.where[0]})`));
console.log(`\n${seconds} s. Wrote evals/REPORT.md and evals/report.json.${blocked.length ? ` The network guard refused ${blocked.length} attempt(s).` : ''}`);
if (harnessErrors.length) {
  console.error(`\nThe harness broke on: ${harnessErrors.map((e) => e.name).join(', ')}`);
  for (const e of harnessErrors) console.error(e.error);
}
process.exit(harnessErrors.length ? 1 : 0);

/**
 * Shared plumbing for the Node evals: where things are, how engine modules are loaded, the network
 * guard, and a few small helpers.
 *
 * The evals import the engine's own modules from services/src only to PRODUCE what is graded
 * (drafts, gate decisions, outgoing requests). Every grader in evals/lib is written separately from
 * the engine's quality check, so the engine is never marking its own homework.
 */
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const EVALS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = path.resolve(EVALS, '..');
export const SERVICES = path.join(ROOT, 'services');
export const INGEST = path.join(ROOT, 'ingest');
export const FIXTURES = path.join(EVALS, 'fixtures');

/** `mongodb` lives in services/node_modules; a require rooted at services/package.json finds it from evals/. */
export const requireFromServices = createRequire(path.join(SERVICES, 'package.json'));

/** Imports an engine module by its path under services/ ("src/outreach/gate.js"). */
export const engine = (rel) => import(pathToFileURL(path.join(SERVICES, rel)).href);

export const fixture = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
export const readText = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * The line number of the first line of a file that contains `needle` (a string or RegExp), as
 * "path:line". Findings cite lines this way, looked up at run time, so the citation stays right while
 * other people edit the file. Falls back to the bare path when the text is no longer there.
 */
export function cite(rel, needle) {
  const file = path.join(ROOT, rel);
  if (!existsSync(file)) return rel;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const i = lines.findIndex((l) => (needle instanceof RegExp ? needle.test(l) : l.includes(needle)));
  return i >= 0 ? `${rel}:${i + 1}` : rel;
}

// ---- the network guard -----------------------------------------------------------------------------
//
// The evals must never reach the internet: no LLM, no verification service, no DNS, no SMTP. Every
// outside call is meant to go through a fake the eval injects; this guard is the backstop for a path
// that forgets one. It refuses fetch() to anything but this machine, TCP connections to anything but
// loopback, and DNS lookups, and records each refusal so the report can say so.

export const blocked = [];
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function installNetworkGuard() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    if (LOOPBACK.has(url.hostname)) return realFetch(input, init);
    blocked.push({ kind: 'fetch', target: url.origin });
    throw new Error(`network blocked by the eval guard: ${url.origin}`);
  };
  const net = requireFromServices('node:net');
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const a = args[0];
    const opts = Array.isArray(a) ? a[0] : a;
    let host = 'localhost';
    if (opts && typeof opts === 'object') host = opts.path ? 'localhost' : (opts.host ?? 'localhost');
    else if (typeof args[1] === 'string') host = args[1];
    if (!LOOPBACK.has(String(host))) {
      blocked.push({ kind: 'tcp', target: String(host) });
      throw new Error(`network blocked by the eval guard: ${host}`);
    }
    return realConnect.apply(this, args);
  };
  const dns = requireFromServices('node:dns');
  const refuse = (name) => async (host) => {
    blocked.push({ kind: 'dns', target: `${name} ${host}` });
    const err = new Error(`DNS blocked by the eval guard: ${host}`);
    err.code = 'EREFUSED';
    throw err;
  };
  for (const fn of ['resolveMx', 'resolve', 'resolve4', 'resolve6', 'resolveTxt', 'resolveCname']) dns.promises[fn] = refuse(fn);
  syncBuiltinESMExports();
}

// ---- small helpers -----------------------------------------------------------------------------------

export const pct = (num, den) => (den ? `${((100 * num) / den).toFixed(1)}%` : 'n/a');
export const rate = (num, den) => ({ num, den, rate: den ? num / den : null, text: `${num}/${den} (${pct(num, den)})` });

/** A logger that says nothing: the engine logs warnings the evals provoke on purpose. */
export const quiet = { info() {}, warn() {}, error() {}, log() {} };

/** Digits only, for finding a phone number however it was spaced. */
export const digits = (s) => String(s ?? '').replace(/\D+/g, '');

/** Every string a value carries, as one text (for searching a captured request for canaries). */
export function flatText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v !== 'object') return String(v);
  return Object.values(v).map(flatText).join('\n');
}

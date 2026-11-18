/**
 * Eval 6: do the docs agree with the code?
 *
 * Static checks a reviewer would otherwise do by hand:
 *   1. every CLI command named in README.md, docs/HANDOVER.md and ops/ exists (services/src/cli.js's
 *      COMMANDS, or the ingest CLI's argparse tree in ingest/src/leadengine/cli.py);
 *   2. every path in docs/platform-openapi.yaml tagged `engine` is served by the Admin or public
 *      server, and every `platform` path has a client in the engine (its URL variable is read);
 *   3. every variable in .env.example is read somewhere, and every variable the code reads is in
 *      .env.example;
 *   4. every config file referenced in the docs or the code exists and parses;
 *   5. the test counts quoted in README.md and docs/HANDOVER.md are close to the real counts.
 * Nothing here runs the engine; it reads files (and asks pytest to collect, not run, its tests).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { INGEST, ROOT, readText } from './common.mjs';

const rel = (p) => path.relative(ROOT, p).replaceAll('\\', '/');
function walk(dir, keep) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.venv', '__pycache__', '.git'].includes(name)) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, keep));
    else if (keep(p)) out.push(p);
  }
  return out;
}
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

// ---- 1. CLI commands -----------------------------------------------------------------------------------

function nodeCommands() {
  const src = readText('services/src/cli.js');
  const m = /const COMMANDS = new Set\(\[([\s\S]*?)\]\)/.exec(src);
  return new Set([...(m?.[1].matchAll(/'([^']+)'/g) ?? [])].map((x) => x[1]).concat(['help']));
}

/** The ingest CLI's commands as "top" or "top sub", from its argparse calls. */
function pythonCommands() {
  const src = readText('ingest/src/leadengine/cli.py');
  const parserPath = new Map([['ap', []]]);
  const owner = new Map();
  for (const line of src.split('\n')) {
    let m = /(\w+)\s*=\s*(\w+)\.add_subparsers\(/.exec(line);
    if (m) owner.set(m[1], m[2]);
    m = /(?:(\w+)\s*=\s*)?(\w+)\.add_parser\(\s*["']([^"']+)["']/.exec(line);
    if (m && owner.has(m[2])) {
      const parent = parserPath.get(owner.get(m[2])) ?? [];
      const p = [...parent, m[3]];
      if (m[1]) parserPath.set(m[1], p);
      else parserPath.set(`_${p.join('_')}`, p);
    }
  }
  const tree = new Map();
  for (const p of parserPath.values()) {
    if (!p.length) continue;
    if (!tree.has(p[0])) tree.set(p[0], new Set());
    if (p[1]) tree.get(p[0]).add(p[1]);
  }
  return tree;
}

function checkCommands() {
  const node = nodeCommands();
  const py = pythonCommands();
  const colonPrefixes = new Set([...node].filter((c) => c.includes(':')).map((c) => c.split(':')[0]));
  const files = [path.join(ROOT, 'README.md'), path.join(ROOT, 'docs', 'HANDOVER.md'),
    ...walk(path.join(ROOT, 'ops'), (p) => /\.md$|\.cron$/.test(p))];
  const seen = new Map();
  const bad = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    const note = (cmd, lang, ok, i, why = null) => {
      const key = `${lang}:${cmd}`;
      if (!seen.has(key)) seen.set(key, { cmd, lang, ok, where: [] });
      const s = seen.get(key);
      s.where.push(`${rel(f)}:${lineOf(text, i)}`);
      if (!ok && !bad.some((b) => b.key === key)) bad.push({ key, cmd, lang, where: `${rel(f)}:${lineOf(text, i)}`, why });
    };
    for (const m of text.matchAll(/(?:node\s+(?:services\/)?src\/cli\.js|\blead-engine)\s+([a-z][a-z0-9:-]*)/g)) note(m[1], 'node', node.has(m[1]), m.index, 'not in services/src/cli.js COMMANDS');
    for (const m of text.matchAll(/`([a-z]+):([a-z][a-z-]*)(?=[`\s])/g)) {
      if (!colonPrefixes.has(m[1])) continue;
      const cmd = `${m[1]}:${m[2]}`;
      note(cmd, 'node', node.has(cmd), m.index, 'not in services/src/cli.js COMMANDS');
    }
    for (const m of text.matchAll(/(?:\bpython\s+-m\s+|(?<![\w/.-]))leadengine\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/g)) {
      const [top, sub] = [m[1], m[2]];
      // "leadengine" is also the server's Unix user (cron's user column, sudo -u leadengine bash): not the CLI
      if (['cd', 'bash', 'sh', 'sudo', 'env'].includes(top)) continue;
      if (!py.has(top)) {
        note(top, 'python', false, m.index, 'not a command of the ingest CLI');
        continue;
      }
      const subs = py.get(top);
      if (subs.size && sub && !subs.has(sub)) note(`${top} ${sub}`, 'python', false, m.index, `"${top}" has no "${sub}" (it has ${[...subs].join(', ')})`);
      else note(subs.size && sub ? `${top} ${sub}` : top, 'python', true, m.index);
    }
  }
  return { checked: seen.size, missing: bad.map(({ key, ...b }) => b), node_commands: node.size, python_commands: [...py.keys()].length };
}

// ---- 2. the OpenAPI file against the servers ----------------------------------------------------------

function checkOpenApi() {
  const yaml = readText('docs/platform-openapi.yaml');
  const lines = yaml.split('\n');
  const paths = [];
  let current = null;
  let inPaths = false;
  lines.forEach((l, i) => {
    if (/^paths:/.test(l)) inPaths = true;
    else if (/^\S/.test(l)) inPaths = false;
    const m = inPaths && /^ {2}(\/\S*):\s*$/.exec(l);
    if (m) {
      current = { path: m[1], line: i + 1, tags: new Set(), servers: [] };
      paths.push(current);
    } else if (current && inPaths) {
      const t = /tags:\s*\[([^\]]+)\]/.exec(l);
      if (t) t[1].split(',').forEach((x) => current.tags.add(x.trim()));
      const s = /url:\s*"\{([A-Z_]+)\}"/.exec(l);
      if (s) current.servers.push(s[1]);
    }
  });
  const servers = ['services/src/admin/server.js', 'services/src/public/server.js'].map((f) => ({ f, src: existsSync(path.join(ROOT, f)) ? readText(f) : '' }));
  const regexes = servers.flatMap(({ src }) => [...src.matchAll(/\/\^\\\/(.*?)\$\//g)].map((m) => {
    try {
      return new RegExp(`^\\/${m[1]}$`);
    } catch {
      return null;
    }
  }).filter(Boolean));
  const sample = (p) => p.replace(/\{id\}/g, 'exp_0123456789ab').replace(/\{[^}]+\}/g, 'x1');
  const code = codeFiles().map((f) => readFileSync(f, 'utf8')).join('\n');
  const problems = [];
  for (const p of paths) {
    if (p.tags.has('engine')) {
      const served = servers.some(({ src }) => src.includes(`'${p.path}'`) || src.includes(`"${p.path}"`)) || regexes.some((rx) => rx.test(sample(p.path)));
      if (!served) problems.push({ path: p.path, where: `docs/platform-openapi.yaml:${p.line}`, why: 'tagged engine, but neither the Admin nor the public server serves it' });
    } else if (p.tags.has('platform')) {
      const unread = p.servers.filter((v) => !new RegExp(`\\b${v}\\b`).test(code));
      if (!p.servers.length) problems.push({ path: p.path, where: `docs/platform-openapi.yaml:${p.line}`, why: 'a platform path with no server URL variable' });
      for (const v of unread) problems.push({ path: p.path, where: `docs/platform-openapi.yaml:${p.line}`, why: `its URL comes from ${v}, which no code reads` });
    } else problems.push({ path: p.path, where: `docs/platform-openapi.yaml:${p.line}`, why: 'no engine or platform tag' });
  }
  // the other way: JSON routes the Admin server answers that the contract does not mention (informational)
  const documented = new Set(paths.map((p) => p.path));
  const admin = servers[0].src;
  const undocumented = [...new Set([...admin.matchAll(/'(\/api\/[a-z/-]+)'/g)].map((m) => m[1]))].filter((x) => !documented.has(x) && x !== '/api/');
  return { paths: paths.length, engine_paths: paths.filter((p) => p.tags.has('engine')).length, problems, undocumented_api_routes: undocumented };
}

// ---- 3. environment variables -------------------------------------------------------------------------

function codeFiles() {
  return [...walk(path.join(ROOT, 'services', 'src'), (p) => p.endsWith('.js')), ...walk(path.join(INGEST, 'src'), (p) => p.endsWith('.py')),
    ...walk(path.join(ROOT, 'ops'), (p) => p.endsWith('.py'))];
}

function checkEnv() {
  const example = readText('.env.example');
  const documented = new Map();
  example.split('\n').forEach((l, i) => {
    const m = /^\s*#?\s*([A-Z][A-Z0-9_]{2,})=/.exec(l);
    if (m && !documented.has(m[1])) documented.set(m[1], i + 1);
  });
  const reads = new Map();
  const patterns = [];
  for (const f of codeFiles()) {
    const src = readFileSync(f, 'utf8');
    const add = (name, i) => {
      if (!reads.has(name)) reads.set(name, `${rel(f)}:${lineOf(src, i)}`);
    };
    if (f.endsWith('.js')) {
      for (const m of src.matchAll(/\b(?:process\.env|env)\.([A-Z][A-Z0-9_]+)\b/g)) add(m[1], m.index);
      for (const m of src.matchAll(/\b(?:process\.env|env)\[['"]([A-Z][A-Z0-9_]+)['"]\]/g)) add(m[1], m.index);
      for (const m of src.matchAll(/\benv\[`\$\{\w+\}_([A-Z0-9_]+)`\]/g)) patterns.push({ suffix: m[1], where: `${rel(f)}:${lineOf(src, m.index)}` });
    } else {
      for (const m of src.matchAll(/\b(?:os\.environ|environ|env|os)\s*(?:\.get|\.getenv|\.setdefault|\.pop)?\s*[[(]\s*["']([A-Z][A-Z0-9_]+)["']/g)) add(m[1], m.index);
    }
  }
  // a template read (MAILBOX_<n>_ADDRESS) is documented when .env.example has at least one of its kind
  const templated = (name) => patterns.some((p) => name.endsWith(`_${p.suffix}`) && /^[A-Z]+_\d+_/.test(name));
  const opsText = walk(path.join(ROOT, 'ops'), (p) => /\.(sh|service|cron|conf|json|md)$/.test(p)).map((f) => readFileSync(f, 'utf8')).join('\n');
  const notDocumented = [...reads].filter(([n]) => !documented.has(n)).map(([n, where]) => ({ name: n, where }));
  const templatesUndocumented = [...new Map(patterns.map((p) => [p.suffix, p])).values()]
    .filter((p) => ![...documented.keys()].some((n) => n.endsWith(`_${p.suffix}`) && /^[A-Z]+_\d+_/.test(n))).map((p) => ({ name: `<MAILBOX_n>_${p.suffix}`, where: p.where }));
  const notRead = [...documented].filter(([n]) => !reads.has(n) && !templated(n)).map(([n, line]) => ({
    name: n, where: `.env.example:${line}`, read_by_ops_only: new RegExp(`\\b${n}\\b`).test(opsText) }));
  return { documented: documented.size, read_in_code: reads.size, not_in_env_example: [...notDocumented, ...templatesUndocumented], never_read: notRead };
}

// ---- 4. config files ----------------------------------------------------------------------------------

function checkConfigs() {
  const sources = [path.join(ROOT, 'README.md'), ...walk(path.join(ROOT, 'docs'), (p) => p.endsWith('.md')), ...walk(path.join(ROOT, 'ops'), (p) => p.endsWith('.md')), ...codeFiles()];
  const refs = new Map();
  for (const f of sources) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/\b((?:config|schema)\/[A-Za-z0-9_/.*-]*\.json)\b/g)) if (!refs.has(m[1])) refs.set(m[1], `${rel(f)}:${lineOf(text, m.index)}`);
  }
  const problems = [];
  const parsed = new Set();
  const tryParse = (file, where) => {
    if (parsed.has(file)) return;
    parsed.add(file);
    try {
      JSON.parse(readFileSync(path.join(ROOT, file), 'utf8'));
    } catch (err) {
      problems.push({ file, where, why: `does not parse: ${err.message.slice(0, 120)}` });
    }
  };
  for (const [ref, where] of refs) {
    if (ref.includes('*')) {
      const dir = path.join(ROOT, path.dirname(ref));
      const rx = new RegExp(`^${path.basename(ref).replace(/\./g, '\\.').replace(/\*/g, '.*')}$`);
      const hits = existsSync(dir) ? readdirSync(dir).filter((n) => rx.test(n)) : [];
      if (!hits.length) problems.push({ file: ref, where, why: 'no file matches' });
      for (const n of hits) tryParse(rel(path.join(dir, n)), where);
    } else if (!existsSync(path.join(ROOT, ref))) problems.push({ file: ref, where, why: 'does not exist' });
    else tryParse(ref, where);
  }
  for (const f of walk(path.join(ROOT, 'config'), (p) => p.endsWith('.json'))) tryParse(rel(f), 'config/');
  return { referenced: refs.size, parsed: parsed.size, problems };
}

// ---- 5. test counts -----------------------------------------------------------------------------------

function countTests() {
  const nodeFiles = walk(path.join(ROOT, 'services', 'test'), (p) => p.endsWith('.test.js'));
  const node = nodeFiles.reduce((n, f) => n + (readFileSync(f, 'utf8').match(/^\s*(?:test|it)(?:\.skip|\.only|\.todo)?\(/gm) ?? []).length, 0);
  let python = null;
  let pyHow = 'pytest --collect-only (collects, runs nothing)';
  const exe = path.join(INGEST, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (existsSync(exe)) {
    const r = spawnSync(exe, ['-m', 'pytest', '--collect-only', '-q', '-p', 'no:cacheprovider'], { cwd: INGEST, encoding: 'utf8', timeout: 120_000 });
    // pytest -q prints "tests/test_x.py: 12" per file (newer versions), or one "file::test" line per test
    const out = `${r.stdout ?? ''}`;
    const perFile = [...out.matchAll(/^tests[\\/]\S+\.py: (\d+)\s*$/gm)].reduce((n, m) => n + Number(m[1]), 0);
    const ids = out.split('\n').filter((l) => l.includes('::')).length;
    const total = /(\d+) tests? collected/.exec(out);
    python = total ? Number(total[1]) : perFile || ids || null;
    if (/\berrors?\b/i.test(out.split('\n').slice(-3).join(' '))) pyHow += '; collection reported errors';
  }
  if (python == null) {
    pyHow = 'static count of "def test_" (parametrised cases not expanded)';
    python = walk(path.join(INGEST, 'tests'), (p) => p.endsWith('.py')).reduce((n, f) => n + (readFileSync(f, 'utf8').match(/^def test_/gm) ?? []).length, 0);
  }
  const quoted = [];
  const readme = readText('README.md');
  const handover = readText('docs/HANDOVER.md');
  let m = /(\d+) tests pass \((\d+) Node, (\d+) Python\)/.exec(readme);
  if (m) quoted.push({ where: `README.md:${lineOf(readme, m.index)}`, node: +m[2], python: +m[3], total: +m[1] });
  else if ((m = /(\d+) tests pass/.exec(readme))) quoted.push({ where: `README.md:${lineOf(readme, m.index)}`, total: +m[1] });
  if ((m = /`services`[^\n]*?(\d+) tests/.exec(handover))) quoted.push({ where: `docs/HANDOVER.md:${lineOf(handover, m.index)}`, node: +m[1] });
  if ((m = /`ingest`[^\n]*?(\d+) tests/.exec(handover))) quoted.push({ where: `docs/HANDOVER.md:${lineOf(handover, m.index)}`, python: +m[1] });
  const real = { node, python, total: node + python, node_how: 'static count of test( and it( calls in services/test/*.test.js', python_how: pyHow };
  // "close": within 2% or 5 tests, whichever is larger
  const close = (q, r) => Math.abs(q - r) <= Math.max(5, Math.round(r * 0.02));
  const mismatches = [];
  for (const q of quoted) {
    for (const k of ['node', 'python', 'total']) {
      if (q[k] != null && !close(q[k], real[k])) mismatches.push({ where: q.where, what: k, quoted: q[k], real: real[k] });
    }
  }
  return { real, quoted, mismatches };
}

export function runDocsEval() {
  const commands = checkCommands();
  const openapi = checkOpenApi();
  const env = checkEnv();
  const configs = checkConfigs();
  const tests = countTests();
  const items = commands.checked + openapi.paths + env.documented + env.read_in_code + configs.parsed + tests.quoted.length;
  const problems = commands.missing.length + openapi.problems.length + env.not_in_env_example.length + env.never_read.filter((x) => !x.read_by_ops_only).length
    + configs.problems.length + tests.mismatches.length;
  return { items, problems, commands, openapi, env, configs, tests };
}

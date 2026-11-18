/**
 * A read-only snapshot of the fictional demo as a static website (for a hosted walkthrough, e.g. on
 * Vercel). The engine needs MongoDB and runs on the company's own server; its pages, though, use no
 * JavaScript, so a copy of each page shows the product faithfully. Buttons and forms do nothing in
 * the copy: every form goes to a page that says so.
 *
 *   1. cd services && node src/cli.js demo:seed && node src/cli.js demo:serve      (keep it running)
 *   2. node ops/demo-site/build.mjs --admin http://127.0.0.1:8787 --pages http://127.0.0.1:8788 \
 *        --token <the admin token demo:serve printed> --page /c/<the company page link it printed>
 *   3. cd ops/demo-site/out && vercel deploy --prod
 *
 * Only the demo database is read (fictional companies on .example domains); the script refuses an
 * Admin server whose pages do not carry the demo banner.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
for (const k of ['admin', 'pages', 'token', 'page']) if (!args[k]) throw new Error(`--${k} is required (see the comment at the top)`);
const OUT = args.out ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
const MAX_PAGES = Number(args.max ?? 400);
const REPO = 'https://github.com/Mr-Bathwal/Solution_ai_lead_engine';

// ---- signing in to the Admin pages, as a browser does ------------------------------------------------
const login = await fetch(`${args.admin}/admin/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ token: args.token }),
  headers: { 'content-type': 'application/x-www-form-urlencoded' } });
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
if (login.status !== 303 || !cookie) throw new Error(`could not sign in to ${args.admin} (status ${login.status})`);

const isAdmin = (u) => u.startsWith('/admin');
const skip = (u) => /^\/admin\/(logout|login|static)|\/download|^\/api\/|^\/mcp|^\/u\/|^\/k\//.test(u);

/** The file a page is saved as, and the link to it: the query becomes part of the folder name. */
function target(u) {
  const [p, q] = u.split('?');
  const dir = (p.replace(/^\/+|\/+$/g, '') || 'home') + (q ? `/q-${decodeURIComponent(q).replace(/[^A-Za-z0-9=_.-]+/g, '_').slice(0, 80)}` : '');
  return { file: path.join(OUT, dir, 'index.html'), href: `/${dir}/` };
}

const unescape = (s) => s.replaceAll('&amp;', '&');
const pages = new Map();          // url -> html
const queue = ['/admin', args.page, `${args.page}/claim`, `${args.page}?lang=hi&preview=1`, `${args.page}/claim?lang=hi&preview=1`,
  ...(args.campaign ? [`/j/${args.campaign}`, `/j/${args.campaign}?q=${encodeURIComponent(args.search ?? 'Sarnath Learning')}`] : [])];
while (queue.length && pages.size < MAX_PAGES) {
  const u = queue.shift();
  if (pages.has(u) || skip(u)) continue;
  const base = isAdmin(u) ? args.admin : args.pages;
  const res = await fetch(base + u, { headers: isAdmin(u) ? { cookie } : {}, redirect: 'manual' });
  if (res.status !== 200 || !/text\/html/.test(res.headers.get('content-type') ?? '')) continue;
  const body = await res.text();
  if (u === '/admin' && !/demonstration|fictional/i.test(body)) throw new Error('this Admin server does not show the demo banner: the snapshot is only ever of the demo');
  pages.set(u, body);
  for (const m of body.matchAll(/href="(\/[^"#]*)"/g)) {
    const link = unescape(m[1]);
    if ((isAdmin(link) || /^\/(c|j)\//.test(link)) && !pages.has(link) && !skip(link)) queue.push(link);
  }
}

// ---- writing the pages -------------------------------------------------------------------------------
rmSync(OUT, { recursive: true, force: true });
const banner = `<div style="background:#1f2937;color:#f9fafb;font:14px/1.5 system-ui,sans-serif;padding:10px 16px;text-align:center">`
  + `A read-only snapshot of the <strong>fictional demo</strong>: invented companies and people, nothing real. Buttons and forms do nothing here. `
  + `<a href="/" style="color:#c7d2fe">About this demo</a> · <a href="${REPO}" style="color:#c7d2fe" rel="noreferrer">Source</a></div>`;
function rewrite(html) {
  return html
    .replace(/<head>/, '<head><meta name="robots" content="noindex, nofollow">')
    .replace(/(<body[^>]*>)/, `$1${banner}`)
    .replace(/href="(\/[^"#]*)"/g, (all, raw) => {
      const link = unescape(raw);
      if (link === '/' || /^\/(admin\/)?static\/|^\/favicon\.ico/.test(link)) return all;
      return `href="${pages.has(link) ? target(link).href : '/snapshot/not-included/'}"`;
    })
    .replace(/<form([^>]*?)\saction="[^"]*"/g, '<form$1 action="/snapshot/read-only/"')
    .replace(/(<form[^>]*?)\smethod="post"/gi, '$1 method="get"');
}
for (const [u, html] of pages) {
  const { file } = target(u);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, rewrite(html));
}

// the stylesheets and icon the pages use
for (const [from, base, to] of [['/admin/static/style.css', args.admin, 'admin/static/style.css'], ['/admin/static/icon.svg', args.admin, 'admin/static/icon.svg'],
  ['/static/public.css', args.pages, 'static/public.css'], ['/favicon.ico', args.admin, 'favicon.ico']]) {
  const res = await fetch(base + from);
  if (!res.ok) continue;
  mkdirSync(path.dirname(path.join(OUT, to)), { recursive: true });
  writeFileSync(path.join(OUT, to), Buffer.from(await res.arrayBuffer()));
}

// ---- the landing page and the two notice pages -----------------------------------------------------------
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${title}</title><link rel="stylesheet" href="/static/public.css"></head><body>${banner}<main style="max-width:44rem;margin:2rem auto;padding:0 16px">${body}</main></body></html>`;
const link = (u, text) => (pages.has(u) ? `<a href="${target(u).href}">${text}</a>` : '');
const write = (rel, html) => {
  mkdirSync(path.join(OUT, rel), { recursive: true });
  writeFileSync(path.join(OUT, rel, 'index.html'), html);
};
write('', page('SolutionAI lead engine: the demo', `<h1>SolutionAI lead engine: the demo</h1>
<p>The engine finds every new company in Uttar Pradesh as it is registered, works out its first filing deadlines and the schemes it may qualify for, and writes to it with something useful, with consent and the law built in. This is a snapshot of its demonstration database: 36 invented companies, seeded through the engine's own code. Nothing here is real and nothing is sent anywhere.</p>
<h2>What to look at</h2>
<ul>
<li>${link('/admin', 'The Admin pages')}: the pipeline, companies, the review queue, approvals of drafted emails, the inbox, calls, results, data health, exports, labels and the audit log, as an admin sees them.</li>
<li>${link(args.page, "A company's own page")}, the link a founder gets: the company's next filing dates, with the law behind each, and the schemes it may qualify for. ${link(`${args.page}/claim`, 'The claim form')} records each consent with its exact wording.</li>
<li>${link(`${args.page}?lang=hi&preview=1`, 'The same page in Hindi')} (a draft until the lawyer approves it).</li>
${args.campaign ? `<li>${link(`/j/${args.campaign}`, 'A campus campaign page')}, where a founder finds their company by name.</li>` : ''}
</ul>
<p>The engine itself runs on a server with MongoDB; this copy shows its pages only. The code, tests and runbooks: <a href="${REPO}" rel="noreferrer">${REPO.replace('https://', '')}</a>.</p>`));
write('snapshot/read-only', page('Read-only snapshot', '<h1>This is a read-only snapshot</h1><p>In the running engine this button or form does its job (and is logged). In this copy of the demo it does nothing. <a href="/">Back to the start</a></p>'));
write('snapshot/not-included', page('Not in the snapshot', '<h1>This page is not in the snapshot</h1><p>The snapshot holds a few hundred pages of the demo; this one was left out. <a href="/">Back to the start</a></p>'));
writeFileSync(path.join(OUT, 'vercel.json'), `${JSON.stringify({
  trailingSlash: true,
  headers: [{ source: '/(.*)', headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }, { key: 'Referrer-Policy', value: 'no-referrer' },
    { key: 'X-Content-Type-Options', value: 'nosniff' }, { key: 'Content-Security-Policy', value: "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" }] }],
}, null, 1)}\n`);
console.log(`${pages.size} pages written to ${OUT}`);

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { SESSION_HOURS, can } from './auth.js';
import { auditPersonalView, companyView, listCompanies, pipeline, recordReview, reviewQueue } from './queries.js';
import { approvalPage, approvalsPage, callPage, callsPage, companiesPage, companyPage, errorPage, healthPage, inboxItemPage, inboxPage, auditPage, exportsPage, labelsPage, loginPage, mcaPage, pipelinePage,
  resultsPage, reviewPage, shortlistPage, signalsPage } from './views.js';
import { approvalDetail, approvalQueue, decideApproval, recordOutcome, resolveUnknown } from './approvals.js';
import { callDetail, callsList, decideInboundRequest, handleCall, inboxDetail, inboxQueue } from './inbox.js';
import { MAX_UPLOAD, mcaState, parseMultipart, saveMcaFile } from './mca.js';
import { decideExport, downloadExport, exportList, requestExport } from './exports.js';
import { labelQueue } from './labels.js';
import { decideSignal, signalQueue } from './signals.js';
import { samplingState } from '../outreach/sampling.js';
import { auditFilters, auditLog, auditView } from './audit.js';
import { campaignResults, channels, costs, lift, shortlistMonths } from '../attribution/results.js';
import { receiveEvents } from '../attribution/events.js';
import { handleMcp } from '../mcp/server.js';

/**
 * The Admin pages and their JSON API (design 7.9): pipeline, companies, the match review queue and
 * data health (Phase 2), the approval queue for outreach (Phase 3), and the inbox, calls and results
 * (Phase 4), and funding news for a person to confirm (Signals, admin/signals.js). `outreach` ({ queue, cfg, org, suppression }) is what deciding an approval or a reply
 * needs; without it those queues can be read only. Built to move into the platform's Admin portal:
 * the /api routes return the same data as JSON, so the portal can render it in its own design.
 *
 * Two routes are for machines rather than people:
 *   POST /api/events  the platform's sign-ups, service requests and payments, signed with
 *                     PLATFORM_EVENTS_SECRET (attribution/events.js); no sign-in, the signature is the key
 *   POST /mcp         the engine's MCP tools (mcp/server.js) for Mr. AI and the team, with an access
 *                     token as a bearer token
 *
 * Security: sign-in required everywhere except /healthz; roles decide who may review matches and
 * who may reveal personal data; every reveal, every review decision, every sign-in and sign-out and
 * every refused token is written to audit_log; forms carry a CSRF token and must come from the same
 * origin; no JavaScript is served, and the Content-Security-Policy forbids it.
 *
 * Failed tokens (on the sign-in form or as an API bearer token) are counted per client address. After
 * `loginLimit` failures in a minute that address gets 429 for wrong tokens, and its further failures
 * are not logged one by one; a valid token is always accepted. The address is the socket's, or, only
 * when `trustProxy` is set (ADMIN_TRUST_PROXY=1, for the platform's proxy), the last X-Forwarded-For
 * entry, which is the one the proxy itself appends.
 *
 * Inside the platform (auth.js): the platform's proxy may sign who the person is on each request
 * (PLATFORM_SSO_SECRET), or the portal's backend may call the JSON API with a service token naming
 * the person in X-Acting-User. The first request of each person in 12 hours is logged as a sign-in;
 * a bad platform signature is refused, logged and throttled like a wrong token. Pages reached through
 * the proxy keep the CSRF token on their forms; `allowedOrigins` (ADMIN_ALLOWED_ORIGINS) lists the
 * portal's origin when the proxy rewrites the Host header.
 */

const CSP = "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const HSTS = 'max-age=31536000; includeSubDomains';
const MAX_BODY = 64 * 1024;
const MAX_DRAIN = 4 * 1024 * 1024;   // an oversized body is read to its end (so the 413 arrives), up to this much
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c6cf0"/><stop offset="1" stop-color="#e58fb6"/></linearGradient></defs><circle cx="16" cy="16" r="13" fill="url(#g)"/></svg>';
const CIN_OR_LLPIN = /^([UL][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}|[A-Z]{3}-[0-9]{4})$/;
const FAILURE_WINDOW_MS = 60_000;

export function istMonth(at = new Date()) {
  return new Date(at.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 7);
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

/** The body hash a platform-signed request carries, kept per request until its body is read. */
const signedBody = new WeakMap();

function readBytes(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let ended = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
      else if (size > limit + MAX_DRAIN) req.destroy();  // past this no answer is worth waiting for
    });
    req.on('end', () => {
      ended = true;
      if (size > limit) return reject(httpError(413, 'body too large'));
      const body = Buffer.concat(chunks);
      // a request signed by the platform's proxy: the body must be the one it signed
      if (signedBody.has(req) && createHash('sha256').update(body).digest('hex') !== signedBody.get(req)) {
        return reject(httpError(401, 'the body does not match the platform signature'));
      }
      return resolve(body);
    });
    req.on('error', reject);
    req.on('close', () => { if (!ended) reject(httpError(400, 'request aborted')); });
  });
}

const readBody = async (req) => (await readBytes(req)).toString('utf8');
const UPLOAD_OVERHEAD = 64 * 1024;     // the multipart wrapping and the CSRF field around an upload

async function readForm(req) {
  const text = await readBody(req);
  if ((req.headers['content-type'] ?? '').includes('application/json')) {
    let body;
    try {
      body = JSON.parse(text || '{}');
    } catch {
      throw httpError(400, 'invalid JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'expected a JSON object');
    return body;
  }
  return Object.fromEntries(new URLSearchParams(text));
}

/** Failed tokens per client address in the last minute. Addresses with nothing recent are forgotten. */
export function failureCounter({ limit, windowMs = FAILURE_WINDOW_MS }) {
  const seen = new Map();   // address -> times of its failures inside the window (at most `limit` kept)
  let swept = -Infinity;
  const recent = (key, now) => (seen.get(key) ?? []).filter((t) => now - t < windowMs);
  return {
    locked: (key, now) => recent(key, now).length >= limit,
    add(key, now) {
      if (now - swept >= windowMs) {
        for (const [k, times] of seen) if (!times.some((t) => now - t < windowMs)) seen.delete(k);
        swept = now;
      }
      seen.set(key, [...recent(key, now), now].slice(-limit));
    },
    get size() { return seen.size; },
  };
}

export function createAdminServer({ db, auth, log = console, clock = () => new Date(), loginLimit = 10,
  trustProxy = process.env.ADMIN_TRUST_PROXY === '1', outreach = null, caps = null, monitorCfg = null, eventsSecret = '',
  allowedOrigins = [], signoutUrl = '', mcaInbox = null, banner = null }) {
  const css = readFileSync(new URL('./style.css', import.meta.url));
  const failures = failureCounter({ limit: loginLimit });
  const origins = new Set(allowedOrigins.map((o) => { try { return new URL(o).origin; } catch { return null; } }).filter(Boolean));
  const signedIn = new Map();   // "via|service|email|role" -> when it was last logged as a sign-in (platform and service only)

  const send = (res, status, body, type = 'text/html; charset=utf-8', extra = {}) => {
    res.writeHead(status, {
      'Content-Type': type, 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store',
      ...(auth.secureCookies ? { 'Strict-Transport-Security': HSTS } : {}), ...extra,
    });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : String(body));
  };
  const json = (res, status, obj) => send(res, status, JSON.stringify(obj, null, 1), 'application/json; charset=utf-8');
  const redirect = (res, to, extra = {}) => send(res, 303, '', 'text/plain', { Location: to, ...extra });
  const audit = (row) => db.collection('audit_log').insertOne({ at: clock(), target: null, fields: null, detail: null, ...row });

  async function ctxFor(user, notice) {
    const [reviewWaiting, approvalsWaiting, inboxWaiting, callsWaiting] = await Promise.all([
      // the Review page holds the matches to check and the news to confirm
      Promise.all([db.collection('entity_links').countDocuments({ status: 'review' }), db.collection('signals').countDocuments({ status: 'proposed' })]).then(([a, b]) => a + b),
      db.collection('messages').countDocuments({ status: { $in: ['awaiting_approval', 'qc_failed'] } }),
      db.collection('inbound').countDocuments({ status: 'needs_person' }),
      db.collection('calls').countDocuments({ $or: [{ status: { $in: ['blocked', 'failed', 'unknown'] } }, { outcome: { $in: ['interested', 'wants_person', 'call_later'] } }],
        'handled.at': { $exists: false } }),
    ]);
    return { user, csrf: auth.csrf(user), notice, reviewWaiting, approvalsWaiting, inboxWaiting, callsWaiting, banner };
  }

  function clientAddress(req) {
    if (trustProxy) {
      const hops = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (hops.length) return hops[hops.length - 1];
    }
    return req.socket.remoteAddress ?? '';
  }

  /** Counts a wrong token and logs it, unless the address is already over the limit. True means "answer 429". */
  async function refused(address, via, reason) {
    const now = clock().getTime();
    if (failures.locked(address, now)) return true;
    failures.add(address, now);
    await audit({ actor: 'unknown', role: null, action: 'denied', detail: {
      reason: via === 'platform' ? `platform sign-in refused: ${reason}` : via === 'token' ? 'API call with an unknown bearer token' : 'sign-in with an unknown token', via, address,
      ...(failures.locked(address, now) ? { throttled_from_now: true } : {}),
    } });
    return false;
  }

  /** A person who came in through the platform: logged as a sign-in on their first request in 12 hours. */
  async function noteSignIn(user, address) {
    if (user.via !== 'platform' && user.via !== 'service') return;
    const key = `${user.via}|${user.service ?? ''}|${user.email}|${user.role}`;
    const now = clock().getTime();
    if (now - (signedIn.get(key) ?? -Infinity) < SESSION_HOURS * 3_600_000) return;
    if (signedIn.size >= 10_000) signedIn.clear();
    signedIn.set(key, now);
    await audit({ actor: user.email, role: user.role, action: 'sign_in', detail: { via: user.via, ...(user.service ? { service: user.service } : {}), address } });
  }

  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;          // forms from older browsers and server-to-server calls; SameSite=Strict and the CSRF token still apply
    try {
      const o = new URL(origin);
      return o.host === req.headers.host || origins.has(o.origin);
    } catch {
      return false;
    }
  }

  async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://admin.local');
    } catch {
      return send(res, 400, 'bad request', 'text/plain');
    }
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const address = clientAddress(req);

    if (path === '/healthz') return send(res, 200, 'ok', 'text/plain');
    if (path === '/admin/static/style.css') return send(res, 200, css, 'text/css; charset=utf-8', { 'Cache-Control': 'max-age=3600' });
    if (path === '/favicon.ico' || path === '/admin/static/icon.svg') return send(res, 200, ICON, 'image/svg+xml', { 'Cache-Control': 'max-age=86400' });
    if (path === '/' ) return redirect(res, '/admin');

    if (path === '/admin/login') {
      if (req.method === 'GET') return send(res, 200, String(loginPage({})));
      if (req.method !== 'POST') return send(res, 405, 'method not allowed', 'text/plain');
      const form = await readForm(req);
      const user = auth.userForToken(typeof form.token === 'string' ? form.token : '');
      if (user) {                                      // a valid token is never refused, lockout or not
        await audit({ actor: user.email, role: user.role, action: 'sign_in', detail: { via: 'form', address } });
        return redirect(res, '/admin', { 'Set-Cookie': auth.sessionCookie(user) });
      }
      if (await refused(address, 'form')) return send(res, 429, String(loginPage({ error: 'Too many attempts. Wait a minute and try again.' })));
      return send(res, 401, String(loginPage({ error: 'That token is not recognised.' })));
    }

    if (path === '/api/events') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      if (failures.locked(address, clock().getTime())) return json(res, 429, { error: 'too many failed attempts; wait a minute' });
      const r = await receiveEvents(db, { rawBody: await readBody(req), signature: req.headers['x-signature'], secret: eventsSecret, address, clock });
      if (r.status === 401) failures.add(address, clock().getTime());
      return json(res, r.status, r.body);
    }

    const isApi = path.startsWith('/api/') || path === '/mcp';
    const who = auth.identify(req);
    if (who.refused) {
      if (who.count !== false && await refused(address, who.via, who.refused)) return json(res, 429, { error: 'too many failed attempts; wait a minute' });
      return isApi || who.via !== 'platform' ? json(res, who.status ?? 401, { error: who.refused }) : send(res, who.status ?? 401, who.refused, 'text/plain');
    }
    if (who.bodySha256) signedBody.set(req, who.bodySha256);
    let user = who.user ?? null;
    if (user && await auth.isRevoked(db, user)) user = null;
    if (!user) return isApi ? json(res, 401, { error: 'sign-in required' }) : redirect(res, '/admin/login');
    await noteSignIn(user, address);

    if (path === '/mcp') {
      // streamable HTTP without a stream: one JSON-RPC message in, one JSON answer out
      if (req.method !== 'POST') return send(res, 405, 'POST only; this server does not open event streams', 'text/plain', { Allow: 'POST' });
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' });
      if (user.via === 'session') return json(res, 403, { error: 'use an access token as a bearer token' });
      let msg;
      try {
        msg = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      }
      const out = await handleMcp(db, msg);
      if (!out) return send(res, 202, '', 'text/plain');
      return json(res, 200, out);
    }

    if ((path === '/admin/exports' || path === '/api/exports') && req.method === 'GET') {
      const list = await exportList(db, { clock });
      const notice = url.searchParams.get('asked') ? 'Asked. An admin other than you approves it; then download it here within 24 hours.'
        : url.searchParams.get('decided') ? 'Saved.' : null;
      return isApi ? json(res, 200, list) : send(res, 200, String(exportsPage(list, await ctxFor(user, notice))));
    }
    const exDl = /^\/(admin|api)\/exports\/(exp_[0-9a-z]{12})\/download$/.exec(path);
    if (exDl && req.method === 'GET') {
      try {
        const r = await downloadExport(db, { id: exDl[2], user, suppression: outreach?.suppression ?? null, clock });
        return send(res, 200, r.csv, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="${r.filename}"` });
      } catch (err) {
        if (!(err instanceof RangeError)) throw err;
        return isApi ? json(res, err.status ?? 400, { error: err.message }) : send(res, err.status ?? 400, String(errorPage(err.status ?? 400, `${err.message}.`, await ctxFor(user))));
      }
    }

    if (path === '/admin/mca' || path === '/api/mca') {
      // the monthly MCA file (admin/mca.js): a page with an upload form, and the same as JSON and a raw upload
      if (!mcaInbox) return isApi ? json(res, 503, { error: 'MCA_INBOX is not set on this server' }) : send(res, 503, String(errorPage(503, 'The MCA inbox is not set up on this server.', await ctxFor(user))));
      const page = async (status, notice) => send(res, status, String(mcaPage(await mcaState(db, { inbox: mcaInbox }), await ctxFor(user, notice))));
      if (req.method === 'GET') {
        if (isApi) {
          const { inbox: _, ...state } = await mcaState(db, { inbox: mcaInbox });
          return json(res, 200, state);
        }
        return page(200, url.searchParams.get('saved') ? 'Uploaded. The nightly run at 05:00 IST loads it, and it then appears under "Loaded".' : null);
      }
      if (req.method !== 'POST') return send(res, 405, 'method not allowed', 'text/plain');
      if (!sameOrigin(req)) return send(res, 403, 'cross-origin request refused', 'text/plain', { Connection: 'close' });
      if (!can(user, 'admin')) return isApi ? json(res, 403, { error: 'admins only' }) : send(res, 403, String(errorPage(403, 'Only admins can upload the MCA file.', await ctxFor(user))), undefined, { Connection: 'close' });
      if (isApi && user.via === 'session') return json(res, 403, { error: 'use an access token as a bearer token' });
      if (Number(req.headers['content-length'] ?? 0) > MAX_UPLOAD + UPLOAD_OVERHEAD) {
        return isApi ? json(res, 413, { error: 'file too large' }) : send(res, 413, 'That file is too large; MCA\'s workbook is a few MB.', 'text/plain', { Connection: 'close' });
      }
      const body = await readBytes(req, MAX_UPLOAD + UPLOAD_OVERHEAD);
      let filename;
      let data;
      try {
        if (isApi) {
          // a raw body: Content-Type application/octet-stream (or the xlsx type), the name in X-File-Name
          filename = String(req.headers['x-file-name'] ?? '');
          data = body;
        } else {
          const { fields, files } = parseMultipart(body, req.headers['content-type']);
          if (!auth.checkCsrf(user, fields.csrf)) return send(res, 403, 'form expired; reload the page', 'text/plain');
          const f = files.find((x) => x.field === 'file');
          filename = f?.filename ?? '';
          data = f?.data ?? Buffer.alloc(0);
        }
        const r = await saveMcaFile(db, { inbox: mcaInbox, filename, data, user, clock });
        return isApi ? json(res, 201, r) : redirect(res, '/admin/mca?saved=1');
      } catch (err) {
        if (!(err instanceof RangeError)) throw err;
        return isApi ? json(res, err.status ?? 400, { error: err.message }) : page(err.status ?? 400, `Not uploaded: ${err.message}.`);
      }
    }

    if (req.method === 'POST') {
      if (!sameOrigin(req)) return send(res, 403, 'cross-origin request refused', 'text/plain');
      const form = await readForm(req);
      // a browser's form, whether from our session or through the platform's proxy, carries the CSRF token
      const browserForm = user.via === 'session' || (user.via === 'platform' && !isApi);
      if (browserForm && !auth.checkCsrf(user, form.csrf)) return send(res, 403, 'form expired; reload the page', 'text/plain');
      if (path === '/admin/logout') {
        await auth.revoke(db, user);
        await audit({ actor: user.email, role: user.role, action: 'sign_out', detail: { via: user.via } });
        if (user.via === 'platform') signedIn.delete(`platform||${user.email}|${user.role}`);
        return redirect(res, user.via === 'platform' && signoutUrl ? signoutUrl : '/admin/login', { 'Set-Cookie': auth.clearCookie() });
      }
      if (path === '/admin/review' || path === '/api/review') {
        if (!can(user, 'reviewer')) return isApi ? json(res, 403, { error: 'reviewers only' }) : send(res, 403, String(errorPage(403, 'Only reviewers can decide matches.', await ctxFor(user))));
        try {
          await recordReview(db, { entityKey: String(form.entity ?? ''), companyId: String(form.company ?? ''),
            decision: String(form.decision ?? ''), note: form.note, user, clock });
        } catch (err) {
          if (err instanceof RangeError) return isApi ? json(res, 400, { error: err.message }) : send(res, 400, String(errorPage(400, err.message, await ctxFor(user))));
          throw err;
        }
        return isApi ? json(res, 200, { saved: true, applies: 'at the next knowledge-base build' }) : redirect(res, '/admin/review?saved=1');
      }
      if (path === '/admin/labels' || path === '/api/labels') {
        // the labelling page (admin/labels.js): pairs the matcher was sure about, to measure it
        if (!can(user, 'reviewer')) return isApi ? json(res, 403, { error: 'reviewers only' }) : send(res, 403, String(errorPage(403, 'Only reviewers can label pairs.', await ctxFor(user))));
        try {
          await recordReview(db, { entityKey: String(form.entity ?? ''), companyId: String(form.company ?? ''),
            decision: String(form.decision ?? ''), note: form.note, user, mode: 'label', clock });
        } catch (err) {
          if (err instanceof RangeError) return isApi ? json(res, 400, { error: err.message }) : send(res, 400, String(errorPage(400, err.message, await ctxFor(user))));
          throw err;
        }
        return isApi ? json(res, 200, { saved: true }) : redirect(res, '/admin/labels?saved=1');
      }
      const sg = /^\/(admin|api)\/signals\/([^/]+)$/.exec(path);
      if (sg) {
        // funding news (admin/signals.js): a reviewer confirms or rejects what the engine proposed
        if (!can(user, 'reviewer')) return isApi ? json(res, 403, { error: 'reviewers only' }) : send(res, 403, String(errorPage(403, 'Only reviewers can decide news.', await ctxFor(user))));
        let id = '';
        try {
          id = decodeURIComponent(sg[2]);
        } catch {
          // malformed percent-encoding: no such signal
        }
        try {
          const r = await decideSignal(db, { id, decision: String(form.decision ?? ''), note: form.note, user, clock });
          return isApi ? json(res, 200, { saved: true, status: r.status }) : redirect(res, '/admin/signals?saved=1');
        } catch (err) {
          if (!(err instanceof RangeError)) throw err;
          return isApi ? json(res, err.status ?? 400, { error: err.message }) : send(res, err.status ?? 400, String(errorPage(err.status ?? 400, `${err.message}.`, await ctxFor(user))));
        }
      }
      const ap = /^\/(admin|api)\/approvals\/([0-9a-f]{24})(\/outcome|\/resolve)?$/.exec(path);
      if (ap) {
        if (!can(user, 'reviewer')) return isApi ? json(res, 403, { error: 'reviewers only' }) : send(res, 403, String(errorPage(403, 'Only reviewers can decide messages.', await ctxFor(user))));
        if (!outreach) return isApi ? json(res, 503, { error: 'outreach is not configured on this server' }) : send(res, 503, String(errorPage(503, 'Outreach is not configured on this server.', await ctxFor(user))));
        const fail = async (status, message) => (isApi ? json(res, status, { error: message }) : send(res, status, String(errorPage(status, message, await ctxFor(user)))));
        try {
          if (ap[3] === '/resolve') {
            const r = await resolveUnknown(db, { id: ap[2], wasSent: form.sent === 'yes', user, queue: outreach.queue, clock });
            return isApi ? json(res, 200, { saved: true, ...r }) : redirect(res, `/admin/approvals/${ap[2]}?recorded=1`);
          }
          if (ap[3]) {
            await recordOutcome(db, { id: ap[2], outcome: String(form.outcome ?? ''), note: form.note, user, suppression: outreach.suppression, clock });
            return isApi ? json(res, 200, { saved: true }) : redirect(res, `/admin/approvals/${ap[2]}?recorded=1`);
          }
          const edit = typeof form.subject === 'string' && typeof form.body === 'string';
          const r = await decideApproval(db, { id: ap[2], decision: String(form.decision ?? ''), user, note: form.note,
            subject: edit ? form.subject : undefined, body: edit ? form.body : undefined, cfg: outreach.cfg, org: outreach.org, queue: outreach.queue, clock });
          if (!r.ok) {
            const failed = r.qc.checks.filter((c) => !c.ok).map((c) => c.detail).join('; ');
            if (isApi) return json(res, 422, { error: 'the edited text fails the quality check', checks: r.qc.checks });
            const m = await approvalDetail(db, ap[2], { user });
            m.draft = { ...m.draft, subject: form.subject, body: form.body };
            m.qc = r.qc;
            return send(res, 422, String(approvalPage(m, await ctxFor(user, `Not approved: the edited text fails the quality check (${failed}).`))));
          }
          return isApi ? json(res, 200, { saved: true, queued: r.queued }) : redirect(res, '/admin/approvals?decided=1');
        } catch (err) {
          if (err instanceof RangeError) return fail(400, err.message);
          throw err;
        }
      }
      const ib = /^\/(admin|api)\/(inbox|calls)\/([0-9a-f]{24})$/.exec(path);
      if (ib) {
        const what = ib[2] === 'inbox' ? 'replies' : 'calls';
        if (!can(user, 'reviewer')) return isApi ? json(res, 403, { error: 'reviewers only' }) : send(res, 403, String(errorPage(403, `Only reviewers can decide ${what}.`, await ctxFor(user))));
        const fail = async (status, message) => (isApi ? json(res, status, { error: message }) : send(res, status, String(errorPage(status, message, await ctxFor(user)))));
        try {
          if (ib[2] === 'calls') {
            await handleCall(db, { id: ib[3], note: form.note, user, clock });
            return isApi ? json(res, 200, { saved: true }) : redirect(res, `/admin/calls/${ib[3]}?saved=1`);
          }
          if (!outreach) return fail(503, 'Outreach is not configured on this server.');
          const handled = form.handled === 'yes' || form.handled === true;
          const r = await decideInboundRequest(db, { id: ib[3], label: typeof form.label === 'string' ? form.label : null, handled, note: form.note,
            user, suppression: outreach.suppression, queue: outreach.queue, clock });
          return isApi ? json(res, 200, { saved: true, ...r }) : redirect(res, handled ? '/admin/inbox?saved=1' : `/admin/inbox/${ib[3]}?saved=1`);
        } catch (err) {
          if (err instanceof RangeError) return fail(400, err.message);
          throw err;
        }
      }
      const ex = /^\/(admin|api)\/exports(?:\/(exp_[0-9a-z]{12}))?$/.exec(path);
      if (ex) {
        // bulk exports (admin/exports.js): a reviewer asks, another admin decides
        const fail = async (status, message) => (isApi ? json(res, status, { error: message })
          : send(res, status, String(exportsPage(await exportList(db, { clock }), await ctxFor(user, `Not saved: ${message}.`)))));
        try {
          if (!ex[2]) {
            if (!can(user, 'reviewer')) return fail(403, 'only reviewers and admins can ask for an export');
            const r = await requestExport(db, { user, reason: form.reason, includeContacts: form.include_contacts === 'yes' || form.include_contacts === true,
              maxRows: form.max_rows || 5000, filters: { stage: form.stage, cohort: form.cohort, shortlist_month: form.shortlist_month, district: form.district }, clock });
            return isApi ? json(res, 201, r) : redirect(res, '/admin/exports?asked=1');
          }
          if (!can(user, 'admin')) return fail(403, 'only admins approve exports');
          const r = await decideExport(db, { id: ex[2], user, decision: String(form.decision ?? ''), note: form.note, clock });
          return isApi ? json(res, 200, r) : redirect(res, '/admin/exports?decided=1');
        } catch (err) {
          if (err instanceof RangeError) return fail(err.status ?? 400, err.message);
          throw err;
        }
      }
      return send(res, 404, 'not found', 'text/plain');
    }
    if (req.method !== 'GET') return send(res, 405, 'method not allowed', 'text/plain');

    const month = /^\d{4}-\d{2}$/.test(url.searchParams.get('month') ?? '') ? url.searchParams.get('month') : istMonth(clock());
    if (path === '/admin' || path === '/api/pipeline') {
      const p = await pipeline(db, { month });
      return isApi ? json(res, 200, p) : send(res, 200, String(pipelinePage(p, await ctxFor(user))));
    }
    if (path === '/admin/shortlist') {
      return send(res, 200, String(shortlistPage(await pipeline(db, { month }), await ctxFor(user))));
    }
    if (path === '/admin/health') {
      const p = await pipeline(db, { month });
      p.alerts = await db.collection('alerts').find({ status: 'open' }).sort({ severity: 1, last_seen_at: -1 }).toArray();
      return send(res, 200, String(healthPage(p, await ctxFor(user))));
    }
    if (path === '/api/alerts') return json(res, 200, { open: await db.collection('alerts').find({ status: 'open' }).sort({ severity: 1 }).toArray() });
    if (path === '/admin/inbox' || path === '/api/inbox') {
      const q = await inboxQueue(db);
      return isApi ? json(res, 200, q) : send(res, 200, String(inboxPage(q, await ctxFor(user, url.searchParams.get('saved') ? 'Saved.' : null))));
    }
    const ibGet = /^\/(admin|api)\/inbox\/([0-9a-f]{24})$/.exec(path);
    if (ibGet) {
      const m = await inboxDetail(db, ibGet[2], { user, clock });
      if (!m) return isApi ? json(res, 404, { error: 'no such email' }) : send(res, 404, String(errorPage(404, 'No such email.', await ctxFor(user))));
      return isApi ? json(res, 200, m) : send(res, 200, String(inboxItemPage(m, await ctxFor(user, url.searchParams.get('saved') ? 'Saved.' : null))));
    }
    if (path === '/admin/calls' || path === '/api/calls') {
      const q = await callsList(db);
      return isApi ? json(res, 200, q) : send(res, 200, String(callsPage(q, await ctxFor(user))));
    }
    const clGet = /^\/(admin|api)\/calls\/([0-9a-f]{24})$/.exec(path);
    if (clGet) {
      const c = await callDetail(db, clGet[2], { user, clock });
      if (!c) return isApi ? json(res, 404, { error: 'no such call' }) : send(res, 404, String(errorPage(404, 'No such call.', await ctxFor(user))));
      return isApi ? json(res, 200, c) : send(res, 200, String(callPage(c, await ctxFor(user, url.searchParams.get('saved') ? 'Saved.' : null))));
    }
    if (path === '/admin/results' || path === '/api/results') {
      const months = await shortlistMonths(db);
      const wanted = url.searchParams.get('month');
      const m = wanted && /^\d{4}-\d{2}$/.test(wanted) ? wanted : months[0] ?? month;
      const r = { months, lift: await lift(db, { month: m }), costs: await costs(db, { month: istMonth(clock()), fixed: monitorCfg?.fixed_costs_inr_per_month ?? [] }),
        channels: caps ? await channels(db, { caps, clock }) : null,
        campaigns: await campaignResults(db, { campaigns: (outreach?.cfg?.campaigns ?? []).filter((c) => c.code) }) };
      if (isApi) return json(res, 200, r);
      if (!r.channels) return send(res, 503, String(errorPage(503, 'Results need the caps configuration on this server.', await ctxFor(user))));
      return send(res, 200, String(resultsPage(r, await ctxFor(user))));
    }
    if (path === '/admin/companies' || path === '/api/companies') {
      const query = { q: url.searchParams.get('q') ?? '', stage: url.searchParams.get('stage') ?? '', cohort: url.searchParams.get('cohort') ?? '' };
      const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
      const r = await listCompanies(db, { ...query, stage: query.stage || undefined, cohort: /^\d{4}-\d{2}$/.test(query.cohort) ? query.cohort : undefined, page });
      return isApi ? json(res, 200, r) : send(res, 200, String(companiesPage(r, query, await ctxFor(user))));
    }
    const m = /^\/(admin|api)\/companies\/([^/]+)$/.exec(path);
    if (m) {
      let id = '';
      try {
        id = decodeURIComponent(m[2]).toUpperCase();
      } catch {
        // malformed percent-encoding: not a CIN either
      }
      if (!CIN_OR_LLPIN.test(id)) return isApi ? json(res, 404, { error: 'not a CIN or LLPIN' }) : send(res, 404, String(errorPage(404, 'Not a CIN or LLPIN.', await ctxFor(user))));
      const wantPersonal = url.searchParams.get('personal') === '1';
      if (wantPersonal && !can(user, 'admin')) return isApi ? json(res, 403, { error: 'admins only' }) : send(res, 403, String(errorPage(403, 'Only admins can see personal data.', await ctxFor(user))));
      const v = await companyView(db, id, { personal: wantPersonal });
      if (!v) return isApi ? json(res, 404, { error: 'no such company' }) : send(res, 404, String(errorPage(404, 'No such company.', await ctxFor(user))));
      if (wantPersonal && v.personal_fields.length) {
        await auditPersonalView(db, { user, target: { type: 'company', id }, fields: v.personal_fields, clock });
      }
      return isApi ? json(res, 200, v) : send(res, 200, String(companyPage(v, await ctxFor(user))));
    }
    if (path === '/admin/approvals' || path === '/api/approvals') {
      const q = await approvalQueue(db, { user });
      if (outreach?.cfg) q.sampling = await samplingState(db, outreach.cfg, { clock });   // all drafts to a person, or a sample, and why
      if (isApi) return json(res, 200, q);
      return send(res, 200, String(approvalsPage(q, await ctxFor(user, url.searchParams.get('decided') ? 'Saved. An approved email goes out when the compliance gate allows it.' : null))));
    }
    const apGet = /^\/(admin|api)\/approvals\/([0-9a-f]{24})$/.exec(path);
    if (apGet) {
      const m = await approvalDetail(db, apGet[2], { user });
      if (!m) return isApi ? json(res, 404, { error: 'no such message' }) : send(res, 404, String(errorPage(404, 'No such message.', await ctxFor(user))));
      return isApi ? json(res, 200, m) : send(res, 200, String(approvalPage(m, await ctxFor(user, url.searchParams.get('recorded') ? 'Recorded.' : null))));
    }
    if (path === '/admin/audit' || path === '/api/audit') {
      if (!can(user, 'admin')) return isApi ? json(res, 403, { error: 'admins only' }) : send(res, 403, String(errorPage(403, 'Only admins can read the audit log.', await ctxFor(user))));
      let filters;
      try {
        filters = auditFilters(url.searchParams);
      } catch (err) {
        if (!(err instanceof RangeError)) throw err;
        return isApi ? json(res, 400, { error: err.message }) : send(res, 400, String(errorPage(400, err.message, await ctxFor(user))));
      }
      await auditView(db, { user, filters, clock });
      const log = await auditLog(db, filters);
      return isApi ? json(res, 200, log) : send(res, 200, String(auditPage(log, await ctxFor(user))));
    }
    if (path === '/admin/labels' || path === '/api/labels') {
      const q = await labelQueue(db);        // team members only as a count: never names
      if (isApi) return json(res, 200, q);
      return send(res, 200, String(labelsPage(q, await ctxFor(user, url.searchParams.get('saved') ? 'Saved. Next pair below.' : null))));
    }
    if (path === '/admin/signals' || path === '/api/signals') {
      const q = await signalQueue(db);       // any signed-in person may read; reviewers decide
      if (isApi) return json(res, 200, q);
      return send(res, 200, String(signalsPage(q, await ctxFor(user, url.searchParams.get('saved') ? 'Saved. A confirmed item shows on the company\'s page.' : null))));
    }
    if (path === '/admin/review' || path === '/api/review') {
      const q = await reviewQueue(db);       // team members only as a count: never names
      if (isApi) return json(res, 200, q);
      return send(res, 200, String(reviewPage(q, await ctxFor(user, url.searchParams.get('saved') ? 'Saved. It applies at the next nightly knowledge-base build.' : null))));
    }
    return isApi ? json(res, 404, { error: 'not found' }) : send(res, 404, String(errorPage(404, 'No such page.', await ctxFor(user))));
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error?.(`[admin] ${req.method} ${req.url}: ${err.stack ?? err}`);
      if (!res.headersSent && !res.destroyed) {
        send(res, err.status ?? 500, err.status ? err.message : 'Something went wrong; it has been logged.', 'text/plain',
          err.status === 413 ? { Connection: 'close' } : {});
      }
    });
  });
  server.failures = failures;     // for tests and monitoring: how many addresses are being counted
  return server;
}

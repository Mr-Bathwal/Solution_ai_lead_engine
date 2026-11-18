import { accessSync, constants, existsSync, readdirSync } from 'node:fs';
import { hindiState } from '../public/i18n.js';
import { PROVIDERS, providerFromEnv } from '../outreach/verify.js';
import * as nodeDns from 'node:dns/promises';
import path from 'node:path';
import { ConsentLedger } from '../consent/ledger.js';
import { ContactBudget } from '../outreach/budget.js';
import { verifySmtp } from '../outreach/smtp.js';
import { ImapClient } from '../inbound/imap.js';
import { istMonth } from '../outreach/meter.js';
import { scriptProblem } from '../voice/calls.js';

/**
 * The go/no-go check before launch, and after any change on the server (`lead-engine preflight`).
 * Every setting, secret and outside service the engine needs, checked in the order things go live:
 *
 *   core       the database, its schema, the secrets, the consent ledger and its anchor
 *   data       this month's MCA file, the shortlist, the CA's sign-off, registered emails
 *   email      the mailboxes, their DNS (MX, SPF, DMARC, DKIM), sign-in to SMTP and IMAP, warm-up
 *   pages      the public address, its health check, the privacy notice
 *   platform   sign-up, notifications, events, the LLM gateway
 *   whatsapp   the account, the approved templates, the webhook secrets
 *   voice      switched on or off, the provider, the script sign-off
 *   ops        the daily summary, open alerts
 *
 * Each check is pass, warn (works, with a fallback or a gap to close), fail (blocks real sending) or
 * skip (not live yet). `live` adds the checks that reach outside the server: SMTP and IMAP sign-in
 * (nothing is sent), DNS, the public health check and Meta's API. Nothing is changed anywhere.
 */

const ok = (area, name, detail) => ({ area, name, status: 'pass', detail });
const warn = (area, name, detail, fix) => ({ area, name, status: 'warn', detail, fix });
const fail = (area, name, detail, fix) => ({ area, name, status: 'fail', detail, fix });
const skip = (area, name, detail) => ({ area, name, status: 'skip', detail });
const DAY = 86_400_000;

async function timed(promise, ms = 10_000) {
  let t;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms); })]);
  } finally {
    clearTimeout(t);
  }
}

export async function preflight({ cfg, spec, db, deps, live = false, fetch = globalThis.fetch, clock = () => new Date(), smtpCheck = verifySmtp,
  imapFactory = (o) => new ImapClient(o), dns = nodeDns }) {
  const env = cfg.env ?? {};
  const out = [];
  const add = (r) => out.push(r);
  const now = clock();

  // ---- core -------------------------------------------------------------------------------------------
  try {
    await db.command({ ping: 1 });
    add(ok('core', 'database', `${cfg.dbName} answers`));
  } catch (err) {
    add(fail('core', 'database', err.message, 'check MONGODB_URI and that the server can reach the cluster'));
    return out;                                    // nothing else can be checked
  }
  const have = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  const missing = Object.keys(spec.collections).filter((c) => !have.has(c));
  add(missing.length ? fail('core', 'schema', `${missing.length} collection(s) missing: ${missing.slice(0, 5).join(', ')}`, 'npm run migrate')
    : ok('core', 'schema', `${Object.keys(spec.collections).length} collections with their validators`));
  try {
    const status = await db.command({ connectionStatus: 1 });
    const roles = (status.authInfo?.authenticatedUserRoles ?? []).map((r) => r.role);
    if (!status.authInfo?.authenticatedUsers?.length) add(warn('core', 'database user', 'connected without a user (fine on a laptop)', 'in production connect as lead_engine_app (ops/mongodb-access.md)'));
    else if (roles.some((r) => ['root', 'dbOwner', 'atlasAdmin', 'readWriteAnyDatabase'].includes(r))) add(warn('core', 'database user', `connected with ${roles.join(', ')}`, 'run the services as lead_engine_app; keep the admin login for erase and unsuppress'));
    else add(ok('core', 'database user', `roles: ${roles.join(', ') || 'none listed'}`));
  } catch {
    add(skip('core', 'database user', 'connectionStatus not available'));
  }
  const secret = (name, value, min = 32) => (String(value ?? '').length >= min ? ok('core', name, 'set') : fail('core', name, value ? `shorter than ${min} characters` : 'not set', `set ${name} in .env (openssl rand -hex 32)`));
  add(secret('CONTACT_KEY_SECRET', cfg.contactKeySecret));
  add(secret('PAGE_SECRET', cfg.pageSecret));
  add(cfg.adminSecret?.length >= 32 ? ok('core', 'ADMIN_SESSION_SECRET', 'set') : warn('core', 'ADMIN_SESSION_SECRET', 'not set', 'needed to sign in to the Admin pages'));
  add(env.HOLDOUT_SALT ? ok('core', 'HOLDOUT_SALT', 'set') : (env.LEADENGINE_ENV === 'development'
    ? warn('core', 'HOLDOUT_SALT', 'not set (development)', 'set it once in production and never change it') : fail('core', 'HOLDOUT_SALT', 'not set', 'set it once and never change it (ops/WEEK2_ACTIONS.md, item 2)')));
  if (cfg.ledgerAnchorFile) {
    let writable = false;
    try {
      accessSync(existsSync(cfg.ledgerAnchorFile) ? cfg.ledgerAnchorFile : path.dirname(cfg.ledgerAnchorFile), constants.W_OK);
      writable = true;
    } catch { /* not writable */ }
    add(writable ? ok('core', 'ledger anchor', cfg.ledgerAnchorFile) : fail('core', 'ledger anchor', `${cfg.ledgerAnchorFile} is not writable`, 'point LEDGER_ANCHOR_FILE at an append-only location the engine can write'));
  } else add(warn('core', 'ledger anchor', 'LEDGER_ANCHOR_FILE not set', 'set it so ledger:anchor can keep the chain head outside the database'));
  if (cfg.contactKeySecret?.length >= 32) {
    const v = await new ConsentLedger(db, { secret: cfg.contactKeySecret, clock }).verify({ maxProblems: 3 });
    add(v.ok ? ok('core', 'consent ledger', `verifies (${v.checked} entries)`) : fail('core', 'consent ledger', `does not verify at entry ${v.seq}: ${v.reason}`, 'stop sending and investigate (docs/HANDOVER.md)'));
  }

  // ---- data -------------------------------------------------------------------------------------------
  const month = istMonth(now);
  const prev = istMonth(new Date(Date.parse(`${month}-01T00:00:00+05:30`) - DAY));
  const lastMca = await db.collection('ingest_runs').find({ source: 'mca_monthly', status: { $in: ['ok', 'partial'] } }).sort({ started_at: -1 }).limit(1).next();
  const prevCohort = await db.collection('companies').countDocuments({ cohort: prev });
  const dayOfMonth = Number(new Date(now.getTime() + 5.5 * 3_600_000).toISOString().slice(8, 10));
  if (prevCohort) add(ok('data', 'MCA file', `${prevCohort} companies incorporated in ${prev}`));
  else add((dayOfMonth > 5 ? fail : warn)('data', 'MCA file', `no companies incorporated in ${prev} yet${lastMca ? `; last file loaded ${lastMca.started_at.toISOString().slice(0, 10)}` : ''}`,
    `download the ${prev} incorporation report from MCA and upload it on Admin, Data health, MCA file (the nightly loads it), or run: leadengine ingest mca <file> (ops/WEEK1_ACTIONS.md, item 9)`));
  const shortlisted = await db.collection('leads').countDocuments({ 'shortlist.month': month, holdout: false });
  add(shortlisted ? ok('data', 'shortlist', `${shortlisted} companies on the ${month} shortlist`)
    : warn('data', 'shortlist', `no ${month} shortlist yet`, 'it is made by the nightly batch once the previous month\'s MCA file is in'));
  const confirmed = await db.collection('leads').findOne({ 'needs.rules_confirmed': true }, { projection: { _id: 1 } });
  add(confirmed ? ok('data', 'CA sign-off', 'the rules are confirmed')
    : fail('data', 'CA sign-off', 'no rule is confirmed by a CA: every message waits at the gate', 'the CA fills confirmed_by in config/rules/*.json; the next nightly applies it'));
  const withEmail = await db.collection('leads').aggregate([
    { $match: { 'shortlist.month': { $in: [month, prev] }, holdout: false } },
    { $lookup: { from: 'companies', localField: 'company_id', foreignField: '_id', as: 'c', pipeline: [{ $match: { 'attrs.registered_email.value': { $type: 'string' } } }, { $project: { _id: 1 } }] } },
    { $match: { 'c.0': { $exists: true } } }, { $count: 'n' },
  ]).toArray();
  const n = withEmail[0]?.n ?? 0;
  add(n ? ok('data', 'registered emails', `${n} shortlisted companies have one`)
    : fail('data', 'registered emails', 'no shortlisted company has a registered email yet', 'set INFYNER_API_KEY, then leadengine enrich probe <CIN> and leadengine enrich run'));

  // ---- email ------------------------------------------------------------------------------------------
  const transport = deps.transport.kind;
  add(transport === 'smtp' ? ok('email', 'transport', 'smtp: emails really go out') : warn('email', 'transport', 'outbox: emails are written to files, nothing is sent', 'OUTREACH_TRANSPORT=smtp once everything else passes'));
  const budget = new ContactBudget(db, cfg.caps, { clock });
  const day = budget.warmupDay(now);
  add(day > cfg.caps.email.warmup_days ? ok('email', 'warm-up', `over (day ${day}); ${budget.mailboxCap(now)} emails a day per mailbox`)
    : fail('email', 'warm-up', `day ${day} of ${cfg.caps.email.warmup_days}`, 'wait for the warm-up to end; the gate holds emails until then'));
  const domains = new Set();
  for (const [id, mb] of Object.entries(deps.mailboxes)) {
    if (!mb.address || !mb.name) {
      add(fail('email', id, 'address or sender name not set', `set ${id.toUpperCase().replace(/-/g, '_')}_ADDRESS and _NAME`));
      continue;
    }
    domains.add(mb.address.split('@')[1]);
    if (!mb.pass) {
      add((transport === 'smtp' ? fail : warn)('email', `${id} SMTP`, 'no SMTP app password', `set ${id.toUpperCase().replace(/-/g, '_')}_SMTP_PASSWORD (a Zoho app password)`));
      continue;
    }
    if (!live) {
      add(skip('email', `${id} SMTP`, 'run with --live to sign in'));
      continue;
    }
    try {
      await timed(smtpCheck({ host: deps.transport.host ?? env.SMTP_HOST ?? 'smtp.zoho.in', port: deps.transport.port ?? Number(env.SMTP_PORT || 465), user: mb.user, pass: mb.pass }), 20_000);
      add(ok('email', `${id} SMTP`, `${mb.address} signs in`));
    } catch (err) {
      add(fail('email', `${id} SMTP`, err.message.slice(0, 160), 'check the app password and that SMTP is on for the mailbox'));
    }
    const imap = deps.imap?.[id];
    if (imap?.configured) {
      const c = imapFactory(imap);
      try {
        await timed(c.connect(), 20_000);
        await timed(c.examine('INBOX'), 20_000);
        add(ok('email', `${id} IMAP`, 'signs in and opens the inbox read-only'));
      } catch (err) {
        add(fail('email', `${id} IMAP`, err.message.slice(0, 160), 'turn IMAP on in Zoho (Settings, Mail Accounts, IMAP); replies are not read without it'));
      } finally {
        await c.logout().catch(() => {});
      }
    }
  }
  for (const domain of domains) {
    if (!live) {
      add(skip('email', `DNS ${domain}`, 'run with --live to look up MX, SPF, DMARC and DKIM'));
      continue;
    }
    const txt = async (name) => (await timed(dns.resolveTxt(name), 8000).catch(() => [])).map((r) => r.join(''));
    const mx = (await timed(dns.resolveMx(domain), 8000).catch(() => [])).map((r) => r.exchange.toLowerCase());
    add(mx.some((x) => x.includes('zoho')) ? ok('email', `MX ${domain}`, mx.join(', ')) : fail('email', `MX ${domain}`, mx.length ? mx.join(', ') : 'none', 'point MX at Zoho (ops/WEEK1_ACTIONS.md)'));
    const spf = (await txt(domain)).filter((t) => t.startsWith('v=spf1'));
    add(spf.length === 1 && /zoho/i.test(spf[0]) && /[~-]all$/.test(spf[0]) ? ok('email', `SPF ${domain}`, spf[0])
      : fail('email', `SPF ${domain}`, spf.length ? spf.join(' | ') : 'none', 'one SPF record that includes zoho and ends in ~all or -all'));
    const dmarc = (await txt(`_dmarc.${domain}`)).find((t) => t.startsWith('v=DMARC1'));
    add(dmarc ? ok('email', `DMARC ${domain}`, dmarc) : fail('email', `DMARC ${domain}`, 'none', 'add a DMARC record with a reporting address'));
    const selector = env.DKIM_SELECTOR || 'zmail';
    const dkim = (await txt(`${selector}._domainkey.${domain}`)).find((t) => /p=/.test(t));
    add(dkim ? ok('email', `DKIM ${domain}`, `selector ${selector} found`) : warn('email', `DKIM ${domain}`, `no key at ${selector}._domainkey`, 'set DKIM_SELECTOR to Zoho\'s selector, or publish the key'));
  }
  const verifyWith = (() => { try { return providerFromEnv(env); } catch { return 'bad'; } })();
  add(verifyWith === 'bad' ? fail('email', 'address checks', `EMAIL_VERIFY_PROVIDER is not one of ${Object.keys(PROVIDERS).join(', ')}`, 'fix it or leave it empty')
    : verifyWith ? ok('email', 'address checks', `${verifyWith.name}, at most ${cfg.caps.monthly?.email_verifications_paid ?? 0} a month, after the free checks`)
      : warn('email', 'address checks', 'free checks only (format, throwaway domains, MX)', 'EMAIL_VERIFY_PROVIDER and EMAIL_VERIFY_API_KEY catch mailboxes that do not exist before they bounce (design 7.3)'));
  add(Object.values(deps.imap ?? {}).some((b) => b.configured) ? ok('email', 'reading replies', 'IMAP passwords set')
    : warn('email', 'reading replies', 'no mailbox can be read', 'the SMTP app passwords work for IMAP: set MAILBOX_n_SMTP_PASSWORD, and turn IMAP on in Zoho'));

  // ---- pages ------------------------------------------------------------------------------------------
  const base = cfg.publicBaseUrl ?? '';
  if (!/^https:\/\/[^/]+/.test(base)) add(fail('pages', 'PUBLIC_BASE_URL', base ? `${base} is not https` : 'not set', 'the https address of the company pages, behind the platform\'s proxy'));
  else if (!live) add(skip('pages', 'PUBLIC_BASE_URL', `${base}; run with --live to reach /healthz`));
  else {
    try {
      const res = await fetch(`${base.replace(/\/+$/, '')}/healthz`, { signal: AbortSignal.timeout(8000) });
      const body = await res.text();
      add(res.ok && body.trim() === 'ok' ? ok('pages', 'PUBLIC_BASE_URL', `${base}/healthz answers ok`) : fail('pages', 'PUBLIC_BASE_URL', `/healthz answered ${res.status}`, 'start the pages service and point the proxy at it'));
    } catch (err) {
      add(fail('pages', 'PUBLIC_BASE_URL', `${base} cannot be reached: ${err.message}`, 'start the pages service and point the proxy at it'));
    }
  }
  add(cfg.privacyUrl && cfg.privacyContact ? ok('pages', 'privacy notice', `${cfg.privacyUrl} · ${cfg.privacyContact}`)
    : fail('pages', 'privacy notice', 'PRIVACY_NOTICE_URL or PRIVACY_CONTACT not set', 'the claim form links to the notice and names the contact (ops/WEEK3_ACTIONS.md, item 3)'));
  const hindi = hindiState(cfg.outreach);
  add(hindi.live ? ok('pages', 'Hindi pages', `approved by ${cfg.outreach.claim.hindi.approved_by} on ${cfg.outreach.claim.hindi.approved_on}`)
    : skip('pages', 'Hindi pages', 'a draft for the lawyer: founders see English only; preview with ?lang=hi&preview=1 on a company page link (ops/WEEK4_ACTIONS.md, item 20)'));

  // ---- platform -----------------------------------------------------------------------------------------
  add(env.PLATFORM_ONBOARDING_URL && env.PLATFORM_API_KEY ? ok('platform', 'onboarding', 'pre-filled sign-up after a claim')
    : warn('platform', 'onboarding', `not set: founders go to ${env.PLATFORM_SIGNUP_URL || cfg.outreach.org.website}`, 'PLATFORM_ONBOARDING_URL (PLATFORM_CONTRACTS.md 3.1)'));
  add(deps.platform.canNotify ? ok('platform', 'notifications', 'email reminders and scheme alerts go out')
    : warn('platform', 'notifications', 'not set: email reminders are skipped, scheme alerts wait', 'PLATFORM_NOTIFY_URL (PLATFORM_CONTRACTS.md 3.2)'));
  add(cfg.platformEventsSecret?.length >= 32 ? ok('platform', 'events', '/api/events accepts signed events')
    : warn('platform', 'events', 'PLATFORM_EVENTS_SECRET not set: payments cannot be attributed', 'share a secret with the platform (PLATFORM_CONTRACTS.md 4.1)'));
  const ssoOn = (cfg.platformSsoSecret ?? '').length >= 32;
  const services = (cfg.adminServiceTokens ?? '').split(';').filter((x) => x.trim()).length;
  add(ssoOn || services ? ok('platform', 'Admin sign-in', [ssoOn && 'signed headers from the platform proxy', services && `${services} service token(s)`].filter(Boolean).join(' and '))
    : warn('platform', 'Admin sign-in', 'personal tokens only: the Admin pages are not inside the platform portal yet', 'PLATFORM_SSO_SECRET or admin:service (PLATFORM_CONTRACTS.md 2)'));
  add(deps.llm.configured ? ok('platform', 'LLM gateway', 'AI drafting and reply classification on')
    : warn('platform', 'LLM gateway', 'not set: the reviewed templates write every email', 'LLM_GATEWAY_URL and LLM_GATEWAY_KEY (PLATFORM_CONTRACTS.md 3.3)'));
  add(env.RULES_ENGINE_URL ? ok('platform', 'rules engine', 'scheme verdicts from the platform')
    : warn('platform', 'rules engine', 'not set: provisional scheme rules', 'RULES_ENGINE_URL (PLATFORM_CONTRACTS.md 1)'));

  // ---- WhatsApp ---------------------------------------------------------------------------------------
  if (!deps.whatsapp.configured) add(skip('whatsapp', 'account', 'not set up: WhatsApp messages go to the outbox'));
  else {
    add(ok('whatsapp', 'account', `phone number id ${deps.whatsapp.phoneNumberId}`));
    if (live) {
      try {
        const res = await fetch(`https://graph.facebook.com/${deps.whatsapp.apiVersion}/${deps.whatsapp.phoneNumberId}?fields=display_phone_number,quality_rating`,
          { headers: { authorization: `Bearer ${deps.whatsapp.token}` }, signal: AbortSignal.timeout(8000) });
        const j = await res.json().catch(() => ({}));
        add(res.ok ? ok('whatsapp', 'Meta API', `${j.display_phone_number ?? 'number'} · quality ${j.quality_rating ?? 'unknown'}`) : fail('whatsapp', 'Meta API', `answered ${res.status}: ${j.error?.message ?? ''}`.slice(0, 160), 'renew WHATSAPP_TOKEN (a system-user token that does not expire)'));
      } catch (err) {
        add(fail('whatsapp', 'Meta API', err.message, 'check the network and WHATSAPP_TOKEN'));
      }
    }
    const approved = await db.collection('channel_templates').countDocuments({ status: 'APPROVED' });
    add(approved >= 2 ? ok('whatsapp', 'templates', `${approved} approved`) : warn('whatsapp', 'templates', `${approved} approved`, 'node src/cli.js whatsapp:templates --submit, then --sync'));
    add(env.WHATSAPP_APP_SECRET && env.WHATSAPP_VERIFY_TOKEN ? ok('whatsapp', 'webhook', 'secrets set')
      : fail('whatsapp', 'webhook', 'WHATSAPP_APP_SECRET or WHATSAPP_VERIFY_TOKEN not set: a STOP reply would not be read', 'ops/WEEK4_ACTIONS.md, section 12'));
  }

  // ---- voice ------------------------------------------------------------------------------------------
  const v = deps.voiceCfg;
  if (!v.enabled) add(skip('voice', 'AI call back', 'switched off: a person makes the calls listed on the Calls page'));
  else {
    add(deps.voice.configured ? ok('voice', 'provider', `Sarvam app ${deps.voice.appId} v${deps.voice.appVersion}`) : fail('voice', 'provider', 'Sarvam is not configured', 'SARVAM_* and VOICE_CALLER_NUMBER'));
    const sp = scriptProblem(v);
    add(sp ? fail('voice', 'script', sp, 'sign off the script in config/voice.json') : ok('voice', 'script', `${v.script.version}, signed off by ${v.script.approved_by}`));
  }

  // ---- ops ------------------------------------------------------------------------------------------
  // backups: the newest full one in BACKUP_DIR, and whether cron can copy them off the server
  const fulls = existsSync(cfg.backupDir ?? '') ? readdirSync(cfg.backupDir).filter((n) => n.endsWith('-full')).sort() : [];
  const newestFull = fulls.at(-1);
  const fullAt = newestFull ? Date.parse(newestFull.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z.*$/, '$1-$2-$3T$4:$5:$6Z')) : null;
  if (!fullAt) add(warn('ops', 'backups', `none in ${cfg.backupDir}`, 'node src/cli.js backup (cron does it nightly and hourly on the server, ops/deploy/leadengine.cron)'));
  else if (now.getTime() - fullAt > 30 * 3_600_000) add(warn('ops', 'backups', `the newest full backup is from ${newestFull.slice(0, 8)}`, 'check backup.log and the cron'));
  else add(ok('ops', 'backups', `newest full backup ${newestFull}`));
  add(env.BACKUP_S3_URI ? ok('ops', 'backups off the server', env.BACKUP_S3_URI) : warn('ops', 'backups off the server', 'BACKUP_S3_URI not set: the backups stay on this server only', 'an encrypted S3 bucket that expires objects after 35 days (ops/deploy/README.md)'));
  add(cfg.summaryTo?.length ? ok('ops', 'daily summary', `to ${cfg.summaryTo.length} address(es)`) : warn('ops', 'daily summary', 'SUMMARY_TO not set', 'the team\'s addresses, comma-separated'));
  const critical = await db.collection('alerts').countDocuments({ status: 'open', severity: 'critical' });
  add(critical ? fail('ops', 'alerts', `${critical} critical alert(s) open`, 'see Data health') : ok('ops', 'alerts', 'no critical alert open'));
  return out;
}

/** A plain report: one line per check, the fixes, and the verdict. */
export function formatPreflight(results) {
  const mark = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skip: ' -- ' };
  const lines = [];
  let area = null;
  for (const r of results) {
    if (r.area !== area) {
      area = r.area;
      lines.push('', area.toUpperCase());
    }
    lines.push(`  ${mark[r.status]}  ${r.name.padEnd(22)} ${r.detail ?? ''}`);
    if (r.fix && r.status !== 'pass') lines.push(`        -> ${r.fix}`);
    if (r.example) lines.push(`        ${r.example}`);
  }
  const fails = results.filter((r) => r.status === 'fail').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  lines.push('', fails ? `NOT READY: ${fails} check(s) block real sending, ${warns} warning(s).` : `READY to send${warns ? `, with ${warns} warning(s) that have fallbacks` : ''}.`);
  return lines.join('\n');
}

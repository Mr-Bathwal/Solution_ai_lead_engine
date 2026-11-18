#!/usr/bin/env node
import { appRoleDefinition, atlasCustomRole, ensureAppRole, migrate } from './db/migrate.js';
import { connect } from './db/client.js';
import { WA_TEMPLATES_PATH, loadConfig, loadSchema } from './config.js';
import { appendAnchor, readAnchors } from './consent/anchor.js';
import { ConsentLedger } from './consent/ledger.js';
import { JobQueue } from './jobs/queue.js';
import { Worker } from './jobs/worker.js';
import { SuppressionList } from './suppression/list.js';
import { Auth, PLATFORM_SKEW_S, ROLES, newServiceToken, newUser, parseServiceTokens, parseUsers, platformHeaders } from './admin/auth.js';
import { createAdminServer } from './admin/server.js';
import { buildOutreach, sendingProblems } from './outreach/index.js';
import { JOB_SEND, planOutreach } from './outreach/sequence.js';
import { planReminders } from './outreach/reminders.js';
import { WhatsAppClient, submitTemplates, syncTemplates } from './outreach/whatsapp.js';
import { istMonth } from './outreach/meter.js';
import { createPublicServer } from './public/server.js';
import { readMailboxes } from './inbound/process.js';
import { emfLine, runMonitor } from './monitor/alerts.js';
import { buildSummary, sendSummary } from './monitor/summary.js';
import { channels, costs, lift, shortlistMonths } from './attribution/results.js';
import { serveStdio } from './mcp/server.js';
import { REAL, evalReplies, exportLabelledReplies } from './eval/replies.js';
import { evalQc } from './eval/qc.js';
import { erase } from './privacy/erase.js';
import { unsuppress } from './privacy/unsuppress.js';
import { assertStaging, clearStaging, seedStaging } from './ops/staging.js';
import { runSmoke } from './ops/smoke.js';
import { backupDb, pruneBackups, restoreDb } from './ops/backup.js';
import { agreement, samplingState } from './outreach/sampling.js';
import { aiCheckPairs } from './admin/ai_check.js';
import { DEMO_MARKER, DEMO_SECRET, demoConfig, demoDbName, demoOutreach, drain, seedDemo } from './ops/demo.js';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { formatPreflight, preflight } from './ops/preflight.js';
import { platformCheck } from './ops/platform_check.js';
import { ROOT } from './config.js';
import { readFileSync } from 'node:fs';

const HELP = `lead-engine <command>

  migrate [--rebuild-indexes [--allow-unique-gap]] [--role]
                                          apply schema/collections.json; --role also creates the app role.
                                          A unique index is only rebuilt with --allow-unique-gap, after
                                          every worker and writer has been stopped
  status                                  collection counts, job stats, consent ledger check
  platform:check [--notify-to ADDR] [--llm]  test the platform's endpoints against docs/platform-openapi.yaml
  preflight [--live] [--json]             the go/no-go check: every setting, secret and outside service; --live also
                                          signs in to SMTP and IMAP (nothing is sent), looks up DNS and the pages
  jobs                                    job counts by type and status
  ledger:verify                           check the consent ledger's hash chain (and LEDGER_ANCHOR_FILE) and print its head
  ledger:anchor                           check the ledger, then append its head to LEDGER_ANCHOR_FILE
  suppress <email|phone|domain> <value> --reason R [--note N]
  unsuppress <email|phone> <value> --by ADMIN_EMAIL --note N
                                          take an address off the do-not-contact list because its owner asked
                                          (never an erasure request, a complaint or a hard bounce; admin MONGODB_URI)
  erase <email|phone> <value> --by ADMIN_EMAIL [--note N]
                                          an erasure request: the person's address or number, contacts, replies,
                                          call transcripts and ledger addresses are removed everywhere; only the
                                          keyed hash stays on the suppression list (needs an admin MONGODB_URI)
  check <email|phone|domain> <value>      is this address suppressed?
  worker                                  run the job worker: drafting, sending, reminders, call backs
  outreach:plan [--month YYYY-MM]         queue today's drafts (first emails for the shortlist, follow-ups)
  reminders:plan                          queue today's deadline reminders for founders who asked for them
  whatsapp:templates [--sync] [--submit [--dry-run]]
                                          the WhatsApp templates and Meta's status for each; --submit sends Meta
                                          the ones it does not have (with PUBLIC_BASE_URL in the buttons), --sync
                                          reads Meta's decisions
  pages                                   serve the company pages, claim form and unsubscribe links (PUBLIC_PORT)
  inbox:read                              read the outreach mailboxes once: replies, bounces, complaints (Phase 4)
  monitor                                 run the alert checks once; prints the open alerts and a CloudWatch metric line
  summary [--send]                        the team's daily summary; --send mails it to SUMMARY_TO (outbox unless smtp)
  results [--month YYYY-MM]               the shortlist against its holdout, the month's costs, channel health
  mcp                                     serve the engine's MCP tools on stdin/stdout (search_leads, company_profile,
                                          deadline_calendar)
  eval:replies [--real] [--ai]            the reply classifier against data/testsets/replies.jsonl (--real: the replies
                                          people labelled in the inbox; --ai: with the LLM gateway)
  inbox:export-labels                     write the replies people labelled to data/testsets/replies_real.jsonl
  eval:qc                                 the quality check against generated drafts with one known fault each
  staging:seed --email ADDR [--phone N]   the end-to-end test company, addressed to one of our own mailboxes, in
                                          a LEAD_DB ending in _staging; prints the CAPS_FILE to run the worker with
  staging:smoke                           the live email test on staging: send between the two real mailboxes, read it
                                          back, reply, and check the engine reads and labels the reply (about 5 minutes)
  staging:clear                           drop the staging database
  kb:ai-check [--limit 50]                the AI model's advice on unsure matches, shown on the review page (needs the
                                          LLM gateway; advice only, a person decides)
  verify:email <address>                  the check a first email's address gets (format, throwaway domain, MX, and the
                                          verification service if EMAIL_VERIFY_PROVIDER is set); counts against its cap
  approval:agreement                      how often the quality check agrees with the reviewers, and whether sample
                                          approval is (or could be) in force (config/outreach.json approval)
  backup [--critical]                     every collection (nightly), or only what cannot be rebuilt (hourly), to
                                          BACKUP_DIR (data/backups); keeps 7 full and 48 critical backups
  restore <backup folder> --into <db>     into a new, empty database, checking every file, the counts and the
                                          consent ledger; never over LEAD_DB
  demo:seed                               fill <LEAD_DB>_demo with fictional companies taken through every step, for
                                          a walkthrough (emptied first; nothing is sent; .env's mailboxes and keys unused)
  demo:serve                              show it: the Admin pages and a company page, with one-time sign-in tokens
  admin                                   serve the Admin pages (ADMIN_USERS, ADMIN_SESSION_SECRET, ADMIN_PORT)
  admin:user <email> <viewer|reviewer|admin>  make an access token and print its ADMIN_USERS entry
  admin:service <name> <max-role>         a service token for the platform's portal (ADMIN_SERVICE_TOKENS); it names
                                          the person on each call in X-Acting-User
  admin:platform-headers <email> <role> [--method GET] [--target /api/pipeline]
                                          the signed headers the platform's proxy adds (PLATFORM_SSO_SECRET), as curl

Exit codes: 0 done, 1 failed, 2 wrong usage or a ledger that does not verify, 130 interrupted twice.`;

const COMMANDS = new Set(['migrate', 'status', 'jobs', 'ledger:verify', 'ledger:anchor', 'suppress', 'check', 'worker', 'admin', 'admin:user', 'admin:service', 'admin:platform-headers',
  'outreach:plan', 'reminders:plan', 'whatsapp:templates', 'pages', 'inbox:read', 'monitor', 'summary', 'results', 'mcp', 'eval:replies', 'eval:qc', 'inbox:export-labels', 'erase', 'staging:seed', 'staging:clear', 'unsuppress', 'preflight', 'platform:check', 'staging:smoke', 'demo:seed', 'demo:serve', 'backup', 'restore', 'approval:agreement', 'verify:email', 'kb:ai-check']);
const NEEDS_SECRET = new Set(['verify:email', 'status', 'ledger:verify', 'ledger:anchor', 'suppress', 'check', 'worker', 'outreach:plan', 'reminders:plan', 'pages',
  'inbox:read', 'monitor', 'erase', 'unsuppress', 'preflight']);
/** Commands that need no database at all. */
const OFFLINE = new Set(['eval:qc']);
const KINDS = ['email', 'phone', 'domain'];
const VALUE_FLAGS = new Set(['--limit', '--reason', '--note', '--month', '--by', '--email', '--phone', '--notify-to', '--method', '--target', '--into']);

/** A mistake in how the command was called: printed without a stack trace, exit code 2. */
class UsageError extends Error {}

const [, , cmd, ...args] = process.argv;
const flag = (name) => args.includes(name);
function opt(name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new UsageError(`${name} needs a value`);
  return v;
}
/** The arguments that are not flags or flag values, so "suppress --reason R email x" works too. */
function positional() {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (VALUE_FLAGS.has(args[i])) i += 1;
    else if (!args[i].startsWith('--')) out.push(args[i]);
  }
  return out;
}
function kindAndValue() {
  const [kind, value] = positional();
  if (!KINDS.includes(kind) || !value) throw new UsageError(`usage: lead-engine ${cmd} <${KINDS.join('|')}> <value>`);
  return [kind, value];
}
/** Input the library refused (an invalid address, an unknown reason) is a usage error, not a crash. */
async function asUsage(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TypeError) throw new UsageError(err.message);
    throw err;
  }
}

/**
 * The first Ctrl+C (or SIGTERM) stops gracefully; a second one exits at once with code 130, so a
 * stuck shutdown can always be interrupted.
 */
function onInterrupt(stop) {
  let count = 0;
  const handler = () => {
    count += 1;
    if (count > 1) {
      console.error('interrupted again: exiting now');
      process.exit(130);
    }
    stop();
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

async function main() {
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(HELP);
    return;
  }
  if (!COMMANDS.has(cmd)) throw new UsageError(`unknown command: ${cmd} (lead-engine help lists them)`);
  if (cmd === 'admin:user') {
    const [email, role] = positional();
    // "," and ";" separate the fields and entries of ADMIN_USERS: an address containing one would
    // produce an entry that stops the Admin pages from starting.
    if (!/^[^\s,;@]+@[^\s,;@]+\.[^\s,;@]+$/.test(email ?? '') || !ROLES.includes(role)) {
      throw new UsageError(`usage: lead-engine admin:user <email> <${ROLES.join('|')}>`);
    }
    const { token, entry } = newUser(email, role);
    console.log(`Give this token to ${email} privately; it is shown only once:

  ${token}
`);
    console.log(`Add this entry to ADMIN_USERS (entries are separated by ";"):

  ${entry}`);
    return;
  }
  if (cmd === 'admin:service') {
    const [name, role] = positional();
    let made;
    try {
      made = newServiceToken(name, role);
    } catch (err) {
      throw new UsageError(`usage: lead-engine admin:service <name> <${ROLES.join('|')}> (${err.message})`);
    }
    console.log(`Give this token to the platform team for ${name}, privately; it is shown only once. They send it as
"Authorization: Bearer <token>" with X-Acting-User (the person's email) and X-Acting-Role on every call:

  ${made.token}
`);
    console.log(`Add this entry to ADMIN_SERVICE_TOKENS (entries are separated by ";"):

  ${made.entry}`);
    return;
  }
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    throw new UsageError(err.message);   // a setting that cannot be used, said plainly
  }
  const spec = loadSchema();
  if (NEEDS_SECRET.has(cmd) && cfg.contactKeySecret.length < 32) {
    throw new UsageError('CONTACT_KEY_SECRET must be set to a secret of at least 32 characters, kept outside the database');
  }
  if (cmd === 'ledger:anchor' && !cfg.ledgerAnchorFile) throw new UsageError('LEDGER_ANCHOR_FILE must name the append-only file that keeps the anchors');
  if (cmd === 'suppress' || cmd === 'check') { // check the arguments before waiting on the database
    kindAndValue();
    opt('--reason');
    opt('--note');
  }
  const secret = cfg.contactKeySecret;
  if (cmd === 'admin:platform-headers') {
    // what the platform's proxy must add, for one request: to test the set-up with curl, and as a worked example
    const [email, role] = positional();
    if (!/^[^\s,;@]+@[^\s,;@]+\.[^\s,;@]+$/.test(email ?? '') || !ROLES.includes(role)) {
      throw new UsageError(`usage: lead-engine admin:platform-headers <email> <${ROLES.join('|')}> [--method GET] [--target /api/pipeline]`);
    }
    if (cfg.platformSsoSecret.length < 32) throw new UsageError('PLATFORM_SSO_SECRET must be set (at least 32 characters, shared with the platform)');
    const method = (opt('--method') ?? 'GET').toUpperCase();
    const target = opt('--target') ?? '/api/pipeline';
    if (!target.startsWith('/')) throw new UsageError('--target is the path and query the engine receives, starting with "/"');
    const h = platformHeaders(cfg.platformSsoSecret, { user: email, role, method, target });
    console.log(`Valid for ${PLATFORM_SKEW_S / 60} minutes, for ${method} ${target} only:\n`);
    console.log(`curl -X ${method} "http://${cfg.adminHost}:${cfg.adminPort}${target}" \\\n${Object.entries(h).map(([k, v]) => `  -H "${k}: ${v}"`).join(' \\\n')}`);
    return;
  }
  if (OFFLINE.has(cmd)) {
    const r = evalQc(cfg);
    console.log(JSON.stringify(r.summary, null, 1));
    if (r.summary.missed) process.exitCode = 1;
    return;
  }
  const { client, db } = await connect(cfg);
  try {
    switch (cmd) {
      case 'migrate': {
        const report = await migrate(db, spec, { rebuildIndexes: flag('--rebuild-indexes'), allowUniqueGap: flag('--allow-unique-gap') });
        console.log(`database ${cfg.dbName}: created [${report.created.join(', ')}] updated [${report.updated.join(', ')}]`);
        console.log(`indexes: ${report.indexes.created} created, ${report.indexes.unchanged} unchanged`);
        if (report.indexes.conflicts.length) {
          console.log(`index definitions that differ (re-run with --rebuild-indexes): ${report.indexes.conflicts.join(', ')}`);
        }
        if (report.indexes.extra.length) console.log(`indexes not in the schema (left alone): ${report.indexes.extra.join(', ')}`);
        if (flag('--role')) {
          try {
            console.log(`role leadEngineApp ${await ensureAppRole(db, spec)}`);
          } catch (err) {
            // Unauthorized, CommandNotFound or Atlas's own refusal: the role has to be made elsewhere.
            // Anything else (the network, a typo in the spec) is a real failure.
            if (![13, 59, 8000].includes(err?.code)) throw err;
            console.log(`could not create the role here (${err.codeName ?? err.message}). On MongoDB Atlas, create this custom role with the Administration API:`);
            console.log(JSON.stringify(atlasCustomRole(cfg.dbName, spec), null, 1));
            console.log('Elsewhere, as an admin user, run createRole with these privileges:');
            console.log(JSON.stringify(appRoleDefinition(cfg.dbName, spec).privileges, null, 1));
          }
        }
        break;
      }
      case 'status': {
        for (const name of Object.keys(spec.collections)) {
          console.log(`${name.padEnd(16)} ${String(await db.collection(name).estimatedDocumentCount()).padStart(8)}`);
        }
        console.log('jobs:', JSON.stringify(await new JobQueue(db).stats()));
        console.log('consent ledger:', JSON.stringify(await new ConsentLedger(db, { secret }).verify({ maxProblems: 20 })));
        break;
      }
      case 'jobs':
        console.log(JSON.stringify(await new JobQueue(db).stats(), null, 2));
        break;
      case 'ledger:verify':
      case 'ledger:anchor': {
        const ledger = new ConsentLedger(db, { secret });
        const anchors = cfg.ledgerAnchorFile ? readAnchors(cfg.ledgerAnchorFile) : [];
        const r = await ledger.verify({ anchors });
        const head = await ledger.head();
        console.log(JSON.stringify({ ...r, anchors: anchors.length, head }));
        if (!r.ok) {
          process.exitCode = 2;
          if (cmd === 'ledger:anchor') console.error('not anchored: the ledger does not verify');
          break;
        }
        if (cmd === 'ledger:anchor') console.log(`anchored: ${JSON.stringify(appendAnchor(cfg.ledgerAnchorFile, head))}`);
        break;
      }
      case 'suppress': {
        const [kind, value] = kindAndValue();
        const list = new SuppressionList(db, { secret });
        const r = await asUsage(() => list.add({ [kind]: value }, { reason: opt('--reason') ?? 'manual', note: opt('--note') ?? null, source: { via: 'cli' } }));
        if (r.erased) console.log(r.added ? `suppressed ${kind}; only its key is kept` : `${kind} was already suppressed; its stored address and note are now erased`);
        else console.log(r.added ? `suppressed ${kind}` : `${kind} was already suppressed`);
        break;
      }
      case 'check': {
        const [kind, value] = kindAndValue();
        const hits = await new SuppressionList(db, { secret }).check({ [kind]: value });
        console.log(hits.length ? `BLOCKED (${hits.map((h) => `${h.kind ?? 'target'}:${h.reason}`).join(', ')})` : 'allowed');
        break;
      }
      case 'admin': {
        const auth = new Auth({ users: parseUsers(cfg.adminUsers), secret: cfg.adminSecret, secureCookies: cfg.adminSecureCookies,
          serviceTokens: parseServiceTokens(cfg.adminServiceTokens), platformSecret: cfg.platformSsoSecret });
        // Deciding approvals needs the suppression list (and so the contact-key secret); without it the queue is read-only.
        const o = secret.length >= 32 ? buildOutreach(cfg, db) : null;
        if (!o) console.log('CONTACT_KEY_SECRET is not set: the approval queue is read-only');
        const server = createAdminServer({ db, auth, trustProxy: cfg.adminTrustProxy, caps: cfg.caps, monitorCfg: cfg.monitor, eventsSecret: cfg.platformEventsSecret,
          allowedOrigins: cfg.adminAllowedOrigins, signoutUrl: cfg.platformSignoutUrl, mcaInbox: cfg.mcaInbox,
          outreach: o && { queue: o.queue, cfg: o.cfg, org: o.org, suppression: o.suppression } });
        if (cfg.platformEventsSecret.length < 32) console.log('PLATFORM_EVENTS_SECRET is not set: /api/events refuses every event');
        await new Promise((resolve) => server.listen(cfg.adminPort, cfg.adminHost, resolve));
        console.log(`Admin pages on http://${cfg.adminHost}:${cfg.adminPort}/admin (${auth.users.length} user(s); sign-in by ${auth.modes.join(', ') || 'nobody yet'}; Ctrl+C to stop)`);
        await new Promise((resolve) => {
          onInterrupt(() => {
            server.close(resolve);
            server.closeIdleConnections?.();
          });
        });
        break;
      }
      case 'outreach:plan': {
        const month = opt('--month') ?? istMonth(new Date());
        if (!/^\d{4}-\d{2}$/.test(month)) throw new UsageError('--month must be YYYY-MM');
        const o = buildOutreach(cfg, db);
        console.log(JSON.stringify({ month, ...(await planOutreach(o, { month })) }, null, 1));
        break;
      }
      case 'reminders:plan': {
        const o = buildOutreach(cfg, db);
        console.log(JSON.stringify(await planReminders(o), null, 1));
        break;
      }
      case 'whatsapp:templates': {
        const wa = new WhatsAppClient({ wabaId: cfg.env.WHATSAPP_WABA_ID, token: cfg.env.WHATSAPP_TOKEN, apiVersion: cfg.outreach.whatsapp.graph_api_version });
        const local = JSON.parse(readFileSync(WA_TEMPLATES_PATH, 'utf8')).templates;
        if (flag('--submit')) {
          for (const r of await asUsage(() => submitTemplates(db, wa, local, { publicBaseUrl: cfg.publicBaseUrl, dryRun: flag('--dry-run') }))) {
            console.log(`${r.name} (${r.language}): ${r.result}${r.payload ? `\n${JSON.stringify(r.payload, null, 1)}` : ''}`);
          }
        }
        if (flag('--sync')) console.log(`synced ${await syncTemplates(db, wa)} template(s) from Meta`);
        for (const t of local) {
          const meta = await db.collection('channel_templates').findOne({ _id: `whatsapp:${t.name}:${t.language}` });
          console.log(`${t.name} (${t.language}, ${t.category}): ${meta ? `${meta.status}${meta.quality ? `, quality ${meta.quality}` : ''}, synced ${meta.synced_at.toISOString()}` : 'not on Meta yet (submit it, then --sync)'}`);
        }
        break;
      }
      case 'pages': {
        const o = buildOutreach(cfg, db);
        const server = createPublicServer({ db, tokens: o.tokens, ledger: o.ledger, suppression: o.suppression, queue: o.queue, platform: o.platform,
          cfg: o.cfg, org: o.org, secret: cfg.pageSecret, privacyUrl: cfg.privacyUrl, privacyContact: cfg.privacyContact, trustProxy: cfg.publicTrustProxy,
          voice: { cfg: o.voiceCfg, webhook: o.voiceWebhook }, confirm: o.claimConfirm,
          whatsapp: { hooks: o.whatsappHooks, appSecret: cfg.env.WHATSAPP_APP_SECRET ?? '', verifyToken: cfg.env.WHATSAPP_VERIFY_TOKEN ?? '' } });
        if (!cfg.env.WHATSAPP_APP_SECRET) console.log('WHATSAPP_APP_SECRET is not set: /hooks/whatsapp refuses every event, so STOP replies are not read');
        await new Promise((resolve) => server.listen(cfg.publicPort, cfg.publicHost, resolve));
        console.log(`Company pages on http://${cfg.publicHost}:${cfg.publicPort} for ${cfg.publicBaseUrl || '(PUBLIC_BASE_URL not set)'} (Ctrl+C to stop)`);
        await new Promise((resolve) => {
          onInterrupt(() => {
            server.close(resolve);
            server.closeIdleConnections?.();
          });
        });
        break;
      }
      case 'inbox:read': {
        const o = buildOutreach(cfg, db);
        console.log(JSON.stringify(await readMailboxes(o), null, 1));
        break;
      }
      case 'monitor': {
        const r = await runMonitor(db, { caps: cfg.caps, cfg: cfg.monitor, secret, backupDir: cfg.backupDir, outreachCfg: cfg.outreach });
        console.log(emfLine(r));
        for (const a of r.open) console.log(`${a.severity.toUpperCase().padEnd(8)} ${a.message}`);
        if (r.open.some((a) => a.severity === 'critical')) process.exitCode = 1;
        break;
      }
      case 'summary': {
        const summary = await buildSummary(db, { caps: cfg.caps, monitorCfg: cfg.monitor });
        if (!flag('--send')) {
          console.log(`Subject: ${summary.subject}\n\n${summary.text}`);
          break;
        }
        if (!cfg.summaryTo.length) throw new UsageError('SUMMARY_TO must list the team addresses (comma-separated)');
        const o = buildOutreach(cfg, db);
        const mailbox = o.mailboxes[cfg.caps.email.mailbox_ids[0]];
        const sent = await sendSummary({ summary, to: cfg.summaryTo, mailbox, transport: o.transport });
        console.log(`summary sent to ${cfg.summaryTo.length} address(es) by ${o.transport.kind}: ${sent.map((r) => r.response).join('; ')}`);
        break;
      }
      case 'results': {
        const months = await shortlistMonths(db);
        const month = opt('--month') ?? months[0] ?? istMonth(new Date());
        if (!/^\d{4}-\d{2}$/.test(month)) throw new UsageError('--month must be YYYY-MM');
        console.log(JSON.stringify({ lift: await lift(db, { month }), costs: await costs(db, { month: istMonth(new Date()), fixed: cfg.monitor.fixed_costs_inr_per_month }),
          channels: await channels(db, { caps: cfg.caps }) }, null, 1));
        break;
      }
      case 'mcp':
        await serveStdio(db);
        break;
      case 'eval:replies': {
        const o = flag('--ai') ? buildOutreach(cfg, db) : null;
        const r = await evalReplies({ llm: o?.llm ?? null, ...(flag('--real') ? { file: REAL } : {}) });
        console.log(JSON.stringify(r.summary, null, 1));
        for (const m of r.mistakes.slice(0, 20)) console.log(`  ${m.id}: expected ${m.expected}, got ${m.got} (${Math.round(m.confidence * 100)}%)  ${m.text.slice(0, 70)}`);
        break;
      }
      case 'erase': {
        const [kind, value] = positional();
        const by = opt('--by');
        if (!['email', 'phone'].includes(kind) || !value || !by) throw new UsageError('usage: lead-engine erase <email|phone> <value> --by ADMIN_EMAIL [--note N]');
        const r = await asUsage(() => erase(db, { kind, value, user: by, secret, note: opt('--note') ?? null }));
        console.log(`erased: ${JSON.stringify(r)}`);
        if (r.company_ids?.length) {
          console.log(`The vendor's raw answers for ${r.company_ids.join(', ')} still hold the address. Finish with:
  cd ../ingest && .venv/bin/python -m leadengine privacy erase-raw ${r.company_ids.join(' ')}`);
        }
        break;
      }
      case 'preflight': {
        const o = buildOutreach(cfg, db);
        const results = await preflight({ cfg, spec, db, deps: o, live: flag('--live') });
        console.log(flag('--json') ? JSON.stringify(results, null, 1) : formatPreflight(results));
        if (results.some((r) => r.status === 'fail')) process.exitCode = 1;
        break;
      }
      case 'platform:check': {
        const o = buildOutreach(cfg, db);
        const results = await platformCheck({ cfg, deps: o, notifyTo: opt('--notify-to') ?? null, llm: flag('--llm') });
        console.log(formatPreflight(results).replace(/\n\n(NOT READY|READY)[^\n]*$/, ''));
        if (results.some((x) => x.status === 'fail')) process.exitCode = 1;
        break;
      }
      case 'unsuppress': {
        const [kind, value] = positional();
        if (!['email', 'phone'].includes(kind) || !value) throw new UsageError('usage: lead-engine unsuppress <email|phone> <value> --by ADMIN_EMAIL --note N');
        console.log(JSON.stringify(await asUsage(() => unsuppress(db, { kind, value, by: opt('--by'), note: opt('--note'), secret }))));
        break;
      }
      case 'staging:seed': {
        await asUsage(async () => assertStaging(cfg.dbName));
        await migrate(db, spec);                     // a fresh staging database gets the schema first
        const r = await asUsage(() => seedStaging(db, { dbName: cfg.dbName, email: opt('--email'), phone: opt('--phone') ?? null, caps: cfg.caps, root: ROOT }));
        console.log(JSON.stringify(r, null, 1));
        console.log(`\nNow run everything for this database with the warm-up-free caps, for example:
  LEAD_DB=${cfg.dbName} CAPS_FILE=data/staging/caps.json node src/cli.js outreach:plan
  LEAD_DB=${cfg.dbName} CAPS_FILE=data/staging/caps.json node src/cli.js worker
and the checklist in ops/WEEK4_ACTIONS.md, section 4. Afterwards: LEAD_DB=${cfg.dbName} node src/cli.js staging:clear`);
        break;
      }
      case 'kb:ai-check': {
        const o = buildOutreach(cfg, db);
        const limit = Number(opt('--limit') ?? 50);
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new UsageError('--limit must be a whole number from 1 to 500');
        const r = await aiCheckPairs(db, { llm: o.llm, limit, log: (l) => console.log(`  ${l}`) });
        console.log(JSON.stringify(r));
        break;
      }
      case 'verify:email': {
        const [address] = positional();
        if (!address) throw new UsageError('usage: lead-engine verify:email <address>');
        const o = buildOutreach(cfg, db);
        const v = await o.verifier.verify(address);
        console.log(JSON.stringify(v, null, 1));
        break;
      }
      case 'approval:agreement': {
        const a = await agreement(db, { windowDays: cfg.outreach.approval?.evidence?.window_days ?? 60 });
        const s = await samplingState(db, cfg.outreach);
        console.log(JSON.stringify({ agreement: a, mode: s.mode, in_force: s.active, why: s.reason, needs: s.needs }, null, 1));
        break;
      }
      case 'backup': {
        const r = await backupDb(db, { root: cfg.backupDir, critical: flag('--critical'), secret });
        const docs = Object.values(r.collections).reduce((a, c) => a + c.count, 0);
        const bytes = Object.values(r.collections).reduce((a, c) => a + c.bytes, 0);
        console.log(`${r.kind} backup of ${r.database}: ${Object.keys(r.collections).length} collections, ${docs} documents, ${(bytes / 1024 / 1024).toFixed(1)} MB in ${r.dir}`);
        if (r.ledger_head) console.log(`consent ledger head: entry ${r.ledger_head.seq}`);
        const pruned = await pruneBackups(cfg.backupDir);
        if (pruned.removed.length) console.log(`removed ${pruned.removed.length} older backup(s)`);
        break;
      }
      case 'restore': {
        const [dir] = positional();
        const into = opt('--into');
        if (!dir || !into) throw new UsageError('usage: lead-engine restore <backup folder> --into <new database name>');
        const r = await asUsage(() => restoreDb(client, { dir: path.resolve(dir), into, spec, liveDbName: cfg.dbName, secret, log: (l) => console.log(`  ${l}`) }));
        console.log(JSON.stringify({ ok: r.ok, database: r.database, kind: r.kind, taken_at: r.taken_at, ledger: r.ledger }, null, 1));
        console.log(r.ok ? `\nRestored into ${r.database}. Check it (LEAD_DB=${r.database} node src/cli.js preflight), then follow docs/HANDOVER.md, "The database is lost".`
          : '\nThe restore does not match the backup: do not use this database.');
        if (!r.ok) process.exitCode = 1;
        break;
      }
      case 'demo:seed': {
        // a database of its own (<LEAD_DB>_demo), emptied and filled with fictional companies
        const dbName = demoDbName(cfg.dbName);
        const dcfg = demoConfig({ mongoUri: cfg.mongoUri, dbName, caps: cfg.caps, root: ROOT });
        const r = await seedDemo(client.db(dbName), { cfg: dcfg, log: (line) => console.log(line) });
        console.log(`\nSeeded ${dbName} (${r.companies} fictional companies; nothing was sent anywhere).`);
        console.log('Show it with: node src/cli.js demo:serve');
        break;
      }
      case 'demo:serve': {
        const dbName = demoDbName(cfg.dbName);
        const ddb = client.db(dbName);
        if (!(await ddb.collection('companies').estimatedDocumentCount())) throw new UsageError(`${dbName} is empty: run demo:seed first`);
        const dcfg = demoConfig({ mongoUri: cfg.mongoUri, dbName, caps: cfg.caps, root: ROOT });
        const { o } = demoOutreach(dcfg, ddb);
        const people = ['viewer', 'reviewer', 'admin'].map((role) => ({ role, ...newUser(`${role}@solutionai.demo.example`, role) }));
        // a fresh second admin, so an export can be approved during the walkthrough
        people.push({ role: 'admin (second)', ...newUser('second.admin@solutionai.demo.example', 'admin') });
        // the reviewer whose export waits for an admin: once it is approved, only she can download it
        people.push({ role: 'reviewer (Neha)', ...newUser('neha.reviewer@solutionai.demo.example', 'reviewer') });
        const auth = new Auth({ users: parseUsers(people.map((p) => p.entry).join(';')), secret: randomBytes(32).toString('hex') });
        const admin = createAdminServer({ db: ddb, auth, caps: dcfg.caps, monitorCfg: dcfg.monitor, eventsSecret: DEMO_SECRET, banner: DEMO_MARKER,
          mcaInbox: path.join(ROOT, 'data', 'demo', 'inbox'), outreach: { queue: o.queue, cfg: o.cfg, org: o.org, suppression: o.suppression } });
        const pages = createPublicServer({ db: ddb, tokens: o.tokens, ledger: o.ledger, suppression: o.suppression, queue: o.queue, platform: o.platform,
          cfg: o.cfg, org: o.org, secret: DEMO_SECRET, privacyUrl: dcfg.privacyUrl, privacyContact: dcfg.privacyContact, voice: { cfg: o.voiceCfg, webhook: o.voiceWebhook },
          // a campaign claim's confirmation email is printed here instead of sent, so the walkthrough can open it
          confirm: { send: async ({ to, token }) => { console.log(`  (demo) the confirmation email to ${to} carries http://127.0.0.1:${cfg.publicPort}/k/${token}`); return { transport: 'demo' }; } } });
        await new Promise((resolve) => admin.listen(cfg.adminPort, '127.0.0.1', resolve));
        await new Promise((resolve) => pages.listen(cfg.publicPort, '127.0.0.1', resolve));
        // an approval made during the walkthrough is "sent" (through the stand-in) within a few seconds
        const sender = setInterval(() => { drain(o, JOB_SEND, 5).catch((err) => console.error(`demo send: ${err.message}`)); }, 3000);
        const top = await ddb.collection('leads').findOne({ stage: 'shortlisted', holdout: false }, { sort: { 'shortlist.rank': 1 } });
        const pageToken = top && await o.tokens.issue({ purpose: 'company_page', companyId: top.company_id, leadId: top._id });
        console.log(`Demonstration (${dbName}): fictional data only, nothing is sent anywhere.

  Admin pages   http://127.0.0.1:${cfg.adminPort}/admin   sign in with one of these tokens (valid until you stop this):
${people.map((p) => `    ${p.role.padEnd(15)} ${p.token}`).join('\n')}
  A founder's view of a company page:  http://127.0.0.1:${cfg.publicPort}/c/${pageToken}
  The same page in Hindi (the draft, marked as such until the lawyer approves it):  http://127.0.0.1:${cfg.publicPort}/c/${pageToken}?lang=hi&preview=1

Ctrl+C to stop.`);
        await new Promise((resolve) => {
          onInterrupt(() => {
            clearInterval(sender);
            admin.close();
            pages.close(resolve);
            admin.closeIdleConnections?.();
            pages.closeIdleConnections?.();
          });
        });
        break;
      }
      case 'staging:smoke': {
        await asUsage(async () => assertStaging(cfg.dbName));
        await migrate(db, spec);
        const everyDay = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
        const buildDeps = (capsFile) => {
          const c = loadConfig({ ...cfg.env, CAPS_FILE: capsFile, LEAD_DB: cfg.dbName });
          c.outreach = { ...c.outreach, send_days_ist: everyDay };      // staging only: the test runs on any day
          return buildOutreach(c, db);
        };
        const r = await runSmoke(buildOutreach(cfg, db), { dbName: cfg.dbName, caps: cfg.caps, root: ROOT, buildDeps, log: (line) => console.log(line) });
        console.log(r.ok ? '\nThe whole email loop works.' : '\nThe email loop is not working yet: fix the first FAIL above and run it again.');
        console.log(`Inspect it in the Admin pages with LEAD_DB=${cfg.dbName}; remove it with staging:clear.`);
        if (!r.ok) process.exitCode = 1;
        break;
      }
      case 'staging:clear':
        console.log(JSON.stringify(await asUsage(() => clearStaging(db, { dbName: cfg.dbName }))));
        break;
      case 'inbox:export-labels':
        console.log(JSON.stringify(await exportLabelledReplies(db)));
        break;
      case 'worker': {
        const o = buildOutreach(cfg, db);
        const problems = sendingProblems(cfg, o);
        if (o.transport.kind === 'smtp' && problems.length) throw new UsageError(`not starting a worker that sends real email:\n  ${problems.join('\n  ')}`);
        if (problems.length) console.log(`outbox mode (nothing is sent); before switching to SMTP:\n  ${problems.join('\n  ')}`);
        const worker = new Worker(o.queue, o.handlers, { workerId: cfg.workerId });
        onInterrupt(() => {
          console.log(`stopping: finishing ${worker.inFlight.size} job(s) in hand (Ctrl+C again to quit at once)`);
          worker.stop();
        });
        console.log(`worker ${cfg.workerId} polling every 30 s for ${Object.keys(o.handlers).join(', ')}; email transport: ${o.transport.kind} (Ctrl+C to stop)`);
        await worker.run();
        break;
      }
      default:
        throw new UsageError(`unknown command: ${cmd}`);
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  if (err instanceof UsageError) {
    console.error(err.message);
    process.exit(2);
  }
  console.error(err);
  process.exit(1);
});

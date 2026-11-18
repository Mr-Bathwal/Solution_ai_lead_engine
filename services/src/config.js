import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SCHEMA_PATH = path.join(ROOT, 'schema', 'collections.json');
export const CAPS_PATH = path.join(ROOT, 'config', 'caps.json');
export const OUTREACH_PATH = path.join(ROOT, 'config', 'outreach.json');
export const LLM_PATH = path.join(ROOT, 'config', 'llm.json');
export const WA_TEMPLATES_PATH = path.join(ROOT, 'config', 'whatsapp_templates.json');
export const VOICE_PATH = path.join(ROOT, 'config', 'voice.json');
export const MONITOR_PATH = path.join(ROOT, 'config', 'monitor.json');

/** Reads KEY=VALUE lines from the repository's .env, without overriding real environment variables. */
function readDotEnv(file = path.join(ROOT, '.env')) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trimStart().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * config/caps.json, or CAPS_FILE: the warm-up-free copy `staging:seed` writes for the end-to-end run
 * on staging. CAPS_FILE is refused for any database but a "_staging" one, so the real engine can
 * never send with the warm-up skipped.
 */
function capsPath(env) {
  if (!env.CAPS_FILE) return CAPS_PATH;
  if (!/_(staging|demo)$/.test(env.LEAD_DB ?? '')) throw new Error('CAPS_FILE is only for a staging or demonstration database (LEAD_DB ending in _staging or _demo)');
  return path.resolve(ROOT, env.CAPS_FILE);
}

export function loadConfig(env = { ...readDotEnv(), ...process.env }) {
  return {
    mongoUri: env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017',
    dbName: env.LEAD_DB ?? 'solutionai_leads',
    workerId: env.WORKER_ID ?? `${os.hostname()}:${process.pid}`,
    adminUsers: env.ADMIN_USERS ?? '',
    adminSecret: env.ADMIN_SESSION_SECRET ?? '',
    adminHost: env.ADMIN_HOST ?? '127.0.0.1',
    // `||`, not `??`: an empty ADMIN_PORT= line would otherwise become port 0, a random port.
    adminPort: Number(env.ADMIN_PORT || 8790),
    adminSecureCookies: env.ADMIN_SECURE_COOKIES === '1',
    adminTrustProxy: env.ADMIN_TRUST_PROXY === '1',
    // Signing in through the platform (admin/auth.js): its proxy's signing secret, the portal's service
    // tokens ("name,max-role,sha256;..."), the portal's origin when the proxy rewrites Host, and where
    // signing out of a page reached through the platform should take the person.
    platformSsoSecret: env.PLATFORM_SSO_SECRET ?? '',
    adminServiceTokens: env.ADMIN_SERVICE_TOKENS ?? '',
    adminAllowedOrigins: (env.ADMIN_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    platformSignoutUrl: env.PLATFORM_SIGNOUT_URL ?? '',
    // Where the Admin upload page puts MCA's monthly file for the nightly run (ingest/src/leadengine/mca_inbox.py).
    mcaInbox: path.resolve(ROOT, env.MCA_INBOX || path.join('data', 'mca', 'inbox')),
    // The secret behind every contact key (suppression entries, consent contact_key). It must live
    // outside the database, so that someone holding a copy of the data cannot reverse the keys back
    // into phone numbers and addresses. At least 32 characters; checked where it is used.
    contactKeySecret: env.CONTACT_KEY_SECRET ?? '',
    // Where `ledger:anchor` appends the consent ledger's head: a path on storage that the database's
    // administrators cannot rewrite (an append-only mount, an object-locked bucket, another machine).
    ledgerAnchorFile: env.LEDGER_ANCHOR_FILE ?? '',
    // Where `backup` writes (ops/backup.js); cron copies it to BACKUP_S3_URI.
    backupDir: path.resolve(ROOT, env.BACKUP_DIR || path.join('data', 'backups')),
    caps: JSON.parse(readFileSync(capsPath(env), 'utf8')),
    // ---- Phase 3: outreach, the company pages, reminders -----------------------------------------
    outreach: JSON.parse(readFileSync(OUTREACH_PATH, 'utf8')),
    llm: JSON.parse(readFileSync(LLM_PATH, 'utf8')),
    // Where founders reach the company pages and unsubscribe links (https, behind the platform's proxy).
    publicBaseUrl: env.PUBLIC_BASE_URL ?? '',
    publicHost: env.PUBLIC_HOST ?? '127.0.0.1',
    publicPort: Number(env.PUBLIC_PORT || 8791),
    publicTrustProxy: env.PUBLIC_TRUST_PROXY === '1',
    pageSecret: env.PAGE_SECRET ?? '',
    privacyUrl: env.PRIVACY_NOTICE_URL ?? '',
    privacyContact: env.PRIVACY_CONTACT ?? '',
    // ---- Phase 4: voice, the mailboxes read back, platform events, monitoring ---------------------
    voice: JSON.parse(readFileSync(VOICE_PATH, 'utf8')),
    monitor: JSON.parse(readFileSync(MONITOR_PATH, 'utf8')),
    // The platform signs the events it sends to /api/events (sign-ups, service requests, payments).
    platformEventsSecret: env.PLATFORM_EVENTS_SECRET ?? '',
    // The team addresses for the daily summary, comma-separated.
    summaryTo: (env.SUMMARY_TO ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    // The rest (mailboxes, transport, the LLM gateway, the platform, WhatsApp, IMAP and Sarvam) is
    // read by outreach/index.js from the same merged environment, kept here once.
    env,
  };
}

export function loadSchema() {
  return JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
}

import { EmailVerifier, providerFromEnv } from './verify.js';
import { claimConfirmer } from '../public/confirm.js';
import path from 'node:path';
import { ROOT } from '../config.js';
import { ConsentLedger } from '../consent/ledger.js';
import { JobQueue } from '../jobs/queue.js';
import { SuppressionList } from '../suppression/list.js';
import { ContactBudget } from './budget.js';
import { Drafter } from './draft.js';
import { ComplianceGate } from './gate.js';
import { LlmGateway } from './llm.js';
import { PlatformClient } from './platform.js';
import { reminderHandlers } from './reminders.js';
import { outreachHandlers } from './sequence.js';
import { PageTokens } from './tokens.js';
import { mailboxesFromEnv, transportFromEnv } from './transport.js';
import { WhatsAppClient } from './whatsapp.js';
import { whatsappHooks } from './whatsapp_hooks.js';
import { imapFromEnv } from '../inbound/process.js';
import { validateVoice, voiceHandlers } from '../voice/calls.js';
import { sarvamFromEnv } from '../voice/sarvam.js';

/**
 * Everything outreach needs, built once from config/*.json and the environment (loadConfig()).
 * Nothing here sends anything by itself; the worker runs the handlers, and the gate decides.
 *
 * Environment read here (see .env.example): OUTREACH_TRANSPORT, OUTBOX_DIR, SMTP_HOST, SMTP_PORT,
 * MAILBOX_<n>_ADDRESS/NAME/TITLE/SMTP_PASSWORD, LLM_GATEWAY_URL, LLM_GATEWAY_KEY, LLM_MODEL_SMALL,
 * LLM_MODEL_STRONG, PLATFORM_API_KEY, PLATFORM_ONBOARDING_URL, PLATFORM_SIGNUP_URL,
 * PLATFORM_NOTIFY_URL, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_WABA_ID, WHATSAPP_TOKEN; and for Phase 4
 * IMAP_HOST, IMAP_PORT, MAILBOX_<n>_IMAP_PASSWORD, SARVAM_API_KEY, SARVAM_ORG_ID, SARVAM_WORKSPACE_ID,
 * SARVAM_APP_ID, SARVAM_APP_VERSION, SARVAM_CONNECTION_ID, VOICE_CALLER_NUMBER. (WHATSAPP_APP_SECRET and
 * WHATSAPP_VERIFY_TOKEN, for Meta's webhook, are read by the pages server's command.)
 */
export function buildOutreach(cfg, db, { clock = () => new Date(), log = console, fetch = globalThis.fetch, transport = null, dns = undefined } = {}) {
  const env = cfg.env ?? {};
  const o = cfg.outreach;
  const queue = new JobQueue(db);
  const suppression = new SuppressionList(db, { secret: cfg.contactKeySecret, clock });
  const ledger = new ConsentLedger(db, { secret: cfg.contactKeySecret, clock });
  const budget = new ContactBudget(db, cfg.caps, { clock });
  const mailboxes = mailboxesFromEnv(env, cfg.caps.email.mailbox_ids);
  const llm = new LlmGateway(db, { url: env.LLM_GATEWAY_URL, key: env.LLM_GATEWAY_KEY, cfg: cfg.llm, caps: cfg.caps,
    models: { small: env.LLM_MODEL_SMALL, strong: env.LLM_MODEL_STRONG }, fetch, clock });
  const outbox = env.OUTBOX_DIR || path.join(ROOT, 'data', 'outbox');
  const deps = {
    db, queue, cfg: o, caps: cfg.caps, org: o.org, mailboxes, suppression, ledger, budget, clock, log,
    drafter: new Drafter({ llm, cfg: o, org: o.org }),
    gate: new ComplianceGate({ cfg: o, caps: cfg.caps, budget, suppression, mailboxes, ledger, clock }),
    transport: transport ?? transportFromEnv(env, { root: ROOT }),
    tokens: new PageTokens(db, { days: o.page.token_days, clock }),
    platform: new PlatformClient({ onboardingUrl: env.PLATFORM_ONBOARDING_URL, notifyUrl: env.PLATFORM_NOTIFY_URL,
      signupUrl: env.PLATFORM_SIGNUP_URL || o.org.website, key: env.PLATFORM_API_KEY, fetch }),
    whatsapp: new WhatsAppClient({ phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID, wabaId: env.WHATSAPP_WABA_ID, token: env.WHATSAPP_TOKEN,
      apiVersion: o.whatsapp.graph_api_version, fetch, outboxDir: outbox }),
    publicBaseUrl: cfg.publicBaseUrl,
    pageSecret: cfg.pageSecret,
    llm,
    imap: imapFromEnv(env, mailboxes),
    voiceCfg: validateVoice(cfg.voice),
    // the address check before a first email (verify.js); needs the contact-key secret
    verifier: (cfg.contactKeySecret ?? '').length >= 32
      ? new EmailVerifier(db, { secret: cfg.contactKeySecret, provider: providerFromEnv(env), caps: cfg.caps, policy: o.verification ?? {}, fetch, clock, log, ...(dns ? { dns } : {}) })
      : null,
  };
  // the email that confirms a claim made from a campaign page (public/confirm.js); null without email set up
  deps.claimConfirm = claimConfirmer({ transport: deps.transport, mailboxes, mailboxIds: cfg.caps.email.mailbox_ids, publicBaseUrl: cfg.publicBaseUrl, org: o.org, clock });
  deps.voice = sarvamFromEnv(env, deps.voiceCfg, { fetch });
  const voice = voiceHandlers(deps);
  deps.voiceWebhook = voice.webhook;
  deps.whatsappHooks = whatsappHooks(deps);
  deps.handlers = { ...outreachHandlers(deps), ...reminderHandlers(deps), ...voice.handlers };
  return deps;
}

/**
 * Settings that must be right before a real email can leave: refuses to start a sender that would
 * put a broken or local link in front of a founder, or send from a mailbox without a sender name.
 * Returns a list of problems (empty when ready).
 */
export function sendingProblems(cfg, deps) {
  const problems = [];
  if (!/^https:\/\/[^/]+/.test(cfg.publicBaseUrl ?? '')) problems.push('PUBLIC_BASE_URL must be the https address of the company pages');
  for (const [id, mb] of Object.entries(deps.mailboxes)) {
    if (!mb.address || !mb.name) problems.push(`${id}: set ${id.toUpperCase().replace(/-/g, '_')}_ADDRESS and _NAME`);
    if (deps.transport.kind === 'smtp' && !mb.pass) problems.push(`${id}: set ${id.toUpperCase().replace(/-/g, '_')}_SMTP_PASSWORD`);
  }
  if ((cfg.pageSecret ?? '').length < 32) problems.push('PAGE_SECRET must be at least 32 characters');
  return problems;
}

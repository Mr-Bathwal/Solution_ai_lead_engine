import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sendSmtp } from './smtp.js';

/**
 * Where an approved email goes once the compliance gate lets it through.
 *
 *   outbox (the default): written as an .eml file to OUTBOX_DIR and sent to no one. Used until the
 *     outreach domain, the mailboxes and their warm-up are ready, and in every test.
 *   smtp: the mailbox's own SMTP account (Zoho Mail, design 7.6), only when OUTREACH_TRANSPORT=smtp.
 *
 * The mailboxes themselves come from the environment, never from a file in the repository:
 *   MAILBOX_1_ADDRESS, MAILBOX_1_NAME, MAILBOX_1_TITLE, MAILBOX_1_SMTP_PASSWORD (for mailbox-1), and
 *   the same with _2_ for mailbox-2; SMTP_HOST (smtp.zoho.in) and SMTP_PORT (465) are shared.
 */

/** 'mailbox-1' -> 'MAILBOX_1'. */
const envPrefix = (id) => id.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

export function mailboxesFromEnv(env, ids) {
  const out = {};
  for (const id of ids) {
    const p = envPrefix(id);
    const address = (env[`${p}_ADDRESS`] ?? '').trim();
    out[id] = {
      id,
      address: address || null,
      name: (env[`${p}_NAME`] ?? '').trim() || null,
      title: (env[`${p}_TITLE`] ?? '').trim() || null,
      user: (env[`${p}_SMTP_USER`] ?? '').trim() || address || null,
      pass: env[`${p}_SMTP_PASSWORD`] ?? '',
    };
  }
  return out;
}

export class OutboxTransport {
  constructor({ dir }) {
    this.kind = 'outbox';
    this.dir = dir;
  }

  async send({ raw, messageId, mailbox }) {
    mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${mailbox.id}-${messageId.replace(/[^A-Za-z0-9@.-]/g, '')}.eml`);
    writeFileSync(file, raw, { flag: 'wx' });
    return { transport: 'outbox', response: `written to ${file}, not sent` };
  }
}

export class SmtpTransport {
  constructor({ host = 'smtp.zoho.in', port = 465, send = sendSmtp } = {}) {
    this.kind = 'smtp';
    this.host = host;
    this.port = port;
    this.sendSmtp = send;
  }

  async send({ raw, mailbox, to }) {
    if (!mailbox.address || !mailbox.pass) throw new Error(`${mailbox.id} has no address or SMTP password configured`);
    const r = await this.sendSmtp({ host: this.host, port: this.port, user: mailbox.user, pass: mailbox.pass, from: mailbox.address, to, raw });
    return { transport: 'smtp', response: `${r.code} ${r.response}` };
  }
}

export function transportFromEnv(env, { root }) {
  const kind = (env.OUTREACH_TRANSPORT ?? 'outbox').trim();
  if (kind === 'smtp') return new SmtpTransport({ host: env.SMTP_HOST || 'smtp.zoho.in', port: Number(env.SMTP_PORT || 465) });
  if (kind !== 'outbox') throw new Error(`OUTREACH_TRANSPORT must be outbox or smtp, not ${kind}`);
  return new OutboxTransport({ dir: env.OUTBOX_DIR || path.join(root, 'data', 'outbox') });
}

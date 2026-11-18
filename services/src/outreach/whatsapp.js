import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * WhatsApp through Meta's Cloud API directly (design 7.6): utility templates only, only to numbers
 * that opted in on the company page. The templates are defined in config/whatsapp_templates.json;
 * what Meta says about each one (approved, paused, its quality rating) is read into
 * channel_templates by syncTemplates(), and a template is sent only while Meta has it APPROVED, so a
 * paused template stops every send at once.
 *
 * Without WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_TOKEN nothing is sent: the message is written to the
 * outbox as a JSON line instead, so the whole flow can be tested before Meta verification is done.
 */

const GRAPH = 'https://graph.facebook.com';

export class WhatsAppClient {
  constructor({ phoneNumberId = '', wabaId = '', token = '', apiVersion = 'v21.0', fetch = globalThis.fetch, outboxDir = null, timeoutMs = 15_000 } = {}) {
    this.phoneNumberId = phoneNumberId;
    this.wabaId = wabaId;
    this.token = token;
    this.apiVersion = apiVersion;
    this.fetch = fetch;
    this.outboxDir = outboxDir;
    this.timeoutMs = timeoutMs;
  }

  get configured() {
    return Boolean(this.phoneNumberId && this.token);
  }

  async #call(method, url, body) {
    const res = await this.fetch(url, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = json?.error ?? {};
      const err = new Error(`WhatsApp API ${res.status}: ${e.message ?? 'error'}`);
      err.status = res.status;
      err.metaCode = e.code ?? null;
      throw err;
    }
    return json;
  }

  /**
   * Sends a template message. `to` is an E.164 number (+91...). `bodyParams` fill {{1}}, {{2}}...;
   * `buttonSuffix` fills the URL button's {{1}}. Returns { id, dry_run }.
   */
  async sendTemplate({ to, name, language, bodyParams = [], buttonSuffix = null }) {
    const components = [];
    if (bodyParams.length) components.push({ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text: String(text) })) });
    if (buttonSuffix) components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: buttonSuffix }] });
    const payload = { messaging_product: 'whatsapp', to: to.replace(/^\+/, ''), type: 'template', template: { name, language: { code: language }, components } };
    if (!this.configured) {
      if (this.outboxDir) {
        mkdirSync(this.outboxDir, { recursive: true });
        appendFileSync(path.join(this.outboxDir, 'whatsapp.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...payload, to: '(redacted)' })}\n`);
      }
      return { id: null, dry_run: true };
    }
    const r = await this.#call('POST', `${GRAPH}/${this.apiVersion}/${this.phoneNumberId}/messages`, payload);
    return { id: r?.messages?.[0]?.id ?? null, dry_run: false };
  }

  /**
   * A plain text reply. Meta allows it only within 24 hours of the person's own last message, so it
   * is used only to answer one: the confirmation after STOP. Returns { id, dry_run }.
   */
  async sendText({ to, text }) {
    const payload = { messaging_product: 'whatsapp', to: to.replace(/^\+/, ''), type: 'text', text: { body: String(text).slice(0, 1000) } };
    if (!this.configured) {
      if (this.outboxDir) {
        mkdirSync(this.outboxDir, { recursive: true });
        appendFileSync(path.join(this.outboxDir, 'whatsapp.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...payload, to: '(redacted)' })}\n`);
      }
      return { id: null, dry_run: true };
    }
    const r = await this.#call('POST', `${GRAPH}/${this.apiVersion}/${this.phoneNumberId}/messages`, payload);
    return { id: r?.messages?.[0]?.id ?? null, dry_run: false };
  }

  /** Every template on the WhatsApp Business account, with Meta's status and quality rating. */
  async listTemplates() {
    if (!this.wabaId || !this.token) throw new Error('WHATSAPP_WABA_ID and WHATSAPP_TOKEN are needed to read the templates');
    const out = [];
    let url = `${GRAPH}/${this.apiVersion}/${this.wabaId}/message_templates?fields=id,name,status,language,category,quality_score&limit=100`;
    for (let page = 0; url && page < 20; page += 1) {
      const r = await this.#call('GET', url);
      out.push(...(r?.data ?? []));
      url = r?.paging?.next ?? null;
    }
    return out;
  }

  /** Submits one template for Meta's review. Returns { id, status, category }. */
  async createTemplate(payload) {
    if (!this.wabaId || !this.token) throw new Error('WHATSAPP_WABA_ID and WHATSAPP_TOKEN are needed to submit templates');
    return this.#call('POST', `${GRAPH}/${this.apiVersion}/${this.wabaId}/message_templates`, payload);
  }
}

const EXAMPLE_HOST = 'https://pages.example.in';

/**
 * A template from config/whatsapp_templates.json in the exact shape Meta takes: only name,
 * language, category and components; the placeholder host in URL buttons replaced by the pages'
 * real address; and each URL button's example made a full URL, as Meta requires.
 */
export function metaTemplate(t, publicBaseUrl) {
  const base = String(publicBaseUrl ?? '').replace(/\/+$/, '');
  if (!/^https:\/\/[^/]+$/.test(base)) throw new TypeError('PUBLIC_BASE_URL must be the https address of the company pages (no path) before templates are submitted');
  const components = structuredClone(t.components).map((c) => {
    if (c.type !== 'BUTTONS') return c;
    return { ...c, buttons: c.buttons.map((b) => {
      if (b.type !== 'URL') return b;
      const url = b.url.replace(EXAMPLE_HOST, base);
      const fill = url.split('{{1}}')[0];
      return { ...b, url, ...(b.example ? { example: b.example.map((e) => (/^https?:\/\//.test(e) ? e.replace(EXAMPLE_HOST, base) : `${fill}${e}`)) } : {}) };
    }) };
  });
  return { name: t.name, language: t.language, category: t.category, components };
}

/**
 * Submits every template Meta does not have yet (`lead-engine whatsapp:templates --submit`), and
 * records each as PENDING in channel_templates until `--sync` reads Meta's decision. A template
 * already known to Meta is left alone: editing an approved template is done in WhatsApp Manager.
 * Returns one line per template.
 */
export async function submitTemplates(db, client, templates, { publicBaseUrl, dryRun = false, clock = () => new Date() }) {
  const out = [];
  for (const t of templates) {
    const id = `whatsapp:${t.name}:${t.language}`;
    const known = await db.collection('channel_templates').findOne({ _id: id });
    if (known && known.status !== 'REJECTED') {
      out.push({ name: t.name, language: t.language, result: `already at Meta (${known.status})` });
      continue;
    }
    const payload = metaTemplate(t, publicBaseUrl);
    if (dryRun) {
      out.push({ name: t.name, language: t.language, result: 'would submit', payload });
      continue;
    }
    try {
      const r = await client.createTemplate(payload);
      await db.collection('channel_templates').updateOne({ _id: id }, { $set: { channel: 'whatsapp', name: t.name, language: t.language,
        category: r.category ?? t.category, status: String(r.status ?? 'PENDING'), quality: null, meta_id: r.id ? String(r.id) : null, reason: null, synced_at: clock() } }, { upsert: true });
      out.push({ name: t.name, language: t.language, result: `submitted (${r.status ?? 'PENDING'})` });
    } catch (err) {
      out.push({ name: t.name, language: t.language, result: `refused: ${err.message}` });
    }
  }
  return out;
}

/** Reads Meta's view of every template into channel_templates. Returns how many were stored. */
export async function syncTemplates(db, client, { clock = () => new Date() } = {}) {
  const now = clock();
  let n = 0;
  for (const t of await client.listTemplates()) {
    if (!/^[a-z0-9_]+$/.test(t.name ?? '') || !/^[a-zA-Z_]+$/.test(t.language ?? '')) continue;
    await db.collection('channel_templates').replaceOne({ _id: `whatsapp:${t.name}:${t.language}` }, {
      _id: `whatsapp:${t.name}:${t.language}`, channel: 'whatsapp', name: t.name, language: t.language, category: t.category ?? null,
      status: String(t.status ?? 'UNKNOWN'), quality: t.quality_score?.score ?? null, meta_id: t.id ? String(t.id) : null, synced_at: now,
    }, { upsert: true });
    n += 1;
  }
  return n;
}

/** Whether Meta has this template approved, as of the last sync. */
export async function templateApproved(db, name, language) {
  const t = await db.collection('channel_templates').findOne({ _id: `whatsapp:${name}:${language}` });
  return t?.status === 'APPROVED';
}

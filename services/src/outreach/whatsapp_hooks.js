import { createHmac, timingSafeEqual } from 'node:crypto';
import { classifyByRules, classifyReply } from '../inbound/classify.js';
import { normalizePhone } from '../util/normalize.js';
import { knownNames } from '../inbound/process.js';

/**
 * Meta's webhook for the WhatsApp number (design 7.6), POSTed to /hooks/whatsapp on the pages server:
 *
 *   a message from a founder   "STOP" (or "unsubscribe", "बंद करें", "band karo"...) withdraws every
 *                              WhatsApp consent for that number in the ledger at once, cancels the
 *                              reminders already queued, and answers with a one-line confirmation, as
 *                              every template and the claim form promise. Anything else waits for a
 *                              person in the Admin inbox, like an email reply.
 *   a status of our message    delivered is recorded; failed is recorded with Meta's reason
 *   a template's status        a paused, disabled or rejected template stops being sent at once (the
 *                              sender checks channel_templates before every message), and the monitor
 *                              raises an alert; quality changes are recorded the same way
 *
 * Every POST is checked against X-Hub-Signature-256, the HMAC of the raw body under the app secret
 * (WHATSAPP_APP_SECRET); Meta's subscription check (GET) must carry WHATSAPP_VERIFY_TOKEN. Each
 * message is handled once, keyed on its id, whatever Meta redelivers.
 */

const DAY = 86_400_000;
const STOP_RX = /^\s*(stop( all)?|unsubscribe|cancel|end|quit|opt[\s-]?out|band( karo| kar do| karein)?|बंद( करें| करो| कर दें)?|रोकें|रोको)\s*[.!।]*\s*$/i;
const WA_PURPOSES = ['deadline_reminders', 'service_updates', 'scheme_alerts', 'marketing'];
const STATUS_OF = { FIRST_PAUSE: 'PAUSED', SECOND_PAUSE: 'PAUSED', PAUSED: 'PAUSED', UNPAUSE: 'APPROVED', REINSTATED: 'APPROVED' };
const CONFIRM = {
  en: 'Done: you will not get WhatsApp reminders from SolutionAI any more.',
  hi: 'ठीक है: अब आपको SolutionAI से WhatsApp पर रिमाइंडर नहीं मिलेंगे।',
};

/** Meta's subscription check: the challenge to echo back, or null. */
export function verifyChallenge(params, verifyToken) {
  if (!verifyToken || verifyToken.length < 16) return null;
  const token = params.get('hub.verify_token') ?? '';
  const ok = params.get('hub.mode') === 'subscribe' && token.length === verifyToken.length && timingSafeEqual(Buffer.from(token), Buffer.from(verifyToken));
  return ok ? params.get('hub.challenge') ?? '' : null;
}

/** True when X-Hub-Signature-256 is the HMAC of the raw body under the app secret. */
export function verifyMetaSignature(appSecret, rawBody, header) {
  if (!appSecret || typeof header !== 'string') return false;
  const m = /^sha256=([0-9a-f]{64})$/.exec(header.trim());
  if (!m) return false;
  return timingSafeEqual(Buffer.from(createHmac('sha256', appSecret).update(rawBody).digest('hex')), Buffer.from(m[1]));
}

const textOf = (msg) => msg?.text?.body ?? msg?.button?.text ?? msg?.interactive?.button_reply?.title ?? msg?.interactive?.list_reply?.title ?? '';

async function insertOnce(db, collection, doc) {
  try {
    await db.collection(collection).insertOne(doc);
    return true;
  } catch (err) {
    if (err?.code === 11000) return false;
    throw err;
  }
}

export function whatsappHooks(deps) {
  const { db, ledger, whatsapp, queue, cfg, clock = () => new Date(), log = console } = deps;

  async function personFor(phone) {
    return db.collection('people').findOne({ 'contacts.address': phone });
  }

  async function stop(msg, phone, person, text) {
    const now = clock();
    let withdrawn = 0;
    for (const purpose of WA_PURPOSES) {
      const s = await ledger.statusForAddress({ channel: 'whatsapp', address: phone, purpose });
      if (!s.granted) continue;
      await ledger.withdraw({ subject: s.entry.subject, channel: 'whatsapp', purpose, address: phone, wording: `Replied "${text.trim().slice(0, 40)}" on WhatsApp.`,
        wordingVersion: 'whatsapp-stop-v1', capturedVia: 'whatsapp_reply', proof: { wamid: msg.id, timestamp: msg.timestamp ?? null }, recordedBy: 'whatsapp_webhook' });
      withdrawn += 1;
    }
    const companyId = person?.company_ids?.[0] ?? null;
    await insertOnce(db, 'activities', { at: now, type: 'unsubscribed', channel: 'whatsapp', company_id: companyId, lead_id: null, holdout: false,
      idem_key: `unsubscribed:wa:${msg.id}`, data: { person_id: person?._id ?? null, via: 'whatsapp_stop', withdrawn } });
    if (person && queue) {
      const pending = await db.collection('jobs').find({ type: { $in: ['reminder.send', 'whatsapp.confirm'] }, status: 'pending', 'payload.person_id': String(person._id),
        $or: [{ 'payload.channel': 'whatsapp' }, { type: 'whatsapp.confirm' }] }, { projection: { idem_key: 1 } }).toArray();
      for (const j of pending) await queue.cancel(j.idem_key, 'the founder replied STOP on WhatsApp');
    }
    // inside the 24 hours Meta allows after the founder's own message; a failure here changes nothing above
    try {
      await whatsapp.sendText({ to: phone, text: /[ऀ-ॿ]/.test(text) ? CONFIRM.hi : CONFIRM.en });
    } catch (err) {
      log.warn?.(`[whatsapp] the STOP confirmation was not sent: ${err.message}`);
    }
    return withdrawn;
  }

  async function message(msg, contacts) {
    const phone = normalizePhone(`+${String(msg.from ?? '').replace(/^\+/, '')}`);
    if (!phone || !msg.id) return 'skipped';
    const text = textOf(msg);
    const person = await personFor(phone);
    const now = clock();
    const idem = `in:whatsapp:${msg.id}`;
    if (await db.collection('inbound').findOne({ idem_key: idem }, { projection: { _id: 1 } })) return 'duplicate';
    const isStop = STOP_RX.test(text) || (classifyByRules({ text }).label === 'unsubscribe' && classifyByRules({ text }).confidence >= 0.8);
    const classification = isStop ? { label: 'unsubscribe', confidence: 1, by: 'rules', model: null, version: 'whatsapp-stop-v1', reasons: ['STOP on WhatsApp'] }
      : await classifyReply({ subject: '', text }, { llm: deps.llm, companyId: person?.company_ids?.[0] ?? null,
        // the sender's WhatsApp profile name and the people the engine knows at the company never reach the AI
        names: [...(await knownNames(db, person?.company_ids?.[0] ?? null, contacts?.[0]?.profile?.name ?? null)), person?.name].filter(Boolean) });
    const doc = {
      idem_key: idem, channel: 'whatsapp', mailbox: 'whatsapp', header_message_id: msg.id, in_reply_to: msg.context?.id ?? null, references: null,
      from: { address: phone, name: contacts?.[0]?.profile?.name ? String(contacts[0].profile.name).slice(0, 80) : null }, subject: null,
      kind: 'reply', label: classification.label,
      classification: { label: classification.label, confidence: classification.confidence, by: classification.by, model: classification.model ?? null,
        version: classification.version ?? null, reasons: classification.reasons ?? [] },
      matched: { message_id: null, company_id: person?.company_ids?.[0] ?? null, lead_id: null, how: person ? 'address' : 'none' },
      dsn: null, text: text.slice(0, 4000) || `(a ${msg.type ?? 'non-text'} message)`, status: 'new', actions: [], handled: null,
      received_at: msg.timestamp ? new Date(Number(msg.timestamp) * 1000) : now, erased_at: null,
      expires_at: new Date(now.getTime() + (cfg.inbound?.retention_days ?? 400) * DAY), created_at: now, updated_at: now,
    };
    if (!(await insertOnce(db, 'inbound', doc))) return 'duplicate';
    const actions = [];
    let status = 'needs_person';
    if (isStop) {
      const n = await stop(msg, phone, person, text);
      actions.push(`withdrew ${n} WhatsApp consent(s) and cancelled the queued reminders; a confirmation was sent`);
      status = 'done';
    } else {
      if (person) {
        await insertOnce(db, 'activities', { at: now, type: 'replied', channel: 'whatsapp', company_id: person.company_ids?.[0] ?? null, lead_id: null, holdout: false,
          idem_key: `replied:wa:${msg.id}`, data: { person_id: person._id, label: classification.label, inbound_idem: idem } });
      }
      actions.push(person ? 'waiting for a person' : 'from a number the engine does not know: waiting for a person');
    }
    await db.collection('inbound').updateOne({ idem_key: idem }, { $set: { status, actions, updated_at: clock() } });
    return isStop ? 'stop' : 'reply';
  }

  async function status(st) {
    const now = clock();
    if (!st?.id) return;
    const sent = await db.collection('activities').findOne({ type: 'sent', channel: 'whatsapp', 'data.provider_id': st.id });
    const base = { at: st.timestamp ? new Date(Number(st.timestamp) * 1000) : now, channel: 'whatsapp', company_id: sent?.company_id ?? null,
      lead_id: sent?.lead_id ?? null, holdout: false };
    if (st.status === 'delivered') {
      await insertOnce(db, 'activities', { ...base, type: 'delivered', idem_key: `delivered:wa:${st.id}`, data: { provider_id: st.id } });
    } else if (st.status === 'failed') {
      const e = st.errors?.[0] ?? {};
      // a note, not a bounce: a failed WhatsApp reminder must not stop email to the company
      await insertOnce(db, 'activities', { ...base, type: 'note', idem_key: `failed:wa:${st.id}`,
        data: { kind: 'whatsapp_failed', provider_id: st.id, code: e.code ?? null, title: e.title ? String(e.title).slice(0, 200) : null } });
    }
  }

  async function template(field, v) {
    const now = clock();
    const name = v?.message_template_name;
    const lang = v?.message_template_language;
    const query = name && lang ? { _id: `whatsapp:${name}:${lang}` } : v?.message_template_id ? { meta_id: String(v.message_template_id) } : null;
    if (!query) return;
    if (field === 'message_template_status_update') {
      const event = String(v.event ?? 'UNKNOWN').toUpperCase();
      const set = { status: STATUS_OF[event] ?? event, reason: v.reason ? String(v.reason).slice(0, 300) : null, synced_at: now };
      if (query._id) {
        await db.collection('channel_templates').updateOne(query, { $set: set, $setOnInsert: { channel: 'whatsapp', name, language: lang, category: v.message_template_category ?? null,
          quality: null, meta_id: v.message_template_id ? String(v.message_template_id) : null } }, { upsert: true });
      } else {
        await db.collection('channel_templates').updateOne(query, { $set: set });
      }
    } else if (field === 'message_template_quality_update') {
      await db.collection('channel_templates').updateOne(query, { $set: { quality: v.new_quality_score ? String(v.new_quality_score) : null, synced_at: now } });
    }
  }

  /** Handles one webhook body. Returns counts of what it saw. */
  async function handle(payload) {
    const out = { stop: 0, reply: 0, duplicate: 0, statuses: 0, templates: 0 };
    if (payload?.object !== 'whatsapp_business_account') return out;
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const v = change.value ?? {};
        if (change.field === 'messages') {
          for (const msg of v.messages ?? []) {
            const r = await message(msg, v.contacts);
            if (out[r] !== undefined) out[r] += 1;
          }
          for (const st of v.statuses ?? []) {
            await status(st);
            out.statuses += 1;
          }
        } else if (change.field === 'message_template_status_update' || change.field === 'message_template_quality_update') {
          await template(change.field, v);
          out.templates += 1;
        }
      }
    }
    return out;
  }

  return { handle };
}

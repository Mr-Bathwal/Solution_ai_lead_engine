import { createHmac, timingSafeEqual } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { contactKey } from '../consent/ledger.js';
import { DeferError } from '../jobs/worker.js';
import { displayName, formatDate, istDate } from '../outreach/evidence.js';
import { Meter, istMonth } from '../outreach/meter.js';
import { VoiceUnavailable } from './sarvam.js';

/**
 * Call backs by the AI voice agent (design 7.6), only for founders who asked for one:
 *
 *   the claim form: a founder ticks "call me back", with a mobile number, a time of day and a
 *     language; the consent (voice, callback) goes to the ledger with its exact words, and
 *     queueCallback() queues a voice.call job for the next calling window.
 *   voice.call: the call gate, then the call. In order:
 *     1. consent still granted, the number not suppressed;
 *     2. the agent is live: enabled in config/voice.json, the provider configured, the caller number a
 *        DLT 140- or 1600-series number, the script signed off and saying it is an AI from SolutionAI;
 *     3. inside the founder's chosen time, inside the calling window (never outside TRAI's 09:00 to
 *        21:00), on a calling day (otherwise: wait);
 *     4. a unit of the month's call cap and the longest call's minutes reserved.
 *     A refusal in 2 or 4 does not leave the founder waiting: the call is marked for a person to
 *     make, and the Admin Calls page lists it. Then the call is placed once; a request that got no
 *     answer is marked 'unknown' and never placed again by itself.
 *   the webhook (POST /hooks/voice/sarvam on the pages server): the outcome, checked against the HMAC
 *     the engine put in the call's metadata; minutes and cost settled; a 'call_completed' activity;
 *     no answer or busy -> one more attempt the next day; "stop" -> the consent is withdrawn.
 */

export const JOB_CALL = 'voice.call';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const FINAL = new Set(['connected', 'no_answer', 'busy', 'failed', 'blocked', 'cancelled', 'unknown']);

const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const ist = (at) => {
  const d = new Date(at.getTime() + 5.5 * HOUR);
  return { day: d.toISOString().slice(0, 10), weekday: WEEKDAYS[d.getUTCDay()], minute: d.getUTCHours() * 60 + d.getUTCMinutes() };
};
const atIst = (day, hhmm) => new Date(`${day}T${hhmm}:00+05:30`);

/**
 * Checks config/voice.json and throws one TypeError naming every problem: above all that no window
 * reaches outside TRAI's permitted hours.
 */
export function validateVoice(cfg) {
  const problems = [];
  const hhmm = (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
  const range = (r) => Array.isArray(r) && r.length === 2 && hhmm(r[0]) && hhmm(r[1]) && minutes(r[0]) < minutes(r[1]);
  const [tFrom, tTo] = range(cfg?.trai_window_ist) ? cfg.trai_window_ist.map(minutes) : [9 * 60, 21 * 60];
  if (tFrom < 9 * 60 || tTo > 21 * 60) problems.push('trai_window_ist must stay inside 09:00 to 21:00 IST');
  const inside = (r) => range(r) && minutes(r[0]) >= tFrom && minutes(r[1]) <= tTo;
  if (!inside(cfg?.window_ist)) problems.push('window_ist must be ["HH:MM", "HH:MM"] inside trai_window_ist');
  for (const [name, r] of Object.entries(cfg?.slots ?? {})) if (!inside(r)) problems.push(`slots.${name} must be inside trai_window_ist`);
  if (!Array.isArray(cfg?.call_days_ist) || !cfg.call_days_ist.length || !cfg.call_days_ist.every((d) => WEEKDAYS.includes(d))) problems.push('call_days_ist must list days as Mon..Sun');
  for (const k of ['max_attempts', 'max_call_seconds', 'price_paise_per_minute', 'retry_after_hours', 'retention_days']) {
    if (!Number.isInteger(cfg?.[k]) || cfg[k] < 1) problems.push(`${k} must be a whole number of at least 1`);
  }
  if (cfg?.max_call_seconds > 600) problems.push('max_call_seconds must be at most 600');
  if (problems.length) throw new TypeError(`config/voice.json is not valid: ${problems.join('; ')}`);
  return cfg;
}

/** Why the script may not be used yet, or null when it is signed off and says what it must. */
export function scriptProblem(cfg) {
  const s = cfg.script ?? {};
  if (!s.approved_by || !/^\d{4}-\d{2}-\d{2}$/.test(s.approved_on ?? '')) return 'the call script is not signed off (script.approved_by and approved_on in config/voice.json)';
  for (const lang of ['en', 'hi']) {
    const line = s.opening?.[lang] ?? '';
    // whole words: "SolutionAI" must not count as saying "AI"
    const missing = (s.must_say ?? []).filter((w) => !new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(line));
    if (!line || missing.length) return `the ${lang} opening line must say ${missing.join(' and ') || 'something'}`;
  }
  return null;
}

/** The next moment at or after `now` inside the founder's slot and the calling window, on a calling day. */
export function nextCallWindow(now, cfg, slot = 'any') {
  const [sFrom, sTo] = cfg.slots?.[slot] ?? cfg.window_ist;
  const from = Math.max(minutes(sFrom), minutes(cfg.window_ist[0]));
  const to = Math.min(minutes(sTo), minutes(cfg.window_ist[1]));
  const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  for (let i = 0; i < 14; i += 1) {
    const p = ist(new Date(now.getTime() + i * DAY));
    if (!cfg.call_days_ist.includes(p.weekday)) continue;
    if (i === 0) {
      if (p.minute < from) return atIst(p.day, fmt(from));
      if (p.minute < to - 5) return now;            // never start a call in the last five minutes of the window
      continue;
    }
    return atIst(p.day, fmt(from));
  }
  throw new Error('no calling day in the next two weeks: check call_days_ist');
}

/** Queues the first attempt of a call back. Returns the enqueue result. */
export function queueCallback(queue, { companyId, leadId = null, personId, slot = 'any', language = 'hi', cfg, clock = () => new Date() }) {
  return queue.enqueue({ type: JOB_CALL, idemKey: `call:${companyId}:${personId}:1`, leadId, step: 'call', dueAt: nextCallWindow(clock(), cfg, slot),
    payload: { company_id: companyId, person_id: String(personId), slot, language, attempt: 1 } });
}

const sign = (secret, callId) => createHmac('sha256', secret).update(`voice-call:${callId}`).digest('hex');

/**
 * The job handler and the webhook. `deps`: { db, queue, ledger, suppression, voice (SarvamClient),
 * voiceCfg, caps, publicBaseUrl, pageSecret, clock, log }.
 */
export function voiceHandlers(deps) {
  const { db, ledger, suppression, voiceCfg: cfg, caps, clock = () => new Date() } = deps;
  const meter = new Meter(db, { clock });
  const calls = db.collection('calls');
  const callCap = caps.monthly?.voice_calls ?? 0;
  const minuteCap = caps.monthly?.voice_minutes ?? 0;
  const maxMinutes = Math.ceil(cfg.max_call_seconds / 60);

  async function note(id, status, set = {}, why = null) {
    const now = clock();
    return calls.findOneAndUpdate({ _id: id }, { $set: { status, updated_at: now, ...set }, $push: { history: { at: now, status, note: why } } }, { returnDocument: 'after' });
  }

  /** The live-agent checks: null when the agent may call, otherwise the reason a person must. */
  function agentProblem() {
    if (!cfg.enabled) return 'the AI voice agent is switched off (enabled: false in config/voice.json) until the DLT registration is through';
    if (!deps.voice?.configured) return 'the voice provider is not configured (SARVAM_* and VOICE_CALLER_NUMBER)';
    if (!new RegExp(cfg.caller_number_pattern).test(String(deps.voice.callerNumber).replace(/[\s-]/g, ''))) {
      return 'the caller number is not a DLT-registered 140- or 1600-series number';
    }
    if (!/^https:\/\//.test(deps.publicBaseUrl ?? '')) return 'PUBLIC_BASE_URL must be https for the call outcome to come back';
    if ((deps.pageSecret ?? '').length < 32) return 'PAGE_SECRET must be set: it signs each call so its outcome can be trusted';
    return scriptProblem(cfg);
  }

  async function callStep(job) {
    const { company_id: cid, person_id: pid, slot = 'any', language = 'hi', attempt = 1 } = job.payload;
    const now = clock();
    const person = await db.collection('people').findOne({ _id: new ObjectId(pid) });
    const contact = (person?.contacts ?? []).find((c) => c.channel === 'voice' && c.legal_basis === 'consent');
    const idem = `call:${cid}:${pid}:${attempt}`;
    const base = { idem_key: idem, company_id: cid, lead_id: job.lead_id ?? null, person_id: new ObjectId(pid), purpose: 'callback',
      to: contact?.address ?? null, contact_key: contact ? contactKey(ledger.secret, 'voice', contact.address) : null, language, slot, attempt,
      provider: cfg.provider, provider_attempt_id: null, script_version: cfg.script?.version ?? null, agent_variables: null, gate: null, placed_at: null,
      ended_at: null, duration_s: null, outcome: null, transcript: null, failure_reason: null, cost_paise: null, history: [],
      erased_at: null, expires_at: new Date(now.getTime() + cfg.retention_days * DAY), created_at: now, updated_at: now };
    let call = await calls.findOne({ idem_key: idem });
    if (call?.status === 'placing') {
      // a worker died while handing the call over: it may have been placed, so it is never placed again
      await note(call._id, 'unknown', { failure_reason: 'the call request was interrupted' }, 'check in the Sarvam dashboard whether this call went out');
      return { status: 'unknown' };
    }
    if (call && call.status !== 'queued') return { skipped: `call is ${call.status}` };   // never placed twice
    if (!call) {
      try {
        call = { ...base, status: 'queued', _id: (await calls.insertOne({ ...base, status: 'queued' })).insertedId };
      } catch (err) {
        if (err?.code !== 11000) throw err;
        return { skipped: 'another worker has this call' };
      }
    }
    const stop = async (why) => { await note(call._id, 'cancelled', {}, why); return { status: 'cancelled', why }; };
    const forPerson = async (code, why) => {
      await note(call._id, 'blocked', { gate: { at: now, code, reasons: [why] } }, why);
      return { status: 'blocked', code };
    };

    if (!contact) return stop('no number with consent for a call back');
    const consent = await ledger.statusForAddress({ channel: 'voice', address: contact.address, purpose: 'callback' });
    if (!consent.granted) return stop('the consent for a call back is not (or no longer) granted');
    if ((await suppression.check({ phone: contact.address })).length) return stop('the number is on the suppression list');
    const problem = agentProblem();
    if (problem) return forPerson('agent_not_live', `${problem}: a person should make this call`);
    const ready = nextCallWindow(now, cfg, slot);
    if (ready > now) {
      await calls.updateOne({ _id: call._id }, { $set: { gate: { at: now, code: 'window', reasons: ['outside the calling window'], until: ready }, updated_at: now } });
      throw new DeferError('outside the calling window', ready);
    }
    const month = istMonth(now);
    if (!(await meter.take({ meter: 'voice_calls', period: month, amount: 1, cap: callCap }))) {
      return forPerson('call_cap', `the month's ${callCap} AI calls are used: a person should make this call`);
    }
    if (!(await meter.take({ meter: 'voice_minutes', period: month, amount: maxMinutes, cap: minuteCap }))) {
      await meter.settle({ meter: 'voice_calls', period: month, reserved: 1, actual: 0 });
      return forPerson('minute_cap', `the month's ${minuteCap} AI call minutes are used: a person should make this call`);
    }

    const [company, lead] = await Promise.all([db.collection('companies').findOne({ _id: cid }), db.collection('leads').findOne({ company_id: cid })]);
    const name = displayName(company);
    const confirmed = lead?.needs?.rules_confirmed === true;
    const today = istDate(now);
    const nextDates = confirmed ? (lead.needs.deadlines ?? []).filter((d) => ['due_soon', 'upcoming'].includes(d.status) && d.due >= today).slice(0, 3)
      .map((d) => `${d.title}${/\d/.test(d.form ?? '') && !/no MCA/i.test(d.form) ? ` (${d.form})` : ''} by ${formatDate(d.due, language)}`) : [];
    const schemes = confirmed ? (lead.needs.schemes ?? []).filter((s) => ['eligible', 'check_required'].includes(s.verdict)).slice(0, 2).map((s) => s.name) : [];
    const variables = {
      call_id: String(call._id), company_name: name, contact_name: String(person.name ?? '').split(/\s+/)[0] || null, language,
      next_dates: nextDates.join('; ') || 'not confirmed yet: offer to send them once they are', schemes: schemes.join('; ') || null,
      max_seconds: cfg.max_call_seconds, brief: cfg.script.agent_brief, script_version: cfg.script.version,
    };
    const opening = cfg.script.opening[language].replaceAll('{company}', name);
    await note(call._id, 'placing', { agent_variables: variables, gate: { at: now, code: 'ok', reasons: ['consent, number, agent, window and caps checked'] } });
    try {
      const r = await deps.voice.call({ to: contact.address, language, opening, variables,
        webhookUrl: `${deps.publicBaseUrl.replace(/\/+$/, '')}/hooks/voice/sarvam`, metadata: { call_id: String(call._id), sig: sign(deps.pageSecret, String(call._id)) } });
      await note(call._id, 'placed', { provider_attempt_id: r.attemptId, placed_at: clock() });
      return { status: 'placed', attempt_id: r.attemptId };
    } catch (err) {
      if (!(err instanceof VoiceUnavailable)) throw err;
      if (err.placed) {
        await note(call._id, 'unknown', { failure_reason: err.message }, 'the call may have been placed; it will not be placed again by itself');
        return { status: 'unknown' };
      }
      await meter.settle({ meter: 'voice_calls', period: month, reserved: 1, actual: 0 });
      await meter.settle({ meter: 'voice_minutes', period: month, reserved: maxMinutes, actual: 0 });
      await note(call._id, 'failed', { failure_reason: err.message }, 'the provider refused the call: a person should make it');
      return { status: 'failed' };
    }
  }

  /**
   * The provider's report on one attempt. Returns { status: 200 | 400 | 403 | 404, body }. Idempotent:
   * a report for a call that already has its outcome is acknowledged and changes nothing.
   */
  async function webhook(payload) {
    const meta = payload?.webhook_config?.metadata ?? {};
    const callId = String(meta.call_id ?? '');
    if (!/^[0-9a-f]{24}$/.test(callId) || typeof meta.sig !== 'string' || meta.sig.length !== 64) return { status: 403, body: { error: 'unsigned' } };
    const want = sign(deps.pageSecret, callId);
    if (!timingSafeEqual(Buffer.from(want), Buffer.from(meta.sig))) return { status: 403, body: { error: 'bad signature' } };
    const call = await calls.findOne({ _id: new ObjectId(callId) });
    if (!call || !call.provider_attempt_id || call.provider_attempt_id !== payload.attempt_id) return { status: 404, body: { error: 'no such call' } };
    if (FINAL.has(call.status)) return { status: 200, body: { ok: true, already: call.status } };
    const status = ['connected', 'no_answer', 'busy', 'failed'].includes(payload.status) ? payload.status : 'failed';
    const now = clock();
    const duration = Number.isFinite(Number(payload.duration)) && Number(payload.duration) >= 0 ? Math.round(Number(payload.duration)) : 0;
    const billed = status === 'connected' ? Math.max(1, Math.ceil(duration / 60)) : 0;
    const month = istMonth(call.placed_at ?? now);
    await meter.settle({ meter: 'voice_minutes', period: month, reserved: maxMinutes, actual: billed });
    const outcomeRaw = payload.final_agent_variables?.outcome;
    const outcome = status === 'connected' ? (cfg.script.outcomes.includes(outcomeRaw) ? outcomeRaw : 'unclear') : null;
    const transcript = Array.isArray(payload.interaction_transcript)
      ? payload.interaction_transcript.slice(0, 200).map((t) => ({ role: t?.role === 'agent' ? 'agent' : 'user', text: String(t?.en_text ?? '').slice(0, 1000) }))
      : null;
    const costPaise = billed * cfg.price_paise_per_minute;
    const updated = await calls.findOneAndUpdate({ _id: call._id, status: { $in: ['placed', 'placing'] } }, {
      $set: { status, ended_at: now, duration_s: duration, outcome, transcript, failure_reason: payload.failure_reason ? String(payload.failure_reason).slice(0, 300) : null,
        cost_paise: costPaise, updated_at: now },
      $push: { history: { at: now, status, note: outcome ? `outcome: ${outcome}` : null } },
    }, { returnDocument: 'after' });
    if (!updated) return { status: 200, body: { ok: true, already: true } };
    // spending is capped by the minutes above; this meter only records it, for the cost page
    await meter.take({ meter: 'voice_paise', period: month, amount: costPaise, cap: 1_000_000_000 });
    try {
      await db.collection('activities').insertOne({ at: now, type: 'call_completed', channel: 'voice', company_id: call.company_id, lead_id: call.lead_id ?? null,
        campaign: 'callback', template_version: call.script_version, model_version: null, holdout: false, idem_key: `call_completed:${call._id}`,
        data: { call_id: call._id, status, duration_s: duration, outcome, attempt: call.attempt, cost_paise: costPaise } });
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
    if (outcome === 'stop') {
      await ledger.withdraw({ subject: { type: 'person', id: String(call.person_id) }, channel: 'voice', purpose: 'callback', address: call.to,
        wording: 'Asked on the call not to be called again.', wordingVersion: cfg.script.version, capturedVia: 'call',
        proof: { call_id: String(call._id), attempt_id: payload.attempt_id }, recordedBy: 'voice_agent' });
    }
    if (['no_answer', 'busy'].includes(status) && call.attempt < cfg.max_attempts) {
      await deps.queue.enqueue({ type: JOB_CALL, idemKey: `call:${call.company_id}:${call.person_id}:${call.attempt + 1}`, leadId: call.lead_id ?? null, step: 'call',
        dueAt: nextCallWindow(new Date(now.getTime() + cfg.retry_after_hours * HOUR), cfg, call.slot ?? 'any'),
        payload: { company_id: call.company_id, person_id: String(call.person_id), slot: call.slot ?? 'any', language: call.language, attempt: call.attempt + 1 } });
    }
    return { status: 200, body: { ok: true } };
  }

  return { handlers: { [JOB_CALL]: callStep }, webhook };
}

/** What a person needs to act on: calls for a person to make, outcomes asking for a person, and calls in doubt. */
export function callsNeedingPerson(db, { limit = 50 } = {}) {
  return db.collection('calls').find({ $or: [{ status: { $in: ['blocked', 'failed', 'unknown'] } }, { outcome: { $in: ['interested', 'wants_person', 'call_later'] } }],
    'handled.at': { $exists: false } }).sort({ updated_at: -1 }).limit(limit).toArray();
}

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Events from the platform (design 7.9 and 8, "Service requests and payments: Platform -> engine"):
 * a founder signed up, raised a service request, or paid through Razorpay. The platform POSTs them to
 * /api/events on the Admin server, signed with PLATFORM_EVENTS_SECRET:
 *
 *   X-Signature: sha256=<hex HMAC-SHA256 of the raw body>
 *   { "events": [ { "id": "evt_123", "type": "paid", "at": "2026-11-24T10:00:00+05:30",
 *                   "company_id": "U62099UP2026PTC300001", "amount_paise": 499900,
 *                   "service": "gst_registration", "reference": "pay_ABC" } ] }
 *
 * Each becomes one activity (idem_key platform:<id>, so a resent event is recorded once), linked to
 * the company's lead with its holdout flag and what the engine had done before it: the first and
 * last touch, and whether the company was contacted at all. That is what attribution reads. A payment
 * makes the lead a customer, holdout or not, so the holdout group's own conversions are counted too.
 *
 * Only these fields are kept. Nothing about the person who paid is sent or stored: the platform
 * identifies the company by its CIN or LLPIN, which the claim handed over at sign-up.
 */

export const EVENT_TYPES = ['signed_up', 'service_request', 'paid'];
const ID_RX = /^[A-Za-z0-9_.:-]{1,100}$/;
const CIN_OR_LLPIN = /^([UL][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}|[A-Z]{3}-[0-9]{4})$/;
const TOUCH = ['sent', 'opened', 'replied', 'claimed', 'call_completed', 'call_requested'];
const MAX_EVENTS = 100;

/** True when `header` is the HMAC of `rawBody` under `secret`. */
export function verifySignature(secret, rawBody, header) {
  if (!secret || secret.length < 32 || typeof header !== 'string') return false;
  const m = /^sha256=([0-9a-f]{64})$/.exec(header.trim());
  if (!m) return false;
  const want = createHmac('sha256', secret).update(rawBody).digest('hex');
  return timingSafeEqual(Buffer.from(want), Buffer.from(m[1]));
}

export const signBody = (secret, rawBody) => `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;

/** Checks one event; returns { event } with only the known fields, or { error }. */
export function validateEvent(e, { now = new Date() } = {}) {
  if (!e || typeof e !== 'object') return { error: 'an event must be an object' };
  if (!ID_RX.test(String(e.id ?? ''))) return { error: 'id must be 1 to 100 letters, digits or _.:-' };
  if (!EVENT_TYPES.includes(e.type)) return { error: `type must be one of ${EVENT_TYPES.join(', ')}` };
  const at = new Date(e.at);
  if (!e.at || Number.isNaN(at.getTime())) return { error: 'at must be an ISO date and time' };
  if (at.getTime() > now.getTime() + 10 * 60_000) return { error: 'at is in the future' };
  const companyId = String(e.company_id ?? '').toUpperCase();
  if (!CIN_OR_LLPIN.test(companyId)) return { error: 'company_id must be a CIN or LLPIN' };
  let amount = null;
  if (e.type === 'paid') {
    if (!Number.isInteger(e.amount_paise) || e.amount_paise < 0 || e.amount_paise > 1_000_000_000) return { error: 'amount_paise must be a whole number of paise' };
    if (e.currency && e.currency !== 'INR') return { error: 'currency must be INR' };
    amount = e.amount_paise;
  }
  const short = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
  return { event: { id: String(e.id), type: e.type, at, company_id: companyId, amount_paise: amount, service: short(e.service, 80), reference: short(e.reference, 100) } };
}

/**
 * Records one validated event. Returns { recorded, duplicate, lead }. `clock` is the receiving time.
 */
export async function recordEvent(db, event, { clock = () => new Date() } = {}) {
  const lead = await db.collection('leads').findOne({ company_id: event.company_id });
  const touches = await db.collection('activities').find({ company_id: event.company_id, type: { $in: TOUCH }, at: { $lte: event.at } })
    .sort({ at: 1 }).project({ at: 1, type: 1, channel: 1, campaign: 1, 'data.kind': 1 }).toArray();
  const firstSent = touches.find((t) => t.type === 'sent');
  const last = touches.at(-1);
  const brief = (t) => t && { at: t.at, type: t.type, channel: t.channel ?? null, campaign: t.campaign ?? null, kind: t.data?.kind ?? null };
  const doc = {
    at: event.at, type: event.type, channel: 'platform', company_id: event.company_id, lead_id: lead?._id ?? null, campaign: 'platform',
    holdout: lead ? lead.holdout === true : null, idem_key: `platform:${event.id}`,
    data: {
      event_id: event.id, amount_paise: event.amount_paise, service: event.service, reference: event.reference, received_at: clock(),
      attribution: {
        known_lead: Boolean(lead), cohort: lead?.cohort ?? null, shortlist_month: lead?.shortlist?.month ?? null,
        contacted: Boolean(firstSent), first_touch: brief(firstSent ?? touches[0]), last_touch: brief(last), touches: touches.length,
        days_since_first_touch: firstSent ? Math.floor((event.at - firstSent.at) / 86_400_000) : null,
      },
    },
  };
  try {
    await db.collection('activities').insertOne(doc);
  } catch (err) {
    if (err?.code === 11000) return { recorded: false, duplicate: true, lead: lead?._id ?? null };
    throw err;
  }
  if (lead && event.type === 'paid') {
    await db.collection('leads').updateOne({ _id: lead._id, stage: { $ne: 'customer' } }, { $set: { stage: 'customer', updated_at: clock() } });
  }
  return { recorded: true, duplicate: false, lead: lead?._id ?? null };
}

/**
 * The whole request: signature, then each event. Returns { status, body } for the HTTP answer.
 * A refused signature is written to audit_log (the platform's key may have leaked or changed).
 */
export async function receiveEvents(db, { rawBody, signature, secret, address = null, clock = () => new Date() }) {
  if (!secret || secret.length < 32) return { status: 503, body: { error: 'PLATFORM_EVENTS_SECRET is not configured on this server' } };
  if (!verifySignature(secret, rawBody, signature)) {
    await db.collection('audit_log').insertOne({ at: clock(), actor: 'platform', role: null, action: 'event_received', target: null, fields: null,
      detail: { refused: 'bad or missing X-Signature', address } });
    return { status: 401, body: { error: 'bad signature' } };
  }
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: 'invalid JSON' } };
  }
  const list = Array.isArray(body?.events) ? body.events : body && typeof body === 'object' && body.id ? [body] : null;
  if (!list) return { status: 400, body: { error: 'expected { "events": [...] } or one event' } };
  if (list.length > MAX_EVENTS) return { status: 413, body: { error: `at most ${MAX_EVENTS} events at a time` } };
  const results = [];
  for (const e of list) {
    const v = validateEvent(e, { now: clock() });
    if (v.error) {
      results.push({ id: e?.id ?? null, ok: false, error: v.error });
      continue;
    }
    if (v.event.id.startsWith('test_')) {
      // the platform's own integration tests: checked and answered like a real event, never recorded
      const lead = await db.collection('leads').findOne({ company_id: v.event.company_id }, { projection: { _id: 1 } });
      results.push({ id: v.event.id, ok: true, test: true, duplicate: false, known_company: Boolean(lead) });
      continue;
    }
    const r = await recordEvent(db, v.event, { clock });
    results.push({ id: v.event.id, ok: true, duplicate: r.duplicate, known_company: Boolean(r.lead) });
  }
  const failed = results.filter((r) => !r.ok).length;
  return { status: failed && failed === results.length ? 422 : 200, body: { received: results.length, failed, results } };
}

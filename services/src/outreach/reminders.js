import { ObjectId } from 'mongodb';
import { DeferError } from '../jobs/worker.js';
import { formatDate, displayName, istDate } from './evidence.js';
import { Meter, istMonth } from './meter.js';
import { templateApproved } from './whatsapp.js';

/**
 * Reminders for founders who asked for them (design 7.6): after claiming the company page, a founder
 * may agree to deadline reminders on WhatsApp, by email, or both. Each agreement is in the consent
 * ledger with its exact wording, and nothing is sent without it.
 *
 *   planReminders (daily, `lead-engine reminders:plan`): for each claimed company whose rules are
 *     confirmed, a reminder job for each firm deadline that is reminders.days_before days away, per
 *     person and channel they agreed to.
 *   reminder.send: checks again at the moment of sending (consent still granted, address not
 *     suppressed, the deadline still ahead, under the per-channel frequency cap, WhatsApp only
 *     between 09:00 and 21:00 IST, an approved template, the month's WhatsApp spend cap), then sends:
 *     WhatsApp through the Cloud API, email through the platform's own mail (the platform's notify
 *     endpoint; the engine's outreach mailboxes are never used for this).
 *   whatsapp.confirm: right after a claim with WhatsApp consent, the confirmation template.
 *   scheme.alert: for a founder who ticked "email me when the company may qualify for a scheme", an
 *     email (through the platform's mail) for each scheme that starts to apply after the claim (the
 *     ones on the page when they claimed it, they have seen), once per scheme, at most
 *     reminders.scheme_alerts_per_30_days a month.
 */

export const JOB_REMINDER = 'reminder.send';
export const JOB_WA_CONFIRM = 'whatsapp.confirm';
export const JOB_SCHEME = 'scheme.alert';
const SCHEME_OK = new Set(['eligible', 'check_required']);
const DAY = 86_400_000;
const FIRM = new Set(['due_soon', 'upcoming']);

const istMinute = (at) => {
  const d = new Date(at.getTime() + 5.5 * 3_600_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};
const hhmm = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

/** The next moment WhatsApp may be used (inside window_ist), at or after `now`. */
export function nextWhatsAppWindow(now, cfg) {
  const [from, to] = cfg.whatsapp.window_ist;
  const m = istMinute(now);
  if (m >= hhmm(from) && m < hhmm(to)) return now;
  const day = istDate(m < hhmm(from) ? now : new Date(now.getTime() + DAY));
  return new Date(`${day}T${from}:00+05:30`);
}

/** Queues today's reminders. Returns counts. `deps`: { db, queue, ledger, cfg, clock }. */
export async function planReminders(deps) {
  const { db, queue, ledger, cfg, clock } = deps;
  const today = istDate(clock());
  const stats = { people: 0, queued: 0, rules_unconfirmed: 0, no_consent: 0, scheme_alerts_queued: 0 };
  const people = await db.collection('people').find({ 'contacts.legal_basis': 'consent' }).toArray();
  for (const person of people) {
    stats.people += 1;
    for (const cid of person.company_ids ?? []) {
      const lead = await db.collection('leads').findOne({ company_id: cid });
      if (lead?.needs?.rules_confirmed !== true) {
        stats.rules_unconfirmed += 1;
        continue;
      }
      for (const contact of person.contacts ?? []) {
        if (contact.legal_basis !== 'consent' || !['email', 'whatsapp'].includes(contact.channel)) continue;
        const consent = await ledger.statusForAddress({ channel: contact.channel, address: contact.address, purpose: 'deadline_reminders' });
        if (!consent.granted) {
          stats.no_consent += 1;
          continue;
        }
        for (const d of lead.needs.deadlines ?? []) {
          if (!FIRM.has(d.status) || !d.due) continue;
          const days = Math.round((Date.parse(`${d.due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY);
          if (!cfg.reminders.days_before.includes(days)) continue;
          const r = await queue.enqueue({
            type: JOB_REMINDER, idemKey: `reminder:${cid}:${person._id}:${contact.channel}:${d.id}:${d.due}:${days}`, leadId: lead._id, step: 'reminder',
            payload: { company_id: cid, person_id: String(person._id), channel: contact.channel, deadline_id: d.id, due: d.due },
          });
          if (r.created) stats.queued += 1;
        }
      }
      // scheme alerts, by email, for a scheme that started to apply after the founder claimed the page
      const email = (person.contacts ?? []).find((c) => c.channel === 'email' && c.legal_basis === 'consent');
      if (email && (await ledger.statusForAddress({ channel: 'email', address: email.address, purpose: 'scheme_alerts' })).granted) {
        const claim = await db.collection('activities').findOne({ type: 'claimed', company_id: cid, 'data.person_id': person._id });
        const shown = new Set(claim?.data?.schemes_shown ?? []);
        for (const s of lead.needs.schemes ?? []) {
          const sid = s.scheme_id ?? s.id;
          if (!sid || !SCHEME_OK.has(s.verdict) || shown.has(sid)) continue;
          const r = await queue.enqueue({ type: JOB_SCHEME, idemKey: `scheme-alert:${cid}:${person._id}:${sid}`, leadId: lead._id, step: 'scheme_alert',
            payload: { company_id: cid, person_id: String(person._id), scheme_id: sid } });
          if (r.created) stats.scheme_alerts_queued += 1;
        }
      }
    }
  }
  return stats;
}

/**
 * Handlers. `deps`: { db, ledger, suppression, whatsapp, platform, tokens, cfg, caps, publicBaseUrl,
 * clock, log }.
 */
export function reminderHandlers(deps) {
  const { db, ledger, suppression, whatsapp, platform, tokens, cfg, caps, clock } = deps;
  const meter = new Meter(db, { clock });
  const capPaise = Math.round((caps.monthly?.whatsapp_spend_inr ?? 0) * 100);

  async function contactOf(personId, channel) {
    const person = await db.collection('people').findOne({ _id: new ObjectId(personId) });
    return { person, contact: (person?.contacts ?? []).find((c) => c.channel === channel && c.legal_basis === 'consent') ?? null };
  }

  /** Checks shared by both jobs. Returns a reason to skip, or null. */
  async function blocked({ channel, contact, purpose }) {
    if (!contact) return 'no contact with consent on this channel';
    const consent = await ledger.statusForAddress({ channel, address: contact.address, purpose });
    if (!consent.granted) return 'consent is not (or no longer) granted';
    const hits = await suppression.check(channel === 'email' ? { email: contact.address } : { phone: contact.address });
    if (hits.length) return 'the address is suppressed';
    return null;
  }

  async function sendWhatsApp({ name, language, to, bodyParams, buttonSuffix }) {
    if (whatsapp.configured && !(await templateApproved(db, name, language))) {
      throw new DeferError(`template ${name} (${language}) is not approved by Meta (run whatsapp:templates --sync)`, new Date(clock().getTime() + DAY));
    }
    const month = istMonth(clock());
    const price = cfg.whatsapp.utility_price_paise ?? 15;
    if (whatsapp.configured && !(await meter.take({ meter: 'whatsapp_paise', period: month, amount: price, cap: capPaise }))) {
      throw new DeferError(`the month's WhatsApp spending cap (₹${capPaise / 100}) is reached`, new Date(`${nextMonth(month)}-01T09:00:00+05:30`));
    }
    try {
      return await whatsapp.sendTemplate({ to, name, language, bodyParams, buttonSuffix });
    } catch (err) {
      if (whatsapp.configured) await meter.settle({ meter: 'whatsapp_paise', period: month, reserved: price, actual: 0 });
      throw err;
    }
  }

  async function reminder(job) {
    const { company_id: cid, person_id: pid, channel, deadline_id: did, due } = job.payload;
    const today = istDate(clock());
    if (due < today) return { skipped: 'the deadline has passed' };
    const lead = await db.collection('leads').findOne({ company_id: cid });
    if (lead?.needs?.rules_confirmed !== true) return { skipped: 'rules not confirmed' };
    const d = (lead.needs.deadlines ?? []).find((x) => x.id === did && x.due === due && FIRM.has(x.status));
    if (!d) return { skipped: 'the deadline no longer applies as planned' };
    const { person, contact } = await contactOf(pid, channel);
    const why = await blocked({ channel, contact, purpose: 'deadline_reminders' });
    if (why) return { skipped: why };
    const recent = await db.collection('activities').countDocuments({ type: 'sent', channel, 'data.kind': 'reminder', 'data.person_id': person._id,
      at: { $gte: new Date(clock().getTime() - 30 * DAY) } });
    if (recent >= cfg.reminders.max_per_30_days) return { skipped: `already ${recent} reminders in 30 days` };
    if (channel === 'whatsapp') {
      const ready = nextWhatsAppWindow(clock(), cfg);
      if (ready > clock()) throw new DeferError('outside WhatsApp hours', ready);
    }
    const company = await db.collection('companies').findOne({ _id: cid });
    const name = displayName(company);
    const deadline = `${d.title}${/\d/.test(d.form ?? '') && !/no MCA/i.test(d.form) ? ` (${d.form})` : ''}`;
    const pageToken = await tokens.issue({ purpose: 'company_page', companyId: cid, leadId: lead._id });
    let result;
    if (channel === 'whatsapp') {
      result = await sendWhatsApp({ name: 'filing_deadline_reminder', language: 'en', to: contact.address,
        bodyParams: [name, deadline, formatDate(due, 'en')], buttonSuffix: pageToken });
    } else {
      if (!platform.canNotify) return { skipped: 'the platform notify endpoint is not configured yet' };
      result = await platform.notify({ channel: 'email', to: contact.address, type: 'deadline_reminder', company: { id: cid, name },
        title: `${name}: ${d.title} is due by ${formatDate(due, 'en')}`, deadline: { id: d.id, title: d.title, form: d.form ?? null, due, law: d.law ?? null },
        link: `${deps.publicBaseUrl.replace(/\/+$/, '')}/c/${pageToken}` });
    }
    if (result.dry_run) return { status: 'dry_run' };
    await db.collection('activities').insertOne({ at: clock(), type: 'sent', channel, company_id: cid, lead_id: lead._id, campaign: 'reminder', holdout: false,
      idem_key: `sent:${job.idem_key}`, data: { kind: 'reminder', person_id: person._id, deadline_id: did, due, provider_id: result.id ?? null } });
    return { status: 'sent' };
  }

  async function confirm(job) {
    const { company_id: cid, person_id: pid } = job.payload;
    const { contact } = await contactOf(pid, 'whatsapp');
    const why = await blocked({ channel: 'whatsapp', contact, purpose: 'deadline_reminders' });
    if (why) return { skipped: why };
    const ready = nextWhatsAppWindow(clock(), cfg);
    if (ready > clock()) throw new DeferError('outside WhatsApp hours', ready);
    const company = await db.collection('companies').findOne({ _id: cid });
    const r = await sendWhatsApp({ name: 'reminders_confirmation', language: 'en', to: contact.address, bodyParams: [displayName(company)] });
    return { status: r.dry_run ? 'dry_run' : 'sent' };
  }

  async function schemeAlert(job) {
    const { company_id: cid, person_id: pid, scheme_id: sid } = job.payload;
    const lead = await db.collection('leads').findOne({ company_id: cid });
    if (lead?.needs?.rules_confirmed !== true) return { skipped: 'rules not confirmed' };
    const s = (lead.needs.schemes ?? []).find((x) => (x.scheme_id ?? x.id) === sid && SCHEME_OK.has(x.verdict));
    if (!s) return { skipped: 'the scheme no longer applies' };
    const { person, contact } = await contactOf(pid, 'email');
    const why = await blocked({ channel: 'email', contact, purpose: 'scheme_alerts' });
    if (why) return { skipped: why };
    // not time-bound like a deadline: an alert waits for the platform's mail rather than being dropped
    if (!platform.canNotify) throw new DeferError('the platform notify endpoint is not configured yet', new Date(clock().getTime() + DAY));
    const recent = await db.collection('activities').countDocuments({ type: 'sent', channel: 'email', 'data.kind': 'scheme_alert', 'data.person_id': person._id,
      at: { $gte: new Date(clock().getTime() - 30 * DAY) } });
    if (recent >= (cfg.reminders.scheme_alerts_per_30_days ?? 2)) throw new DeferError(`already ${recent} scheme alerts in 30 days`, new Date(clock().getTime() + 7 * DAY));
    const company = await db.collection('companies').findOne({ _id: cid });
    const name = displayName(company);
    const pageToken = await tokens.issue({ purpose: 'company_page', companyId: cid, leadId: lead._id });
    const result = await platform.notify({ channel: 'email', to: contact.address, type: 'scheme_alert', company: { id: cid, name },
      title: `${name} may qualify for ${s.name}`,
      scheme: { id: sid, name: s.name, verdict: s.verdict, benefit: s.benefit ?? null, to_check: s.missing ?? [], source_url: s.source_url ?? null },
      link: `${deps.publicBaseUrl.replace(/\/+$/, '')}/c/${pageToken}` });
    await db.collection('activities').insertOne({ at: clock(), type: 'sent', channel: 'email', company_id: cid, lead_id: lead._id, campaign: 'scheme_alert', holdout: false,
      idem_key: `sent:${job.idem_key}`, data: { kind: 'scheme_alert', person_id: person._id, scheme_id: sid, provider_id: result.id ?? null } });
    return { status: 'sent' };
  }

  return { [JOB_REMINDER]: reminder, [JOB_WA_CONFIRM]: confirm, [JOB_SCHEME]: schemeAlert };
}

function nextMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

import { WAIT_CODES } from './budget.js';
import { approvedHash } from './messages.js';

/**
 * The compliance gate (design 7.5 and 7.7): deterministic checks run immediately before every send,
 * after every AI step, so nothing can go around them. In order:
 *
 *   1. the message is approved, and its text is exactly what the person approved;
 *   2. it has not expired, and no date it calls upcoming has passed since it was drafted;
 *   3. the rules behind its facts are confirmed by a CA (design 7.4);
 *   4. the recipient has a legal basis this channel accepts (config/outreach.json recipient);
 *   5. the sending mailbox is configured, and today is a sending day;
 *   6. the address, its domain and parent domains are not on the suppression list (which fails
 *      closed: an address it cannot read counts as suppressed);
 *   7. the contact budget reserves the company and a unit of the mailbox's daily cap: not a holdout,
 *      not ineligible, no reply or opt-out, warm-up over, inside the send window, under the caps,
 *      mailbox not paused for bounces or complaints.
 *
 * The answer is 'send' (with the budget's reservation, which the sender must release), 'wait' (with
 * the time to look again: the window opens, the warm-up ends, the rules get confirmed) or 'stop'
 * (this message will never be sent).
 */

const DAY = 86_400_000;
const IST = 5.5 * 3_600_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const istParts = (at) => {
  const d = new Date(at.getTime() + IST);
  return { day: d.toISOString().slice(0, 10), weekday: WEEKDAYS[d.getUTCDay()], minute: d.getUTCHours() * 60 + d.getUTCMinutes() };
};
const atIst = (day, hhmm) => new Date(`${day}T${hhmm}:00+05:30`);
const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** The next moment at or after `now` when the send window is open on a sending day. */
export function nextWindowOpen(now, caps, sendDays) {
  const [from, to] = caps.email.send_window_ist;
  for (let i = 0; i < 14; i += 1) {
    const probe = new Date(now.getTime() + i * DAY);
    const { day, weekday, minute } = istParts(probe);
    if (!sendDays.includes(weekday)) continue;
    if (i === 0) {
      if (minute < minutes(from)) return atIst(day, from);
      if (minute < minutes(to)) return now;
      continue;
    }
    return atIst(day, from);
  }
  throw new Error('no sending day in the next two weeks: check send_days_ist');
}

/** When to look again after a budget refusal that passes with time. */
function waitUntil(code, now, caps, sendDays, budget) {
  const nextDay = () => nextWindowOpen(new Date(atIst(istParts(new Date(now.getTime() + DAY)).day, '00:00').getTime()), caps, sendDays);
  switch (code) {
    case 'window': return nextWindowOpen(now, caps, sendDays);
    case 'daily_cap':
    case 'mailbox_paused':
    case 'too_soon': return nextDay();
    case 'warmup': {
      const start = atIst(caps.email.warmup_start, '00:00');
      return nextWindowOpen(new Date(Math.max(now.getTime() + 60_000, start.getTime() + caps.email.warmup_days * DAY)), caps, sendDays);
    }
    case 'busy': return new Date(now.getTime() + Math.min(budget.holdMs, 5 * 60_000));
    default: return nextDay();
  }
}

export class ComplianceGate {
  constructor({ cfg, caps, budget, suppression, mailboxes, ledger = null, clock = () => new Date() }) {
    this.cfg = cfg;
    this.ledger = ledger;
    this.caps = caps;
    this.budget = budget;
    this.suppression = suppression;
    this.mailboxes = mailboxes;
    this.clock = clock;
  }

  /** Returns { decision: 'send' | 'wait' | 'stop', code, reasons, until?, reservation? }. */
  async check({ message, lead }) {
    const now = this.clock();
    const sendDays = this.cfg.send_days_ist;
    const stop = (code, reason) => ({ decision: 'stop', code, reasons: [reason] });
    const wait = (code, reason, until) => ({ decision: 'wait', code, reasons: [reason], until });

    if (message?.status !== 'approved' || message.approval?.decision !== 'approved') return stop('not_approved', 'the message is not approved');
    if (approvedHash(message.draft.subject, message.draft.body) !== message.approval.approved_hash) {
      return stop('approval_stale', 'the text changed after it was approved');
    }
    if (!(message.expires_at > now)) return stop('expired', 'the message is too old to send; its facts may have changed');
    const today = istParts(now).day;
    const passed = (message.evidence.pack.deadlines ?? []).filter((d) => d.status === 'upcoming' && d.due < today);
    if (passed.length) return stop('stale_facts', `it calls ${passed.map((d) => d.title).join(', ')} upcoming, but the date has passed`);
    if (!message.evidence.pack.rules?.confirmed || lead?.needs?.rules_confirmed !== true) {
      return wait('rules_unconfirmed', "the deadline and scheme rules are not yet confirmed by a CA", waitUntil('rules', now, this.caps, sendDays, this.budget));
    }
    // UP only: a company's CIN carries the state it was registered in, whatever its record says
    const cin = /^[LU]\d{5}([A-Z]{2})\d{4}[A-Z]{3}\d{6}$/.exec(String(message.company_id ?? ''));
    if (cin && cin[1] !== 'UP') return stop('not_up', `the company's CIN was issued in ${cin[1]}, not Uttar Pradesh`);
    const r = message.recipient;
    if (!r?.address) return stop('no_recipient', 'there is no address to send to');
    if (!this.cfg.recipient.legal_bases.includes(r.legal_basis)) return stop('no_legal_basis', `the address's legal basis (${r.legal_basis ?? 'none'}) does not allow this message`);
    // the switch is read at send time too: turning it off stops what was drafted while it was on
    if (r.legal_basis === 'published_by_company' && !this.cfg.recipient.use_website_email) {
      return stop('website_email_off', "addresses from companies' own websites are switched off (recipient.use_website_email)");
    }
    // "consent" is only as good as the ledger says it is now
    if (r.legal_basis === 'consent') {
      const granted = this.ledger && (await Promise.all(['deadline_reminders', 'scheme_alerts']
        .map((purpose) => this.ledger.statusForAddress({ channel: 'email', address: r.address, purpose })))).some((x) => x.granted);
      if (!granted) return stop('no_consent', 'the address is marked as consented, but the consent ledger holds no current consent for it');
    }
    const mb = this.mailboxes[message.mailbox];
    if (!mb?.address) return wait('mailbox_not_configured', `${message.mailbox} has no address configured`, waitUntil('config', now, this.caps, sendDays, this.budget));
    if (!sendDays.includes(istParts(now).weekday)) return wait('window', `${istParts(now).weekday} is not a sending day`, nextWindowOpen(now, this.caps, sendDays));

    const hits = await this.suppression.check({ email: r.address });
    if (hits.length) return stop('suppressed', `the address is on the suppression list (${hits.map((h) => h.reason).join(', ')})`);

    const res = await this.budget.reserve({ lead, kind: message.kind, mailbox: message.mailbox, needId: message.need_id ?? null });
    if (res.allowed) return { decision: 'send', code: 'ok', reasons: [res.reason], reservation: res.reservation };
    if (WAIT_CODES.has(res.code)) return wait(res.code, res.reason, waitUntil(res.code, now, this.caps, sendDays, this.budget));
    return stop(res.code ?? 'budget', res.reason);
  }
}

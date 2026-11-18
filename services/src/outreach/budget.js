import { randomUUID } from 'node:crypto';

/**
 * The contact budget (design 7.4): how often a company may hear from us, decided in code before any
 * message is drafted, and again at the compliance gate before it is sent (Phase 3).
 *
 *   - never a holdout company, never an ineligible one;
 *   - one first email, then at most one follow-up (after N days, within a window, only if there was
 *     no reply and nothing else was sent in between);
 *   - after that, a new message only when a new deadline or scheme becomes relevant, at most once
 *     per need, and not within 30 days of the last one;
 *   - once a founder replies, opts out, complains, claims the company page or an email hard-bounces,
 *     cold outreach stops (a founder who claimed gets only what they agreed to, through reminders);
 *   - each mailbox sends nothing until its warm-up is over, then follows the ramp in caps.json, only
 *     inside the IST send window, and pauses when its bounce or complaint rate passes the limits.
 *
 * Every touch is read from `activities`, the single log of what was sent, so the budget can never
 * disagree with what really happened. Each refusal carries a `code` as well as its reason, so the
 * compliance gate can tell a refusal that passes with time (warm-up, the send window, today's cap)
 * from one that never will (a holdout, an opt-out, the budget used up): see WAIT_CODES. check() only reads, so two workers checking at the same moment
 * would both be allowed; the send-time gate therefore uses reserve(), which takes the company and a
 * unit of the mailbox's daily cap atomically before anything is sent.
 *
 * Activities this reads: 'sent' with data.kind (first_touch, follow_up, new_need, reply), data.mailbox
 * and, for new_need, data.need_id; 'bounced' with data.mailbox and data.bounce ('hard' or 'soft';
 * missing counts as hard); 'complained' with data.mailbox; 'replied', 'unsubscribed' and 'claimed'.
 */

const DAY = 86_400_000;
const IST_OFFSET_MS = 5.5 * 3_600_000;
const KINDS = ['first_touch', 'follow_up', 'new_need', 'reply'];
/** Bounce and complaint rates cover the last 30 days. */
const HEALTH_WINDOW_DAYS = 30;
/** The rates never divide by fewer than 50 sends, so one early bounce does not pause a new mailbox for a month. */
const HEALTH_MIN_SAMPLE = 50;
/** Without contact_budget.follow_up_within_days, a follow-up is not sent later than this after the first email. */
const DEFAULT_FOLLOW_UP_WITHIN_DAYS = 21;

/** Refusals that can pass later without anyone doing anything; every other code is final for this message. */
export const WAIT_CODES = new Set(['warmup', 'window', 'daily_cap', 'busy', 'mailbox_paused', 'too_soon']);

/** The IST calendar day of an instant, as 'YYYY-MM-DD'. */
export function istDay(at) {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** [start, end) of the IST day containing `at`, as UTC instants. */
function istDayBounds(at) {
  const start = new Date(`${istDay(at)}T00:00:00+05:30`);
  return [start, new Date(start.getTime() + DAY)];
}

/** Minutes since IST midnight. */
function istMinutes(at) {
  const d = new Date(at.getTime() + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** "17:30" -> 1050, or NaN. */
function clockMinutes(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : Number.NaN;
}

/**
 * Checks the parts of caps.json the budget relies on and throws one TypeError naming every problem.
 * A malformed value must stop the engine, not quietly turn into "no limit": a misspelt warm-up date
 * used to make every mailbox send its full cap from day one.
 */
export function validateCaps(caps) {
  const problems = [];
  const whole = (v, min = 0) => Number.isInteger(v) && v >= min;
  const e = caps?.email;
  const cb = caps?.contact_budget;
  if (!e || typeof e !== 'object') {
    problems.push('email is missing');
  } else {
    const start = /^\d{4}-\d{2}-\d{2}$/.test(e.warmup_start ?? '') ? new Date(`${e.warmup_start}T00:00:00+05:30`) : null;
    if (!start || Number.isNaN(start.getTime()) || istDay(start) !== e.warmup_start) problems.push('email.warmup_start must be a real date written YYYY-MM-DD');
    if (!whole(e.warmup_days)) problems.push('email.warmup_days must be a whole number');
    if (!whole(e.daily_cap_per_mailbox)) problems.push('email.daily_cap_per_mailbox must be a whole number');
    if (!Array.isArray(e.mailbox_ids) || !e.mailbox_ids.length || !e.mailbox_ids.every((m) => typeof m === 'string' && m)) {
      problems.push('email.mailbox_ids must list the mailboxes');
    }
    const ramp = e.outreach_ramp ?? [];
    if (!Array.isArray(ramp) || !ramp.every((s) => whole(s?.from_day, 1) && whole(s?.cap))) {
      problems.push('email.outreach_ramp must be a list of { from_day, cap } whole numbers');
    } else if (ramp.some((s, i) => i > 0 && s.from_day <= ramp[i - 1].from_day)) {
      problems.push('email.outreach_ramp must be in order of from_day');
    }
    const [from, to] = Array.isArray(e.send_window_ist) ? e.send_window_ist.map(clockMinutes) : [];
    if (!(from < to)) problems.push('email.send_window_ist must be ["HH:MM", "HH:MM"], start before end');
    for (const k of ['pause_if_bounce_pct_above', 'pause_if_complaint_pct_above']) {
      if (!(Number.isFinite(e[k]) && e[k] >= 0)) problems.push(`email.${k} must be a number of at least 0`);
    }
  }
  if (!cb || typeof cb !== 'object') {
    problems.push('contact_budget is missing');
  } else {
    for (const k of ['first_touch', 'follow_ups', 'follow_up_after_days', 'new_need_min_gap_days', 'max_touches_per_30_days']) {
      if (!whole(cb[k])) problems.push(`contact_budget.${k} must be a whole number`);
    }
    if (cb.follow_up_within_days !== undefined && !whole(cb.follow_up_within_days, cb.follow_up_after_days ?? 0)) {
      problems.push('contact_budget.follow_up_within_days must be a whole number no smaller than follow_up_after_days');
    }
  }
  if (problems.length) throw new TypeError(`config/caps.json is not valid: ${problems.join('; ')}`);
  return caps;
}

export class ContactBudget {
  /** `holdMs`: how long reserve() keeps a company to itself if release() is never called (a crashed sender). */
  constructor(db, caps, { clock = () => new Date(), holdMs = 10 * 60_000 } = {}) {
    this.activities = db.collection('activities');
    this.usage = db.collection('usage');
    this.locks = db.collection('locks');
    this.caps = validateCaps(caps);
    this.clock = clock;
    this.holdMs = holdMs;
  }

  /** Day of a mailbox's warm-up (1 on the first day), from caps.email.warmup_start. */
  warmupDay(at = this.clock()) {
    const start = new Date(`${this.caps.email.warmup_start}T00:00:00+05:30`);
    return Math.floor((new Date(`${istDay(at)}T00:00:00+05:30`) - start) / DAY) + 1;
  }

  /** Outreach emails a mailbox may send today: 0 during warm-up, then the configured ramp. A ramp cap of 0 pauses. */
  mailboxCap(at = this.clock()) {
    const e = this.caps.email;
    const day = this.warmupDay(at);
    if (!Number.isFinite(day) || day <= e.warmup_days) return 0;
    let cap = e.daily_cap_per_mailbox;
    for (const step of e.outreach_ramp ?? []) if (day >= step.from_day) cap = step.cap;
    return Math.min(cap, e.daily_cap_per_mailbox);
  }

  async mailboxSentToday(mailbox, at = this.clock()) {
    const [from, to] = istDayBounds(at);
    return this.activities.countDocuments({ type: 'sent', channel: 'email', 'data.mailbox': mailbox, at: { $gte: from, $lt: to } });
  }

  /** A mailbox's sends, hard bounces and complaints over the last 30 days, and the rates the pause rules use. */
  async mailboxHealth(mailbox, at = this.clock()) {
    const since = new Date(at.getTime() - HEALTH_WINDOW_DAYS * DAY);
    const recent = { 'data.mailbox': mailbox, at: { $gte: since, $lte: at } };
    const [sent, bounced, complained] = await Promise.all([
      this.activities.countDocuments({ type: 'sent', channel: 'email', ...recent }),
      this.activities.countDocuments({ type: 'bounced', 'data.bounce': { $ne: 'soft' }, ...recent }),
      this.activities.countDocuments({ type: 'complained', ...recent }),
    ]);
    const base = Math.max(sent, HEALTH_MIN_SAMPLE);
    return { sent, bounced, complained, bouncePct: (100 * bounced) / base, complaintPct: (100 * complained) / base };
  }

  /**
   * May this lead get a message of this kind now? Returns { allowed, reason }.
   * kind: 'first_touch' | 'follow_up' | 'new_need' | 'reply' (a person answering the founder is never budgeted)
   * stage: 'send' (the default) checks everything; 'draft' leaves out the send window and today's
   * count, which only matter at the moment of sending.
   * Only reads: use reserve() at the moment of sending.
   */
  async check({ lead, kind, channel = 'email', mailbox = null, needId = null, stage = 'send' }) {
    const now = this.clock();
    const no = (reason, code) => ({ allowed: false, reason, code });
    if (!lead) return no('no lead', 'no_lead');
    if (lead.holdout) return no('holdout: this company is never contacted', 'holdout');
    if (lead.eligible === false) return no(`not eligible: ${(lead.eligibility_reasons ?? []).join('; ')}`, 'ineligible');
    if (!KINDS.includes(kind)) return no(`unknown kind: ${kind}`, 'config');
    if (kind === 'reply') return { allowed: true, reason: 'answering the founder' };
    // never match on a missing id: { company_id: null } would match every activity without one
    if (!lead.company_id && !lead._id) return no('the lead has no company_id', 'no_lead');
    // Only email has caps in caps.json. Another channel is refused until it has its own, rather than
    // being sent without any limit.
    if (channel !== 'email') return no(`no contact budget is configured for ${channel}`, 'config');
    const e = this.caps.email;
    if (!mailbox) return no('no mailbox chosen', 'config');
    if (!e.mailbox_ids.includes(mailbox)) return no(`${mailbox} is not one of the mailboxes in caps.json`, 'config');

    const who = [];
    if (lead.company_id) who.push({ company_id: lead.company_id });
    if (lead._id) who.push({ lead_id: lead._id });
    const history = await this.activities
      .find({ $or: who, type: { $in: ['sent', 'replied', 'unsubscribed', 'complained', 'bounced', 'claimed'] } })
      .sort({ at: 1 })
      .toArray();
    const sent = history.filter((a) => a.type === 'sent');
    const firsts = sent.filter((a) => a.data?.kind === 'first_touch');
    const first = firsts[0];
    const followUps = sent.filter((a) => a.data?.kind === 'follow_up');
    const last = sent.at(-1);
    if (history.some((a) => ['unsubscribed', 'complained'].includes(a.type))) return no('the founder opted out or complained', 'opted_out');
    if (history.some((a) => a.type === 'replied')) return no('the founder replied: a person takes over', 'replied');
    if (history.some((a) => a.type === 'claimed')) return no('the founder claimed the company page: only what they agreed to from now on', 'claimed');
    if (history.some((a) => a.type === 'bounced' && a.data?.bounce !== 'soft')) return no('an email to this company hard-bounced: find a working address first', 'bounced');
    const cb = this.caps.contact_budget;
    const recent = sent.filter((a) => now - a.at < 30 * DAY).length;
    if (recent >= cb.max_touches_per_30_days) return no(`already ${recent} messages in the last 30 days`, 'touch_limit');

    if (kind === 'first_touch') {
      if (firsts.length >= cb.first_touch) return no('the first email has already been sent', 'already_sent');
    } else if (kind === 'follow_up') {
      const within = cb.follow_up_within_days ?? DEFAULT_FOLLOW_UP_WITHIN_DAYS;
      if (!first) return no('no first email yet', 'no_first');
      if (followUps.length >= cb.follow_ups) return no('the follow-up has already been sent', 'already_sent');
      if (sent.some((a) => a.at > first.at && a.data?.kind !== 'follow_up')) return no('another message went out after the first email, so a follow-up no longer fits', 'superseded');
      if (now - first.at < cb.follow_up_after_days * DAY) return no(`a follow-up waits ${cb.follow_up_after_days} days after the first email`, 'too_soon');
      if (now - first.at > within * DAY) return no(`a follow-up is only sent within ${within} days of the first email`, 'too_late');
    } else if (kind === 'new_need') {
      if (!needId) return no('a new-need message must name the need', 'config');
      if (!first) return no('no first email yet', 'no_first');
      if (sent.some((a) => a.data?.need_id === needId)) return no('this need has already been mentioned', 'already_sent');
      if (last && now - last.at < cb.new_need_min_gap_days * DAY) return no(`less than ${cb.new_need_min_gap_days} days since the last message`, 'too_soon');
    }

    const cap = this.mailboxCap(now);
    if (cap === 0) {
      const day = this.warmupDay(now);
      return day <= e.warmup_days
        ? no(`${mailbox} is still warming up (day ${day} of ${e.warmup_days})`, 'warmup')
        : no(`${mailbox} is paused: its cap for day ${day} is 0`, 'mailbox_paused');
    }
    const health = await this.mailboxHealth(mailbox, now);
    if (health.bouncePct > e.pause_if_bounce_pct_above) {
      return no(`${mailbox} is paused: ${health.bounced} hard bounces in 30 days (${health.bouncePct.toFixed(1)}%, limit ${e.pause_if_bounce_pct_above}%)`, 'mailbox_paused');
    }
    if (health.complaintPct > e.pause_if_complaint_pct_above) {
      return no(`${mailbox} is paused: ${health.complained} complaints in 30 days (${health.complaintPct.toFixed(2)}%, limit ${e.pause_if_complaint_pct_above}%)`, 'mailbox_paused');
    }
    if (stage === 'send') {
      const [from, to] = e.send_window_ist;
      const minute = istMinutes(now);
      if (minute < clockMinutes(from) || minute >= clockMinutes(to)) return no(`outside the send window (${from} to ${to} IST)`, 'window');
      const used = await this.mailboxSentToday(mailbox, now);
      if (used >= cap) return no(`${mailbox} has sent its ${cap} emails for today`, 'daily_cap');
    }
    return { allowed: true, reason: kind === 'first_touch' ? 'first email' : kind.replace('_', ' ') };
  }

  /**
   * The send-time gate. Holds the company (one message to it at a time, across all workers), runs
   * check(), and takes one unit of the mailbox's daily cap atomically, so two workers can never
   * both pass the last free place or both send to one company. Returns { allowed, reason,
   * reservation }.
   *
   * After sending, record the 'sent' activity first and then call release(reservation, { sent: true }):
   * the next check for this company must see it. If nothing was sent, release(reservation,
   * { sent: false }) gives the unit back. A sender that dies holding a reservation blocks the company
   * for holdMs; its unit stays used, which errs on the side of sending less.
   */
  async reserve({ lead, kind, channel = 'email', mailbox = null, needId = null }) {
    const no = (reason, code) => ({ allowed: false, reason, code, reservation: null });
    if (kind === 'reply') return { ...(await this.check({ lead, kind, channel, mailbox, needId })), reservation: null };
    if (!lead?.company_id) return no(lead ? 'the lead has no company_id' : 'no lead', 'no_lead');
    const now = this.clock();
    const lock = `lead:${lead.company_id}`;
    const holder = randomUUID();
    if (!(await this.#hold(lock, holder, now))) return no('another message to this company is being prepared or sent', 'busy');
    try {
      const decision = await this.check({ lead, kind, channel, mailbox, needId });
      if (!decision.allowed) {
        await this.#unhold(lock, holder);
        return { ...decision, reservation: null };
      }
      const cap = this.mailboxCap(now);
      const used = await this.mailboxSentToday(mailbox, now);
      const unit = await this.#takeUnit(mailbox, istDay(now), cap, used, now);
      if (!unit) {
        await this.#unhold(lock, holder);
        return no(`${mailbox} has sent its ${cap} emails for today`, 'daily_cap');
      }
      return { allowed: true, reason: decision.reason, reservation: { lock, holder, unit } };
    } catch (err) {
      await this.#unhold(lock, holder).catch(() => {});
      throw err;
    }
  }

  /** Ends a reservation from reserve(). `sent` says whether the message went out. */
  async release(reservation, { sent } = {}) {
    if (typeof sent !== 'boolean') throw new TypeError('release() needs { sent: true | false }');
    if (!reservation) return;
    if (!sent && reservation.unit) {
      await this.usage.updateOne({ _id: reservation.unit, count: { $gt: 0 } }, { $inc: { count: -1 }, $set: { updated_at: this.clock() } });
    }
    await this.#unhold(reservation.lock, reservation.holder);
  }

  /** Takes a company for `holder`, unless someone else holds it and their hold has not run out. */
  async #hold(id, holder, now) {
    try {
      const r = await this.locks.findOneAndUpdate(
        { _id: id, $or: [{ holder: null }, { held_until: { $lt: now } }] },
        { $set: { holder, held_until: new Date(now.getTime() + this.holdMs), updated_at: now } },
        { upsert: true, returnDocument: 'after' },
      );
      return r?.holder === holder;
    } catch (err) {
      if (err?.code === 11000) return false; // held: the upsert's insert collided with the holder's document
      throw err;
    }
  }

  async #unhold(id, holder) {
    await this.locks.updateOne({ _id: id, holder }, { $set: { holder: null, held_until: null, updated_at: this.clock() } });
  }

  /**
   * One unit of a mailbox's cap for an IST day, from its counter in `usage` (meter email:<mailbox>,
   * period <day>). First the counter is created or raised to `used`, the day's 'sent' activities, so
   * sends that did not go through reserve() still count ($max never lowers it). Then one atomic
   * increment that only matches while the count is below the cap: of two workers after the last
   * free place, exactly one gets it.
   */
  async #takeUnit(mailbox, day, cap, used, now) {
    if (!(cap > used)) return null;
    const id = `email:${mailbox}:${day}`;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.usage.updateOne(
          { _id: id },
          { $max: { count: used }, $set: { updated_at: now }, $setOnInsert: { meter: `email:${mailbox}`, period: day, cap } },
          { upsert: true },
        );
        break;
      } catch (err) {
        if (err?.code !== 11000 || attempt > 0) throw err; // two workers created it at once: the loser updates it
      }
    }
    const r = await this.usage.findOneAndUpdate(
      { _id: id, count: { $lt: cap } },
      { $inc: { count: 1 }, $set: { cap, updated_at: now } },
      { returnDocument: 'after' },
    );
    return r ? id : null;
  }
}

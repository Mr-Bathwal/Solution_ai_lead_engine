import { ContactBudget } from '../outreach/budget.js';
import { istMonth } from '../outreach/meter.js';

/**
 * The numbers the Results page, the daily summary and the API show (design 7.9):
 *
 *   lift(month)    the month's shortlist against its holdout: the companies that would have been on
 *                  the shortlist but were drawn into the holdout and never contacted. For each group,
 *                  how many companies signed up, raised a service request and paid, and the difference
 *                  in the paying rate with a 95% interval (Newcombe's method, which behaves at small
 *                  numbers). "Too early to tell" until both groups are large enough to say anything.
 *   costs(month)   what the month cost: AI, WhatsApp and voice from their meters, vendor profiles,
 *                  and the fixed costs in config/monitor.json; per shortlisted company, per engaged
 *                  company and per paying client.
 *   channels(now)  bounce and complaint rates per mailbox with today's cap, WhatsApp templates and
 *                  their quality, calls and their outcomes, replies by label.
 *
 * Everything is read from `activities`, the one log of what happened, so the page can never
 * disagree with what was sent or received.
 */

const DAY = 86_400_000;
const Z = 1.959964;
const VENDOR_PROFILE_INR = 5;      // the vendor's full profile (ingest/src/leadengine/enrich/infyner.py COST_INR)

/** Wilson score interval for k of n. */
export function wilson(k, n) {
  if (!n) return [0, 1];
  const p = k / n;
  const d = 1 + (Z * Z) / n;
  const c = (p + (Z * Z) / (2 * n)) / d;
  const h = (Z * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/** The difference p1 - p2 of two proportions, with Newcombe's hybrid score interval (method 10). */
export function difference(k1, n1, k2, n2) {
  const p1 = n1 ? k1 / n1 : 0;
  const p2 = n2 ? k2 / n2 : 0;
  const [l1, u1] = wilson(k1, n1);
  const [l2, u2] = wilson(k2, n2);
  const d = p1 - p2;
  return { diff: d, low: d - Math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2), high: d + Math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2) };
}

const monthBounds = (month) => {
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return [new Date(`${month}-01T00:00:00+05:30`), new Date(`${next}-01T00:00:00+05:30`)];
};

async function companiesWith(db, ids, types) {
  if (!ids.length) return new Map();
  const rows = await db.collection('activities').aggregate([
    { $match: { company_id: { $in: ids }, type: { $in: types } } },
    { $group: { _id: { t: '$type', c: '$company_id' }, revenue: { $sum: { $ifNull: ['$data.amount_paise', 0] } } } },
  ]).toArray();
  const out = new Map(types.map((t) => [t, { companies: 0, revenue_paise: 0 }]));
  for (const r of rows) {
    const o = out.get(r._id.t);
    o.companies += 1;
    o.revenue_paise += r.revenue;
  }
  return out;
}

/** The month's shortlist against its holdout. */
export async function lift(db, { month }) {
  const [shortlisted, holdout] = await Promise.all([
    db.collection('leads').find({ 'shortlist.month': month, holdout: false }, { projection: { company_id: 1 } }).toArray(),
    db.collection('leads').find({ 'shortlist.month': month, holdout: true }, { projection: { company_id: 1 } }).toArray(),
  ]);
  const types = ['sent', 'opened', 'replied', 'claimed', 'signed_up', 'service_request', 'paid'];
  const [a, b] = await Promise.all([companiesWith(db, shortlisted.map((l) => l.company_id), types), companiesWith(db, holdout.map((l) => l.company_id), types)]);
  const group = (n, m) => ({
    companies: n, contacted: m.get('sent').companies, opened: m.get('opened').companies, replied: m.get('replied').companies, claimed: m.get('claimed').companies,
    signed_up: m.get('signed_up').companies, service_request: m.get('service_request').companies, paid: m.get('paid').companies, revenue_paise: m.get('paid').revenue_paise,
  });
  const g1 = group(shortlisted.length, a);
  const g2 = group(holdout.length, b);
  const paying = difference(g1.paid, g1.companies, g2.paid, g2.companies);
  const signing = difference(g1.signed_up, g1.companies, g2.signed_up, g2.companies);
  // the design (7.4) expects about 20 holdout companies a month: one month alone will rarely say anything
  const enough = g2.companies >= 30 && g1.paid + g2.paid >= 10;
  const verdict = !enough ? 'too_early'
    : paying.low > 0 ? 'lift' : paying.high < 0 ? 'worse' : 'no_clear_difference';
  return { month, contacted: g1, holdout: g2, paying, signing, enough, verdict };
}

/** The shortlist months there are, newest first. */
export async function shortlistMonths(db) {
  return (await db.collection('leads').distinct('shortlist.month', { 'shortlist.month': { $type: 'string' } })).sort().reverse();
}

/** What a month cost and what it cost per result. `fixed`: config/monitor.json fixed_costs_inr_per_month. */
export async function costs(db, { month, fixed = [] }) {
  const [from, to] = monthBounds(month);
  const meter = async (name) => (await db.collection('usage').findOne({ _id: `${name}:${month}` }))?.count ?? 0;
  const [llm, whatsapp, voice, profiles] = await Promise.all([meter('llm_paise'), meter('whatsapp_paise'), meter('voice_paise'), meter('vendor.full_profile')]);
  const variable = [
    { item: 'AI (LLM gateway)', inr: llm / 100 },
    { item: 'WhatsApp templates', inr: whatsapp / 100 },
    { item: 'AI voice calls', inr: voice / 100 },
    { item: `Company profiles (${profiles} at ₹${VENDOR_PROFILE_INR})`, inr: profiles * VENDOR_PROFILE_INR },
  ];
  const lines = [...variable, ...fixed.map((f) => ({ item: f.item, inr: f.inr, fixed: true }))];
  const total = lines.reduce((n, l) => n + l.inr, 0);
  const inMonth = { at: { $gte: from, $lt: to } };
  const [shortlisted, engaged, paying] = await Promise.all([
    db.collection('leads').countDocuments({ 'shortlist.month': month, holdout: false }),
    db.collection('activities').distinct('company_id', { ...inMonth, holdout: { $ne: true }, $or: [{ type: { $in: ['replied', 'claimed', 'call_requested'] } }, { type: 'call_completed', 'data.status': 'connected' }] }),
    db.collection('activities').distinct('company_id', { ...inMonth, type: 'paid', holdout: { $ne: true } }),
  ]);
  const per = (n) => (n ? Math.round((total / n) * 100) / 100 : null);
  return { month, lines, total_inr: Math.round(total * 100) / 100,
    per_shortlisted_inr: per(shortlisted), per_engaged_inr: per(engaged.length), per_paying_inr: per(paying.length),
    counts: { shortlisted, engaged: engaged.length, paying: paying.length } };
}

/** Channel health: mailboxes, WhatsApp templates, calls and replies over the last 30 days. */
export async function channels(db, { caps, clock = () => new Date() }) {
  const now = clock();
  const budget = new ContactBudget(db, caps, { clock });
  const since = new Date(now.getTime() - 30 * DAY);
  const mailboxes = [];
  for (const id of caps.email.mailbox_ids) {
    const h = await budget.mailboxHealth(id, now);
    const e = caps.email;
    mailboxes.push({ id, ...h, sent_today: await budget.mailboxSentToday(id, now), cap_today: budget.mailboxCap(now), warmup_day: budget.warmupDay(now),
      paused: h.bouncePct > e.pause_if_bounce_pct_above || h.complaintPct > e.pause_if_complaint_pct_above,
      limits: { bounce_pct: e.pause_if_bounce_pct_above, complaint_pct: e.pause_if_complaint_pct_above } });
  }
  const [templates, calls, outcomes, replies, opens] = await Promise.all([
    db.collection('channel_templates').find({}).sort({ _id: 1 }).toArray(),
    db.collection('calls').aggregate([{ $match: { created_at: { $gte: since } } }, { $group: { _id: '$status', n: { $sum: 1 }, seconds: { $sum: { $ifNull: ['$duration_s', 0] } } } }]).toArray(),
    db.collection('calls').aggregate([{ $match: { created_at: { $gte: since }, outcome: { $type: 'string' } } }, { $group: { _id: '$outcome', n: { $sum: 1 } } }]).toArray(),
    db.collection('inbound').aggregate([{ $match: { received_at: { $gte: since } } }, { $group: { _id: { k: '$kind', l: '$label' }, n: { $sum: 1 } } }]).toArray(),
    db.collection('activities').countDocuments({ type: 'opened', at: { $gte: since } }),
  ]);
  return {
    month: istMonth(now), mailboxes,
    whatsapp: templates.map((t) => ({ name: t.name, language: t.language, status: t.status, quality: t.quality ?? null, synced_at: t.synced_at })),
    calls: Object.fromEntries(calls.map((c) => [c._id, { n: c.n, seconds: c.seconds }])),
    call_outcomes: Object.fromEntries(outcomes.map((o) => [o._id, o.n])),
    inbound: replies.map((r) => ({ kind: r._id.k, label: r._id.l ?? null, n: r.n })),
    page_opens_30d: opens,
  };
}

/**
 * Each campaign (config/outreach.json campaigns, public/campaigns.js): the companies whose page was
 * opened and claimed from its landing page, and the platform's sign-ups and payments whose first or
 * last touch came from it, with the revenue. Campaign pages are open to every company, holdout ones
 * included, so these are counts, not a measured lift.
 */
export async function campaignResults(db, { campaigns = [] } = {}) {
  const keys = campaigns.map((c) => `campaign:${c.code}`);
  if (!keys.length) return [];
  const [acts, platform] = await Promise.all([
    db.collection('activities').aggregate([
      { $match: { campaign: { $in: keys }, type: { $in: ['opened', 'claimed'] } } },
      { $group: { _id: { c: '$campaign', t: '$type' }, companies: { $addToSet: '$company_id' } } },
    ]).toArray(),
    db.collection('activities').find({ channel: 'platform', type: { $in: ['signed_up', 'paid'] },
      $or: [{ 'data.attribution.first_touch.campaign': { $in: keys } }, { 'data.attribution.last_touch.campaign': { $in: keys } }] },
    { projection: { type: 1, company_id: 1, 'data.amount_paise': 1, 'data.attribution.first_touch.campaign': 1, 'data.attribution.last_touch.campaign': 1 } }).toArray(),
  ]);
  return campaigns.map((c) => {
    const key = `campaign:${c.code}`;
    const n = (t) => acts.find((a) => a._id.c === key && a._id.t === t)?.companies.length ?? 0;
    const mine = platform.filter((e) => e.data?.attribution?.first_touch?.campaign === key || e.data?.attribution?.last_touch?.campaign === key);
    const paid = mine.filter((e) => e.type === 'paid');
    return { code: c.code, name: c.name, channel: c.channel ?? null, active: c.active !== false, opened: n('opened'), claimed: n('claimed'),
      signed_up: new Set(mine.filter((e) => e.type === 'signed_up').map((e) => e.company_id)).size, paid: paid.length,
      revenue_paise: paid.reduce((a, e) => a + (e.data?.amount_paise ?? 0), 0) };
  });
}

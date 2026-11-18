import { buildEmail } from '../outreach/mime.js';
import { istDate } from '../outreach/evidence.js';
import { istMonth } from '../outreach/meter.js';
import { costs } from '../attribution/results.js';

/**
 * The daily summary for the team (design 7.10): what happened yesterday (IST), what waits for a
 * person, the month's spending against its caps and the open alerts. Plain text, with counts and no
 * personal data: company names appear only where a person must act.
 */

const DAY = 86_400_000;

export async function buildSummary(db, { caps, monitorCfg, clock = () => new Date() }) {
  const now = clock();
  const today = istDate(now);
  const from = new Date(new Date(`${today}T00:00:00+05:30`).getTime() - DAY);
  const to = new Date(`${today}T00:00:00+05:30`);
  const yesterday = istDate(from);
  const acts = await db.collection('activities').aggregate([
    { $match: { at: { $gte: from, $lt: to } } },
    { $group: { _id: { t: '$type', c: '$channel' }, n: { $sum: 1 }, paise: { $sum: { $ifNull: ['$data.amount_paise', 0] } } } },
  ]).toArray();
  const n = (type, channel = null) => acts.filter((a) => a._id.t === type && (!channel || a._id.c === channel)).reduce((s, a) => s + a.n, 0);
  const revenue = acts.filter((a) => a._id.t === 'paid').reduce((s, a) => s + a.paise, 0);
  const [waitingDrafts, waitingReplies, waitingCalls, unknown, labels, alerts, month, waitingExports] = await Promise.all([
    db.collection('messages').countDocuments({ status: { $in: ['awaiting_approval', 'qc_failed'] } }),
    db.collection('inbound').find({ status: 'needs_person' }).sort({ received_at: 1 }).limit(10).toArray(),
    db.collection('calls').countDocuments({ $or: [{ status: { $in: ['blocked', 'failed', 'unknown'] } }, { outcome: { $in: ['interested', 'wants_person', 'call_later'] } }], 'handled.at': { $exists: false } }),
    db.collection('messages').countDocuments({ status: 'send_unknown' }),
    db.collection('inbound').aggregate([{ $match: { received_at: { $gte: from, $lt: to }, kind: 'reply' } }, { $group: { _id: '$label', n: { $sum: 1 } } }]).toArray(),
    db.collection('alerts').find({ status: 'open' }).sort({ severity: 1 }).toArray(),
    costs(db, { month: istMonth(now), fixed: monitorCfg.fixed_costs_inr_per_month ?? [] }),
    db.collection('exports').countDocuments({ status: 'requested' }),
  ]);
  const names = new Map((await db.collection('companies').find({ _id: { $in: waitingReplies.map((r) => r.matched?.company_id).filter(Boolean) } }, { projection: { name: 1 } }).toArray()).map((c) => [c._id, c.name]));
  const usage = async (m) => (await db.collection('usage').findOne({ _id: `${m}:${istMonth(now)}` }))?.count ?? 0;
  const lines = [
    `Lead engine, ${yesterday}`,
    '',
    'Yesterday',
    `  emails drafted ${n('drafted')}, approved ${n('approved')}, sent ${n('sent', 'email')}`,
    `  bounces ${n('bounced')}, complaints ${n('complained')}, unsubscribes ${n('unsubscribed')}`,
    `  replies ${n('replied')}${labels.length ? ` (${labels.map((l) => `${String(l._id ?? 'unlabelled').replace('_', ' ')} ${l.n}`).join(', ')})` : ''}`,
    `  company pages opened ${n('opened')}, claimed ${n('claimed')}, call backs asked for ${n('call_requested')}, calls ${n('call_completed')}`,
    `  reminders sent ${n('sent', 'whatsapp')} on WhatsApp`,
    `  sign-ups ${n('signed_up')}, service requests ${n('service_request')}, payments ${n('paid')}${revenue ? ` (₹${(revenue / 100).toLocaleString('en-IN')})` : ''}`,
    '',
    'Waiting for a person',
    `  drafts to approve: ${waitingDrafts}`,
    `  replies to answer: ${waitingReplies.length}${waitingReplies.length ? `, oldest from ${names.get(waitingReplies[0].matched?.company_id) ?? 'an unknown sender'}` : ''}`,
    `  call backs to make or follow up: ${waitingCalls}`,
    ...(unknown ? [`  emails whose send was interrupted: ${unknown}`] : []),
    ...(waitingExports ? [`  exports waiting for an admin's approval: ${waitingExports}`] : []),
    '',
    `This month (${month.month})`,
    `  spent ₹${month.total_inr.toLocaleString('en-IN')} so far; AI ₹${((await usage('llm_paise')) / 100).toFixed(2)} of ₹${caps.monthly?.llm_spend_inr ?? 0}, WhatsApp ₹${((await usage('whatsapp_paise')) / 100).toFixed(2)} of ₹${caps.monthly?.whatsapp_spend_inr ?? 0}, AI calls ${await usage('voice_calls')} of ${caps.monthly?.voice_calls ?? 0}, company profiles ${await usage('vendor.full_profile')} of ${caps.monthly?.paid_profile_lookups ?? 0}`,
    `  per paying client: ${month.per_paying_inr === null ? 'none yet' : `₹${month.per_paying_inr.toLocaleString('en-IN')}`}`,
    '',
    alerts.length ? 'Open alerts' : 'No open alerts.',
    ...alerts.map((a) => `  ${a.severity.toUpperCase()}: ${a.message}`),
    '',
    'Details: the Admin pages (Approvals, Inbox, Calls, Results, Data health).',
  ];
  return { subject: `Lead engine ${yesterday}: ${n('sent', 'email')} sent, ${n('replied')} replies, ${alerts.length} alert(s)`, text: lines.join('\n') };
}

/**
 * Sends the summary to `to` (a list of addresses) through the outreach transport, from `mailbox`
 * (outbox mode writes it to a file). Not logged as an outreach email: it goes to the team only.
 */
export async function sendSummary({ summary, to, mailbox, transport, clock = () => new Date() }) {
  const results = [];
  for (const address of to) {
    const email = buildEmail({ from: { name: 'Lead engine', address: mailbox.address ?? 'lead-engine@localhost' }, to: { name: null, address },
      subject: summary.subject, text: summary.text, unsubscribe: null, at: clock() });
    results.push(await transport.send({ raw: email.raw, messageId: email.messageId, mailbox, to: address }));
  }
  return results;
}

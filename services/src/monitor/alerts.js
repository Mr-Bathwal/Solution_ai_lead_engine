import { readdir } from 'node:fs/promises';
import { ConsentLedger } from '../consent/ledger.js';
import { samplingState } from '../outreach/sampling.js';
import { ContactBudget } from '../outreach/budget.js';
import { istMonth } from '../outreach/meter.js';

/**
 * Monitoring (design 7.10), run every hour by `lead-engine monitor`. Each check below returns the
 * problems it sees now; each problem is an alert keyed on what it is about, so a problem that lasts
 * is one alert (last_seen_at moves on), one that goes away is resolved, and one that comes back is
 * reopened. Checks:
 *
 *   jobs       dead in the last 24 hours; pending and overdue (the worker is not running)
 *   queues     the oldest draft waiting for approval, reply waiting for a person, call waiting for a person
 *   email      bounce and complaint rates per mailbox, warned below the pause limits; a mailbox
 *              paused; messages whose send was interrupted
 *   whatsapp   a template paused, disabled or rejected by Meta, or its quality falling
 *   caps       a monthly cap mostly used
 *   runs       the nightly batch and the weekly portal crawls stale, partial or failed
 *   data       last month's MCA file not loaded by the due day; an uploaded MCA file that could not be read
 *   exports    a bulk export waiting for a second admin
 *   approval   sample mode configured but not in force (too few decisions, or the check agrees too little)
 *   backups    the newest full (nightly) or critical (hourly) backup too old, where backups are kept
 *   llm        failed AI calls
 *   ledger     the consent ledger's hash chain does not verify
 *
 * The result is also printed as one JSON line (in CloudWatch's embedded-metric shape). The CloudWatch
 * agent ships the monitor's log, and a metric filter on it turns OpenAlertsCritical into a metric
 * and an alarm (ops/deploy/README.md), without any AWS call from the engine.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const age = (d, now) => (d ? (now - d) / HOUR : 0);

export async function checks(db, { caps, cfg, secret, clock = () => new Date(), backupDir = null, outreachCfg = null }) {
  const now = clock();
  const found = [];
  const add = (id, kind, severity, message, value = null, threshold = null) => found.push({ _id: id, kind, severity, message, value, threshold });

  // ---- jobs ------------------------------------------------------------------------------------------
  const [dead, overdue] = await Promise.all([
    db.collection('jobs').aggregate([{ $match: { status: 'dead', finished_at: { $gte: new Date(now - DAY) } } }, { $group: { _id: '$type', n: { $sum: 1 }, last: { $first: '$last_error' } } }]).toArray(),
    db.collection('jobs').countDocuments({ status: 'pending', due_at: { $lt: new Date(now - cfg.jobs.overdue_minutes_critical * 60_000) } }),
  ]);
  for (const d of dead) {
    if (d.n >= cfg.jobs.dead_in_24h_warn) add(`jobs.dead.${d._id}`, 'jobs', 'warn', `${d.n} ${d._id} job(s) failed for good in the last day${d.last ? `: ${String(d.last).slice(0, 120)}` : ''}`, d.n, cfg.jobs.dead_in_24h_warn);
  }
  if (overdue) add('jobs.overdue', 'jobs', 'critical', `${overdue} job(s) are more than ${cfg.jobs.overdue_minutes_critical} minutes overdue: is the worker running?`, overdue, 0);

  // ---- queues ------------------------------------------------------------------------------------------
  const [oldestDraft, oldestReply, oldestCall, unknown] = await Promise.all([
    db.collection('messages').find({ status: { $in: ['awaiting_approval', 'qc_failed'] } }).sort({ created_at: 1 }).limit(1).next(),
    db.collection('inbound').find({ status: 'needs_person' }).sort({ received_at: 1 }).limit(1).next(),
    db.collection('calls').find({ $or: [{ status: { $in: ['blocked', 'failed', 'unknown'] } }, { outcome: { $in: ['interested', 'wants_person', 'call_later'] } }],
      'handled.at': { $exists: false } }).sort({ updated_at: 1 }).limit(1).next(),
    db.collection('messages').countDocuments({ status: 'send_unknown' }),
  ]);
  const q = cfg.queues;
  if (age(oldestDraft?.created_at, now) > q.approval_oldest_hours_warn) add('queue.approvals', 'queues', 'warn', `a draft has waited ${Math.floor(age(oldestDraft.created_at, now))} hours for approval`, Math.floor(age(oldestDraft.created_at, now)), q.approval_oldest_hours_warn);
  if (age(oldestReply?.received_at, now) > q.inbox_oldest_hours_warn) add('queue.inbox', 'queues', 'warn', `a reply has waited ${Math.floor(age(oldestReply.received_at, now))} hours for a person`, Math.floor(age(oldestReply.received_at, now)), q.inbox_oldest_hours_warn);
  if (age(oldestCall?.updated_at, now) > q.calls_oldest_hours_warn) add('queue.calls', 'queues', 'warn', `a call back has waited ${Math.floor(age(oldestCall.updated_at, now))} hours for a person`, Math.floor(age(oldestCall.updated_at, now)), q.calls_oldest_hours_warn);
  if (unknown) add('email.send_unknown', 'email', 'warn', `${unknown} email(s) had their send interrupted: check the Sent folder and settle them on the message's page`, unknown, 0);

  // ---- email health ------------------------------------------------------------------------------------------
  const budget = new ContactBudget(db, caps, { clock });
  for (const id of caps.email.mailbox_ids) {
    const h = await budget.mailboxHealth(id, now);
    const e = caps.email;
    if (h.bouncePct > e.pause_if_bounce_pct_above) add(`email.paused.bounces.${id}`, 'email', 'critical', `${id} is paused: ${h.bouncePct.toFixed(1)}% hard bounces in 30 days (limit ${e.pause_if_bounce_pct_above}%)`, h.bouncePct, e.pause_if_bounce_pct_above);
    else if (h.bouncePct > cfg.email.bounce_pct_warn) add(`email.bounces.${id}`, 'email', 'warn', `${id}: ${h.bouncePct.toFixed(1)}% hard bounces in 30 days, near the ${e.pause_if_bounce_pct_above}% pause`, h.bouncePct, cfg.email.bounce_pct_warn);
    if (h.complaintPct > e.pause_if_complaint_pct_above) add(`email.paused.complaints.${id}`, 'email', 'critical', `${id} is paused: ${h.complaintPct.toFixed(2)}% complaints in 30 days (limit ${e.pause_if_complaint_pct_above}%)`, h.complaintPct, e.pause_if_complaint_pct_above);
    else if (h.complaintPct > cfg.email.complaint_pct_warn) add(`email.complaints.${id}`, 'email', 'warn', `${id}: ${h.complaintPct.toFixed(2)}% complaints in 30 days, near the ${e.pause_if_complaint_pct_above}% pause`, h.complaintPct, cfg.email.complaint_pct_warn);
  }

  // ---- WhatsApp ------------------------------------------------------------------------------------------
  for (const t of await db.collection('channel_templates').find({}).toArray()) {
    const w = cfg.whatsapp;
    if (w.status_critical.includes(String(t.status).toUpperCase())) add(`whatsapp.status.${t._id}`, 'whatsapp', 'critical', `WhatsApp template ${t.name} (${t.language}) is ${t.status} at Meta: its reminders have stopped`, t.status);
    const quality = String(t.quality ?? '').toUpperCase();
    if (w.quality_critical.includes(quality)) add(`whatsapp.quality.${t._id}`, 'whatsapp', 'critical', `WhatsApp template ${t.name} (${t.language}) has ${t.quality} quality`, t.quality);
    else if (w.quality_warn.includes(quality)) add(`whatsapp.quality.${t._id}`, 'whatsapp', 'warn', `WhatsApp template ${t.name} (${t.language}) quality fell to ${t.quality}`, t.quality);
  }

  // ---- caps ------------------------------------------------------------------------------------------
  const month = istMonth(now);
  const capped = { llm_paise: (caps.monthly?.llm_spend_inr ?? 0) * 100, whatsapp_paise: (caps.monthly?.whatsapp_spend_inr ?? 0) * 100,
    voice_calls: caps.monthly?.voice_calls ?? 0, voice_minutes: caps.monthly?.voice_minutes ?? 0, 'vendor.full_profile': caps.monthly?.paid_profile_lookups ?? 0 };
  for (const [m, cap] of Object.entries(capped)) {
    const used = (await db.collection('usage').findOne({ _id: `${m}:${month}` }))?.count ?? 0;
    const pct = cap ? (100 * used) / cap : 0;
    if (cap && pct >= cfg.caps.used_pct_warn) add(`caps.${m}`, 'caps', 'warn', `${m.replace(/[._]/g, ' ')}: ${Math.round(pct)}% of this month's cap is used`, Math.round(pct), cfg.caps.used_pct_warn);
  }

  // ---- runs ------------------------------------------------------------------------------------------
  for (const [source, staleHours] of Object.entries(cfg.runs.stale_hours)) {
    const run = await db.collection('ingest_runs').find({ source }).sort({ started_at: -1 }).limit(1).next();
    if (!run) continue;
    const when = run.started_at.toISOString().slice(0, 16).replace('T', ' ');
    if (run.status === 'failed') add(`runs.failed.${source}`, 'runs', 'critical', `the last ${source} run failed (${when} UTC)`, run.status);
    else if (run.status === 'partial') add(`runs.partial.${source}`, 'runs', 'warn', `the last ${source} run was partial (${when} UTC): some steps or pages failed`, run.status);
    if (age(run.started_at, now) > staleHours) add(`runs.stale.${source}`, 'runs', 'warn', `no ${source} run for ${Math.floor(age(run.started_at, now))} hours: is it scheduled?`, Math.floor(age(run.started_at, now)), staleHours);
  }

  // ---- data: MCA's monthly file -------------------------------------------------------------------
  const d = cfg.data ?? {};
  const istNow = new Date(now.getTime() + 5.5 * HOUR);
  const prevMonth = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  if (d.mca_file_due_day_ist && istNow.getUTCDate() >= d.mca_file_due_day_ist
      && !(await db.collection('companies').countDocuments({ cohort: prevMonth }, { limit: 1 }))) {
    add(`data.mca_file.${prevMonth}`, 'data', 'warn', `no companies incorporated in ${prevMonth} yet: download MCA's monthly file and upload it on Data health, MCA file`, 0, d.mca_file_due_day_ist);
  }
  const badFiles = await db.collection('ingest_runs').find({ source: 'mca_monthly', status: 'failed', 'params.via': 'inbox', started_at: { $gte: new Date(now - 7 * DAY) } })
    .sort({ started_at: -1 }).limit(3).toArray();
  for (const r of badFiles) {
    add(`data.mca_failed.${r._id}`, 'data', 'warn', `the MCA file ${r.params.file} could not be loaded (${String(r.notes?.at(-1) ?? 'see the run').slice(0, 120)}); it is in the inbox's failed folder`, r.params.file);
  }

  // ---- sample approval configured but suspended ---------------------------------------------------------
  if (outreachCfg?.approval?.mode === 'sample') {
    const s = await samplingState(db, outreachCfg, { clock });
    if (!s.active) add('approval.sampling', 'queues', 'warn', `sample approval is configured but not in force, so every draft goes to a person: ${s.reason}`, s.agreement?.pct ?? null, s.needs.agreement_pct);
  }

  // ---- exports waiting for a second admin --------------------------------------------------------------
  const oldestExport = await db.collection('exports').find({ status: 'requested' }).sort({ requested_at: 1 }).limit(1).next();
  if (q.export_oldest_hours_warn && age(oldestExport?.requested_at, now) > q.export_oldest_hours_warn) {
    add('queue.exports', 'queues', 'warn', `an export asked for by ${oldestExport.requested_by} has waited ${Math.floor(age(oldestExport.requested_at, now))} hours for an admin`, Math.floor(age(oldestExport.requested_at, now)), q.export_oldest_hours_warn);
  }

  // ---- backups (only where the backup folder exists: the server) -----------------------------------
  const names = backupDir && cfg.backups ? await readdir(backupDir).catch(() => null) : null;
  if (names) {
    for (const [kind, hours] of [['full', cfg.backups.full_stale_hours], ['critical', cfg.backups.critical_stale_hours]]) {
      const newest = names.filter((n) => n.endsWith(`-${kind}`)).sort().at(-1);
      const m = newest && /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(newest);
      const taken = m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) : null;
      if (!taken || age(taken, now) > hours) {
        add(`backups.${kind}`, 'backups', 'warn', taken ? `the newest ${kind} backup is ${Math.floor(age(taken, now))} hours old: is the backup cron running? (backup.log)`
          : `no ${kind} backup in ${backupDir}: is the backup cron running?`, taken ? Math.floor(age(taken, now)) : null, hours);
      }
    }
  }

  // ---- AI ------------------------------------------------------------------------------------------
  const failedCalls = await db.collection('llm_calls').countDocuments({ ok: false, at: { $gte: new Date(now - DAY) } });
  if (failedCalls >= cfg.llm.failed_calls_24h_warn) add('llm.failed', 'llm', 'warn', `${failedCalls} AI calls failed in the last day; drafts fall back to the templates`, failedCalls, cfg.llm.failed_calls_24h_warn);

  // ---- consent ledger ------------------------------------------------------------------------------------------
  if (secret && secret.length >= 32) {
    const v = await new ConsentLedger(db, { secret, clock }).verify({ maxProblems: 5 });
    if (!v.ok) add('ledger.verify', 'ledger', 'critical', `the consent ledger does not verify: ${JSON.stringify(v.problems?.[0] ?? v).slice(0, 200)}`, false);
  }
  return found;
}

/**
 * Runs the checks and updates `alerts`. Returns { open: [...], opened: [...], resolved: n }. `opened`
 * holds the alerts that are new or came back, the ones worth telling someone about at once.
 */
export async function runMonitor(db, opts) {
  const clock = opts.clock ?? (() => new Date());
  const now = clock();
  const found = await checks(db, opts);
  const col = db.collection('alerts');
  const opened = [];
  for (const a of found) {
    const prev = await col.findOne({ _id: a._id });
    await col.updateOne({ _id: a._id }, {
      $set: { kind: a.kind, severity: a.severity, status: 'open', message: a.message, value: a.value, threshold: a.threshold, last_seen_at: now, resolved_at: null },
      $setOnInsert: { first_seen_at: now, notified_at: null },
    }, { upsert: true });
    if (!prev || prev.status === 'resolved') opened.push(a);
    if (prev?.status === 'resolved') await col.updateOne({ _id: a._id }, { $set: { first_seen_at: now } });
  }
  const r = await col.updateMany({ status: 'open', _id: { $nin: found.map((a) => a._id) } }, { $set: { status: 'resolved', resolved_at: now } });
  const open = await col.find({ status: 'open' }).sort({ severity: 1, last_seen_at: -1 }).toArray();
  return { open, opened, resolved: r.modifiedCount };
}

/** One CloudWatch embedded-metric-format line for the monitor's log. */
export function emfLine(result, { at = new Date(), namespace = 'LeadEngine' } = {}) {
  const count = (sev) => result.open.filter((a) => a.severity === sev).length;
  const metrics = { OpenAlertsCritical: count('critical'), OpenAlertsWarn: count('warn'), AlertsOpened: result.opened.length };
  return JSON.stringify({
    _aws: { Timestamp: at.getTime(), CloudWatchMetrics: [{ Namespace: namespace, Dimensions: [[]], Metrics: Object.keys(metrics).map((Name) => ({ Name, Unit: 'Count' })) }] },
    ...metrics,
    alerts: result.open.map((a) => `${a.severity}: ${a.message}`),
  });
}

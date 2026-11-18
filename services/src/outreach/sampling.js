import { randomInt } from 'node:crypto';

/**
 * From approving every draft to approving a sample (design 7.5: "Once the quality check agrees with
 * our reviewers consistently, we move to approving a sample (10–20%)").
 *
 * Agreement is measured on what reviewers actually did, over the last `window_days`:
 *   the check passed and the person approved it as written          agree
 *   the check passed and the person rejected it, or had to edit it  disagree
 *   the check failed and the person rejected it, or had to fix it   agree
 * (the check's own verdict is the draft's first status, kept in its history).
 *
 * Sample mode (config/outreach.json approval.mode = "sample") takes effect only while
 *   - at least `min_decisions` person decisions are in the window,
 *   - agreement is at least `min_agreement_pct`, and
 *   - a person has recorded switching it on (`switched_on_by`, `switched_on_on`).
 * Otherwise every draft goes to a person, whatever the mode says, and the monitor says why.
 * In sample mode `sample_pct` of the drafts that pass the check still go to a person, picked at
 * random, which keeps the measurement going; the rest are approved by "engine:sample", audited like
 * any approval. The compliance gate checks every send either way.
 */

export const SAMPLE_USER = Object.freeze({ email: 'engine:sample', role: 'system', via: 'engine' });
const DAY = 86_400_000;

export async function agreement(db, { windowDays = 60, clock = () => new Date() } = {}) {
  const since = new Date(clock().getTime() - windowDays * DAY);
  const rows = await db.collection('messages').find(
    { 'approval.at': { $gte: since }, 'approval.decision': { $in: ['approved', 'rejected'] }, 'approval.by': { $ne: SAMPLE_USER.email } },
    { projection: { kind: 1, approval: 1, 'history.status': 1 } },
  ).toArray();
  let agree = 0;
  const byKind = {};
  for (const m of rows) {
    const checkPassed = m.history?.[0]?.status === 'awaiting_approval';
    const approvedAsWritten = m.approval.decision === 'approved' && !m.approval.edited;
    const ok = checkPassed ? approvedAsWritten : !approvedAsWritten;
    if (ok) agree += 1;
    byKind[m.kind] ??= { decided: 0, agree: 0 };
    byKind[m.kind].decided += 1;
    if (ok) byKind[m.kind].agree += 1;
  }
  return { decided: rows.length, agree, pct: rows.length ? Math.round((agree / rows.length) * 1000) / 10 : null, window_days: windowDays, by_kind: byKind };
}

/** Whether drafts are being sampled now, and why or why not. */
export async function samplingState(db, cfg, { clock = () => new Date() } = {}) {
  const a = cfg.approval ?? {};
  const ev = a.evidence ?? {};
  const base = { mode: a.mode ?? 'all', sample_pct: a.sample_pct ?? 20, kinds: a.sample_kinds ?? ['first_touch', 'follow_up', 'new_need'],
    needs: { decisions: ev.min_decisions ?? 100, agreement_pct: ev.min_agreement_pct ?? 95 } };
  if (base.mode !== 'sample') return { ...base, active: false, reason: 'every draft is approved by a person (approval.mode is "all")' };
  const measured = await agreement(db, { windowDays: ev.window_days ?? 60, clock });
  const out = { ...base, agreement: measured };
  if (!String(a.switched_on_by ?? '').trim() || !/^\d{4}-\d{2}-\d{2}$/.test(String(a.switched_on_on ?? ''))) {
    return { ...out, active: false, reason: 'sample mode is configured but nobody has recorded switching it on (approval.switched_on_by and switched_on_on)' };
  }
  if (measured.decided < base.needs.decisions) {
    return { ...out, active: false, reason: `only ${measured.decided} reviewer decisions in ${measured.window_days} days; sample mode needs ${base.needs.decisions}` };
  }
  if (measured.pct < base.needs.agreement_pct) {
    return { ...out, active: false, reason: `the check agrees with the reviewers on ${measured.pct}% of drafts; sample mode needs ${base.needs.agreement_pct}%` };
  }
  return { ...out, active: true, reason: `${base.sample_pct}% of drafts that pass the check go to a person; the check agrees with the reviewers on ${measured.pct}% of ${measured.decided}` };
}

/** True when this draft is one of the `pct` percent picked for a person. */
export const pickForPerson = (pct, draw = () => randomInt(100)) => draw() < pct;

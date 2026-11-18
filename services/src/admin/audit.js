/**
 * The audit log, readable (design 7.11): every sign-in and refused token, every view of personal
 * data, every decision on a match, an email or a reply, every export, upload, erasure and lifted
 * opt-out, and every platform event refused. Admins only. The log names staff and their addresses,
 * so opening it is itself logged.
 */

export const AUDIT_ACTIONS = ['view_personal', 'export', 'export_request', 'export_decision', 'review_decision', 'approval_decision', 'outcome_recorded',
  'inbound_decision', 'denied', 'sign_in', 'sign_out', 'label_import', 'erasure', 'suppression_lifted', 'upload_mca_file', 'event_received'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const AUDIT_PAGE = 100;

/** The filters from a query string, checked: a bad one is refused, not ignored. */
export function auditFilters(params) {
  const f = {};
  const get = (k) => String(params.get?.(k) ?? params[k] ?? '').trim();
  if (get('action')) {
    if (!AUDIT_ACTIONS.includes(get('action'))) throw new RangeError(`action must be one of ${AUDIT_ACTIONS.join(', ')}`);
    f.action = get('action');
  }
  if (get('actor')) f.actor = get('actor').slice(0, 120);
  for (const k of ['from', 'to']) {
    if (get(k)) {
      if (!DAY.test(get(k))) throw new RangeError(`${k} must be a date, YYYY-MM-DD`);
      f[k] = get(k);
    }
  }
  const page = Number(get('page') || 1);
  f.page = Number.isInteger(page) && page >= 1 && page <= 1000 ? page : 1;
  return f;
}

export async function auditLog(db, f) {
  const q = {};
  if (f.action) q.action = f.action;
  if (f.actor) q.actor = { $regex: `^${f.actor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, $options: 'i' };
  if (f.from || f.to) {
    q.at = {};
    if (f.from) q.at.$gte = new Date(`${f.from}T00:00:00+05:30`);
    if (f.to) q.at.$lt = new Date(Date.parse(`${f.to}T00:00:00+05:30`) + 86_400_000);
  }
  const col = db.collection('audit_log');
  const [total, rows, counts] = await Promise.all([
    col.countDocuments(q),
    col.find(q).sort({ at: -1, _id: -1 }).skip((f.page - 1) * AUDIT_PAGE).limit(AUDIT_PAGE).toArray(),
    col.aggregate([{ $match: { at: { $gte: new Date(Date.now() - 30 * 86_400_000) } } }, { $group: { _id: '$action', n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray(),
  ]);
  return { filters: f, total, page: f.page, size: AUDIT_PAGE, rows: rows.map((r) => ({ id: String(r._id), at: r.at, actor: r.actor, role: r.role ?? null,
    action: r.action, target: r.target ?? null, fields: r.fields ?? null, detail: r.detail ?? null })), last_30_days: counts };
}

/** Opening the log is a view of personal data (staff names, addresses), and is logged like one. */
export async function auditView(db, { user, filters, clock = () => new Date() }) {
  const { page, ...rest } = filters;
  await db.collection('audit_log').insertOne({ at: clock(), actor: user.email, role: user.role, action: 'view_personal',
    target: { type: 'audit_log', id: null }, fields: ['audit_log'], detail: { filters: rest, page } });
}

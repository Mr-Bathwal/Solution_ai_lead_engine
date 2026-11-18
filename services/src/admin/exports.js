import { createHash, randomBytes } from 'node:crypto';
import { STAGES, registeredEmailIsPersonal } from './queries.js';

/** Two sign-ins are the same person whatever the capitals (personal tokens kept them, platform sign-ins did not). */
const sameEmail = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

/**
 * Bulk exports with an admin's approval (design 7.11: "Every view or export of personal data is
 * logged, and bulk export needs an admin's approval").
 *
 *   1. A reviewer or admin asks for a list (filters, up to 20,000 rows) and says why.
 *   2. An admin who is not the person asking approves or rejects it. A request not decided in
 *      7 days expires.
 *   3. The person who asked downloads the CSV, as often as they need, for 24 hours. Every download is
 *      written to audit_log (action "export") with the row count and the columns.
 *
 * What a list can hold is company-level only: the company's facts from the MCA register, its stage
 * and fit, its deadlines and schemes. Holdout companies are never in a list (contacting them would
 * spoil the measurement of what the outreach does). With "include contacts" the company's registered
 * email is added only when it is a company address (not a person's) and not on the suppression list;
 * directors and personal addresses are never exported.
 */

export const EXPORT_MAX_ROWS = 20_000;
const REQUEST_DAYS = 7;
const DOWNLOAD_HOURS = 24;
const MONTH = /^\d{4}-\d{2}$/;

export const EXPORT_COLUMNS = ['cin', 'name', 'incorporated', 'company_type', 'district', 'sector', 'cohort', 'stage', 'fit',
  'shortlist_month', 'shortlist_rank', 'eligible_schemes', 'next_deadline', 'next_deadline_due'];

const newId = () => `exp_${BigInt(`0x${randomBytes(8).toString('hex')}`).toString(36).padStart(12, '0').slice(-12)}`;

/** The filters a request may carry, checked; anything else is refused rather than ignored. */
export function cleanFilters(input = {}) {
  const f = {};
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  if (s(input.stage)) {
    if (!STAGES.includes(s(input.stage))) throw new RangeError(`stage must be one of ${STAGES.join(', ')}`);
    f.stage = s(input.stage);
  }
  for (const k of ['cohort', 'shortlist_month']) {
    if (s(input[k])) {
      if (!MONTH.test(s(input[k]))) throw new RangeError(`${k.replace('_', ' ')} must be a month, YYYY-MM`);
      f[k] = s(input[k]);
    }
  }
  if (s(input.district)) {
    if (s(input.district).length > 60) throw new RangeError('district is too long');
    f.district = s(input.district);
  }
  return f;
}

function leadFilter(f) {
  const q = { holdout: false };                    // never the holdout
  if (f.stage) q.stage = f.stage;
  if (f.cohort) q.cohort = f.cohort;
  if (f.shortlist_month) q['shortlist.month'] = f.shortlist_month;
  return q;
}

async function companyIds(db, f, limit) {
  const leads = await db.collection('leads').find(leadFilter(f), { projection: { company_id: 1 } })
    .sort({ 'shortlist.rank': 1, 'score.fit': -1, company_id: 1 }).limit(f.district ? 0 : limit).toArray();
  let ids = leads.map((l) => l.company_id);
  if (f.district) {
    const re = new RegExp(`^${f.district.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    const inDistrict = new Set((await db.collection('companies').find({ _id: { $in: ids }, $or: [{ 'attrs.registered_district.value': re }, { 'attrs.district.value': re }] },
      { projection: { _id: 1 } }).toArray()).map((c) => c._id));
    ids = ids.filter((id) => inDistrict.has(id)).slice(0, limit);
  }
  return ids;
}

export async function requestExport(db, { user, filters, reason, includeContacts = false, maxRows = 5000, clock = () => new Date() }) {
  const why = String(reason ?? '').trim();
  if (why.length < 10) throw new RangeError('say what the list is for (at least 10 characters): the approving admin needs to know');
  if (why.length > 500) throw new RangeError('keep the reason under 500 characters');
  const max = Number(maxRows);
  if (!Number.isInteger(max) || max < 1 || max > EXPORT_MAX_ROWS) throw new RangeError(`rows must be a whole number from 1 to ${EXPORT_MAX_ROWS.toLocaleString('en-IN')}`);
  const f = cleanFilters(filters);
  const estimate = (await companyIds(db, f, max)).length;
  const now = clock();
  const doc = { _id: newId(), status: 'requested', requested_by: user.email, requested_role: user.role, reason: why, filters: f,
    include_contacts: Boolean(includeContacts), max_rows: max, estimate, requested_at: now, decided_by: null, decided_at: null,
    decision_note: null, download_until: null, downloads: [] };
  await db.collection('audit_log').insertOne({ at: now, actor: user.email, role: user.role, action: 'export_request',
    target: { type: 'export', id: doc._id }, fields: includeContacts ? ['registered_email'] : null,
    detail: { filters: f, estimate, max_rows: max, include_contacts: doc.include_contacts, via: user.via } });
  await db.collection('exports').insertOne(doc);
  return doc;
}

/** Requests older than a week are closed: a list nobody approved in time is asked for again. */
async function expireOld(db, now) {
  await db.collection('exports').updateMany({ status: 'requested', requested_at: { $lt: new Date(now.getTime() - REQUEST_DAYS * 86_400_000) } },
    { $set: { status: 'expired' } });
}

export async function decideExport(db, { id, user, decision, note = '', clock = () => new Date() }) {
  if (!['approve', 'reject'].includes(decision)) throw new RangeError('decision must be approve or reject');
  const now = clock();
  await expireOld(db, now);
  const ex = await db.collection('exports').findOne({ _id: String(id) });
  if (!ex) throw Object.assign(new RangeError('no such export'), { status: 404 });
  if (ex.status !== 'requested') throw Object.assign(new RangeError(`this export is already ${ex.status}`), { status: 409 });
  if (sameEmail(ex.requested_by, user.email)) throw Object.assign(new RangeError('another admin must decide: nobody approves their own export'), { status: 403 });
  const status = decision === 'approve' ? 'approved' : 'rejected';
  const text = String(note ?? '').trim().slice(0, 500) || null;
  await db.collection('audit_log').insertOne({ at: now, actor: user.email, role: user.role, action: 'export_decision',
    target: { type: 'export', id: ex._id }, fields: null, detail: { decision: status, requested_by: ex.requested_by, note: text, via: user.via } });
  const r = await db.collection('exports').findOneAndUpdate({ _id: ex._id, status: 'requested' }, { $set: { status, decided_by: user.email, decided_at: now,
    decision_note: text, download_until: status === 'approved' ? new Date(now.getTime() + DOWNLOAD_HOURS * 3_600_000) : null } }, { returnDocument: 'after' });
  if (!r) throw Object.assign(new RangeError('someone else decided it a moment ago'), { status: 409 });
  return r;
}

const cell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;              // a spreadsheet must never run a cell as a formula
  return `"${s.replace(/"/g, '""')}"`;
};

function nextDeadline(needs) {
  const open = (needs?.deadlines ?? []).filter((d) => d.due && ['due_soon', 'upcoming'].includes(d.status)).sort((a, b) => String(a.due).localeCompare(String(b.due)));
  return open[0] ?? null;
}

/** The CSV for an approved export, for the person who asked. Every download is logged. */
export async function downloadExport(db, { id, user, suppression = null, clock = () => new Date() }) {
  const now = clock();
  const ex = await db.collection('exports').findOne({ _id: String(id) });
  if (!ex) throw Object.assign(new RangeError('no such export'), { status: 404 });
  if (!sameEmail(ex.requested_by, user.email)) throw Object.assign(new RangeError('only the person who asked for this export can download it'), { status: 403 });
  if (ex.status !== 'approved') throw Object.assign(new RangeError(`this export is ${ex.status}, not approved`), { status: 409 });
  if (ex.download_until < now) throw Object.assign(new RangeError('the 24 hours to download it are over; ask again'), { status: 410 });
  if (ex.include_contacts && !suppression) throw Object.assign(new RangeError('contacts need the suppression list, which is not configured on this server'), { status: 503 });

  const ids = await companyIds(db, ex.filters, ex.max_rows);
  const [companies, leads] = await Promise.all([
    db.collection('companies').find({ _id: { $in: ids } }).toArray(),
    db.collection('leads').find({ company_id: { $in: ids }, holdout: false }).toArray(),
  ]);
  const byId = new Map(companies.map((c) => [c._id, c]));
  const leadOf = new Map(leads.map((l) => [l.company_id, l]));
  const columns = ex.include_contacts ? [...EXPORT_COLUMNS, 'registered_email'] : EXPORT_COLUMNS;
  const lines = [columns.map(cell).join(',')];
  let rows = 0;
  let emails = 0;
  for (const id of ids) {
    const c = byId.get(id);
    const l = leadOf.get(id);
    if (!c || !l) continue;
    const a = c.attrs ?? {};
    const d = nextDeadline(l.needs);
    const row = [c._id, c.name, a.incorporation_date?.value, a.company_type?.value, a.registered_district?.value ?? a.district?.value ?? null,
      l.score?.theme?.name ?? a.sector?.value ?? null, l.cohort ?? c.cohort, l.stage, l.score?.fit, l.shortlist?.month, l.shortlist?.rank,
      (l.needs?.schemes ?? []).filter((x) => x.verdict === 'eligible').length, d?.title ?? null, d?.due ?? null];
    if (ex.include_contacts) {
      const em = a.registered_email;
      let value = null;
      if (em?.value && !registeredEmailIsPersonal(em) && !(await suppression.check({ email: em.value })).length) value = em.value;
      if (value) emails += 1;
      row.push(value);
    }
    lines.push(row.map(cell).join(','));
    rows += 1;
  }
  const csv = `${lines.join('\r\n')}\r\n`;
  const digest = createHash('sha256').update(csv).digest('hex');
  // the download is logged before it is handed over
  await db.collection('audit_log').insertOne({ at: now, actor: user.email, role: user.role, action: 'export',
    target: { type: 'export', id: ex._id }, fields: ex.include_contacts ? ['registered_email'] : null,
    detail: { rows, columns, company_emails: ex.include_contacts ? emails : null, sha256: digest, approved_by: ex.decided_by, via: user.via } });
  await db.collection('exports').updateOne({ _id: ex._id }, { $push: { downloads: { at: now, rows, sha256: digest } } });
  return { filename: `solutionai-leads-${ex._id}.csv`, csv, rows };
}

export async function exportList(db, { clock = () => new Date() } = {}) {
  await expireOld(db, clock());
  const items = await db.collection('exports').find({}).sort({ requested_at: -1 }).limit(50).toArray();
  return { items, waiting: items.filter((x) => x.status === 'requested').length, columns: EXPORT_COLUMNS, max_rows: EXPORT_MAX_ROWS, stages: STAGES };
}

import { ObjectId } from 'mongodb';
import { sha256 } from '../util/canonical.js';
import { qualityCheck } from './qc.js';
import { knownNames } from '../inbound/process.js';

/**
 * Every outreach message's life, in `messages` (design 7.5):
 *
 *   qc_failed | awaiting_approval --(a person)--> approved | rejected
 *   approved --(send job: compliance gate)--> sending --> sent | bounced | send_unknown
 *   approved --(gate says never)--> blocked;  awaiting_approval | approved --(too old)--> expired
 *
 * A person's approval records a hash of exactly the subject and body they approved; the sender
 * refuses anything whose text no longer matches it. Every status change is appended to `history`,
 * every decision is written to audit_log before it is saved, and drafted, approved and rejected
 * messages are logged in `activities` like every other touch.
 */

export const approvedHash = (subject, body) => sha256(`${subject}\n\n${body}`);
const OPEN = ['qc_failed', 'awaiting_approval', 'approved'];

export class MessageStore {
  constructor(db, { clock = () => new Date() } = {}) {
    this.db = db;
    this.col = db.collection('messages');
    this.activities = db.collection('activities');
    this.audit = db.collection('audit_log');
    this.clock = clock;
  }

  static idemKey(companyId, kind, needId = null) {
    return `msg:${companyId}:${kind}${needId ? `:${needId}` : ''}`;
  }

  byId(id) {
    return this.col.findOne({ _id: typeof id === 'string' ? new ObjectId(id) : id });
  }

  /** Stores a new draft. Returns { created, message }; a second draft for the same idem_key is not stored. */
  async create({ companyId, leadId, kind, language, recipient, mailbox, evidence, draft, expiresAt, needId = null }) {
    const now = this.clock();
    const status = draft.qc.passed ? 'awaiting_approval' : 'qc_failed';
    const doc = {
      idem_key: MessageStore.idemKey(companyId, kind, needId), company_id: companyId, lead_id: leadId ?? null, kind, channel: 'email', need_id: needId,
      language, status, recipient, mailbox, evidence,
      draft: { subject: draft.subject, body: draft.body, drafter: draft.drafter, prompt_version: draft.prompt_version ?? null, model: draft.model ?? null, tries: draft.tries ?? [] },
      qc: draft.qc, approval: null, gate: null, send: null,
      history: [{ at: now, status, by: 'engine', note: `${draft.drafter} draft` }],
      expires_at: expiresAt, created_at: now, updated_at: now,
    };
    try {
      const r = await this.col.insertOne(doc);
      await this.activities.insertOne({ at: now, type: 'drafted', channel: 'email', company_id: companyId, lead_id: leadId ?? null,
        template_version: draft.prompt_version ?? null, model_version: draft.model ?? null, holdout: false, idem_key: `drafted:${doc.idem_key}`,
        data: { message_id: r.insertedId, kind, drafter: draft.drafter, qc_passed: draft.qc.passed } });
      return { created: true, message: { ...doc, _id: r.insertedId } };
    } catch (err) {
      if (err?.code !== 11000) throw err;
      return { created: false, message: await this.col.findOne({ idem_key: doc.idem_key }) };
    }
  }

  /**
   * A person's decision on a draft: 'approve' or 'reject', optionally with an edited subject and
   * body. An edit is checked again by the quality check and cannot be approved if it fails.
   * Returns { ok, message, qc }. The audit row is written first: a decision that cannot be logged is
   * not saved.
   */
  async decide(id, { decision, user, note = null, edit = null, cfg, org }) {
    if (!['approve', 'reject'].includes(decision)) throw new RangeError('decision must be approve or reject');
    const msg = await this.byId(id);
    if (!msg) throw new RangeError('no such message');
    if (!['awaiting_approval', 'qc_failed'].includes(msg.status)) throw new RangeError(`this message is ${msg.status.replace('_', ' ')}, not waiting for a decision`);
    let subject = msg.draft.subject;
    let body = msg.draft.body;
    let qc = msg.qc;
    const edited = Boolean(edit) && (edit.subject !== subject || edit.body !== body);
    if (edited) {
      subject = String(edit.subject ?? '').replace(/\r\n?/g, '\n').trim();
      body = String(edit.body ?? '').replace(/\r\n?/g, '\n').trim();
      qc = qualityCheck({ subject, body }, msg.evidence.pack, { kind: msg.kind, language: msg.language, cfg, org, names: await knownNames(this.db, msg.company_id) });
    }
    if (decision === 'approve' && !qc.passed) return { ok: false, message: msg, qc };
    const now = this.clock();
    const status = decision === 'approve' ? 'approved' : 'rejected';
    await this.audit.insertOne({ at: now, actor: user.email, role: user.role, action: 'approval_decision',
      target: { type: 'message', id: String(msg._id) }, fields: null,
      detail: { company_id: msg.company_id, kind: msg.kind, decision: status, edited } });
    const approval = { decision: status, by: user.email, at: now, note: note ? String(note).slice(0, 1000) : null, edited,
      approved_hash: status === 'approved' ? approvedHash(subject, body) : null };
    const set = { status, approval, updated_at: now, ...(edited ? { 'draft.subject': subject, 'draft.body': body, 'draft.edited_by': user.email, qc } : {}) };
    const r = await this.col.findOneAndUpdate(
      { _id: msg._id, status: msg.status },
      { $set: set, $push: { history: { at: now, status, by: user.email, note: edited ? 'edited, then decided' : null } } },
      { returnDocument: 'after' },
    );
    if (!r) throw new RangeError('someone else decided this message at the same moment; reload the page');
    await this.activities.insertOne({ at: now, type: status, channel: 'email', company_id: msg.company_id, lead_id: msg.lead_id,
      holdout: false, idem_key: `${status}:${msg.idem_key}`, data: { message_id: msg._id, by: user.email, edited } });
    return { ok: true, message: r, qc };
  }

  /** Moves a message from one status to another only if it is still in `from`; returns the new document or null. */
  async move(id, from, to, { set = {}, by = 'engine', note = null } = {}) {
    const now = this.clock();
    return this.col.findOneAndUpdate(
      { _id: id, status: { $in: [].concat(from) } },
      { $set: { status: to, updated_at: now, ...set }, $push: { history: { at: now, status: to, by, note } } },
      { returnDocument: 'after' },
    );
  }

  /** Drafts and approvals older than their expiry: the facts in them may no longer be current. */
  async expireOld() {
    const now = this.clock();
    const r = await this.col.updateMany(
      { status: { $in: OPEN }, expires_at: { $lt: now } },
      { $set: { status: 'expired', updated_at: now }, $push: { history: { at: now, status: 'expired', by: 'engine', note: 'too old to send' } } },
    );
    return r.modifiedCount;
  }

  async waiting({ limit = 50 } = {}) {
    return this.col.find({ status: { $in: ['awaiting_approval', 'qc_failed'] } }).sort({ created_at: 1 }).limit(limit).toArray();
  }

  async counts() {
    const rows = await this.col.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray();
    return Object.fromEntries(rows.map((r) => [r._id, r.n]));
  }
}

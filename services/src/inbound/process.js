import { normalizeEmail } from '../util/normalize.js';
import { MessageStore } from '../outreach/messages.js';
import { stopOutreach } from '../outreach/stop.js';
import { classifyByRules, classifyReply } from './classify.js';
import { newText, parseMessage } from './parse.js';
import { readNew } from './imap.js';

/**
 * Reading the outreach mailboxes (design 7.5 and 7.6: "replies come back into the dashboard"):
 *
 *   readMailboxes (every 10 minutes, `lead-engine inbox:read`): for each mailbox with IMAP set up,
 *   the emails after the last one read (by UID, read-only), each passed to processInbound.
 *
 *   processInbound: parse -> match it to the message it answers (In-Reply-To or References, the
 *   original Message-ID inside a bounce, else the sender's address) -> what it is:
 *
 *     a bounce (delivery report)  a permanent failure (5.x.x) suppresses the address, marks the
 *                                 message bounced and counts against the mailbox; a temporary one
 *                                 (4.x.x) is counted as a soft bounce only
 *     a complaint (abuse report)  suppresses the address and closes the lead
 *     an automatic reply          kept, and nothing else: an out-of-office does not stop a follow-up
 *     a reply                     a 'replied' activity, which ends cold outreach to the company (the
 *                                 contact budget reads it); queued drafts and sends are cancelled; the
 *                                 reply is classified, and waits for a person in the Admin inbox. Only
 *                                 a clear opt-out or a clear "wrong address" acts by itself: the
 *                                 address goes on the suppression list.
 *     anything else               (warm-up mail, newsletters) ignored, and its text not kept
 *
 * Every step is idempotent, keyed on the mailbox, its UIDVALIDITY and the message's UID: a crash
 * half-way leaves the email at 'new', and the next run finishes it without doing anything twice.
 */

const DAY = 86_400_000;
const SENT = ['sent', 'send_unknown', 'bounced'];

/** IMAP settings per mailbox, from MAILBOX_<n>_IMAP_PASSWORD (or the SMTP password) and IMAP_HOST / IMAP_PORT. */
export function imapFromEnv(env, mailboxes) {
  const out = {};
  for (const [id, mb] of Object.entries(mailboxes)) {
    const p = id.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    const pass = env[`${p}_IMAP_PASSWORD`] || mb.pass || '';
    out[id] = { id, host: env.IMAP_HOST || 'imap.zoho.in', port: Number(env.IMAP_PORT || 993), user: mb.user ?? mb.address, pass,
      configured: Boolean(mb.address && pass) };
  }
  return out;
}

async function insertActivity(db, doc) {
  try {
    await db.collection('activities').insertOne(doc);
    return true;
  } catch (err) {
    if (err?.code === 11000) return false;       // already recorded by an earlier run, or by a person
    throw err;
  }
}

async function findMessage(db, parsed) {
  const ids = [parsed.inReplyTo, ...parsed.references, parsed.report?.originalMessageId].filter(Boolean);
  if (ids.length) {
    const m = await db.collection('messages').findOne({ 'send.message_id': { $in: ids } }, { sort: { 'send.at': -1 } });
    if (m) {
      const how = parsed.inReplyTo === m.send.message_id ? 'in_reply_to' : parsed.report?.originalMessageId === m.send.message_id ? 'bounce_original' : 'references';
      return { message: m, how };
    }
  }
  const addresses = parsed.report
    ? (parsed.report.recipients ?? []).map((r) => normalizeEmail(r.recipient)).filter(Boolean)
    : [normalizeEmail(parsed.from.address)].filter(Boolean);
  if (addresses.length) {
    const m = await db.collection('messages').findOne({ 'recipient.address': { $in: addresses }, status: { $in: SENT } }, { sort: { 'send.at': -1 } });
    if (m) return { message: m, how: parsed.report ? 'bounce_original' : 'address' };
  }
  return { message: null, how: 'none' };
}

/** What an email is, from its parse: 'bounce', 'complaint', 'auto_reply', 'reply' or 'other'. */
function kindOf(parsed, matched) {
  if (parsed.report?.kind === 'feedback') return 'complaint';
  if (parsed.report?.kind === 'delivery' || parsed.looksLikeBounce) return 'bounce';
  if (!matched) return 'other';
  if (parsed.auto.yes) return 'auto_reply';
  return 'reply';
}

/**
 * Handles one email. `deps`: { db, queue, suppression, llm, cfg (outreach.json), clock }.
 * Returns { status, kind, label?, actions, duplicate? }.
 */
/**
 * The names a reply may carry that must not leave the engine when the AI reads it: the sender's
 * display name, the people the engine knows at the company, and its directors from the vendor profile.
 */
export async function knownNames(db, companyId, senderName = null) {
  const names = senderName ? [senderName] : [];
  if (!companyId) return names;
  const [people, company] = await Promise.all([
    db.collection('people').find({ company_ids: companyId }, { projection: { name: 1 } }).limit(50).toArray(),
    db.collection('companies').findOne({ _id: companyId }, { projection: { 'attrs.directors': 1 } }),
  ]);
  const directors = [].concat(company?.attrs?.directors?.value ?? []).map((d) => (typeof d === 'string' ? d : d?.name));
  return [...names, ...people.map((p) => p.name), ...directors].filter((n) => typeof n === 'string' && n.trim());
}

export async function processInbound(deps, { mailbox, uid, uidvalidity, internalDate = null, raw }) {
  const { db, cfg, clock = () => new Date() } = deps;
  const ic = cfg.inbound ?? {};
  const idem = `in:${mailbox}:${uidvalidity}:${uid}`;
  const existing = await db.collection('inbound').findOne({ idem_key: idem });
  if (existing && existing.status !== 'new') return { status: existing.status, kind: existing.kind, label: existing.label, actions: existing.actions, duplicate: true };

  const parsed = parseMessage(raw);
  const now = clock();
  const { message, how } = await findMessage(db, parsed);
  const kind = kindOf(parsed, message);
  const receivedAt = internalDate ?? parsed.date ?? now;
  const text = kind === 'reply' || kind === 'auto_reply' ? newText(parsed.text).slice(0, 4000) : null;
  let classification = null;
  if (kind === 'reply') {
    classification = await classifyReply({ subject: parsed.subject, text }, { llm: deps.llm, aiBelow: ic.ai_below ?? 0.8,
      companyId: message?.company_id ?? null, leadId: message?.lead_id ?? null, names: await knownNames(db, message?.company_id, parsed.from?.name) });
  } else if (kind === 'auto_reply') {
    const r = classifyByRules({ subject: parsed.subject, text });
    if (r.label === 'wrong_person') classification = r;        // "this address is no longer in use": a person checks
  }
  const doc = existing ?? {
    idem_key: idem, mailbox, uid, uidvalidity,
    header_message_id: parsed.messageId, in_reply_to: parsed.inReplyTo, references: parsed.references,
    from: kind === 'other' ? { address: parsed.from.address, name: null } : parsed.from,
    subject: parsed.subject.slice(0, 300), kind,
    label: classification?.label ?? null,
    classification: classification && { label: classification.label, confidence: classification.confidence, by: classification.by,
      model: classification.model ?? null, version: classification.version ?? null, reasons: classification.reasons },
    matched: { message_id: message?._id ?? null, company_id: message?.company_id ?? null, lead_id: message?.lead_id ?? null, how },
    dsn: parsed.report ? { kind: parsed.report.kind, recipients: parsed.report.recipients, feedback_type: parsed.report.feedbackType,
      heuristic: parsed.report.heuristic === true } : null,
    text, status: 'new', actions: [], handled: null, received_at: receivedAt, erased_at: null,
    expires_at: new Date(receivedAt.getTime() + (ic.retention_days ?? 400) * DAY), created_at: now, updated_at: now,
  };
  if (!existing) {
    try {
      doc._id = (await db.collection('inbound').insertOne(doc)).insertedId;
    } catch (err) {
      if (err?.code !== 11000) throw err;
      return { status: 'new', kind, actions: [], duplicate: true };     // another reader got it at the same moment
    }
  }
  // a second copy of one email (the same Message-ID read from another folder): recorded, not acted on twice
  const twin = parsed.messageId && await db.collection('inbound').findOne({ header_message_id: parsed.messageId, _id: { $ne: doc._id }, status: { $ne: 'new' } });
  const { actions, status } = twin ? { actions: [`same email as ${twin.idem_key}`], status: 'ignored' } : await act(deps, { doc, parsed, message, kind, classification, now });
  await db.collection('inbound').updateOne({ _id: doc._id }, { $set: { status, actions, updated_at: clock() } });
  return { status, kind, label: doc.label, actions };
}

async function act(deps, { doc, parsed, message, kind, classification, now }) {
  const { db, queue, suppression, cfg, clock = () => new Date() } = deps;
  const ic = cfg.inbound ?? {};
  const actions = [];
  const lead = message ? await db.collection('leads').findOne({ company_id: message.company_id }) : null;
  const base = { at: now, company_id: message?.company_id ?? null, lead_id: message?.lead_id ?? lead?._id ?? null, holdout: false };
  const store = new MessageStore(db, { clock });
  const setStage = (stage, from) => lead && db.collection('leads').updateOne({ _id: lead._id, stage: { $in: from } }, { $set: { stage, updated_at: now } });

  if ((kind === 'bounce' || kind === 'complaint') && !message) {
    // about mail the engine did not send (warm-up, a person's own mail): it must not count against the mailbox
    return { actions: [`a ${kind === 'bounce' ? 'delivery report' : 'complaint'} about an email the engine did not send`], status: 'done' };
  }
  if (kind === 'bounce') {
    const rcpt = parsed.report?.recipients?.find((r) => r.status) ?? parsed.report?.recipients?.[0] ?? null;
    const hard = !rcpt?.status || rcpt.status.startsWith('5');
    const address = normalizeEmail(rcpt?.recipient) ?? message?.recipient?.address ?? null;
    const key = message ? `bounced:${message._id}` : `bounced:${doc.idem_key}`;
    if (hard) {
      if (await insertActivity(db, { ...base, type: 'bounced', channel: 'email', idem_key: key,
        data: { mailbox: message?.mailbox ?? doc.mailbox, bounce: 'hard', message_id: message?._id ?? null, status: rcpt?.status ?? null, via: 'dsn', inbound_id: doc._id } })) {
        actions.push('recorded a hard bounce');
      }
      if (address) {
        await suppression.add({ email: address }, { reason: 'hard_bounce', source: { via: 'dsn', status: rcpt?.status ?? null, inbound: doc.idem_key } });
        actions.push('suppressed the address');
      }
      if (message && await store.move(message._id, ['sent', 'send_unknown'], 'bounced', { note: `delivery report ${rcpt?.status ?? ''}`.trim() })) actions.push('marked the message bounced');
      await setStage('closed', ['discovered', 'shortlisted', 'contacted']);
    } else if (await insertActivity(db, { ...base, type: 'bounced', channel: 'email', idem_key: `bounced-soft:${doc.idem_key}`,
      data: { mailbox: message?.mailbox ?? doc.mailbox, bounce: 'soft', message_id: message?._id ?? null, status: rcpt.status, via: 'dsn', inbound_id: doc._id } })) {
      actions.push(`recorded a temporary failure (${rcpt.status})`);
    }
    return { actions, status: 'done' };
  }

  if (kind === 'complaint') {
    if (await insertActivity(db, { ...base, type: 'complained', channel: 'email', idem_key: message ? `complained:${message._id}` : `complained:${doc.idem_key}`,
      data: { mailbox: message?.mailbox ?? doc.mailbox, message_id: message?._id ?? null, feedback_type: parsed.report?.feedbackType ?? null, inbound_id: doc._id } })) {
      actions.push('recorded a complaint');
    }
    if (message?.recipient?.address) {
      await suppression.add({ email: message.recipient.address }, { reason: 'spam_complaint', source: { via: 'feedback_report', inbound: doc.idem_key } });
      actions.push('suppressed the address');
    }
    await setStage('closed', ['discovered', 'shortlisted', 'contacted', 'engaged']);
    if (message) actions.push(`stopped ${await stopOutreach(db, queue, message.company_id, 'a complaint arrived', { by: 'engine', clock })} queued item(s)`);
    return { actions, status: 'done' };
  }

  if (kind === 'auto_reply') return { actions: ['an automatic reply: nothing to do'], status: classification ? 'needs_person' : 'done' };
  if (kind === 'other') return { actions: ['not about our outreach'], status: 'ignored' };

  // a reply from the founder (or someone at the company)
  const label = classification.label;
  if (await insertActivity(db, { ...base, type: 'replied', channel: 'email', idem_key: `replied:${message._id}`,
    data: { message_id: message._id, mailbox: message.mailbox, inbound_id: doc._id, label, confidence: classification.confidence, by: classification.by } })) {
    actions.push('recorded the reply: cold outreach to this company stops');
  }
  const stopped = await stopOutreach(db, queue, message.company_id, 'the founder replied', { by: 'engine', clock });
  if (stopped) actions.push(`stopped ${stopped} queued item(s)`);
  const sure = classification.confidence >= (ic.auto_act_confidence ?? 0.8);
  const from = normalizeEmail(parsed.from.address);
  if (sure && label === 'unsubscribe') {
    for (const a of new Set([from, message.recipient?.address].filter(Boolean))) {
      await suppression.add({ email: a }, { reason: 'unsubscribe', source: { via: 'email_reply', inbound: doc.idem_key } });
    }
    await insertActivity(db, { ...base, type: 'unsubscribed', channel: 'email', idem_key: `unsubscribed:${doc.idem_key}`, data: { message_id: message._id, via: 'reply' } });
    await setStage('closed', ['discovered', 'shortlisted', 'contacted', 'engaged']);
    actions.push('the founder asked not to be contacted: the address is suppressed');
    return { actions, status: 'done' };
  }
  if (sure && label === 'wrong_person') {
    for (const a of new Set([from, message.recipient?.address].filter(Boolean))) {
      await suppression.add({ email: a }, { reason: 'wrong_contact', source: { via: 'email_reply', inbound: doc.idem_key } });
    }
    await setStage('closed', ['discovered', 'shortlisted', 'contacted']);
    actions.push('not the company\'s own address: suppressed');
    return { actions, status: 'needs_person' };
  }
  await setStage('engaged', ['discovered', 'shortlisted', 'contacted']);
  actions.push('waiting for a person');
  return { actions, status: 'needs_person' };
}

/** The last UID read in a mailbox folder, and its UIDVALIDITY, from what is already stored. */
async function cursorFor(db, mailbox) {
  const last = await db.collection('inbound').find({ mailbox }).sort({ received_at: -1, uid: -1 }).limit(1).next();
  if (!last) return { uidvalidity: null, afterUid: null };
  const top = await db.collection('inbound').find({ mailbox, uidvalidity: last.uidvalidity }).sort({ uid: -1 }).limit(1).next();
  return { uidvalidity: last.uidvalidity, afterUid: top.uid };
}

/**
 * Reads every configured mailbox once. `deps` as processInbound, plus `imap` (from imapFromEnv) and
 * `readNewFn` (tests). Returns per-mailbox counts.
 */
export async function readMailboxes(deps, { readNewFn = readNew, log = console } = {}) {
  const { db, cfg, clock = () => new Date() } = deps;
  const ic = cfg.inbound ?? {};
  const out = {};
  for (const [id, box] of Object.entries(deps.imap ?? {})) {
    if (!box.configured) {
      out[id] = { skipped: 'no address or IMAP password configured' };
      continue;
    }
    const stats = { read: 0, reply: 0, bounce: 0, complaint: 0, auto_reply: 0, other: 0, needs_person: 0, duplicate: 0 };
    try {
      const cursor = await cursorFor(db, id);
      const startDate = ic.start_date ? new Date(`${ic.start_date}T00:00:00+05:30`) : null;
      const since = new Date(Math.max(startDate?.getTime() ?? 0, clock().getTime() - (ic.first_read_days ?? 30) * DAY));
      const r = await readNewFn(box, { folder: ic.folder ?? 'INBOX', uidvalidity: cursor.uidvalidity, afterUid: cursor.afterUid, since,
        limit: ic.max_per_run ?? 200, maxBytes: ic.max_bytes ?? 262_144 });
      for (const m of r.messages) {
        const res = await processInbound(deps, { mailbox: id, uid: m.uid, uidvalidity: r.uidvalidity, internalDate: m.internalDate, raw: m.raw });
        stats.read += 1;
        if (res.duplicate) stats.duplicate += 1;
        else stats[res.kind] = (stats[res.kind] ?? 0) + 1;
        if (res.status === 'needs_person') stats.needs_person += 1;
      }
      if (r.more) stats.more = true;
    } catch (err) {
      log.error?.(`[inbox] ${id}: ${err.message}`);
      stats.error = err.message;
    }
    out[id] = stats;
  }
  return out;
}

/** The labels a person can choose in the inbox. */
export const PERSON_LABELS = ['interested', 'question', 'not_now', 'unsubscribe', 'wrong_person', 'unclear'];

/**
 * A person's decision on an inbound email: a label (theirs replaces the classifier's), and whether
 * it is dealt with. An opt-out or a wrong address chosen by a person suppresses the address, as the
 * classifier would have. Audited first. `user`: { email, role }.
 */
export async function decideInbound(db, { id, label = null, handled = false, note = null, user, suppression, queue, clock = () => new Date() }) {
  const doc = await db.collection('inbound').findOne({ _id: id });
  if (!doc) throw new RangeError('no such email');
  if (label !== null && !PERSON_LABELS.includes(label)) throw new RangeError(`label must be one of ${PERSON_LABELS.join(', ')}`);
  if (label && doc.kind !== 'reply' && doc.kind !== 'auto_reply') throw new RangeError('only a reply can be labelled');
  const now = clock();
  await db.collection('audit_log').insertOne({ at: now, actor: user.email, role: user.role, action: 'inbound_decision',
    target: { type: 'inbound', id: String(doc._id) }, fields: null, detail: { company_id: doc.matched?.company_id ?? null, label, handled, was: doc.label } });
  const set = { updated_at: now };
  const actions = [];
  if (label && label !== doc.label) {
    set.label = label;
    set.classification = { ...(doc.classification ?? {}), label, confidence: 1, by: 'person', model: null, reasons: [`chosen by ${user.email}`],
      previous: doc.classification ? { label: doc.classification.label, by: doc.classification.by, confidence: doc.classification.confidence } : null };
    if (['unsubscribe', 'wrong_person'].includes(label) && doc.from?.address) {
      await suppression.add({ [doc.channel === 'whatsapp' ? 'phone' : 'email']: doc.from.address },
        { reason: label === 'unsubscribe' ? 'unsubscribe' : 'wrong_contact', source: { via: 'admin', by: user.email, inbound: doc.idem_key } });
      actions.push(`suppressed the address (${label.replace('_', ' ')}, by ${user.email})`);
      if (doc.matched?.company_id) {
        await stopOutreach(db, queue, doc.matched.company_id, `marked ${label.replace('_', ' ')} by a person`, { by: user.email, clock });
        await db.collection('leads').updateOne({ company_id: doc.matched.company_id, stage: { $in: ['discovered', 'shortlisted', 'contacted', 'engaged'] } }, { $set: { stage: 'closed', updated_at: now } });
      }
    }
  }
  if (handled) {
    set.status = 'handled';
    set.handled = { by: user.email, at: now, note: note ? String(note).slice(0, 1000) : null };
    if (doc.matched?.company_id) {
      await insertActivity(db, { at: now, type: 'handed_over', channel: doc.channel === 'whatsapp' ? 'whatsapp' : 'email', company_id: doc.matched.company_id, lead_id: doc.matched.lead_id ?? null,
        holdout: false, idem_key: `handed_over:${doc.idem_key}`, data: { inbound_id: doc._id, by: user.email, label: label ?? doc.label } });
    }
  }
  await db.collection('inbound').updateOne({ _id: doc._id }, { $set: set, ...(actions.length ? { $push: { actions: { $each: actions } } } : {}) });
  return { ok: true, actions };
}

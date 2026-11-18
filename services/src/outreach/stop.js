/**
 * Stops everything still queued for a company once its founder has answered, claimed the page or
 * opted out: open messages are cancelled (never sent), and pending draft and send jobs are cancelled
 * on the job table. Used by the company pages, the inbound reader and the call outcomes, so every
 * way a founder can say "enough" stops outreach the same way. Returns how many were stopped.
 */
export async function stopOutreach(db, queue, companyId, why, { by = 'founder', clock = () => new Date() } = {}) {
  const now = clock();
  let stopped = 0;
  const open = await db.collection('messages').find({ company_id: companyId, status: { $in: ['qc_failed', 'awaiting_approval', 'approved'] } }).toArray();
  for (const m of open) {
    const r = await db.collection('messages').updateOne({ _id: m._id, status: m.status }, { $set: { status: 'cancelled', updated_at: now },
      $push: { history: { at: now, status: 'cancelled', by, note: why } } });
    stopped += r.modifiedCount;
    await queue?.cancel(`send:${m._id}`, why);
  }
  if (queue) {
    const drafts = await db.collection('jobs').find({ type: 'outreach.draft', status: { $in: ['pending', 'running'] }, 'payload.company_id': companyId },
      { projection: { idem_key: 1 } }).toArray();
    for (const j of drafts) if (await queue.cancel(j.idem_key, why)) stopped += 1;
  }
  return stopped;
}

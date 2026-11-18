import { randomUUID } from 'node:crypto';

/**
 * A job table in MongoDB instead of a separate queue (no Redis). Each job has a due time and,
 * while running, a lock with an owner, a random token and an expiry.
 *
 * Guarantees:
 * - enqueue is idempotent on `idemKey`: enqueuing the same step twice creates one job.
 * - claim is atomic: two workers can never hold the same job at once.
 * - a crashed worker's job becomes claimable again when its lock expires.
 * - complete/fail are fenced by the lock token, so a worker whose lock expired (and whose job
 *   was re-claimed by someone else) cannot overwrite the newer attempt's outcome.
 *
 * Time comes from the database server, not from each worker's machine: lock expiry is compared
 * across workers, and a worker whose clock ran a few minutes fast would otherwise take over jobs
 * that are still being worked on. (Tests pass a fixed `clock` instead.)
 *
 * Delivery is at-least-once. A handler with a side effect (sending a message) must record that
 * effect under the job's idem_key (activities has a unique index on it) before reporting success,
 * which is what makes a retry safe.
 *
 * The default retry schedule (10 attempts, 2 minutes doubling to at most 6 hours, ±20%) spans about
 * 14 hours, so an outage of the mail or AI provider for part of a day does not kill every due job;
 * a permanent failure (PermanentError) is still dead at once.
 */
export class JobQueue {
  constructor(db, {
    clock = null,
    localClock = () => Date.now(),
    clockSyncMs = 60_000,
    lockMs = 5 * 60_000,
    maxAttempts = 10,
    backoffBaseMs = 2 * 60_000,
    backoffMaxMs = 6 * 3_600_000,
    random = Math.random,
  } = {}) {
    this.db = db;
    this.col = db.collection('jobs');
    this.clock = clock;
    this.localClock = localClock;
    this.clockSyncMs = clockSyncMs;
    this.offsetMs = null;
    this.syncedAt = 0;
    this.lockMs = lockMs;
    this.maxAttempts = maxAttempts;
    this.backoffBaseMs = backoffBaseMs;
    this.backoffMaxMs = backoffMaxMs;
    this.random = random;
  }

  /**
   * The current time. With a `clock` option that clock; otherwise the database server's time,
   * from this machine's clock plus an offset measured with `hello` once a minute (its error is half
   * a round trip, milliseconds, against lock times of minutes).
   */
  async now() {
    if (this.clock) return this.clock();
    if (this.offsetMs === null || this.localClock() - this.syncedAt > this.clockSyncMs) {
      const t0 = this.localClock();
      const hello = await this.db.command({ hello: 1 });
      const t1 = this.localClock();
      this.offsetMs = hello.localTime instanceof Date ? hello.localTime.getTime() - (t0 + t1) / 2 : 0;
      this.syncedAt = t1;
    }
    return new Date(Math.round(this.localClock() + this.offsetMs));
  }

  /** Returns { created, id }. `created` is false when a job with this idemKey already exists. */
  async enqueue({ type, idemKey, dueAt, payload = {}, priority = 0, leadId = null, step = null, maxAttempts }) {
    if (!type || !idemKey) throw new TypeError('enqueue needs type and idemKey');
    // An Invalid Date would be stored as 1970-01-01 and run at once: a follow-up meant for next
    // week would go out today.
    if (dueAt !== undefined && dueAt !== null && !(dueAt instanceof Date && Number.isFinite(dueAt.getTime()))) {
      throw new TypeError(`enqueue needs dueAt to be a valid Date (got ${String(dueAt)})`);
    }
    if (!Number.isInteger(priority)) throw new TypeError('priority must be an integer');
    const max = maxAttempts ?? this.maxAttempts;
    if (!Number.isInteger(max) || max < 1) throw new TypeError('maxAttempts must be a whole number of at least 1');
    const now = await this.now();
    const doc = {
      type,
      idem_key: idemKey,
      status: 'pending',
      due_at: dueAt ?? now,
      priority,
      attempts: 0,
      max_attempts: max,
      lead_id: leadId,
      step,
      payload,
      lock: null,
      last_error: null,
      created_at: now,
      updated_at: now,
      finished_at: null,
    };
    try {
      const r = await this.col.updateOne({ idem_key: idemKey }, { $setOnInsert: doc }, { upsert: true });
      if (r.upsertedId) return { created: true, id: r.upsertedId };
    } catch (err) {
      if (err?.code !== 11000) throw err; // two concurrent upserts: the loser lands here
    }
    const existing = await this.col.findOne({ idem_key: idemKey }, { projection: { _id: 1 } });
    return { created: false, id: existing._id };
  }

  /**
   * Atomically takes the most urgent due job, or returns null. `types` limits it to those job types
   * (the claim_by_type index serves that query without scanning due jobs of other types).
   */
  async claim(workerId, { types } = {}) {
    const now = await this.now();
    const filter = { status: 'pending', due_at: { $lte: now } };
    if (types) {
      if (!types.length) return null;
      filter.type = { $in: types };
    }
    return this.col.findOneAndUpdate(
      filter,
      {
        $set: {
          status: 'running',
          lock: { owner: workerId, token: randomUUID(), expires_at: new Date(now.getTime() + this.lockMs) },
          updated_at: now,
        },
        $inc: { attempts: 1 },
      },
      { sort: { priority: -1, due_at: 1 }, returnDocument: 'after' },
    );
  }

  /** Extends a running job's lock. Returns false if the lock was lost. */
  async heartbeat(job) {
    const now = await this.now();
    const r = await this.col.updateOne(
      this.#fence(job),
      { $set: { 'lock.expires_at': new Date(now.getTime() + this.lockMs), updated_at: now } },
    );
    return r.modifiedCount === 1;
  }

  /**
   * Marks a job done. Returns false if the lock was lost (the result is then discarded). `note` is
   * kept in last_error, for a job that succeeded but whose result could not be stored.
   */
  async complete(job, result = null, { note = null } = {}) {
    const now = await this.now();
    const r = await this.col.updateOne(
      this.#fence(job),
      { $set: { status: 'done', result, lock: null, last_error: note, updated_at: now, finished_at: now } },
    );
    return r.modifiedCount === 1;
  }

  /**
   * Records a failure. Retryable failures are rescheduled with exponential backoff and jitter
   * until max_attempts is reached; then, or for permanent failures, the job is marked dead.
   * A job whose cancel() arrived while this attempt ran is cancelled instead of retried.
   * Returns 'retry', 'dead', 'cancelled' or 'lost'.
   */
  async fail(job, error, { retryable = true } = {}) {
    const now = await this.now();
    const message = describeError(error);
    if (!retryable || job.attempts >= job.max_attempts) {
      const r = await this.col.updateOne(
        this.#fence(job),
        { $set: { status: 'dead', lock: null, last_error: message, updated_at: now, finished_at: now } },
      );
      return r.modifiedCount === 1 ? 'dead' : 'lost';
    }
    const cancel = { $eq: ['$cancel_requested', true] };
    const r = await this.col.findOneAndUpdate(this.#fence(job), [{
      $set: {
        status: { $cond: [cancel, 'cancelled', 'pending'] },
        lock: null,
        last_error: { $literal: message }, // literal: an error message starting with "$" is not a field path
        updated_at: now,
        due_at: { $cond: [cancel, '$due_at', new Date(now.getTime() + this.backoffMs(job.attempts))] },
        finished_at: { $cond: [cancel, now, null] },
      },
    }], { returnDocument: 'after', projection: { status: 1 } });
    if (!r) return 'lost';
    return r.status === 'cancelled' ? 'cancelled' : 'retry';
  }

  /**
   * Puts a running job back to wait until `dueAt` without using up an attempt: the step was not
   * tried and failed, it was told to wait (the send window is closed, today's cap is used, a mailbox
   * is still warming up). Fenced like complete(); a job whose cancel() arrived meanwhile is cancelled.
   * Returns 'deferred', 'cancelled' or 'lost'.
   */
  async defer(job, dueAt, reason = 'deferred') {
    if (!(dueAt instanceof Date && Number.isFinite(dueAt.getTime()))) throw new TypeError(`defer needs a valid Date (got ${String(dueAt)})`);
    const now = await this.now();
    const cancel = { $eq: ['$cancel_requested', true] };
    const r = await this.col.findOneAndUpdate(this.#fence(job), [{
      $set: {
        status: { $cond: [cancel, 'cancelled', 'pending'] },
        lock: null,
        attempts: { $cond: [cancel, '$attempts', { $max: [0, { $subtract: ['$attempts', 1] }] }] },
        deferrals: { $add: [{ $ifNull: ['$deferrals', 0] }, 1] },
        last_error: { $literal: `waiting: ${String(reason).slice(0, 1900)}` },
        updated_at: now,
        due_at: { $cond: [cancel, '$due_at', dueAt] },
        finished_at: { $cond: [cancel, now, null] },
      },
    }], { returnDocument: 'after', projection: { status: 1 } });
    if (!r) return 'lost';
    return r.status === 'cancelled' ? 'cancelled' : 'deferred';
  }

  backoffMs(attempts) {
    const exp = Math.min(this.backoffBaseMs * 2 ** Math.max(0, attempts - 1), this.backoffMaxMs);
    // ±20% jitter so retries do not bunch up, but never past backoffMaxMs
    return Math.min(Math.round(exp * (0.8 + 0.4 * this.random())), this.backoffMaxMs);
  }

  /**
   * Cancels a job (for example when a founder replies before a follow-up is due). A pending job is
   * cancelled at once. A running attempt cannot be stopped from here: it is marked, so that it is
   * cancelled instead of retried if it fails or its worker is lost. The attempt itself may still
   * finish, which is why a step with a side effect checks the contact budget again at send time.
   * Returns true if the job is cancelled or will be, false if it had already finished.
   */
  async cancel(idemKey, reason = 'cancelled') {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const now = await this.now();
      const r = await this.col.updateOne(
        { idem_key: idemKey, status: 'pending' },
        { $set: { status: 'cancelled', last_error: reason, cancel_reason: reason, updated_at: now, finished_at: now } },
      );
      if (r.modifiedCount === 1) return true;
      const running = await this.col.updateOne(
        { idem_key: idemKey, status: 'running' },
        { $set: { cancel_requested: true, cancel_reason: reason, updated_at: now } },
      );
      if (running.modifiedCount === 1) return true;
      // it may have moved from running back to pending between the two updates; look again
      const job = await this.col.findOne({ idem_key: idemKey }, { projection: { status: 1 } });
      if (!job || !['pending', 'running'].includes(job.status)) return false;
    }
    return false;
  }

  /**
   * Returns jobs whose worker vanished (lock expired) to the queue, marks them dead if they have
   * used all their attempts, or cancels them if cancel() was asked for. Workers call this on every
   * poll. Returns { requeued, dead }, plus `cancelled` when any were.
   */
  async recoverStale() {
    const now = await this.now();
    const stale = { status: 'running', 'lock.expires_at': { $lt: now } };
    const cancelled = await this.col.updateMany(
      { ...stale, cancel_requested: true },
      { $set: { status: 'cancelled', lock: null, last_error: 'cancelled; its worker was lost during the attempt', updated_at: now, finished_at: now } },
    );
    // The attempts test is in the requeue itself, so a job on its final attempt is never handed out
    // again, even if the step that marks it dead below fails.
    const requeued = await this.col.updateMany(
      { ...stale, cancel_requested: { $ne: true }, $expr: { $lt: ['$attempts', '$max_attempts'] } },
      { $set: { status: 'pending', lock: null, last_error: 'lock expired; worker presumed lost', updated_at: now, due_at: now } },
    );
    const exhausted = await this.col.updateMany(
      { ...stale, $expr: { $gte: ['$attempts', '$max_attempts'] } },
      { $set: { status: 'dead', lock: null, last_error: 'lock expired on the final attempt', updated_at: now, finished_at: now } },
    );
    const out = { requeued: requeued.modifiedCount, dead: exhausted.modifiedCount };
    if (cancelled.modifiedCount) out.cancelled = cancelled.modifiedCount;
    return out;
  }

  async stats() {
    const rows = await this.col.aggregate([{ $group: { _id: { type: '$type', status: '$status' }, n: { $sum: 1 } } }]).toArray();
    const out = {};
    for (const { _id, n } of rows) (out[_id.type] ??= {})[_id.status] = n;
    return out;
  }

  #fence(job) {
    return { _id: job._id, status: 'running', 'lock.token': job.lock.token };
  }
}

/** The error's stack or text, at most 2,000 characters, even for odd values thrown (null, objects whose getters throw). */
export function describeError(error) {
  try {
    return String(error?.stack ?? error?.message ?? error).slice(0, 2000);
  } catch {
    return 'an error that could not be printed';
  }
}

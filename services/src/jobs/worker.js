import { setTimeout as sleep } from 'node:timers/promises';

/** Throw this from a handler when retrying cannot help (bad input, a suppressed address, ...). */
export class PermanentError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'PermanentError';
  }
}

/**
 * Throw this from a handler when the step must wait rather than fail: the send window is closed,
 * today's cap is used up. The job goes back to the queue due at `until` and keeps all its attempts.
 */
export class DeferError extends Error {
  constructor(message, until) {
    super(message);
    if (!(until instanceof Date && Number.isFinite(until.getTime()))) throw new TypeError('DeferError needs the Date to wait until');
    this.name = 'DeferError';
    this.until = until;
  }
}

/** The reason a handler's signal aborts: 'LockLostError', 'MaxRunTimeError' or 'WorkerStoppingError'. */
function abortReason(name, message) {
  const err = new Error(message);
  err.name = name;
  return err;
}

// By name as well as class: a second copy of this module (another package version) would make a
// PermanentError that fails instanceof, and the job would be retried for nothing.
const isPermanent = (err) => err instanceof PermanentError || err?.name === 'PermanentError';
const isDefer = (err) => (err instanceof DeferError || err?.name === 'DeferError') && err.until instanceof Date;

/**
 * Errors that mean a value can never be stored (it cannot be turned into BSON, or the document
 * would be too large or invalid), as opposed to the database being unreachable for now.
 */
const isUnstorable = (err) => err?.name === 'BSONError' || err instanceof RangeError || err instanceof TypeError
  || [121, 10334, 17419, 17420].includes(err?.code);

/** An error's message for a log line, even for null or a value whose getters throw. */
function messageOf(err) {
  try {
    return err?.message ?? String(err);
  } catch {
    return 'an error that could not be printed';
  }
}

/**
 * Polls the job table and runs handlers. After a job finishes it immediately looks for the next
 * due one, and only sleeps (pollMs, 30 s by default) when nothing is due. While a handler runs,
 * the lock is extended every third of its lifetime, so long steps are not taken over.
 *
 * Limits, so one bad step cannot hold a job or the worker forever:
 * - maxRunMs (15 minutes by default, per type in maxRunMsByType): the handler's signal aborts and
 *   the lock is no longer extended, so the job can be retried elsewhere once the lock expires;
 * - stop(): jobs in hand get stopGraceMs to finish, then their signals abort;
 * - after any abort, a handler that does not settle within abortGraceMs is abandoned: execute()
 *   returns 'abandoned' and its slot is freed. Its lock expires and recoverStale() hands it out again.
 */
export class Worker {
  constructor(queue, handlers, {
    workerId,
    pollMs = 30_000,
    concurrency = 2,
    log = console,
    maxRunMs = 15 * 60_000,
    maxRunMsByType = {},
    stopGraceMs = 30_000,
    abortGraceMs = 5_000,
  } = {}) {
    if (!workerId) throw new TypeError('workerId is required');
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError('concurrency must be a whole number of at least 1');
    this.queue = queue;
    this.handlers = handlers;
    this.workerId = workerId;
    this.pollMs = pollMs;
    this.concurrency = concurrency;
    this.log = log;
    this.maxRunMs = maxRunMs;
    this.maxRunMsByType = maxRunMsByType;
    this.stopGraceMs = stopGraceMs;
    this.abortGraceMs = abortGraceMs;
    this.inFlight = new Set();
    this.aborts = new Set();
    this.stopping = false;
    this.running = false;
    this.wake = null;
  }

  /** Runs until stop() is called. A Worker runs one loop at a time. */
  async run() {
    // Two loops on one Worker would keep ending each other's idle() wait and poll without pause.
    if (this.running) throw new Error(`worker ${this.workerId} is already running`);
    this.running = true;
    try {
      while (!this.stopping) {
        try {
          await this.queue.recoverStale();
          const started = await this.fill();
          // Sleep while every slot is busy or nothing was due. A finishing job ends the sleep at once
          // (fill() wires that up), which frees its slot for the next due job.
          if (started === 0 || this.inFlight.size >= this.concurrency) await this.idle(this.pollMs);
        } catch (err) {
          this.log.error?.(`[worker ${this.workerId}] poll failed: ${messageOf(err)}`);
          await this.idle(this.pollMs);
        }
      }
      await this.#drain();
    } finally {
      this.running = false;
    }
  }

  /** Claims jobs until the concurrency limit is reached or nothing is due. Returns how many started. */
  async fill() {
    let started = 0;
    const types = Object.keys(this.handlers);
    while (!this.stopping && this.inFlight.size < this.concurrency) {
      const job = await this.queue.claim(this.workerId, { types });
      if (!job) break;
      const p = this.execute(job).finally(() => {
        this.inFlight.delete(p);
        this.wake?.();
      });
      this.inFlight.add(p);
      started += 1;
    }
    return started;
  }

  /** Waits for the jobs in hand: stopGraceMs, then their signals abort, then at most abortGraceMs more. */
  async #drain() {
    if (!this.inFlight.size) return;
    const all = Promise.allSettled([...this.inFlight]);
    const timer = new AbortController();
    const finished = await Promise.race([all.then(() => true), sleep(this.stopGraceMs, false, { signal: timer.signal }).catch(() => true)]);
    timer.abort();
    if (finished) return;
    this.log.warn?.(`[worker ${this.workerId}] ${this.inFlight.size} job(s) still running ${this.stopGraceMs} ms after stop(); aborting them`);
    for (const abort of this.aborts) abort(abortReason('WorkerStoppingError', `worker ${this.workerId} is stopping`));
    await all; // each execute() settles within abortGraceMs of its abort
  }

  /**
   * Runs one job to completion and records the outcome. Exposed for tests and one-off runs.
   * Returns 'done', 'retry', 'deferred', 'dead', 'cancelled', 'lost', 'abandoned' or 'unrecorded'.
   *
   * Never rejects. If the outcome cannot be recorded (the database is unreachable), the job is left
   * running; its lock expires and recoverStale() hands it out again, which is safe because every
   * side effect is recorded under the job's idem_key.
   *
   * The handler is called as handler(job, { workerId, signal }). The signal aborts when this worker
   * may no longer own the job, so a long handler can stop before a side effect it does not own:
   * - a heartbeat finds the lock gone (another worker may now hold the job);
   * - heartbeats keep failing (the database is unreachable) until the lock is about to expire:
   *   this worker cannot tell whether someone else has taken over, so it assumes so;
   * - the step runs past maxRunMs, or the worker is stopping and stopGraceMs has passed.
   */
  async execute(job) {
    const signal = new AbortController();
    const { lockMs } = this.queue;
    const limit = this.maxRunMsByType[job.type] ?? this.maxRunMs;
    const safety = Math.min(5_000, Math.floor(lockMs / 10));
    let beating = true;
    let asking = false;
    let fence = null;
    let runTimer = null;
    let giveUpTimer = null;
    const stopBeats = () => {
      beating = false;
      clearInterval(beat);
      clearTimeout(fence);
    };
    const abort = (reason) => {
      stopBeats();
      if (!signal.signal.aborted) signal.abort(reason);
    };
    // Our own view of the lock, on this machine's monotonic clock: it runs from the moment the last
    // confirmed heartbeat was sent (or the job was claimed), so it never outlasts the real lock.
    const armFence = (lockedUntil) => {
      clearTimeout(fence);
      fence = setTimeout(
        () => abort(abortReason('LockLostError', `no confirmed heartbeat for ${job.idem_key} before its lock expired; another worker may hold it`)),
        Math.max(0, lockedUntil - safety - performance.now()),
      );
    };
    armFence(performance.now() + lockMs);
    const beat = setInterval(() => {
      if (!beating || asking) return; // one heartbeat at a time; a slow one is not doubled up
      asking = true;
      const sentAt = performance.now();
      this.queue.heartbeat(job).then(
        (held) => {
          if (!beating) return;
          if (held) armFence(sentAt + lockMs);
          else abort(abortReason('LockLostError', `lock on ${job.idem_key} lost`));
        },
        () => {}, // a failed heartbeat is not proof of a lost lock; the fence timer decides
      ).finally(() => { asking = false; });
    }, Math.max(1_000, Math.floor(lockMs / 3)));
    runTimer = setTimeout(() => abort(abortReason('MaxRunTimeError', `${job.idem_key} ran longer than ${limit} ms`)), limit);
    this.aborts.add(abort);

    try {
      const handled = (async () => this.handlers[job.type](job, { workerId: this.workerId, signal: signal.signal }))()
        .then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
      const gaveUp = new Promise((resolve) => {
        const start = () => { giveUpTimer = setTimeout(() => resolve(null), this.abortGraceMs); };
        if (signal.signal.aborted) start();
        else signal.signal.addEventListener('abort', start, { once: true });
      });
      const outcome = await Promise.race([handled, gaveUp]);
      stopBeats();
      if (!outcome) {
        this.log.error?.(`[worker ${this.workerId}] ${job.idem_key} did not stop within ${this.abortGraceMs} ms of being aborted (${messageOf(signal.signal.reason)}); abandoned, it is retried when its lock expires`);
        return 'abandoned';
      }
      if (!outcome.ok) {
        const err = outcome.error;
        if (isDefer(err)) {
          const result = await this.queue.defer(job, err.until, messageOf(err));
          this.log.info?.(`[worker ${this.workerId}] ${job.idem_key} waits until ${err.until.toISOString()} (${result}): ${messageOf(err)}`);
          return result;
        }
        const result = await this.queue.fail(job, err, { retryable: !isPermanent(err) });
        this.log.warn?.(`[worker ${this.workerId}] ${job.idem_key} failed (${result}): ${messageOf(err)}`);
        return result;
      }
      let ok;
      try {
        ok = await this.queue.complete(job, outcome.value ?? null);
      } catch (err) {
        if (!isUnstorable(err)) throw err;
        // The step succeeded; only its return value cannot be stored. Record the job as done
        // without it: leaving it running or failing it would run the step, and its side effect, again.
        this.log.error?.(`[worker ${this.workerId}] the result of ${job.idem_key} cannot be stored (${messageOf(err)}); recorded as done without it`);
        ok = await this.queue.complete(job, null, { note: `the result could not be stored: ${messageOf(err)}`.slice(0, 2000) });
      }
      if (!ok) this.log.warn?.(`[worker ${this.workerId}] lost the lock on ${job.idem_key}; result discarded`);
      return ok ? 'done' : 'lost';
    } catch (err) {
      this.log.error?.(`[worker ${this.workerId}] could not record the outcome of ${job.idem_key}: ${messageOf(err)}; it will be retried when its lock expires`);
      return 'unrecorded';
    } finally {
      stopBeats();
      clearTimeout(runTimer);
      clearTimeout(giveUpTimer);
      this.aborts.delete(abort);
    }
  }

  /**
   * Stops claiming new jobs and ends run() once the jobs in hand are finished. `graceMs` overrides
   * stopGraceMs: how long they may run on before their signals abort.
   */
  stop({ graceMs } = {}) {
    if (graceMs !== undefined) this.stopGraceMs = graceMs;
    this.stopping = true;
    this.wake?.();
  }

  idle(ms) {
    this.wake?.(); // end any earlier wait, so at most one timer is ever pending
    // stop() may have been called while the loop was waiting on the database: do not start a new wait
    if (this.stopping) return Promise.resolve();
    return new Promise((resolve) => {
      const ac = new AbortController();
      this.wake = () => ac.abort();
      sleep(ms, undefined, { signal: ac.signal }).catch(() => {}).finally(resolve);
    });
  }
}

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { freshDb, startMongo } from './helpers/mongod.js';
import { JobQueue } from '../src/jobs/queue.js';
import { PermanentError, Worker } from '../src/jobs/worker.js';

let mongo;
let client;
let db;
let now;
const clock = () => new Date(now);
const advance = (ms) => { now += ms; };

before(async () => { mongo = await startMongo(); });
after(async () => { await mongo.stop(); });
beforeEach(async () => {
  await client?.close();
  ({ client, db } = await freshDb(mongo.uri));
  now = Date.parse('2026-11-18T05:30:00Z');
});
after(async () => { await client?.close(); });

const q = (opts = {}) => new JobQueue(db, { clock, lockMs: 60_000, backoffBaseMs: 1_000, random: () => 0.5, ...opts });

describe('enqueue', () => {
  test('is idempotent on idemKey', async () => {
    const queue = q();
    const a = await queue.enqueue({ type: 'email.first', idemKey: 'lead1:first' });
    const b = await queue.enqueue({ type: 'email.first', idemKey: 'lead1:first' });
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.deepEqual(b.id, a.id);
    assert.equal(await db.collection('jobs').countDocuments(), 1);
  });

  test('survives concurrent duplicate enqueues', async () => {
    const queue = q();
    const results = await Promise.all(Array.from({ length: 20 }, () => queue.enqueue({ type: 't', idemKey: 'same' })));
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.equal(await db.collection('jobs').countDocuments(), 1);
  });

  test('the database rejects a job without a type', async () => {
    await assert.rejects(db.collection('jobs').insertOne({ idem_key: 'x' }), /validation/i);
  });
});

describe('claim', () => {
  test('respects due time and priority', async () => {
    const queue = q();
    await queue.enqueue({ type: 't', idemKey: 'later', dueAt: new Date(now + 60_000) });
    await queue.enqueue({ type: 't', idemKey: 'low', priority: 0 });
    await queue.enqueue({ type: 't', idemKey: 'high', priority: 5 });
    assert.equal((await queue.claim('w')).idem_key, 'high');
    assert.equal((await queue.claim('w')).idem_key, 'low');
    assert.equal(await queue.claim('w'), null);
    advance(60_000);
    assert.equal((await queue.claim('w')).idem_key, 'later');
  });

  test('never gives the same job to two workers', async () => {
    const queue = q();
    for (let i = 0; i < 5; i += 1) await queue.enqueue({ type: 't', idemKey: `j${i}` });
    const claims = await Promise.all(Array.from({ length: 25 }, (_, i) => queue.claim(`w${i}`)));
    const got = claims.filter(Boolean).map((j) => j.idem_key);
    assert.equal(got.length, 5);
    assert.equal(new Set(got).size, 5);
  });

  test('filters by type', async () => {
    const queue = q();
    await queue.enqueue({ type: 'a', idemKey: 'a1' });
    await queue.enqueue({ type: 'b', idemKey: 'b1' });
    assert.equal((await queue.claim('w', { types: ['b'] })).idem_key, 'b1');
  });
});

describe('outcomes', () => {
  test('retries with backoff, then marks dead after max attempts', async () => {
    const queue = q();
    await queue.enqueue({ type: 't', idemKey: 'flaky', maxAttempts: 3 });
    let job = await queue.claim('w');
    assert.equal(await queue.fail(job, new Error('timeout')), 'retry');
    assert.equal(await queue.claim('w'), null, 'not due during backoff');
    advance(1_000);
    job = await queue.claim('w');
    assert.equal(job.attempts, 2);
    assert.equal(await queue.fail(job, new Error('timeout')), 'retry');
    advance(2_000); // second backoff doubles
    job = await queue.claim('w');
    assert.equal(await queue.fail(job, new Error('timeout')), 'dead');
    const stored = await db.collection('jobs').findOne({ idem_key: 'flaky' });
    assert.equal(stored.status, 'dead');
    assert.match(stored.last_error, /timeout/);
  });

  test('a permanent failure is dead at once', async () => {
    const queue = q();
    await queue.enqueue({ type: 't', idemKey: 'bad' });
    const job = await queue.claim('w');
    assert.equal(await queue.fail(job, new Error('suppressed'), { retryable: false }), 'dead');
  });

  test('cancel stops a pending job', async () => {
    const queue = q();
    await queue.enqueue({ type: 't', idemKey: 'followup' });
    assert.equal(await queue.cancel('followup', 'founder replied'), true);
    assert.equal(await queue.claim('w'), null);
  });
});

describe('crash recovery and fencing', () => {
  test('an expired lock is recovered and the old worker cannot overwrite the new attempt', async () => {
    const queue = q();
    await queue.enqueue({ type: 't', idemKey: 'slow' });
    const first = await queue.claim('worker-A');
    advance(61_000); // worker A went silent past its lock
    assert.deepEqual(await queue.recoverStale(), { requeued: 1, dead: 0 });
    const second = await queue.claim('worker-B');
    assert.equal(second.attempts, 2);
    assert.equal(await queue.complete(first, 'late result'), false, 'A is fenced out');
    assert.equal(await queue.complete(second, 'ok'), true);
    const stored = await db.collection('jobs').findOne({ idem_key: 'slow' });
    assert.equal(stored.status, 'done');
    assert.equal(stored.result, 'ok');
  });

  test('heartbeat keeps a long job locked', async () => {
    const queue = q();
    await queue.enqueue({ type: 't', idemKey: 'long' });
    const job = await queue.claim('w');
    advance(50_000);
    assert.equal(await queue.heartbeat(job), true);
    advance(50_000); // 100 s after claim, but only 50 s after the heartbeat
    assert.deepEqual(await queue.recoverStale(), { requeued: 0, dead: 0 });
  });

  test('a job that dies on its final attempt is marked dead, not retried forever', async () => {
    const queue = q();
    await queue.enqueue({ type: 't', idemKey: 'last', maxAttempts: 1 });
    await queue.claim('w');
    advance(61_000);
    assert.deepEqual(await queue.recoverStale(), { requeued: 0, dead: 1 });
  });
});

describe('worker', () => {
  test('runs handlers and records each outcome', async () => {
    const queue = new JobQueue(db, { lockMs: 60_000, backoffBaseMs: 1 });
    await queue.enqueue({ type: 'ok', idemKey: 'a', payload: { n: 2 } });
    await queue.enqueue({ type: 'boom', idemKey: 'b' });
    await queue.enqueue({ type: 'never', idemKey: 'c' });
    const quiet = { warn() {}, error() {} };
    const worker = new Worker(queue, {
      ok: async (job) => job.payload.n * 21,
      boom: async () => { throw new PermanentError('bad input'); },
    }, { workerId: 'test', pollMs: 50, concurrency: 2, log: quiet });
    await worker.fill();
    await Promise.all([...worker.inFlight]);
    const byKey = Object.fromEntries((await db.collection('jobs').find().toArray()).map((j) => [j.idem_key, j]));
    assert.equal(byKey.a.status, 'done');
    assert.equal(byKey.a.result, 42);
    assert.equal(byKey.b.status, 'dead');
    assert.equal(byKey.c.status, 'pending', 'no handler for this type, so it is left alone');
  });

  test('a database error while recording the outcome never becomes an unhandled rejection', async () => {
    const queue = new JobQueue(db, { lockMs: 60_000 });
    await queue.enqueue({ type: 'ok', idemKey: 'x' });
    const job = await queue.claim('w');
    queue.complete = async () => { throw new Error('connection reset'); };
    queue.fail = async () => { throw new Error('connection reset'); };
    const worker = new Worker(queue, { ok: async () => 1 }, { workerId: 'w', log: { warn() {}, error() {} } });
    assert.equal(await worker.execute(job), 'unrecorded');
    const failing = new Worker(queue, { ok: async () => { throw new Error('handler broke'); } }, { workerId: 'w', log: { warn() {}, error() {} } });
    assert.equal(await failing.execute(job), 'unrecorded');
    assert.equal((await db.collection('jobs').findOne({ idem_key: 'x' })).status, 'running', 'left for recoverStale');
  });

  test('a handler is told when its lock is lost', async () => {
    const queue = new JobQueue(db, { lockMs: 3_000 });
    await queue.enqueue({ type: 'slow', idemKey: 'y' });
    const job = await queue.claim('w');
    let aborted = false;
    const worker = new Worker(queue, {
      slow: (_job, { signal }) => new Promise((resolve) => {
        signal.addEventListener('abort', () => { aborted = true; resolve('stopped'); });
      }),
    }, { workerId: 'w', log: { warn() {}, error() {} } });
    // another worker takes the job over (its lock token changes)
    await db.collection('jobs').updateOne({ _id: job._id }, { $set: { 'lock.token': 'someone-else' } });
    assert.equal(await worker.execute(job), 'lost');
    assert.ok(aborted, 'the first heartbeat after the takeover aborts the handler');
  });

  test('stop() ends the run loop promptly', async () => {
    const worker = new Worker(new JobQueue(db), {}, { workerId: 'test', pollMs: 30_000 });
    const running = worker.run();
    setTimeout(() => worker.stop(), 50);
    const t0 = Date.now();
    await running;
    assert.ok(Date.now() - t0 < 5_000);
  });
});

const quiet = { warn() {}, error() {} };
const jobDoc = (idemKey) => db.collection('jobs').findOne({ idem_key: idemKey });

describe('queue: inputs, cancel, recovery, time', () => {
  test('enqueue refuses an Invalid Date (it would run at once) and a fractional priority', async () => {
    const queue = q();
    await assert.rejects(queue.enqueue({ type: 't', idemKey: 'bad-date', dueAt: new Date(undefined + 7 * 86_400_000) }), /valid Date/);
    await assert.rejects(queue.enqueue({ type: 't', idemKey: 'bad-date', dueAt: '2026-12-01' }), /valid Date/);
    await assert.rejects(queue.enqueue({ type: 't', idemKey: 'bad-pri', priority: 1.5 }), /priority/);
    assert.equal(await db.collection('jobs').countDocuments(), 0);
  });

  test('cancelling a running job: its attempt is not retried, and a lost worker does not bring it back', async () => {
    const queue = q();
    await queue.enqueue({ type: 't', idemKey: 'followup' });
    let job = await queue.claim('w');
    assert.equal(await queue.cancel('followup', 'founder replied'), true);
    assert.equal(await queue.fail(job, new Error('SMTP 421')), 'cancelled');
    assert.equal((await jobDoc('followup')).status, 'cancelled');
    assert.equal(await queue.cancel('followup'), false, 'already finished');

    await queue.enqueue({ type: 't', idemKey: 'followup2' });
    job = await queue.claim('w');
    await queue.cancel('followup2', 'founder replied');
    advance(61_000); // the worker vanished mid-attempt
    assert.deepEqual(await queue.recoverStale(), { requeued: 0, dead: 0, cancelled: 1 });
    assert.equal((await jobDoc('followup2')).status, 'cancelled');
  });

  test('recoverStale never hands out a job on its final attempt, even if marking it dead fails', async () => {
    const queue = q();
    await queue.enqueue({ type: 't', idemKey: 'last', maxAttempts: 1 });
    await queue.claim('w');
    advance(61_000);
    const updateMany = queue.col.updateMany.bind(queue.col);
    queue.col.updateMany = (filter, update, opts) => (update.$set?.status === 'dead' ? Promise.resolve({ modifiedCount: 0 }) : updateMany(filter, update, opts));
    assert.deepEqual(await queue.recoverStale(), { requeued: 0, dead: 0 });
    assert.equal(await queue.claim('w'), null);
    queue.col.updateMany = updateMany;
    assert.deepEqual(await queue.recoverStale(), { requeued: 0, dead: 1 });
  });

  test('backoff never passes backoffMaxMs, and the default schedule rides out a half-day outage', () => {
    const high = new JobQueue(db, { random: () => 0.9999 });
    assert.equal(high.backoffMs(40), high.backoffMaxMs);
    const mid = new JobQueue(db, { random: () => 0.5 });
    let total = 0;
    for (let attempt = 1; attempt < mid.maxAttempts; attempt += 1) total += mid.backoffMs(attempt);
    assert.ok(total >= 12 * 3_600_000, `retries span ${(total / 3_600_000).toFixed(1)} h`);
  });

  test('lock times come from the database server: a worker whose clock runs fast takes nothing over', async () => {
    const onTime = new JobQueue(db, { lockMs: 60_000 });
    const fast = new JobQueue(db, { lockMs: 60_000, localClock: () => Date.now() + 120_000 });
    await onTime.enqueue({ type: 't', idemKey: 'live' });
    const job = await onTime.claim('A');
    assert.deepEqual(await fast.recoverStale(), { requeued: 0, dead: 0 });
    assert.equal(await fast.claim('B'), null);
    assert.equal(await onTime.heartbeat(job), true);
    assert.ok(Math.abs((await fast.now()) - (await onTime.now())) < 5_000, 'both read the server clock');
  });

  test('a claim by type reads its own jobs through claim_by_type, not every due job of other types', async () => {
    const at = new Date(now - 1_000);
    const base = { status: 'pending', due_at: at, attempts: 0, max_attempts: 5, lead_id: null, step: null, payload: {}, lock: null, last_error: null, created_at: at, updated_at: at, finished_at: null };
    await db.collection('jobs').insertMany(Array.from({ length: 2_000 }, (_, i) => ({ ...base, type: 'not-mine', idem_key: `o${i}`, priority: 5 })));
    await q().enqueue({ type: 'mine', idemKey: 'm1' });
    const ex = await db.command({
      explain: { findAndModify: 'jobs', query: { status: 'pending', due_at: { $lte: new Date(now) }, type: { $in: ['mine'] } }, sort: { priority: -1, due_at: 1 }, update: { $set: { x: 1 } } },
      verbosity: 'executionStats',
    });
    assert.match(JSON.stringify(ex.queryPlanner.winningPlan), /claim_by_type/);
    assert.ok(ex.executionStats.totalKeysExamined <= 5, `examined ${ex.executionStats.totalKeysExamined} keys`);
    assert.equal((await q().claim('w', { types: ['mine'] })).idem_key, 'm1');
  });
});

describe('worker: limits and failure paths', () => {
  test('stop() while the loop waits on the database returns at once, not after pollMs', async () => {
    const slow = { lockMs: 60_000, recoverStale: () => sleep(300), claim: async () => null };
    const worker = new Worker(slow, { t: async () => 1 }, { workerId: 'w', pollMs: 30_000, log: quiet });
    const t0 = Date.now();
    const running = worker.run();
    worker.stop(); // Ctrl+C while recoverStale() is waiting on the server
    await running;
    assert.ok(Date.now() - t0 < 2_000, `took ${Date.now() - t0} ms`);
  });

  test('run() twice on one Worker is refused', async () => {
    const worker = new Worker(new JobQueue(db), {}, { workerId: 'w', pollMs: 30_000, log: quiet });
    const running = worker.run();
    await assert.rejects(worker.run(), /already running/);
    worker.stop();
    await running;
  });

  test('a result that cannot be stored: the job is done without it, and the step is not run again', async () => {
    const queue = new JobQueue(db, { lockMs: 60_000 });
    await queue.enqueue({ type: 'big', idemKey: 'r1' });
    let runs = 0;
    const circular = {};
    circular.self = circular;
    const worker = new Worker(queue, { big: async () => { runs += 1; return circular; } }, { workerId: 'w', log: quiet });
    assert.equal(await worker.execute(await queue.claim('w')), 'done');
    const stored = await jobDoc('r1');
    assert.equal(stored.status, 'done');
    assert.equal(stored.result, null);
    assert.match(stored.last_error, /could not be stored/);
    assert.equal(runs, 1);
  });

  test('odd failures are recorded truthfully: a rejection with null, a PermanentError from another copy of the module', async () => {
    const queue = new JobQueue(db, { lockMs: 60_000, backoffBaseMs: 1 });
    await queue.enqueue({ type: 'nul', idemKey: 'n1' });
    await queue.enqueue({ type: 'perm', idemKey: 'p1' });
    const logs = [];
    const foreign = new Error('suppressed address');
    foreign.name = 'PermanentError';
    const worker = new Worker(queue, { nul: () => Promise.reject(null), perm: async () => { throw foreign; } }, { workerId: 'w', log: { warn: (m) => logs.push(m), error: (m) => logs.push(m) } });
    assert.equal(await worker.execute(await queue.claim('w', { types: ['nul'] })), 'retry');
    assert.match(logs[0], /failed \(retry\): null/);
    assert.equal(await worker.execute(await queue.claim('w', { types: ['perm'] })), 'dead');
  });

  test('when heartbeats cannot reach the database, the handler is told before its lock expires', async () => {
    const queue = new JobQueue(db, { lockMs: 3_000 });
    await queue.enqueue({ type: 'slow', idemKey: 'h1' });
    const job = await queue.claim('A');
    queue.heartbeat = async () => { throw new Error('ECONNRESET'); };
    let abortedAfter = null;
    let reason = null;
    const t0 = performance.now();
    const worker = new Worker(queue, {
      slow: (_job, { signal }) => new Promise((resolve) => {
        signal.addEventListener('abort', () => { abortedAfter = performance.now() - t0; reason = signal.reason; resolve('stopped'); });
      }),
    }, { workerId: 'A', log: quiet });
    await worker.execute(job);
    assert.equal(reason?.name, 'LockLostError');
    assert.ok(abortedAfter < 3_000, `aborted after ${Math.round(abortedAfter)} ms, the lock lasts 3000`);
  });

  test('a step that runs past maxRunMs is aborted, and abandoned if it ignores the abort', async () => {
    const queue = new JobQueue(db, { lockMs: 60_000, backoffBaseMs: 1 });
    await queue.enqueue({ type: 'polite', idemKey: 'm1' });
    await queue.enqueue({ type: 'stuck', idemKey: 'm2' });
    const worker = new Worker(queue, {
      polite: (_job, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
      stuck: () => new Promise(() => {}),
    }, { workerId: 'w', maxRunMs: 200, abortGraceMs: 200, log: quiet });
    assert.equal(await worker.execute(await queue.claim('w', { types: ['polite'] })), 'retry');
    assert.match((await jobDoc('m1')).last_error, /ran longer than 200 ms/);
    const stuck = await queue.claim('w', { types: ['stuck'] });
    const t0 = Date.now();
    assert.equal(await worker.execute(stuck), 'abandoned');
    assert.ok(Date.now() - t0 < 2_000);
    const doc = await jobDoc('m2');
    assert.equal(doc.status, 'running', 'left for recoverStale once its lock expires');
    assert.deepEqual(doc.lock.expires_at, stuck.lock.expires_at, 'no longer extended by heartbeats');
  });

  test('stop() gives the jobs in hand stopGraceMs, then aborts them', async () => {
    const queue = new JobQueue(db, { lockMs: 60_000, backoffBaseMs: 1 });
    await queue.enqueue({ type: 'long', idemKey: 's1' });
    const worker = new Worker(queue, {
      long: (_job, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
    }, { workerId: 'w', pollMs: 30_000, log: quiet });
    const running = worker.run();
    while (worker.inFlight.size === 0) await sleep(20);
    const t0 = Date.now();
    worker.stop({ graceMs: 200 });
    await running;
    assert.ok(Date.now() - t0 < 3_000, `stopped after ${Date.now() - t0} ms`);
    const doc = await jobDoc('s1');
    assert.equal(doc.status, 'pending', 'retried later, not lost');
    assert.match(doc.last_error, /is stopping/);
  });

  test('a free slot is used as soon as a job finishes, even while another job hangs', async () => {
    const queue = new JobQueue(db, { lockMs: 60_000 });
    await queue.enqueue({ type: 'hang', idemKey: 'hang', priority: 9 });
    for (let i = 0; i < 20; i += 1) await queue.enqueue({ type: 'fast', idemKey: `f${i}` });
    const worker = new Worker(queue, {
      hang: (_job, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
      fast: async () => 'ok',
    }, { workerId: 'w', pollMs: 30_000, concurrency: 2, log: quiet });
    const running = worker.run();
    const t0 = Date.now();
    while (await db.collection('jobs').countDocuments({ type: 'fast', status: 'done' }) < 20 && Date.now() - t0 < 10_000) await sleep(50);
    assert.equal(await db.collection('jobs').countDocuments({ type: 'fast', status: 'done' }), 20, 'without waiting for pollMs');
    worker.stop({ graceMs: 0 });
    await running;
  });
});

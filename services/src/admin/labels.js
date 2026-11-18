import { createHash } from 'node:crypto';
import { startupView } from './queries.js';
import { wilson } from '../attribution/results.js';

/**
 * Labelling pairs to measure the matcher (design 7.2 and 7.10; ingest/src/leadengine/kb/labels.py).
 *
 * The review queue holds the pairs the matcher was unsure about. This page holds the ones it was
 * sure about, because those are what precision is measured on: every link the matcher made on its
 * own (entity_links.matcher), held-out links first, then a fixed sample of near misses (candidates it
 * did not link), which show whether it misses true matches. A person says same, different or unsure;
 * the decision goes into match_reviews like a review decision (so a "different" also undoes the link
 * at the next nightly build) and is logged.
 *
 * The held-out fold is the same as the matcher's: one startup in five by the SHA-1 of its key, never
 * used to train the model, so precision on it is the honest number for the design's 95% target.
 * `kb eval` on the data side reports the same figure with the other measures.
 */

export const NEAR_MISS_SAMPLE = 100;

/** match.holdout(entity_key) in the data side: int(sha1(key), 16) % 5 == 0. */
export const heldOut = (entityKey) => BigInt(`0x${createHash('sha1').update(entityKey, 'utf8').digest('hex')}`) % 5n === 0n;
const own = (d) => d.matcher ?? { status: d.status, company_id: d.company_id, method: d.method, probability: d.probability };
const order = (s) => createHash('sha1').update(s, 'utf8').digest('hex');

/** Every pair on the labelling page, in the order a person should take them. */
async function labelPairs(db, { nearMisses = NEAR_MISS_SAMPLE } = {}) {
  const links = await db.collection('entity_links').find({ entity_type: 'startup' },
    { projection: { entity_key: 1, status: 1, company_id: 1, method: 1, probability: 1, matcher: 1, candidates: 1 } }).toArray();
  const linked = [];
  const near = [];
  for (const d of links) {
    const m = own(d);
    if (m.status === 'linked' && m.company_id) {
      linked.push({ entity_key: d.entity_key, company_id: m.company_id, kind: 'link', method: m.method ?? null, probability: m.probability ?? null, held_out: heldOut(d.entity_key) });
    }
    if (d.status === 'review') continue;                      // those are on the review page
    for (const c of d.candidates ?? []) {
      if (c.company_id !== m.company_id) near.push({ entity_key: d.entity_key, company_id: c.company_id, kind: 'near_miss', method: c.method ?? null, probability: c.probability ?? null, held_out: heldOut(d.entity_key) });
    }
  }
  linked.sort((a, b) => Number(b.held_out) - Number(a.held_out) || a.entity_key.localeCompare(b.entity_key));
  near.sort((a, b) => order(`${a.entity_key}|${a.company_id}`).localeCompare(order(`${b.entity_key}|${b.company_id}`)));
  return [...linked, ...near.slice(0, nearMisses)];
}

/** The labelling page: progress, precision so far, and the next pairs to label. */
export async function labelQueue(db, { limit = 20 } = {}) {
  const pairs = await labelPairs(db);
  const reviews = new Map((await db.collection('match_reviews').find({ entity_type: 'startup' }, { projection: { decision: 1, decided_by: 1 } }).toArray())
    .map((r) => [r._id, r]));
  const key = (p) => `startup:${p.entity_key}|${p.company_id}`;
  const done = pairs.filter((p) => reviews.has(key(p)));
  const todo = pairs.filter((p) => !reviews.has(key(p)));
  const precision = (subset) => {
    let same = 0;
    let different = 0;
    for (const p of subset) {
      const d = reviews.get(key(p))?.decision;
      if (d === 'same') same += 1;
      if (d === 'different') different += 1;
    }
    const n = same + different;
    return { judged: n, same, different, precision: n ? same / n : null, wilson_95: n ? wilson(same, n) : null };
  };
  const links = pairs.filter((p) => p.kind === 'link');
  const companies = new Map((await db.collection('companies').find({ _id: { $in: todo.slice(0, limit).map((p) => p.company_id) } },
    { projection: { name: 1, cohort: 1, 'attrs.incorporation_date.value': 1, 'attrs.registered_district.value': 1, 'attrs.district.value': 1 } }).toArray())
    .map((c) => [c._id, c]));
  const items = [];
  for (const p of todo.slice(0, limit)) {
    const c = companies.get(p.company_id);
    items.push({ ...p, startup: await startupView(db, p.entity_key),
      company: { id: p.company_id, name: c?.name ?? null, incorporated: c?.attrs?.incorporation_date?.value ?? null,
        district: c?.attrs?.registered_district?.value ?? c?.attrs?.district?.value ?? null } });
  }
  return {
    total: pairs.length, labelled: done.length, waiting: todo.length,
    links: links.length, held_out_links: links.filter((p) => p.held_out).length, near_misses: pairs.length - links.length,
    precision: { held_out: precision(links.filter((p) => p.held_out)), all_links: precision(links) },
    recall_check: { near_misses_labelled: done.filter((p) => p.kind === 'near_miss').length,
      near_misses_same: done.filter((p) => p.kind === 'near_miss' && reviews.get(key(p))?.decision === 'same').length },
    target: 0.95,
    items,
  };
}

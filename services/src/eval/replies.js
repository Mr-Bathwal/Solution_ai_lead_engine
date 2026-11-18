import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';
import { LABELS, classifyByRules, classifyReply, scrub } from '../inbound/classify.js';

/**
 * The reply-classification test sets (design 7.10: "about 200 replies for reply classification"):
 *
 *   data/testsets/replies.jsonl       160 replies written for the build, in English, Hindi and
 *                                     Hinglish, each with its label. The rules were tuned on them, so
 *                                     they are a regression test, not a measure: rules v2 scored
 *                                     57.5% on the last 40 before those were used to tune v3.
 *   data/testsets/replies_real.jsonl  real replies labelled in the Admin inbox (`inbox:export-labels`),
 *                                     never used for tuning: the measure that counts (`--real`).
 *
 * Re-run whenever the rules, the prompt or the model change (`lead-engine eval:replies`, `--ai` to
 * include the gateway).
 *
 * Two numbers matter more than accuracy:
 *   wrong_suppressions  replies the engine would have suppressed by itself (opt-out or wrong address
 *                       at the auto-act confidence) that a person labelled otherwise: someone who
 *                       wanted to hear from us, silenced. This must stay at 0.
 *   missed_opt_outs     opt-outs the engine would not have acted on by itself. They still stop cold
 *                       outreach (any reply does) and wait for a person, so they cost a person's time,
 *                       not a founder's trust.
 */

export const TESTSET = path.join(ROOT, 'data', 'testsets', 'replies.jsonl');
/**
 * Real replies, labelled by people in the Admin inbox and exported with `lead-engine inbox:export-labels`
 * (addresses and numbers taken out). Never used to tune the rules: the honest measure.
 */
export const REAL = path.join(ROOT, 'data', 'testsets', 'replies_real.jsonl');

export function loadReplies(file = TESTSET) {
  return readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
}

export async function evalReplies({ llm = null, file = TESTSET, autoAct = 0.8 } = {}) {
  const cases = loadReplies(file);
  const confusion = Object.fromEntries(LABELS.map((a) => [a, Object.fromEntries(LABELS.map((b) => [b, 0]))]));
  const mistakes = [];
  let right = 0;
  let wrongSuppressions = 0;
  let missedOptOuts = 0;
  let aiCalls = 0;
  for (const c of cases) {
    const r = llm?.configured ? await classifyReply({ subject: c.subject, text: c.text }, { llm }) : classifyByRules({ subject: c.subject, text: c.text });
    if (r.by === 'ai') aiCalls += 1;
    confusion[c.label][r.label] += 1;
    if (r.label === c.label) right += 1;
    else mistakes.push({ id: c.id, expected: c.label, got: r.label, confidence: r.confidence, text: c.text });
    const acts = ['unsubscribe', 'wrong_person'].includes(r.label) && r.confidence >= autoAct;
    if (acts && r.label !== c.label) wrongSuppressions += 1;
    if (c.label === 'unsubscribe' && !(r.label === 'unsubscribe' && r.confidence >= autoAct)) missedOptOuts += 1;
  }
  const perLabel = Object.fromEntries(LABELS.map((l) => {
    const tp = confusion[l][l];
    const predicted = LABELS.reduce((n, x) => n + confusion[x][l], 0);
    const actual = LABELS.reduce((n, x) => n + confusion[l][x], 0);
    return [l, { cases: actual, precision: predicted ? +(tp / predicted).toFixed(3) : null, recall: actual ? +(tp / actual).toFixed(3) : null }];
  }));
  return {
    summary: { cases: cases.length, accuracy: +(right / cases.length).toFixed(3), wrong_suppressions: wrongSuppressions, missed_opt_outs: missedOptOuts,
      by: llm?.configured ? 'rules, then the AI when unsure' : 'rules only', ai_calls: aiCalls, per_label: perLabel },
    confusion, mistakes,
  };
}

/**
 * Writes the replies people have labelled in the inbox to replies_real.jsonl, with addresses, links
 * and numbers taken out (scrub). The file holds what founders wrote, so it is personal data: it is
 * kept on the server under the same retention as the inbox, never committed or shared.
 */
export async function exportLabelledReplies(db, { file = REAL } = {}) {
  const rows = await db.collection('inbound').find({ kind: 'reply', 'classification.by': 'person', label: { $type: 'string' }, text: { $type: 'string' } })
    .sort({ received_at: 1 }).toArray();
  const lines = rows.map((m) => JSON.stringify({ id: createHash('sha256').update(m.idem_key).digest('hex').slice(0, 12),
    lang: /[ऀ-ॿ]/.test(m.text) ? 'hi' : 'en', subject: scrub(m.subject ?? ''), text: scrub(m.text), label: m.label,
    engine_said: m.classification?.previous?.label ?? null }));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, lines.length ? `${lines.join('\n')}\n` : '');
  return { written: lines.length, file };
}

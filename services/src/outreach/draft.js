import { formatDate } from './evidence.js';
import { LlmUnavailable } from './llm.js';
import { maxWordsFor, qualityCheck } from './qc.js';
import { PAGE_URL, TEMPLATE_VERSION, templateDraft } from './templates.js';

/**
 * Writes a message from an evidence pack (design 7.5). With the LLM gateway configured, the strong
 * model drafts it from the pack alone; a draft that fails the quality check is tried again with the
 * failures as feedback, up to drafting.max_ai_attempts, and then the reviewed templates write it
 * instead. Without the gateway the templates write it. Either way the result has passed (or, for a
 * template bug, visibly failed) the same quality check before a person sees it.
 *
 * The prompt hands the model the signature and the opt-out paragraph word for word, so the parts
 * that matter legally are never paraphrased.
 */

export const PROMPT_VERSION = 'draft-v1';

const LANGUAGE = { en: 'English', hi: 'Hindi, in Devanagari script (deadline titles, form names and the law may stay in English)' };

export function draftPrompt(pack, { kind, language, fixed, maxWords, feedback = [] }) {
  const job = kind === 'follow_up'
    ? `a short follow-up to the first email (subject "${fixed.firstSubject}", sent on ${fixed.firstSentOn}). The subject must be "Re: ${fixed.firstSubject}".`
    : kind === 'new_need'
      ? `a short new email (not a reply) about the one new deadline or scheme in the pack's "need", mentioning that you first wrote on ${fixed.firstSentOn}.`
      : 'a short first email to the company\'s team.';
  const system = [
    `You write ${job} It goes from SolutionAI, which helps new companies in Uttar Pradesh, India, with their filings, to a newly registered company.`,
    'Use only the facts in the evidence pack. Do not add any other date, number, form, law, name, link or claim.',
    `Write in ${LANGUAGE[language]}. Plain text, no markdown, no exclamation marks.`,
    'Name the company exactly as written in the pack. Write each date as in the pack\'s examples ("13 November 2026"; in Hindi "13 नवंबर 2026").',
    'For a deadline whose status is was_due, say it "was due by" the date and that the founder can ignore it if it is done; never say a filing was missed, overdue or late.',
    'Schemes are things the company may qualify for, never promises. Never threaten penalties, never create urgency, never claim to write for the government or the MCA.',
    `Put the line ${PAGE_URL} on its own line exactly once, as the only link. End the body with the signature and then the opt-out paragraph below, copied exactly.`,
    `At most ${maxWords} words in the body.`,
    'Answer with JSON only: {"subject": "...", "body": "..."}.',
  ].join('\n');
  const user = JSON.stringify({
    evidence_pack: pack,
    date_examples: Object.fromEntries((pack.deadlines ?? []).map((d) => [d.due, fixed.dateText(d.due)])),
    signature: fixed.signature,
    opt_out_paragraph: fixed.optOut,
    ...(feedback.length ? { your_last_draft_failed_these_checks: feedback } : {}),
  });
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

function parseDraft(content) {
  let v;
  try {
    v = JSON.parse(content);
  } catch {
    const m = /\{[\s\S]*\}/.exec(content);
    if (!m) return null;
    try {
      v = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  return typeof v?.subject === 'string' && typeof v?.body === 'string' ? { subject: v.subject.trim(), body: v.body.trim() } : null;
}

export class Drafter {
  /** `llm`: an LlmGateway (or null); `cfg`: config/outreach.json; `org`: { name, website }. */
  constructor({ llm = null, cfg, org }) {
    this.llm = llm;
    this.cfg = cfg;
    this.org = org;
  }

  /**
   * Returns { subject, body, drafter, prompt_version, model, qc, tries }. `ctx`: { kind, language,
   * sender, firstSubject, firstSentOn, companyId, leadId }.
   */
  async draft(pack, ctx) {
    const { kind, language } = ctx;
    const tpl = templateDraft(pack, { kind, language, sender: ctx.sender, org: this.org, firstSubject: ctx.firstSubject, firstSentOn: ctx.firstSentOn });
    const check = (d) => qualityCheck(d, pack, { kind, language, cfg: this.cfg, org: this.org });
    const tries = [];
    if (this.llm?.configured) {
      // the parts the AI must copy word for word, taken from the template so they are identical
      const blocks = tpl.body.split('\n\n');
      const fixed = {
        signature: blocks.at(-2), optOut: blocks.at(-1), firstSubject: ctx.firstSubject, firstSentOn: ctx.firstSentOn,
        dateText: (iso) => formatDate(iso, language) ?? iso,
      };
      let feedback = [];
      for (let i = 0; i < (this.cfg.drafting?.max_ai_attempts ?? 2); i += 1) {
        let res;
        try {
          res = await this.llm.chat({
            task: 'draft', companyId: ctx.companyId ?? null, leadId: ctx.leadId ?? null,
            messages: draftPrompt(pack, { kind, language, fixed, maxWords: maxWordsFor(this.cfg, kind, language), feedback }),
          });
        } catch (err) {
          if (!(err instanceof LlmUnavailable)) throw err;
          tries.push({ drafter: 'ai', error: err.message });
          break;
        }
        const d = parseDraft(res.content);
        const qc = d ? check(d) : { passed: false, checks: [{ id: 'format', ok: false, detail: 'the answer was not {"subject", "body"} JSON' }] };
        tries.push({ drafter: 'ai', model: res.model, passed: qc.passed, failed: qc.checks.filter((c) => !c.ok).map((c) => c.id) });
        if (d && qc.passed) {
          return { ...d, drafter: 'ai', prompt_version: PROMPT_VERSION, model: res.model, qc: await this.#review(d, pack, qc, ctx), tries };
        }
        feedback = qc.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`);
      }
    }
    const qc = check(tpl);
    tries.push({ drafter: 'template', passed: qc.passed });
    return { ...tpl, drafter: 'template', prompt_version: TEMPLATE_VERSION, model: null, qc: qc.passed ? await this.#review(tpl, pack, qc, ctx) : qc, tries };
  }

  /**
   * The AI review (design 7.5): the small model answers yes/no questions about a draft that has
   * passed the rules. Advice only, shown to the approver beside the rules, until its answers have been
   * shown to agree with the reviewers' decisions; it never passes or fails a draft. Any failure of
   * the call leaves the draft as it was.
   */
  async #review(draft, pack, qc, ctx) {
    if (!this.llm?.configured) return qc;
    try {
      const res = await this.llm.chat({
        task: 'quality_check', companyId: ctx.companyId ?? null, leadId: ctx.leadId ?? null,
        messages: [
          { role: 'system', content: [
            'You check an email before a person approves it. Answer each question with true or false, judging only from the email and the evidence pack.',
            'facts_only: does every fact in the email appear in the evidence pack?',
            'no_false_claims: is it free of promises, threats, urgency and any claim to speak for the government?',
            'polite: is the tone polite and plain?',
            'one_next_step: does it ask for one clear next step?',
            'Answer with JSON only: {"facts_only": true, "no_false_claims": true, "polite": true, "one_next_step": true, "note": "at most one sentence"}.',
          ].join('\n') },
          { role: 'user', content: JSON.stringify({ evidence_pack: pack, email: { subject: draft.subject, body: draft.body } }) },
        ],
      });
      const v = parseDraftReview(res.content);
      return v ? { ...qc, ai_review: { ...v, model: res.model, advisory: true } } : qc;
    } catch (err) {
      if (err instanceof LlmUnavailable) return qc;
      throw err;
    }
  }
}

const REVIEW_KEYS = ['facts_only', 'no_false_claims', 'polite', 'one_next_step'];

function parseDraftReview(content) {
  let v;
  try {
    v = JSON.parse(content);
  } catch {
    return null;
  }
  if (!v || !REVIEW_KEYS.every((k) => typeof v[k] === 'boolean')) return null;
  return { ...Object.fromEntries(REVIEW_KEYS.map((k) => [k, v[k]])), note: typeof v.note === 'string' ? v.note.slice(0, 300) : null };
}

import { Meter, istMonth } from './meter.js';

/**
 * The platform's LLM gateway (design 7.5 and 8), as the engine uses it:
 *
 *   - every call names a task (draft, quality_check); the task fixes the model alias, the prompt
 *     version, the output limit and the temperature (config/llm.json), so a model or prompt change
 *     is a reviewed change to that file;
 *   - before a call, its largest possible cost is reserved against the month's cap
 *     (caps.json monthly.llm_spend_inr, kept in paise on the `llm_paise` meter) and against the
 *     company's token budget; after it, the reservation becomes the real cost;
 *   - every call, failed or not, is written to llm_calls with its model, tokens, cost and latency.
 *
 * The gateway is assumed to speak the OpenAI-compatible chat-completions format (POST
 * {LLM_GATEWAY_URL}/chat/completions, bearer key), which most gateways offer; the shape is in
 * docs/PLATFORM_CONTRACTS.md for the platform team to confirm. Without LLM_GATEWAY_URL and
 * LLM_GATEWAY_KEY nothing is called and the drafter uses the reviewed templates.
 */

export class LlmUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = 'LlmUnavailable';
  }
}

const estimateTokens = (messages) => Math.ceil(messages.reduce((n, m) => n + String(m.content ?? '').length, 0) / 3) + 50;

export class LlmGateway {
  constructor(db, { url = '', key = '', cfg, caps, models = {}, fetch = globalThis.fetch, clock = () => new Date() }) {
    this.db = db;
    this.url = String(url ?? '').replace(/\/+$/, '');
    this.key = key ?? '';
    this.cfg = cfg;
    this.capPaise = Math.round((caps?.monthly?.llm_spend_inr ?? 0) * 100);
    this.models = models;            // { small: 'name', strong: 'name' } from LLM_MODEL_SMALL / LLM_MODEL_STRONG
    this.fetch = fetch;
    this.clock = clock;
    this.meter = new Meter(db, { clock });
  }

  get configured() {
    return Boolean(this.url && this.key);
  }

  modelFor(task) {
    const t = this.cfg.tasks[task];
    if (!t) throw new TypeError(`no LLM task called ${task} in config/llm.json`);
    const alias = this.cfg.models[t.model];
    if (!alias) throw new TypeError(`config/llm.json task ${task} names an unknown model alias ${t.model}`);
    return { task: t, price: alias, name: this.models[t.model] || alias.name };
  }

  /** Tokens this company has used this month, from llm_calls. */
  async tokensUsed(companyId, month) {
    if (!companyId) return 0;
    const [from, to] = [new Date(`${month}-01T00:00:00+05:30`), nextMonthStart(month)];
    const r = await this.db.collection('llm_calls').aggregate([
      { $match: { company_id: companyId, at: { $gte: from, $lt: to } } },
      { $group: { _id: null, n: { $sum: { $add: ['$input_tokens', '$output_tokens'] } } } },
    ]).toArray();
    return r[0]?.n ?? 0;
  }

  /**
   * One chat call. Returns { content, model, inputTokens, outputTokens, costInr }. Throws
   * LlmUnavailable when the gateway is not configured, the cap or the company's budget would be
   * passed, or the gateway fails; the caller then falls back to the templates.
   */
  async chat({ task, messages, companyId = null, leadId = null, json = true }) {
    if (!this.configured) throw new LlmUnavailable('the LLM gateway is not configured');
    const { task: t, price, name } = this.modelFor(task);
    const now = this.clock();
    const month = istMonth(now);
    const inEst = estimateTokens(messages);
    if (companyId && (await this.tokensUsed(companyId, month)) + inEst + t.max_output_tokens > this.cfg.per_lead_token_budget) {
      throw new LlmUnavailable(`company ${companyId} has used its AI token budget for ${month}`);
    }
    const reserved = Math.ceil(((inEst * price.inr_per_mtok_in) + (t.max_output_tokens * price.inr_per_mtok_out)) / 1e6 * 100);
    if (!(await this.meter.take({ meter: 'llm_paise', period: month, amount: reserved, cap: this.capPaise }))) {
      throw new LlmUnavailable(`the month's AI spending cap (₹${this.capPaise / 100}) would be passed`);
    }
    const started = performance.now();
    let inputTokens = 0;
    let outputTokens = 0;
    let ok = false;
    try {
      const res = await this.fetch(`${this.url}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: name, messages, max_tokens: t.max_output_tokens, temperature: t.temperature,
          ...(json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: AbortSignal.timeout(this.cfg.timeout_ms ?? 30_000),
      });
      if (!res.ok) throw new LlmUnavailable(`the LLM gateway answered ${res.status}`);
      const body = await res.json();
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new LlmUnavailable('the LLM gateway answered without a message');
      inputTokens = Number.isInteger(body?.usage?.prompt_tokens) ? body.usage.prompt_tokens : inEst;
      outputTokens = Number.isInteger(body?.usage?.completion_tokens) ? body.usage.completion_tokens : Math.ceil(content.length / 3);
      ok = true;
      const costInr = (inputTokens * price.inr_per_mtok_in + outputTokens * price.inr_per_mtok_out) / 1e6;
      return { content, model: body.model ?? name, inputTokens, outputTokens, costInr };
    } catch (err) {
      if (err instanceof LlmUnavailable) throw err;
      throw new LlmUnavailable(`the LLM gateway call failed: ${err?.message ?? err}`);
    } finally {
      const costInr = ok ? (inputTokens * price.inr_per_mtok_in + outputTokens * price.inr_per_mtok_out) / 1e6 : 0;
      await this.meter.settle({ meter: 'llm_paise', period: month, reserved, actual: Math.ceil(costInr * 100) });
      await this.db.collection('llm_calls').insertOne({
        at: now, task, model: name, prompt_version: t.prompt_version, input_tokens: inputTokens, output_tokens: outputTokens,
        cost_inr: costInr, company_id: companyId, lead_id: leadId, latency_ms: Math.round(performance.now() - started), ok,
      });
    }
  }
}

function nextMonthStart(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01T00:00:00+05:30`);
}

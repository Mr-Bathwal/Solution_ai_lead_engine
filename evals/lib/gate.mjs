/**
 * Eval 3: does the compliance gate (and what stands in front of it) block what it must?
 *
 * Every case in fixtures/gate_cases.json runs the engine's own path on a throwaway database:
 * planOutreach -> the draft job (with the address check) -> a person's approval (MessageStore.decide
 * and queueSend, as the Admin approval page does) -> the send job, whose compliance gate decides.
 * The transport is a fake that keeps the email, DNS answers for invented domains, and fetch refuses
 * anything not routed to a fake. The outcome is what actually happened, compared with what the
 * engine promises for that case.
 */
import { engine, fixture } from './common.mjs';
import { REVIEWER, buildDeps, capturingFetch, fakeDns, fakeTransport } from './harness.mjs';

const MONTH = '2026-11';
const DAY = 86_400_000;

function companyDoc(base, over) {
  const seen = new Date('2026-11-01T00:00:00Z');
  const attr = (value, source) => ({ value, source, seen_at: seen });
  const email = 'registered_email' in over ? over.registered_email : base.registered_email;
  const site = over.website_email ?? null;
  const cin = over.cin ?? base.cin;
  const attrs = { incorporation_date: attr(base.incorporated, 'mca_monthly'), company_type: attr('Private Limited Company', 'mca_monthly'),
    registered_district: attr(base.district, 'mca_monthly') };
  if (email) attrs.registered_email = attr(email, 'infyner');
  if (site) attrs.website_email = { ...attr(site, 'company_website'), ref: { domain: site.split('@')[1], legal_basis: 'published_by_company' } };
  return { _id: cin, kind: 'company', state: over.state ?? 'UP', name: over.name ?? base.name, ids: { cin, uplc: [] }, cohort: '2026-10',
    sources: ['mca_monthly'], first_seen_at: seen, updated_at: seen, schema_version: 2, former_names: [], attrs };
}

function leadDoc(base, cid, over, extra) {
  const lead = {
    company_id: cid, stage: 'shortlisted', holdout: false, eligible: true, cohort: '2026-10', shortlist: { month: MONTH, rank: 1 },
    needs: { rules_confirmed: true, rules_version: 'eval-rules', deadlines: [...base.deadlines, ...(extra ?? [])], schemes: base.schemes },
    created_at: new Date('2026-11-01T00:00:00Z'), updated_at: new Date('2026-11-01T00:00:00Z'),
  };
  for (const [k, v] of Object.entries(over)) {
    const parts = k.split('.');
    let t = lead;
    for (const p of parts.slice(0, -1)) t = t[p];
    t[parts.at(-1)] = v;
  }
  return lead;
}

export async function runGateEval(h) {
  const fx = fixture('gate_cases.json');
  const { planOutreach, JOB_DRAFT, JOB_SEND, queueSend } = await engine('src/outreach/sequence.js');
  const { MessageStore } = await engine('src/outreach/messages.js');
  const { DeferError } = await engine('src/jobs/worker.js');
  const results = [];
  for (const c of fx.cases) {
    await h.reset();
    let now = Date.parse(c.draft_at ?? fx.base.draft_at);
    const clock = () => new Date(now);
    const transport = fakeTransport();
    const outside = capturingFetch(c.provider_says ? [{ match: /api\.zerobounce\.net|api\.millionverifier\.com/, reply: () => ({ json: { status: c.provider_says } }) }] : []);
    const dns = fakeDns({ noMx: c.dns?.no_mx, aOnly: c.dns?.a_only });
    const make = (useWebsite) => buildDeps(h, { env: c.env ?? {}, recipientCfg: useWebsite === undefined ? null : { use_website_email: useWebsite },
      clock, fetch: outside.fetch, transport, dns });
    const { o } = await make(c.use_website_email);
    const trail = [];
    const row = { id: c.id, why: c.why, expect: c.expect, outcome: null, gate: null, detail: '' };
    try {
      const company = companyDoc(fx.base, c.company ?? {});
      try {
        await h.db.collection('companies').insertOne(company);
      } catch (err) {
        trail.push(`the database refused the company (${err.code === 121 ? 'schema validation' : err.message})`);
      }
      const lead = leadDoc(fx.base, company._id, c.lead ?? {}, c.deadlines_extra);
      lead._id = (await h.db.collection('leads').insertOne(lead)).insertedId;
      const activity = (type, { daysAgo = 0, data = {}, companyId = company._id, i = 0 } = {}) => h.db.collection('activities').insertOne({
        at: new Date(now - daysAgo * DAY - 3_600_000), type, channel: type === 'claimed' ? 'page' : 'email', company_id: companyId,
        lead_id: companyId === company._id ? lead._id : null, holdout: false, idem_key: `eval:${type}:${companyId}:${daysAgo}:${i}`, data });
      const apply = async (op, msgId) => {
        if (op.op === 'suppress') await o.suppression.add(op.email ? { email: op.email } : { domain: op.domain }, { reason: 'unsubscribe', source: { via: 'eval' } });
        else if (op.op === 'activity') await activity(op.type, { daysAgo: op.days_ago ?? 0, data: op.data ?? {} });
        else if (op.op === 'sent_today') {
          for (const mb of ['mailbox-1', 'mailbox-2']) {
            for (let i = 0; i < op.per_mailbox; i += 1) await activity('sent', { companyId: `OTHER-${mb}-${i}`, data: { kind: 'first_touch', mailbox: mb }, i });
          }
        } else if (op.op === 'bounces') {
          for (const mb of ['mailbox-1', 'mailbox-2']) {
            for (let i = 0; i < op.sends; i += 1) await activity('sent', { companyId: `OTHER-${mb}-${i}`, daysAgo: 2 + (i % 18), data: { kind: 'first_touch', mailbox: mb }, i });
            for (let i = 0; i < op.per_mailbox; i += 1) await activity('bounced', { companyId: `OTHER-${mb}-${i}`, daysAgo: 3, data: { bounce: 'hard', mailbox: mb }, i });
          }
        } else if (op.op === 'lead') await h.db.collection('leads').updateOne({ _id: lead._id }, { $set: op.set });
        else if (op.op === 'message') await h.db.collection('messages').updateOne({ _id: msgId }, { $set: op.set });
        else throw new Error(`unknown op ${op.op}`);
      };
      for (const op of c.before ?? []) await apply(op);

      // plan and draft, as the daily plan and the worker do (twice when the case says the plan runs again)
      for (let round = 0; round < (c.replan ? 2 : 1); round += 1) {
        const stats = await planOutreach(o, { month: MONTH });
        trail.push(`plan: ${Object.entries(stats).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ') || 'nothing'}`);
        for (let job; (job = await o.queue.claim('eval', { types: [JOB_DRAFT] }));) {
          try {
            const r = await o.handlers[JOB_DRAFT](job);
            await o.queue.complete(job, r);
            trail.push(`draft: ${r.skipped ? `skipped (${r.skipped})` : r.status}`);
          } catch (err) {
            if (!(err instanceof DeferError)) throw err;
            trail.push(`draft: deferred (${err.message})`);
          }
        }
      }
      const msg = await h.db.collection('messages').findOne({ company_id: company._id, status: { $in: ['awaiting_approval', 'qc_failed'] } }, { sort: { created_at: -1 } });
      if (!msg) {
        row.outcome = 'no_message';
      } else if (msg.status === 'qc_failed') {
        row.outcome = 'no_message';
        trail.push('the draft failed the quality check');
      } else {
        const store = new MessageStore(h.db, { clock });
        const d = await store.decide(msg._id, { decision: 'approve', user: REVIEWER, cfg: o.cfg, org: o.org });
        await queueSend(o.queue, d.message);
        let sender = o;
        for (const op of c.after_approval ?? []) {
          if (op.op === 'use_website_email') sender = (await make(op.value)).o;
          else await apply(op, msg._id);
        }
        now = Date.parse(c.send_at ?? c.draft_at ?? fx.base.draft_at);
        const job = await sender.queue.claim('eval', { types: [JOB_SEND] });
        try {
          const r = await sender.handlers[JOB_SEND](job);
          row.outcome = transport.sent.length ? 'send' : 'stop';
          if (r.skipped) trail.push(`send: skipped (${r.skipped})`);
        } catch (err) {
          if (!(err instanceof DeferError)) throw err;
          row.outcome = transport.sent.length ? 'send' : 'wait';
        }
        const after = await h.db.collection('messages').findOne({ _id: msg._id });
        row.gate = after.gate ? { decision: after.gate.decision, code: after.gate.code, reason: after.gate.reasons?.join('; ') } : null;
        row.recipient_basis = after.recipient?.legal_basis ?? null;
      }
      if (c.expect_basis && row.outcome === 'send' && row.recipient_basis !== c.expect_basis) {
        trail.push(`sent under ${row.recipient_basis}, expected ${c.expect_basis}`);
        row.basis_mismatch = true;
      }
      const providerCalls = outside.calls.filter((x) => /zerobounce|millionverifier/.test(x.url)).length;
      if (c.expect_provider_calls !== undefined && providerCalls !== c.expect_provider_calls) {
        trail.push(`the verification service was called ${providerCalls} time(s)`);
        row.provider_mismatch = true;
      }
    } catch (err) {
      row.outcome = 'error';
      trail.push(`harness error: ${err.stack?.split('\n').slice(0, 3).join(' | ') ?? err}`);
    }
    row.agree = c.expect.includes(row.outcome) && !row.basis_mismatch && !row.provider_mismatch;
    row.detail = trail.join('; ');
    results.push(row);
  }
  const agree = results.filter((r) => r.agree).length;
  const errors = results.filter((r) => r.outcome === 'error').length;
  return { cases: results.length, agree, errors, results, disagreements: results.filter((r) => !r.agree) };
}

import readline from 'node:readline';
import { displayName, istDate } from '../outreach/evidence.js';
import { escapeRegex } from '../admin/queries.js';

/**
 * The engine's tools for Mr. AI and the team (design 7.5 "MCP tools" and 8), over the Model Context
 * Protocol: JSON-RPC 2.0, on stdio (`lead-engine mcp`, for a desktop client) or as streamable HTTP
 * (POST /mcp on the Admin server, with an Admin access token). Read-only, and company-level only:
 * no director, no contact detail, no consent or message is ever returned.
 *
 *   search_leads       UP companies by name, district, stage or shortlist month. Holdout companies
 *                      are left out: they are the comparison group and must not be approached.
 *   company_profile    one company's public facts, its stage, fit and why, and its needs.
 *   deadline_calendar  one company's filing calendar, each date with its law and source, and
 *                      whether a CA has confirmed the rules yet.
 *
 * Which tools Mr. AI gets is still to agree with the platform team (design section 14); these three
 * are the ones the design names.
 */

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'solutionai-lead-engine', version: '0.4.0' };
const STAGES = ['discovered', 'shortlisted', 'contacted', 'engaged', 'claimed', 'customer', 'closed'];
const CIN_OR_LLPIN = /^([UL][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}|[A-Z]{3}-[0-9]{4})$/;

export const TOOLS = [
  {
    name: 'search_leads',
    title: 'Search UP companies',
    description: 'Find newly registered Uttar Pradesh companies the lead engine knows, by name, district, stage or shortlist month. Company-level facts only. Holdout companies (the comparison group that is never contacted) are not returned.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      query: { type: 'string', description: 'Part of the company name' },
      district: { type: 'string', description: 'UP district, e.g. Lucknow' },
      stage: { type: 'string', enum: STAGES },
      shortlist_month: { type: 'string', pattern: '^\\d{4}-\\d{2}$', description: 'Only companies on this month\'s shortlist' },
      limit: { type: 'integer', minimum: 1, maximum: 25, default: 10 },
    } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'company_profile',
    title: 'Company profile',
    description: 'One company\'s public facts (MCA register and the UP startup portals), its stage in the pipeline, its fit score and the reasons, and its deadlines and schemes. Company-level only.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['company_id'], properties: { company_id: { type: 'string', description: 'CIN or LLPIN' } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'deadline_calendar',
    title: 'Filing calendar',
    description: 'A company\'s filing deadlines with dates, the law and the source for each, and whether a chartered accountant has confirmed the rules yet. Dates come from the incorporation date and the law; the engine cannot see what has already been filed.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['company_id'], properties: {
      company_id: { type: 'string', description: 'CIN or LLPIN' }, include_past: { type: 'boolean', default: false } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

const a = (c, k) => c?.attrs?.[k]?.value ?? null;
const facts = (c) => ({ company_id: c._id, name: displayName(c), kind: c.kind, legal_form: a(c, 'company_type'), incorporated: a(c, 'incorporation_date'),
  district: a(c, 'registered_district') ?? a(c, 'district'), nic_division: a(c, 'nic_division') ?? null, cohort: c.cohort ?? null });

async function searchLeads(db, args) {
  const limit = Math.min(25, Math.max(1, Number.isInteger(args.limit) ? args.limit : 10));
  const leadQ = { holdout: false };
  if (args.stage) {
    if (!STAGES.includes(args.stage)) throw new RangeError(`stage must be one of ${STAGES.join(', ')}`);
    leadQ.stage = args.stage;
  }
  if (args.shortlist_month) {
    if (!/^\d{4}-\d{2}$/.test(args.shortlist_month)) throw new RangeError('shortlist_month must be YYYY-MM');
    leadQ['shortlist.month'] = args.shortlist_month;
  }
  const companyQ = {};
  if (args.query) companyQ.name = { $regex: escapeRegex(String(args.query).toUpperCase().slice(0, 100)) };
  if (args.district) {
    const d = { $regex: `^${escapeRegex(String(args.district).slice(0, 60))}$`, $options: 'i' };
    companyQ.$or = [{ 'attrs.registered_district.value': d }, { 'attrs.district.value': d }];
  }
  const rows = await db.collection('leads').aggregate([
    { $match: leadQ },
    { $sort: { 'score.fit': -1 } },
    { $lookup: { from: 'companies', localField: 'company_id', foreignField: '_id', as: 'c', pipeline: [{ $match: companyQ }, { $project: { name: 1, kind: 1, cohort: 1, attrs: 1 } }] } },
    { $match: { 'c.0': { $exists: true } } },
    { $limit: limit },
  ]).toArray();
  return rows.map((l) => ({ ...facts(l.c[0]), stage: l.stage, fit: l.score?.fit ?? null, theme: l.score?.theme?.name ?? null,
    shortlist: l.shortlist ? { month: l.shortlist.month, rank: l.shortlist.rank } : null }));
}

async function companyOf(db, args) {
  const id = String(args.company_id ?? '').trim().toUpperCase();
  if (!CIN_OR_LLPIN.test(id)) throw new RangeError('company_id must be a CIN or LLPIN');
  const [company, lead] = await Promise.all([db.collection('companies').findOne({ _id: id }), db.collection('leads').findOne({ company_id: id })]);
  if (!company) throw new RangeError(`the engine has no company ${id} (it holds UP companies only)`);
  return { company, lead };
}

async function companyProfile(db, args) {
  const { company, lead } = await companyOf(db, args);
  const needs = lead?.needs ?? {};
  return {
    ...facts(company),
    on_up_startup_portals: (company.ids?.uplc ?? []).length > 0,
    stage: lead?.stage ?? null,
    outreach: !lead ? 'no lead yet' : lead.holdout ? 'holdout: the engine never contacts this company' : lead.eligible === false ? `not eligible: ${(lead.eligibility_reasons ?? []).join('; ')}` : 'eligible',
    fit: lead?.score ? { score: lead.score.fit, theme: lead.score.theme?.name ?? null, version: lead.score.version ?? null,
      reasons: (lead.score.components ?? []).filter((x) => x.points).slice(0, 8).map((x) => `${x.reason ?? x.key} (${x.points > 0 ? '+' : ''}${x.points})`) } : null,
    rules_confirmed: needs.rules_confirmed === true,
    schemes: (needs.schemes ?? []).map((s) => ({ name: s.name, verdict: s.verdict, benefit: s.benefit ?? null, missing: s.missing ?? [], source_url: s.source_url ?? null })),
    next_deadline: needs.next_deadline ? { title: needs.next_deadline.title, due: needs.next_deadline.due ?? null } : null,
  };
}

async function deadlineCalendar(db, args) {
  const { company, lead } = await companyOf(db, args);
  const today = istDate();
  const needs = lead?.needs ?? {};
  const deadlines = (needs.deadlines ?? [])
    .filter((d) => args.include_past || !d.due || d.due >= today || d.status === 'was_due')
    .map((d) => ({ title: d.title, form: d.form ?? null, due: d.due ?? null, status: d.status, law: d.law ?? null, source_url: d.source_url ?? null, note: d.note ?? null }));
  return {
    company_id: company._id, name: displayName(company), incorporated: a(company, 'incorporation_date'), rules_version: needs.rules_version ?? null,
    rules_confirmed: needs.rules_confirmed === true,
    caveat: needs.rules_confirmed === true ? 'Dates come from the incorporation date and the law; the engine cannot see what has already been filed.'
      : 'Not yet confirmed by a chartered accountant: do not tell a founder these dates as fact.',
    deadlines,
  };
}

const HANDLERS = { search_leads: searchLeads, company_profile: companyProfile, deadline_calendar: deadlineCalendar };

/**
 * Handles one JSON-RPC message. Returns the response object, or null for a notification.
 */
export async function handleMcp(db, msg) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const error = (code, message) => ({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return error(-32600, 'invalid request');
  const isNotification = !('id' in msg);
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return reply({ protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0], capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO, instructions: 'Read-only, company-level data on newly registered Uttar Pradesh companies. Never use it to contact a holdout company.' });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = msg.params?.name;
      const fn = HANDLERS[name];
      if (!fn) return error(-32602, `unknown tool: ${name}`);
      try {
        const out = await fn(db, msg.params?.arguments ?? {});
        return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 1) }], structuredContent: Array.isArray(out) ? { results: out } : out, isError: false });
      } catch (err) {
        if (err instanceof RangeError) return reply({ content: [{ type: 'text', text: err.message }], isError: true });
        throw err;
      }
    }
    default:
      return isNotification ? null : error(-32601, `method not found: ${msg.method}`);
  }
}

/** Serves MCP on stdin/stdout, one JSON message per line; anything else goes to stderr. */
export function serveStdio(db, { input = process.stdin, output = process.stdout, log = console } = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const pending = new Set();
  rl.on('line', (line) => {
    const p = answer(line).finally(() => pending.delete(p));
    pending.add(p);
  });
  async function answer(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`);
      return;
    }
    try {
      const res = await handleMcp(db, msg);
      if (res) output.write(`${JSON.stringify(res)}\n`);
    } catch (err) {
      log.error?.(`[mcp] ${err.stack ?? err}`);
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: 'internal error' } })}\n`);
    }
  }
  // the input ending (a client closing, or a piped batch) waits for the answers still being worked out
  return new Promise((resolve) => rl.on('close', () => Promise.allSettled([...pending]).then(() => resolve())));
}

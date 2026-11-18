import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { failureCounter } from '../admin/server.js';
import { maskEmail } from '../admin/queries.js';
import { displayName, istDate } from '../outreach/evidence.js';
import { stopOutreach } from '../outreach/stop.js';
import { tokenId } from '../outreach/tokens.js';
import { queueCallback } from '../voice/calls.js';
import { verifyChallenge, verifyMetaSignature } from '../outreach/whatsapp_hooks.js';
import { normalizeEmail, normalizePhone } from '../util/normalize.js';
import { campaignPage, checkEmailPage, claimError, claimPage, claimedPage, companyPage, confirmClaimPage, consentOptions, noticeText, notFoundPage, unsubscribePage } from './views.js';
import { TEXT, hindiState, pageLanguage } from './i18n.js';
import { CONFIRM_HOURS } from './confirm.js';
import { activeCampaign, campaignKey, findCompanies } from './campaigns.js';

/**
 * The founder-facing pages (design 7.6), served on their own port behind the platform's HTTPS proxy
 * at PUBLIC_BASE_URL. Separate from the Admin pages, which never face the internet.
 *
 *   GET  /c/{token}         the company's page: its next firm deadlines and the schemes it may
 *                           qualify for, with the law and sources, once the rules are confirmed
 *   GET  /c/{token}/claim   the claim form: who you are, and exactly what you agree to hear about
 *   POST /c/{token}/claim   records each agreement in the consent ledger with its exact wording, the
 *                           person (with consent as the legal basis) in `people`, a 'claimed'
 *                           activity, and hands the founder to the platform's sign-up
 *   GET  /k/{token}         a claim made from a campaign page, waiting for its email confirmation:
 *                           shows a button; POST completes the claim (the link works once, 48 hours)
 *   GET  /u/{token}         asks before unsubscribing (link scanners follow GET links)
 *   POST /u/{token}         unsubscribes: the address goes on the suppression list at once; also
 *                           the RFC 8058 one-click POST that mail providers send
 *   POST /hooks/voice/sarvam  the voice provider's report on a call back (Phase 4), checked against
 *                           the HMAC the engine put in the call's metadata (voice/calls.js)
 *   GET|POST /hooks/whatsapp  Meta's webhook: STOP and other replies, delivery reports, template
 *                           pauses (outreach/whatsapp_hooks.js), signed with the app secret
 *
 * A page view is logged as an 'opened' activity at most once a day per link, with no address or
 * cookie. No JavaScript, a strict Content-Security-Policy, no Referer sent (the links are
 * capabilities), and noindex for search engines.
 */

const CSP = "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const MAX_BODY = 16 * 1024;
const MAX_HOOK_BODY = 512 * 1024;     // a call report carries its transcript
const BAD_TOKEN_LIMIT = 20;

function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size <= max) chunks.push(c);
      else req.destroy();
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const CALL_SLOTS = ['morning', 'afternoon', 'evening', 'any'];
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createPublicServer({
  db, tokens, ledger, suppression, queue = null, platform, cfg, org, secret, privacyUrl = '', privacyContact = '',
  clock = () => new Date(), log = console, trustProxy = false, voice = null, whatsapp = null, confirm = null,
}) {
  if (!secret || secret.length < 32) throw new Error('PAGE_SECRET must be at least 32 characters');
  const css = readFileSync(new URL('./public.css', import.meta.url));
  const badTokens = failureCounter({ limit: BAD_TOKEN_LIMIT });
  const claims = failureCounter({ limit: 10, windowMs: 3_600_000 });
  const searches = failureCounter({ limit: 60, windowMs: 3_600_000 });   // campaign landing pages: searches and opened pages per address
  const confirmations = failureCounter({ limit: 3, windowMs: 86_400_000 });   // confirmation emails to one address in a day
  const sign = (s) => createHmac('sha256', secret).update(s).digest('base64url');
  const csrfFor = (tokenDoc) => sign(`form:${tokenDoc._id}`);
  const ipHash = (address) => sign(`ip:${address}`).slice(0, 32);

  const send = (res, status, body, type = 'text/html; charset=utf-8', extra = {}) => {
    res.writeHead(status, { 'Content-Type': type, 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow',
      'Strict-Transport-Security': 'max-age=31536000', ...extra });
    res.end(String(body));
  };
  const address = (req) => {
    if (trustProxy) {
      const hops = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (hops.length) return hops.at(-1);
    }
    return req.socket.remoteAddress ?? '';
  };

  async function companyView(companyId) {
    const [company, lead] = await Promise.all([db.collection('companies').findOne({ _id: companyId }), db.collection('leads').findOne({ company_id: companyId })]);
    if (!company) return null;
    const today = istDate(clock());
    const needs = lead?.needs ?? {};
    const firm = new Set(['due_soon', 'upcoming', 'was_due']);
    const deadlines = (needs.deadlines ?? []).filter((d) => firm.has(d.status) && d.due)
      .filter((d) => d.due >= today || Date.parse(today) - Date.parse(d.due) <= cfg.evidence.past_window_days * 86_400_000)
      .sort((a, b) => a.due.localeCompare(b.due)).slice(0, 8)
      .map((d) => ({ title: d.title, form: /\d/.test(d.form ?? '') && !/no MCA/i.test(d.form) ? d.form : null, due: d.due, past: d.due < today,
        law: d.law ?? null, source_url: d.source_url ?? null, note: d.note ?? null }));
    const schemes = (needs.schemes ?? []).filter((s) => ['eligible', 'check_required'].includes(s.verdict))
      .map((s) => ({ id: s.scheme_id ?? s.id ?? null, name: s.name, verdict: s.verdict, benefit: s.benefit ?? null, missing: s.missing ?? [], source_url: s.source_url ?? null }));
    const a = (k) => company.attrs?.[k]?.value ?? null;
    return {
      company: { id: company._id, name: displayName(company), kind: company.kind, legal_form: a('company_type'), incorporated: a('incorporation_date'),
        district: a('registered_district') ?? a('district') },
      lead, confirmed: needs.rules_confirmed === true, deadlines, schemes,
    };
  }

  async function logOpen(doc, lead = null) {
    const day = istDate(clock());
    try {
      // a page reached from an email is never a holdout company's; one found on a campaign page may be
      await db.collection('activities').insertOne({ at: clock(), type: 'opened', channel: 'page', company_id: doc.company_id, lead_id: doc.lead_id ?? null,
        campaign: doc.campaign ?? null, holdout: doc.campaign ? lead?.holdout === true : false, idem_key: `opened:${doc._id}:${day}`,
        data: { message_id: doc.message_id ?? null } });
    } catch (err) {
      if (err?.code !== 11000) throw err;     // already counted today
    }
  }

  /**
   * A campaign's landing page (campaigns.js): GET shows the search, GET ?q= the results (each signed,
   * so only a company the search found can be opened), POST /open issues the company page's link
   * with the campaign on it and goes there. Searches and opened pages are limited per address.
   */
  async function handleCampaign(req, res, url, code, open) {
    const campaign = activeCampaign(cfg, code, clock());
    if (!campaign) return send(res, 404, notFoundPage({ org }));
    const who = address(req);
    const now = clock().getTime();
    const signup = String(platform?.signupUrl || org.website || '');
    const signupUrl = signup ? `${signup}${signup.includes('?') ? '&' : '?'}ref=${encodeURIComponent(code)}` : null;
    const resultSig = (cid) => sign(`campaign:${code}:${cid}`);
    if (!open) {
      if (req.method !== 'GET') return send(res, 405, 'method not allowed', 'text/plain');
      const q = String(url.searchParams.get('q') ?? '').slice(0, 120);
      if (!q.trim()) return send(res, 200, campaignPage({ campaign, signupUrl }, { org }));
      if (searches.locked(who, now)) return send(res, 429, 'Too many searches from this connection. Please try again in an hour.', 'text/plain; charset=utf-8');
      searches.add(who, now);
      const found = await findCompanies(db, q);
      return send(res, 200, campaignPage({ campaign, signupUrl, query: q, results: found?.map((c) => ({ ...c, sig: resultSig(c.id) })) ?? null, tooShort: found === null }, { org }));
    }
    if (req.method !== 'POST') return send(res, 405, 'method not allowed', 'text/plain');
    const params = new URLSearchParams(await readBody(req));
    const cid = String(params.get('company') ?? '');
    if (!same(params.get('sig') ?? '', resultSig(cid))) return send(res, 403, 'This form has expired. Go back and search again.', 'text/plain; charset=utf-8');
    if (searches.locked(who, now)) return send(res, 429, 'Too many requests from this connection. Please try again in an hour.', 'text/plain; charset=utf-8');
    searches.add(who, now);
    const lead = await db.collection('leads').findOne({ company_id: cid }, { projection: { _id: 1 } });
    const token = await tokens.issue({ purpose: 'company_page', companyId: cid, leadId: lead?._id ?? null, campaign: campaignKey(code) });
    return send(res, 303, '', 'text/plain', { Location: `/c/${token}` });
  }

  /** Stops what is still queued for a company once its founder has taken over or opted out. */
  const stopQueued = (companyId, why) => stopOutreach(db, queue, companyId, why, { clock });

  /**
   * Reads and checks the claim form. Returns the claim, or null once it has answered with the form
   * again (or a refusal).
   */
  async function readClaim(req, res, doc, view, base) {
    const params = new URLSearchParams(await readBody(req));
    const form = Object.fromEntries(['csrf', 'name', 'role', 'email', 'whatsapp', 'call_slot', 'call_language'].map((k) => [k, params.get(k)]));
    form.consent = params.getAll('consent');
    const lang = params.get('lang') === 'hi' ? 'hi' : 'en';
    const hindi = hindiState(cfg);
    // a consent is only ever recorded in wording a lawyer has approved
    if (lang === 'hi' && !hindi.live) {
      send(res, 409, 'हिन्दी पेज अभी चालू नहीं है। The Hindi page is not live yet: please use the English form.', 'text/plain; charset=utf-8');
      return null;
    }
    const wordingVersion = lang === 'hi' ? hindi.wordingVersion : cfg.claim.wording_version;
    if (!same(form.csrf, csrfFor(doc))) {
      send(res, 403, 'This form has expired. Go back, reload the page and try again.', 'text/plain; charset=utf-8');
      return null;
    }
    const who = address(req);
    const now = clock().getTime();
    if (claims.locked(who, now)) {
      send(res, 429, 'Too many attempts from this connection. Please try again in an hour.', 'text/plain; charset=utf-8');
      return null;
    }
    claims.add(who, now);
    const options = consentOptions(view.company.name, org, lang);
    const values = { name: String(form.name ?? '').trim(), role: String(form.role ?? ''), email: String(form.email ?? '').trim(),
      whatsapp: String(form.whatsapp ?? '').trim(), consent: [].concat(form.consent ?? []).filter((k) => options.some((o) => o.key === k)),
      call_slot: CALL_SLOTS.includes(form.call_slot) ? form.call_slot : 'any', call_language: form.call_language === 'en' ? 'en' : 'hi' };
    const email = normalizeEmail(values.email);
    const phone = values.whatsapp ? normalizePhone(values.whatsapp) : null;
    const again = (key) => {
      send(res, 400, claimPage({ company: view.company, csrf: csrfFor(doc), error: claimError(lang, key), values },
        { org, privacyUrl, contact: privacyContact, action: `${base}/claim`, lang, back: lang === 'hi' ? `${base}?lang=hi` : base }));
      return null;
    };
    if (values.name.length < 2 || values.name.length > 100) return again('name');
    if (!['Director', 'Founder', 'Partner', 'Employee', 'Other'].includes(values.role)) return again('role');
    if (!email) return again('email');
    if (values.whatsapp && !phone) return again('mobile');
    if (values.consent.includes('whatsapp_reminders') && !phone) return again('whatsapp_needs_mobile');
    if (values.consent.includes('callback') && !phone) return again('callback_needs_mobile');
    // the exact words shown, kept with the claim: a confirmation two days later records these, not today's
    const chosen = options.filter((o) => values.consent.includes(o.key)).map(({ key, channel, purpose, text }) => ({ key, channel, purpose, text }));
    return { name: values.name, role: values.role, email, phone, chosen, call_slot: values.call_slot, call_language: values.call_language,
      lang, wording_version: wordingVersion, ip_hash: ipHash(who), notice_text_hash: tokenId(noticeText(org, privacyUrl, privacyContact, lang)) };
  }

  async function handleClaim(req, res, doc, view, base) {
    const claim = await readClaim(req, res, doc, view, base);
    if (!claim) return undefined;
    // a page found on a campaign page proves nothing about who opened it: the email address must answer first
    if (doc.campaign) return askToConfirm(res, doc, view, claim);
    return completeClaim(res, { page: doc, view, claim });
  }

  /** A claim from a campaign page: nothing is recorded until the link sent to the given address is opened. */
  async function askToConfirm(res, doc, view, claim) {
    const t = TEXT[claim.lang].confirm;
    if (!confirm) return send(res, 503, t.not_open, 'text/plain; charset=utf-8');
    const now = clock().getTime();
    const key = sign(`confirm:${claim.email}`).slice(0, 32);
    if (confirmations.locked(key, now)) return send(res, 429, t.too_many, 'text/plain; charset=utf-8');
    confirmations.add(key, now);
    // an address that asked us never to write gets no confirmation email (the page looks the same, so it says nothing about who opted out)
    if (!(await suppression.check({ email: claim.email })).length) {
      const token = await tokens.issue({ purpose: 'claim_confirm', companyId: doc.company_id, leadId: doc.lead_id ?? null, campaign: doc.campaign ?? null,
        pending: { ...claim, page_token: doc._id, asked_at: clock() }, hours: CONFIRM_HOURS });
      await confirm.send({ to: claim.email, token, company: view.company, lang: claim.lang });
    }
    return send(res, 200, checkEmailPage({ company: view.company, masked: maskEmail(claim.email) }, { org, lang: claim.lang }));
  }

  /** The confirmation link: GET shows a button (link scanners open links), POST completes the claim once. */
  async function handleConfirm(req, res, doc, base) {
    const claim = doc.pending;
    const view = claim && await companyView(doc.company_id);
    if (!view) return send(res, 404, notFoundPage({ org }));
    const csrf = sign(`confirm-form:${doc._id}`);
    if (req.method === 'GET') {
      return send(res, 200, confirmClaimPage({ company: view.company, csrf, action: base, chosen: claim.chosen, callSlot: claim.call_slot }, { org, lang: claim.lang }));
    }
    const params = new URLSearchParams(await readBody(req));
    if (!same(params.get('csrf') ?? '', csrf)) return send(res, 403, 'This form has expired. Open the link in the email again.', 'text/plain; charset=utf-8');
    // used once: the link is gone before anything is recorded, so a second click cannot claim twice
    if (!(await tokens.consume(doc))) return send(res, 404, notFoundPage({ org }));
    const page = { _id: claim.page_token, company_id: doc.company_id, lead_id: doc.lead_id ?? null, campaign: doc.campaign ?? null };
    return completeClaim(res, { page, view, claim, confirmedAt: clock() });
  }

  /**
   * Records a claim: each agreement in the consent ledger with its exact wording, the person (with
   * consent as the legal basis), a 'claimed' activity, the end of outreach to the company, any
   * WhatsApp confirmation and call back, and the hand-over to the platform's sign-up.
   */
  async function completeClaim(res, { page, view, claim, confirmedAt = null }) {
    const { email, phone, chosen, lang } = claim;
    const cid = page.company_id;
    const at = clock();
    const holdout = page.campaign ? view.lead?.holdout === true : false;     // only a company found on a campaign page can be a holdout's
    const contacts = [{ channel: 'email', address: email, source: 'company_page_claim', legal_basis: 'consent', verified: Boolean(confirmedAt), verified_at: confirmedAt }];
    if (phone) contacts.push({ channel: 'whatsapp', address: phone, source: 'company_page_claim', legal_basis: 'consent', verified: false, verified_at: null });
    if (phone && chosen.some((o) => o.key === 'callback')) contacts.push({ channel: 'voice', address: phone, source: 'company_page_claim', legal_basis: 'consent', verified: false, verified_at: null });
    const existing = await db.collection('people').findOne({ company_ids: cid, 'contacts.address': email });
    let personId;
    if (existing) {
      personId = existing._id;
      const kept = (existing.contacts ?? []).filter((c) => !contacts.some((n) => n.channel === c.channel));
      await db.collection('people').updateOne({ _id: personId }, { $set: { name: claim.name, role: claim.role, contacts: [...kept, ...contacts], updated_at: at } });
    } else {
      personId = (await db.collection('people').insertOne({ name: claim.name, role: claim.role, company_ids: [cid], contacts, created_at: at, updated_at: at })).insertedId;
    }
    const proof = { page_token: page._id, form: claim.wording_version, notice: cfg.claim.privacy_notice_version, ip_hash: claim.ip_hash,
      notice_text_hash: claim.notice_text_hash, ...(lang === 'hi' ? { language: 'hi' } : {}), ...(confirmedAt ? { email_confirmed: true } : {}) };
    for (const o of chosen) {
      await ledger.grant({ subject: { type: 'person', id: String(personId) }, channel: o.channel, purpose: o.purpose,
        address: o.channel === 'email' ? email : phone, wording: o.text, wordingVersion: claim.wording_version,
        capturedVia: 'company_page_claim', proof, recordedBy: 'company_page' });
    }
    try {
      await db.collection('activities').insertOne({ at, type: 'claimed', channel: 'page', company_id: cid, lead_id: page.lead_id ?? null,
        campaign: page.campaign ?? null, holdout,
        idem_key: `claimed:${cid}:${personId}`, data: { person_id: personId, consents: chosen.map((o) => ({ channel: o.channel, purpose: o.purpose })),
          // the schemes the page showed, so a scheme alert is only about one that starts to apply later
          schemes_shown: view.confirmed ? view.schemes.map((s) => s.id).filter(Boolean) : [] } });
    } catch (err) {
      if (err?.code !== 11000) throw err;      // claimed again by the same person: the consents above are still recorded
    }
    await db.collection('leads').updateOne({ company_id: cid, stage: { $in: ['discovered', 'shortlisted', 'contacted', 'engaged'] } }, { $set: { stage: 'claimed', updated_at: at } });
    await stopQueued(cid, 'the founder claimed the company page');
    if (phone && chosen.some((o) => o.channel === 'whatsapp')) {
      await queue?.enqueue({ type: 'whatsapp.confirm', idemKey: `wa-confirm:${cid}:${personId}`, leadId: page.lead_id ?? null, step: 'confirm',
        payload: { company_id: cid, person_id: String(personId) } });
    }
    if (phone && chosen.some((o) => o.channel === 'voice')) {
      try {
        await db.collection('activities').insertOne({ at, type: 'call_requested', channel: 'page', company_id: cid, lead_id: page.lead_id ?? null, holdout,
          idem_key: `call_requested:${cid}:${personId}`, data: { person_id: personId, slot: claim.call_slot, language: claim.call_language } });
      } catch (err) {
        if (err?.code !== 11000) throw err;
      }
      if (queue && voice?.cfg) {
        await queueCallback(queue, { companyId: cid, leadId: page.lead_id ?? null, personId, slot: claim.call_slot, language: claim.call_language, cfg: voice.cfg, clock });
      }
    }
    const handoff = await platform.onboard({
      company: { id: cid, name: view.company.name, kind: view.company.kind, legal_form: view.company.legal_form, incorporated: view.company.incorporated,
        district: view.company.district, state: 'UP' },
      contact: { name: claim.name, role: claim.role, email, whatsapp: phone },
      consents: chosen.map((o) => ({ channel: o.channel, purpose: o.purpose, wording: o.text, wording_version: claim.wording_version })),
      source: { engine: 'lead-engine', claimed_at: at.toISOString() },
    }, { log });
    return send(res, 200, claimedPage({ company: view.company, signupUrl: handoff.signup_url, prefilled: handoff.prefilled, chosen, callSlot: claim.call_slot }, { org, lang }));
  }

  async function handleUnsubscribe(req, res, doc, base) {
    const msg = doc.message_id ? await db.collection('messages').findOne({ _id: doc.message_id }) : null;
    const target = msg?.recipient?.address ?? null;
    if (req.method === 'GET') {
      return send(res, 200, unsubscribePage({ masked: target ? maskEmail(target) : 'this address', csrf: sign(`unsub:${doc._id}`), action: base }, { org }));
    }
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const oneClick = params.get('List-Unsubscribe') === 'One-Click';
    if (!oneClick && !same(params.get('csrf') ?? '', sign(`unsub:${doc._id}`))) {
      return send(res, 403, 'This form has expired. Go back, reload the page and try again.', 'text/plain; charset=utf-8');
    }
    if (target) {
      await suppression.add({ email: target }, { reason: 'unsubscribe', source: { via: oneClick ? 'one_click' : 'unsubscribe_page', message_id: String(doc.message_id) } });
    }
    const at = clock();
    try {
      await db.collection('activities').insertOne({ at, type: 'unsubscribed', channel: 'email', company_id: doc.company_id, lead_id: doc.lead_id ?? null,
        holdout: false, idem_key: `unsubscribed:${doc._id}`, data: { message_id: doc.message_id ?? null, via: oneClick ? 'one_click' : 'page' } });
    } catch (err) {
      if (err?.code !== 11000) throw err;     // unsubscribed twice
    }
    await db.collection('leads').updateOne({ company_id: doc.company_id, stage: { $in: ['discovered', 'shortlisted', 'contacted', 'engaged'] } }, { $set: { stage: 'closed', updated_at: at } });
    await stopQueued(doc.company_id, 'the founder unsubscribed');
    if (oneClick) return send(res, 200, 'unsubscribed', 'text/plain; charset=utf-8');
    return send(res, 200, unsubscribePage({ masked: target ? maskEmail(target) : 'this address', done: true }, { org }));
  }

  /** The voice provider's report on a call. A bad signature counts like a bad token. */
  async function handleVoiceHook(req, res) {
    if (req.method !== 'POST') return send(res, 405, 'method not allowed', 'text/plain');
    const who = address(req);
    if (badTokens.locked(who, clock().getTime())) return send(res, 429, '{"error":"too many requests"}', 'application/json');
    if (!voice?.webhook) return send(res, 503, '{"error":"voice is not set up on this server"}', 'application/json');
    let payload;
    try {
      payload = JSON.parse(await readBody(req, MAX_HOOK_BODY));
    } catch {
      return send(res, 400, '{"error":"expected JSON"}', 'application/json');
    }
    const r = await voice.webhook(payload);
    if (r.status === 403 || r.status === 404) badTokens.add(who, clock().getTime());
    return send(res, r.status, JSON.stringify(r.body), 'application/json');
  }

  /** Meta's webhook: its subscription check (GET), then signed events (POST). */
  async function handleWhatsAppHook(req, res, url) {
    const who = address(req);
    if (badTokens.locked(who, clock().getTime())) return send(res, 429, 'too many requests', 'text/plain');
    if (!whatsapp?.hooks) return send(res, 503, 'WhatsApp is not set up on this server', 'text/plain');
    if (req.method === 'GET') {
      const challenge = verifyChallenge(url.searchParams, whatsapp.verifyToken);
      if (challenge === null) {
        badTokens.add(who, clock().getTime());
        return send(res, 403, 'forbidden', 'text/plain');
      }
      return send(res, 200, challenge, 'text/plain');
    }
    if (req.method !== 'POST') return send(res, 405, 'method not allowed', 'text/plain');
    const raw = await readBody(req, MAX_HOOK_BODY);
    if (!verifyMetaSignature(whatsapp.appSecret, raw, req.headers['x-hub-signature-256'])) {
      badTokens.add(who, clock().getTime());
      return send(res, 403, 'bad signature', 'text/plain');
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return send(res, 400, 'expected JSON', 'text/plain');
    }
    const r = await whatsapp.hooks.handle(payload);
    return send(res, 200, JSON.stringify(r), 'application/json');
  }

  async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://pages.local');
    } catch {
      return send(res, 400, 'bad request', 'text/plain');
    }
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path === '/healthz') return send(res, 200, 'ok', 'text/plain');
    if (path === '/static/public.css') return send(res, 200, css, 'text/css; charset=utf-8', { 'Cache-Control': 'max-age=3600' });
    if (path === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /\n', 'text/plain');
    if (path === '/hooks/voice/sarvam') return handleVoiceHook(req, res);
    if (path === '/hooks/whatsapp') return handleWhatsAppHook(req, res, url);
    const j = /^\/j\/([a-z0-9-]{2,41})(\/open)?$/.exec(path);
    if (j) return handleCampaign(req, res, url, j[1], Boolean(j[2]));
    const m = /^\/(c|u|k)\/([A-Za-z0-9_-]{1,64})(\/claim)?$/.exec(path);
    if (!m || (m[1] !== 'c' && m[3])) return send(res, 404, notFoundPage({ org }));
    if (!['GET', 'POST'].includes(req.method)) return send(res, 405, 'method not allowed', 'text/plain');
    const who = address(req);
    if (badTokens.locked(who, clock().getTime())) return send(res, 429, 'Too many requests. Please wait a minute.', 'text/plain');
    const doc = await tokens.resolve(m[2], { c: 'company_page', u: 'unsubscribe', k: 'claim_confirm' }[m[1]]);
    if (!doc) {
      badTokens.add(who, clock().getTime());
      return send(res, 404, notFoundPage({ org }));
    }
    const base = `/${m[1]}/${m[2]}`;
    if (m[1] === 'u') return handleUnsubscribe(req, res, doc, base);
    if (m[1] === 'k') return handleConfirm(req, res, doc, base);
    const view = await companyView(doc.company_id);
    if (!view) return send(res, 404, notFoundPage({ org }));
    const hindi = hindiState(cfg);
    const { lang, preview } = pageLanguage(url.searchParams, hindi);
    const q = lang === 'hi' ? `?lang=hi${preview ? '&preview=1' : ''}` : '';
    const other = (p) => (lang === 'hi' ? p : hindi.live ? `${p}?lang=hi` : null);    // the same page in the other language
    if (!m[3]) {
      if (req.method !== 'GET') return send(res, 405, 'method not allowed', 'text/plain');
      if (!preview) await logOpen(doc, view.lead);
      return send(res, 200, companyPage(view, { org, claimUrl: `${base}/claim${q}`, lang, preview, alt: other(base) }));
    }
    if (req.method === 'GET') {
      return send(res, 200, claimPage({ company: view.company, csrf: csrfFor(doc) }, { org, privacyUrl, contact: privacyContact, action: `${base}/claim`,
        lang, preview, alt: other(`${base}/claim`), back: `${base}${q}` }));
    }
    return handleClaim(req, res, doc, view, base);
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error?.(`[pages] ${req.method} ${req.url?.replace(/\/(c|u|k)\/[^/]+/, '/$1/…')}: ${err.stack ?? err}`);
      if (!res.headersSent && !res.destroyed) send(res, 500, 'Something went wrong on our side. Please try again in a few minutes.', 'text/plain; charset=utf-8');
    });
  });
}

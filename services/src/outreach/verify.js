import * as nodeDns from 'node:dns/promises';
import { keyedHash } from '../util/canonical.js';
import { normalizeEmail } from '../util/normalize.js';
import { Meter, istMonth } from './meter.js';

/**
 * Checking an address before the first email to it (design 7.3: "Every email address is verified
 * before it is used ... Addresses on accept-all domains are kept out of the first wave"). Bounces
 * cost more than the check: above 2% hard bounces in 30 days a mailbox pauses itself.
 *
 * Free checks, always: the address is well formed, its domain is not a throwaway-mail service, and
 * the domain receives mail: it has an MX record, or, with none, an address record its mail falls
 * back to (RFC 5321 s.5.1); a "null MX" (RFC 7505) or a domain that does not exist fails.
 *
 * Then, if a verification service is configured (EMAIL_VERIFY_PROVIDER and EMAIL_VERIFY_API_KEY),
 * and the address is not a person's own (a person's address never leaves the engine: verify(address,
 * { external: false }) keeps it to the free checks), the service's verdict, within the monthly cap
 * caps.monthly.email_verifications_paid:
 *   deliverable    the mailbox exists
 *   accept_all     the domain accepts every address, so the mailbox cannot be confirmed
 *   unknown        the service could not tell (a slow or greylisting server)
 *   undeliverable  the mailbox does not exist, or must not be mailed
 * Without a service (or with its cap used up), an address that passes the free checks is
 * "unverified". What may be sent to is config/outreach.json `verification`: by default deliverable,
 * unknown and unverified addresses are used, accept-all ones are held back from the first wave, and
 * the rest are never used.
 *
 * Results are kept 30 days in `email_checks`, under a keyed hash of the address (like the
 * suppression list), never the address itself.
 */

export const RESULTS = ['deliverable', 'accept_all', 'unknown', 'unverified', 'undeliverable', 'disposable', 'no_mx', 'malformed'];

// throwaway-mail services: a company's registered email on one of these is not a real contact
export const DISPOSABLE = new Set(['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org', 'yopmail.com',
  'trashmail.com', 'sharklasers.com', 'getnada.com', 'dispostable.com', 'maildrop.cc', 'throwawaymail.com', 'fakeinbox.com', 'mintemail.com',
  'mailnesia.com', 'tempail.com', 'emailondeck.com', 'moakt.com', 'burnermail.io', 'mohmal.com']);

const DAY = 86_400_000;

/**
 * The verification services we can call. Each maps the service's answer onto RESULTS. The mappings
 * follow the services' published API references (ZeroBounce v2 /validate, MillionVerifier v3); check
 * them against the current reference when the key arrives (`lead-engine verify:email <address>`).
 */
export const PROVIDERS = {
  zerobounce: {
    url: (key, email) => `https://api.zerobounce.net/v2/validate?api_key=${encodeURIComponent(key)}&email=${encodeURIComponent(email)}&ip_address=`,
    map(j) {
      const status = String(j.status ?? '').toLowerCase();
      const sub = String(j.sub_status ?? '').toLowerCase();
      // a role address (info@, accounts@) is what a company files with the Registrar: not a reason to skip it
      if (status === 'do_not_mail' && sub === 'role_based') return 'deliverable';
      if (status === 'do_not_mail' && sub === 'role_based_catch_all') return 'accept_all';
      return { valid: 'deliverable', 'catch-all': 'accept_all', unknown: 'unknown', invalid: 'undeliverable', spamtrap: 'undeliverable',
        abuse: 'undeliverable', do_not_mail: 'undeliverable' }[status] ?? 'unknown';
    },
  },
  millionverifier: {
    url: (key, email) => `https://api.millionverifier.com/api/v3/?api=${encodeURIComponent(key)}&email=${encodeURIComponent(email)}&timeout=10`,
    map(j) {
      return { ok: 'deliverable', catch_all: 'accept_all', unknown: 'unknown', invalid: 'undeliverable', disposable: 'disposable' }[String(j.result ?? '').toLowerCase()] ?? 'unknown';
    },
  },
};

export function providerFromEnv(env = {}) {
  const name = String(env.EMAIL_VERIFY_PROVIDER ?? '').trim().toLowerCase();
  const key = String(env.EMAIL_VERIFY_API_KEY ?? '').trim();
  if (!name || !key) return null;
  if (!PROVIDERS[name]) throw new Error(`EMAIL_VERIFY_PROVIDER must be one of ${Object.keys(PROVIDERS).join(', ')}`);
  return { name, key };
}

export class EmailVerifier {
  constructor(db, { secret, provider = null, caps, policy = {}, dns = nodeDns, fetch = globalThis.fetch, clock = () => new Date(), log = console }) {
    if (!secret || secret.length < 32) throw new Error('CONTACT_KEY_SECRET is needed to key the address checks');
    this.col = db.collection('email_checks');
    this.secret = secret;
    this.provider = provider;
    this.cap = caps?.monthly?.email_verifications_paid ?? 0;
    this.policy = { use: ['deliverable', 'unknown', 'unverified'], hold: ['accept_all'], cache_days: 30, ...policy };
    this.meter = new Meter(db, { clock });
    this.dns = dns;
    this.fetch = fetch;
    this.clock = clock;
    this.log = log;
    this.mx = new Map();
  }

  /** true if the domain receives mail, false if it cannot, null if the lookup itself failed. */
  async hasMx(domain) {
    if (!this.mx.has(domain)) this.mx.set(domain, this.receivesMail(domain));
    return this.mx.get(domain);
  }

  async receivesMail(domain) {
    const gone = (err) => ['ENOTFOUND', 'ENONAME', 'NXDOMAIN'].includes(err?.code);    // the domain does not exist
    try {
      const r = await this.dns.resolveMx(domain);
      // a "null MX" (a single '.' exchange) is the domain saying it takes no mail (RFC 7505)
      if (r.length) return r.some((x) => x.exchange && x.exchange !== '.');
    } catch (err) {
      if (gone(err)) return false;
      if (err?.code !== 'ENODATA') return null;
    }
    // no MX record: mail goes to the domain's own address record (RFC 5321 s.5.1, the "implicit MX")
    let failed = false;
    for (const lookup of ['resolve4', 'resolve6']) {
      if (typeof this.dns[lookup] !== 'function') continue;
      try {
        if ((await this.dns[lookup](domain)).length) return true;
      } catch (err) {
        if (!gone(err) && err?.code !== 'ENODATA') failed = true;
      }
    }
    return failed ? null : false;
  }

  async callProvider(address) {
    const month = istMonth(this.clock());
    if (!(await this.meter.take({ meter: 'email_verify', period: month, amount: 1, cap: this.cap }))) return { result: 'unverified', detail: 'the monthly verification cap is used up' };
    try {
      const res = await this.fetch(PROVIDERS[this.provider.name].url(this.provider.key, address), { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`answered ${res.status}`);
      const result = PROVIDERS[this.provider.name].map(await res.json());
      return { result, detail: `${this.provider.name}` };
    } catch (err) {
      await this.meter.settle({ meter: 'email_verify', period: month, reserved: 1, actual: 0 });   // not charged for an answer we did not get
      this.log.warn?.(`[verify] ${this.provider.name}: ${err.message}`);
      return { result: 'unknown', detail: `${this.provider.name} did not answer: ${String(err.message).slice(0, 80)}`, retry: true };
    }
  }

  /**
   * Checks an address (from the cache when it was checked in the last 30 days). Returns
   * { result, use: 'send' | 'hold' | 'never', reason, provider, cached, checked_at }.
   * external: false keeps a person's address to the free checks, so it never reaches the service.
   */
  async verify(address, { external = true } = {}) {
    const email = normalizeEmail(address);
    const now = this.clock();
    const decide = (r) => ({ ...r, use: this.policy.use.includes(r.result) ? 'send' : this.policy.hold.includes(r.result) ? 'hold' : 'never',
      reason: r.result === 'deliverable' ? 'address deliverable' : `address ${r.result.replace('_', '-')}${r.detail ? ` (${r.detail})` : ''}` });
    if (!email) return decide({ result: 'malformed', provider: 'free', cached: false, checked_at: now });
    const _id = keyedHash(this.secret, `email:${email}`);
    const hit = await this.col.findOne({ _id, expires_at: { $gt: now } });
    if (hit) return decide({ result: hit.result, detail: hit.detail ?? null, provider: hit.provider, cached: true, checked_at: hit.checked_at });
    const domain = email.split('@')[1];
    let r;
    if (DISPOSABLE.has(domain)) r = { result: 'disposable', detail: 'a throwaway-mail domain' };
    else {
      const mx = await this.hasMx(domain);
      if (mx === false) r = { result: 'no_mx', detail: `${domain} receives no mail` };
      else if (this.provider && external) r = await this.callProvider(email);
      else if (this.provider) r = { result: 'unverified', detail: 'a person\'s address: free checks only, never sent to the verification service' };
      else r = { result: 'unverified', detail: mx === null ? 'no MX lookup possible; no verification service configured' : 'no verification service configured' };
    }
    const provider = this.provider && !['disposable', 'no_mx'].includes(r.result) && r.result !== 'unverified' ? this.provider.name : 'free';
    // an answer we did not get is asked again tomorrow, not in a month
    const days = r.retry || r.result === 'unverified' ? 1 : this.policy.cache_days;
    await this.col.replaceOne({ _id }, { _id, domain, result: r.result, detail: r.detail ?? null, provider, checked_at: now,
      expires_at: new Date(now.getTime() + days * DAY) }, { upsert: true });
    return decide({ result: r.result, detail: r.detail ?? null, provider, cached: false, checked_at: now });
  }
}

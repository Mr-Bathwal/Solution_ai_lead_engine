import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Sign-in for the Admin pages until they move into the platform's Admin portal (design 7.9: "the
 * same sign-in and roles"). Each person gets a random token; only its SHA-256 is configured:
 *
 *   ADMIN_USERS="you@solutionai.in,admin,<sha256 of token>;reviewer@solutionai.in,reviewer,<sha256>,1"
 *
 * The optional fourth field is the person's session epoch (0 when left out). Raising it signs that
 * person out everywhere without changing their token; giving them a new token does the same.
 *
 * Roles: viewer (pipeline and company pages, personal data masked), reviewer (also decides matches),
 * admin (may also reveal personal data, which is logged). Sessions are HMAC-signed cookies that carry
 * a keyed fingerprint of the token and the epoch, so a rotated token or a raised epoch ends them at
 * once. Signing out records the session in revoked_sessions, so a copied cookie stops working too.
 */

export const ROLES = ['viewer', 'reviewer', 'admin'];
export const SESSION_HOURS = 12;

export const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url').toString('utf8');

export function parseUsers(spec = '') {
  const users = [];
  for (const entry of spec.split(';').map((x) => x.trim()).filter(Boolean)) {
    const [email, role, hash, epoch = '0', ...rest] = entry.split(',').map((x) => x.trim());
    if (!email || !ROLES.includes(role) || !/^[0-9a-f]{64}$/.test(hash ?? '') || !/^\d{1,9}$/.test(epoch) || rest.length) {
      throw new Error(`ADMIN_USERS entry is not "email,role,sha256[,epoch]": ${email ?? entry}`);
    }
    // lower-cased like platform and service sign-ins, so one person is one email everywhere (the
    // two-admin rule on exports compares emails)
    users.push({ email: email.toLowerCase(), role, hash, epoch: Number(epoch) });
  }
  return users;
}

/** A new token and the line to add to ADMIN_USERS. The token is shown once and never stored. */
export function newUser(email, role) {
  if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(', ')}`);
  const token = randomBytes(24).toString('base64url');
  return { token, entry: `${email},${role},${sha256(token)}` };
}

/** Constant-time equality for two strings; anything that is not a string never matches. */
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Signing in through the platform (PLATFORM_CONTRACTS.md section 2): two ways, either or both on.
 *
 * 1. The platform's proxy signs who the person is, on every request it forwards (PLATFORM_SSO_SECRET):
 *
 *      X-Platform-User:      you@solutionai.in
 *      X-Platform-Role:      viewer | reviewer | admin
 *      X-Platform-Time:      1763020800                    (Unix seconds; within 2 minutes of ours)
 *      X-Platform-Signature: sha256=<hex HMAC-SHA256 of "v1\n<time>\n<METHOD>\n<target>\n<user>\n<role>">
 *
 *    where <target> is the request target exactly as sent to the engine (path and query). A captured
 *    header set is good for that one request for two minutes, nothing else.
 *
 * 2. The portal's backend calls the JSON API with a service token and names the person:
 *
 *      Authorization: Bearer <service token>                (ADMIN_SERVICE_TOKENS="name,max-role,sha256")
 *      X-Acting-User: you@solutionai.in                  (required: every action is the person's)
 *      X-Acting-Role: viewer | reviewer | admin             (default viewer; never above the token's max role)
 *
 * Either way the person's email and role are what the audit log records, as with a personal token.
 */
export const PLATFORM_SKEW_S = 120;
const EMAIL = /^[^\s,;@]+@[^\s,;@]+\.[^\s,;@]+$/;

export function parseServiceTokens(spec = '') {
  const out = [];
  for (const entry of spec.split(';').map((x) => x.trim()).filter(Boolean)) {
    const [name, role, hash, ...rest] = entry.split(',').map((x) => x.trim());
    if (!/^[a-z0-9][a-z0-9._-]{0,40}$/.test(name ?? '') || !ROLES.includes(role) || !/^[0-9a-f]{64}$/.test(hash ?? '') || rest.length) {
      throw new Error(`ADMIN_SERVICE_TOKENS entry is not "name,max-role,sha256": ${name ?? entry}`);
    }
    out.push({ name, role, hash });
  }
  return out;
}

/** A new service token and its ADMIN_SERVICE_TOKENS entry. Shown once, never stored. */
export function newServiceToken(name, role) {
  if (!/^[a-z0-9][a-z0-9._-]{0,40}$/.test(name ?? '')) throw new Error('the name is lower-case letters, digits, ".", "_" or "-"');
  if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(', ')}`);
  const token = `svc_${randomBytes(30).toString('base64url')}`;
  return { token, entry: `${name},${role},${sha256(token)}` };
}

export function platformSignature(secret, { time, method, target, user, role }) {
  return `sha256=${createHmac('sha256', secret).update(`v1\n${time}\n${method}\n${target}\n${user}\n${role}`).digest('hex')}`;
}

/** The four headers the platform's proxy adds (the reference for its developers, and for tests and curl). */
export function platformHeaders(secret, { user, role, method = 'GET', target, at = new Date() }) {
  const time = String(Math.floor(at.getTime() / 1000));
  return { 'X-Platform-User': user, 'X-Platform-Role': role, 'X-Platform-Time': time,
    'X-Platform-Signature': platformSignature(secret, { time, method: method.toUpperCase(), target, user, role }) };
}

export class Auth {
  constructor({ users, secret, clock = () => new Date(), secureCookies = false, serviceTokens = [], platformSecret = '' }) {
    if (!secret || secret.length < 32) throw new Error('ADMIN_SESSION_SECRET must be at least 32 characters');
    if (platformSecret && platformSecret.length < 32) throw new Error('PLATFORM_SSO_SECRET must be at least 32 characters');
    this.users = users;
    this.secret = secret;
    this.clock = clock;
    this.secureCookies = secureCookies;
    this.serviceTokens = serviceTokens;
    this.platformSecret = platformSecret;
  }

  /** Which ways in are switched on, for the start-up line and preflight. */
  get modes() {
    return [this.users.length && 'personal tokens', this.platformSecret && 'platform proxy', this.serviceTokens.length && 'service tokens'].filter(Boolean);
  }

  /**
   * Who is asking, by whichever way they came in: { user }, {} (nobody), or { refused, status, count }
   * where count=false means a configuration mistake on a trusted caller rather than a guess, so it is
   * not throttled or logged as an attack.
   */
  identify(req) {
    const h = req.headers;
    if (h['x-platform-signature'] !== undefined || h['x-platform-user'] !== undefined) return this.platformUser(req);
    const bearer = Auth.bearer(req);
    if (bearer && !this.userForToken(bearer)) {
      const s = this.serviceForToken(bearer);
      return s ? this.actingUser(req, s) : { refused: 'unknown token', via: 'token' };
    }
    const u = this.user(req);
    return u ? { user: u } : {};
  }

  serviceForToken(token) {
    if (typeof token !== 'string' || !token) return null;
    const h = sha256(token);
    return this.serviceTokens.find((s) => same(s.hash, h)) ?? null;
  }

  actingUser(req, service) {
    const email = String(req.headers['x-acting-user'] ?? '').trim().toLowerCase();
    if (!EMAIL.test(email)) return { refused: 'X-Acting-User must be the email address of the person acting: every action is recorded against a person', status: 400, count: false };
    const role = String(req.headers['x-acting-role'] ?? 'viewer').trim();
    if (!ROLES.includes(role)) return { refused: `X-Acting-Role must be one of ${ROLES.join(', ')}`, status: 400, count: false };
    if (ROLES.indexOf(role) > ROLES.indexOf(service.role)) return { refused: `the ${service.name} service token allows at most ${service.role}`, status: 403, count: false };
    return { user: { email, role, via: 'service', service: service.name } };
  }

  platformUser(req) {
    if (!this.platformSecret) return { refused: 'signing in through the platform is not set up on this server (PLATFORM_SSO_SECRET)', via: 'platform' };
    const h = req.headers;
    const raw = (k) => (typeof h[k] === 'string' ? h[k].trim() : '');
    const [user, role, time, sig] = ['x-platform-user', 'x-platform-role', 'x-platform-time', 'x-platform-signature'].map(raw);
    if (!/^\d{9,11}$/.test(time) || !/^sha256=[0-9a-f]{64}$/.test(sig)) return { refused: 'bad platform signature', via: 'platform' };
    if (!same(sig, platformSignature(this.platformSecret, { time, method: req.method, target: req.url, user, role }))) return { refused: 'bad platform signature', via: 'platform' };
    if (Math.abs(this.clock().getTime() / 1000 - Number(time)) > PLATFORM_SKEW_S) return { refused: 'platform signature too old or from the future (check both clocks)', via: 'platform' };
    if (!EMAIL.test(user)) return { refused: 'X-Platform-User must be an email address', status: 400, count: false };
    if (!ROLES.includes(role)) return { refused: `X-Platform-Role must be one of ${ROLES.join(', ')}`, status: 403, count: false };
    return { user: { email: user.toLowerCase(), role, via: 'platform' } };
  }

  userForToken(token) {
    if (typeof token !== 'string' || !token) return null;
    const h = sha256(token);
    return this.users.find((u) => same(u.hash, h)) ?? null;
  }

  sign(value) {
    return createHmac('sha256', this.secret).update(value).digest('base64url');
  }

  /** Ties a session to the token it was opened with, without putting any of the token's hash in the cookie. */
  fingerprint(user) {
    return this.sign(`token:${user.hash}`).slice(0, 22);
  }

  sessionCookie(user) {
    const body = b64(JSON.stringify({ e: user.email, r: user.role, f: this.fingerprint(user), n: user.epoch ?? 0,
      x: this.clock().getTime() + SESSION_HOURS * 3_600_000 }));
    const attrs = ['Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${SESSION_HOURS * 3600}`];
    if (this.secureCookies) attrs.push('Secure');
    return `le_session=${body}.${this.sign(body)}; ${attrs.join('; ')}`;
  }

  clearCookie() {
    return `le_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${this.secureCookies ? '; Secure' : ''}`;
  }

  /** The bearer token a request presents, if any (whether or not it is valid). */
  static bearer(req) {
    return /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '')?.[1] ?? null;
  }

  /**
   * The signed-in user for a request (session cookie, or a bearer token for the JSON API). A session
   * is accepted only while its person is configured with the same role, the same token and the same
   * epoch. Whether it was signed out is a database question: see isRevoked().
   */
  user(req) {
    const bearer = Auth.bearer(req);
    if (bearer) {
      const u = this.userForToken(bearer);
      return u ? { email: u.email, role: u.role, via: 'token' } : null;
    }
    const cookie = (req.headers.cookie ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith('le_session='));
    if (!cookie) return null;
    const [body, sig] = cookie.slice('le_session='.length).split('.');
    if (!body || !sig || !same(sig, this.sign(body))) return null;
    try {
      const s = JSON.parse(unb64(body));
      if (typeof s.x !== 'number' || s.x < this.clock().getTime()) return null;
      const still = this.users.find((u) => u.email === s.e && u.role === s.r && (u.epoch ?? 0) === s.n
        && same(this.fingerprint(u), s.f));   // removed, re-roled, re-tokened or re-epoched users lose access at once
      return still ? { email: s.e, role: s.r, via: 'session', session: sig, expires: s.x } : null;
    } catch {
      return null;
    }
  }

  /** The revoked_sessions key for a session: a hash of its signature, never the cookie itself. */
  static sessionId(user) {
    return sha256(`session:${user.session}`);
  }

  async isRevoked(db, user) {
    if (user?.via !== 'session') return false;
    return Boolean(await db.collection('revoked_sessions').findOne({ _id: Auth.sessionId(user) }, { projection: { _id: 1 } }));
  }

  /** Ends a session for good. The entry outlives the cookie by nothing: the TTL index drops it at the cookie's expiry. */
  async revoke(db, user, reason = 'sign_out') {
    if (user?.via !== 'session') return;
    try {
      await db.collection('revoked_sessions').insertOne({ _id: Auth.sessionId(user), email: user.email, reason,
        revoked_at: this.clock(), expires_at: new Date(user.expires) });
    } catch (err) {
      if (err?.code !== 11000) throw err;    // signed out twice: already revoked
    }
  }

  /** A per-session token for forms; with SameSite=Strict cookies and an Origin check it stops CSRF. */
  csrf(user) {
    return this.sign(`csrf:${user.session ?? user.email}`);
  }

  checkCsrf(user, token) {
    return typeof token === 'string' && token !== '' && same(token, this.csrf(user));
  }
}

export const can = (user, role) => Boolean(user) && ROLES.indexOf(user.role) >= ROLES.indexOf(role);

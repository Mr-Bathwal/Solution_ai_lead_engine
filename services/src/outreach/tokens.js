import { createHash, randomBytes } from 'node:crypto';

/**
 * Unguessable links (design 7.6): a company's page, its unsubscribe link, and the link that confirms
 * a claim made from a campaign page. A token is 128 random bits; only its SHA-256 is stored, so
 * neither a database copy nor a log of it can open a page, unsubscribe anyone or confirm a claim.
 * Tokens expire (config/outreach.json page.token_days, or `hours` for a confirmation link) and the
 * TTL index removes them.
 */

export const PURPOSES = ['company_page', 'unsubscribe', 'claim_confirm'];
const hash = (token) => createHash('sha256').update(token, 'utf8').digest('hex');
const SHAPE = /^[A-Za-z0-9_-]{22}$/;

export class PageTokens {
  constructor(db, { days = 120, clock = () => new Date() } = {}) {
    this.col = db.collection('page_tokens');
    this.days = days;
    this.clock = clock;
  }

  /**
   * A new token for one purpose; returns the token itself, which is never stored. `pending` is the
   * claim a confirmation link completes (it leaves with the token); `hours` shortens the token's life.
   */
  async issue({ purpose, companyId, leadId = null, messageId = null, campaign = null, pending = null, hours = null }) {
    if (!PURPOSES.includes(purpose)) throw new TypeError(`unknown token purpose: ${purpose}`);
    const token = randomBytes(16).toString('base64url');
    const now = this.clock();
    const life = hours ? hours * 3_600_000 : this.days * 86_400_000;
    await this.col.insertOne({ _id: hash(token), purpose, company_id: companyId, lead_id: leadId, message_id: messageId, campaign,
      ...(pending ? { pending } : {}), created_at: now, expires_at: new Date(now.getTime() + life) });
    return token;
  }

  /** The token's record if it exists, has this purpose and has not expired; otherwise null. */
  async resolve(token, purpose) {
    if (typeof token !== 'string' || !SHAPE.test(token)) return null;
    const doc = await this.col.findOne({ _id: hash(token), purpose });
    return doc && doc.expires_at > this.clock() ? doc : null;
  }

  /** Uses up a one-time token (a confirmation link). True only for the one caller that removed it. */
  async consume(doc) {
    return (await this.col.deleteOne({ _id: doc._id, purpose: doc.purpose })).deletedCount === 1;
  }
}

export const tokenId = hash;

import { domainToASCII } from 'node:url';

/**
 * Address normalisation shared by the suppression list and the consent ledger, so that
 * "Info@Acme.in " and "info@acme.in" are the same address, and "098765 43210" is "+919876543210".
 */

// The local part may hold letters from any script (SMTPUTF8 addresses such as "pérez@acme.in");
// the domain is always compared in its ASCII (punycode) form.
const EMAIL_RX = /^[\p{L}\p{M}\p{N}.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const DOMAIN_RX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Invisible characters that creep into copied addresses: zero-width spaces and joiners, BOM. */
const INVISIBLE = /[​-‍⁠﻿]/g;

/** A host name in its ASCII form: "डाक.भारत" -> "xn--11bx1g.xn--h2brj9c". Null if it is not one. */
function asciiHost(host) {
  const s = host.replace(/\.$/, '');
  const ascii = /^[\x00-\x7F]*$/.test(s) ? s : domainToASCII(s);
  return ascii && DOMAIN_RX.test(ascii) ? ascii : null;
}

/**
 * "Founder" <Founder@Acme.in>, "founder@acme.in.", "mailto:founder@acme.in;" -> "founder@acme.in".
 * Scraped pages and mail headers write addresses in all of these forms; reading them the same way
 * matters most for the suppression list, where an unread address must never pass as "not listed".
 */
export function normalizeEmail(input) {
  if (typeof input !== 'string') return null;
  let s = input.replace(INVISIBLE, '').replace(/ /g, ' ').trim();
  const named = /<([^<>\s]+)>\s*$/.exec(s); // display-name form: Name <address>
  if (named) s = named[1];
  s = s.replace(/^mailto:/i, '').replace(/^[<("']+|[>)"']+$/g, '').replace(/[.,;:]+$/, '').normalize('NFC');
  const at = s.lastIndexOf('@');
  if (at < 1 || s.length > 254) return null;
  const domain = asciiHost(s.slice(at + 1).toLowerCase());
  if (!domain) return null;
  const e = `${s.slice(0, at).toLowerCase()}@${domain}`;
  return EMAIL_RX.test(e) ? e : null;
}

export function emailDomain(email) {
  const e = normalizeEmail(email);
  return e ? e.slice(e.lastIndexOf('@') + 1) : null;
}

/**
 * The mailbox an address delivers to, for the suppression list: "founder+news@acme.in" reaches
 * founder@acme.in, and Gmail ignores dots and treats googlemail.com as gmail.com. Someone who
 * unsubscribed under one form must not be reached under another.
 */
export function mailboxForm(email) {
  const e = normalizeEmail(email);
  if (!e) return null;
  let local = e.slice(0, e.lastIndexOf('@'));
  let domain = e.slice(e.lastIndexOf('@') + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  local = local.split('+')[0] || local;
  if (domain === 'gmail.com') local = local.replaceAll('.', '') || local;
  return `${local}@${domain}`;
}

/**
 * Mail domains shared by many unrelated people. The one list for the whole engine: the suppression
 * list refuses a domain entry for these, and the Admin pages treat an address at one as a person's.
 */
export const SHARED_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.in', 'ymail.com', 'rocketmail.com',
  'outlook.com', 'outlook.in', 'hotmail.com', 'hotmail.co.in', 'live.com', 'live.in', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'zoho.com', 'zohomail.in',
  'rediffmail.com', 'rediff.com', 'gmx.com', 'mail.com', 'yandex.com', 'tutanota.com',
]);

/**
 * Registry suffixes under which anyone can register a name ("co.in", "gov.in"). A suppression entry
 * for one would block thousands of unrelated companies. Not the full Public Suffix List: the Indian
 * second-level zones and the common foreign ones founders' companies use.
 */
export const PUBLIC_SUFFIXES = new Set([
  'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in', 'ac.in', 'edu.in', 'res.in', 'gov.in', 'nic.in', 'mil.in', 'ernet.in',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'com.sg', 'com.my', 'co.jp', 'com.br', 'co.za', 'com.cn',
]);

export function isPublicSuffix(domain) {
  return !domain.includes('.') || PUBLIC_SUFFIXES.has(domain);
}

/** "mail.sales.acme.in" -> ["mail.sales.acme.in", "sales.acme.in", "acme.in"]: a domain and every parent that a company could own. */
export function domainAndParents(domain) {
  const labels = domain.split('.');
  const out = [];
  for (let i = 0; i < labels.length - 1; i += 1) {
    const d = labels.slice(i).join('.');
    if (isPublicSuffix(d)) break;
    out.push(d);
  }
  return out;
}

/** Local parts that name a function, not a person ("info@", "accounts@"). */
const ROLE_LOCAL = /^(info|contact|contactus|hello|hi|admin|accounts?|finance|billing|sales|support|help|hr|careers|jobs|office|team|mail|enquir(y|ies)|inquir(y|ies)|compliance|legal|cs|secretarial|director|directors|ca|tax|gst|payments?|ops|operations|marketing|business|corporate|company|connect|care|service|services|query|queries|feedback|noreply|no-reply)([._-]?\d*)?$/;

/** True for a role address at a company's own domain, the only kind treated as company-level. */
export function isRoleAddress(email) {
  const e = normalizeEmail(email);
  if (!e) return false;
  const [local, domain] = [e.slice(0, e.lastIndexOf('@')), e.slice(e.lastIndexOf('@') + 1)];
  return !SHARED_MAIL_DOMAINS.has(domain) && ROLE_LOCAL.test(local);
}

/**
 * Whether an email address must be handled as personal data. Personal unless it is a role address
 * at the company's own domain: "firstname@acme.in" belongs to a person as much as "x@gmail.com" does.
 * Anything that does not parse is treated as personal, which is the safe side.
 */
export const emailIsPersonal = (email) => typeof email === 'string' && email.trim() !== '' && !isRoleAddress(email);

/** "https://www.Acme.in/about" -> "acme.in". */
export function normalizeDomain(input) {
  if (typeof input !== 'string') return null;
  let s = input.replace(INVISIBLE, '').trim().toLowerCase();
  if (s.includes('@')) s = s.slice(s.lastIndexOf('@') + 1);
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0].split(':')[0];
  const host = asciiHost(s);
  return host ? host.replace(/^www\d?\./, '') : null;
}

/** A national Indian number (10 digits, or 11 with a trunk 0 written after +91) in E.164. */
function indianNumber(national) {
  const n = national.length === 11 && national.startsWith('0') ? national.slice(1) : national;
  return /^[1-9]\d{9}$/.test(n) ? `+91${n}` : null;
}

/**
 * Indian numbers to E.164. Accepts 10-digit mobiles (6-9 first digit), 0-prefixed mobiles and
 * landlines ("0522 2345678"), 91-, +91- and 0091-prefixed forms (also "+91 0 98765 43210", with
 * the trunk 0 left in), other +-prefixed international numbers, and drops an extension
 * ("ext 12"). Returns null for anything it cannot place with confidence.
 */
export function normalizePhone(input) {
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  const raw = String(input).replace(INVISIBLE, '').trim().replace(/\s*(?:ext\.?|extn\.?|x)\s*\d{1,6}\s*$/i, '');
  let digits = raw.replace(/[^\d]/g, '');
  let international = raw.startsWith('+');
  if (!international && digits.startsWith('00')) { // dialled from India: 00 is the international prefix
    international = true;
    digits = digits.slice(2);
  }
  if (international) {
    if (digits.startsWith('91')) return indianNumber(digits.slice(2));
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  // A bare 10-digit number is only placed when it is a mobile; a landline needs its 0 or 91 prefix.
  if (digits.length === 10) return /^[6-9]/.test(digits) ? `+91${digits}` : null;
  if (digits.length === 11 && digits.startsWith('0')) return indianNumber(digits.slice(1));
  if (digits.length === 12 && digits.startsWith('91')) return indianNumber(digits.slice(2));
  return null;
}

/** Normalises an address for a channel: email for email, E.164 for phone channels. */
export function normalizeAddress(channel, address) {
  if (channel === 'email') return normalizeEmail(address);
  if (['whatsapp', 'voice', 'sms'].includes(channel)) return normalizePhone(address);
  return typeof address === 'string' && address.trim() ? address.trim() : null;
}

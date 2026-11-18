import { randomUUID } from 'node:crypto';

/**
 * A plain-text email as RFC 5322 / MIME text: UTF-8 everywhere, the subject and display names as
 * RFC 2047 encoded words when they are not ASCII, the body as quoted-printable (readable, and safe
 * for Hindi), CRLF line ends. No HTML, no images, no tracking: the warm-up rules and the design say
 * so (WEEK1_ACTIONS item 4).
 *
 * Every outreach message carries both unsubscribe headers mailbox providers ask bulk senders for
 * (RFC 2369 List-Unsubscribe with an https and a mailto target, and RFC 8058 one-click).
 */

const CRLF = '\r\n';
const isAscii = (s) => /^[\x20-\x7e]*$/.test(s);

/** RFC 2047 B-encoded words, each under 75 characters, never splitting a character. */
export function encodeWords(text) {
  if (isAscii(text)) return text;
  const words = [];
  let chunk = '';
  for (const ch of text) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join(`${CRLF} `);
}

const QUOTE = (s) => `"${s.replace(/["\\]/g, '\\$&')}"`;

/** "Name <address>" with the name encoded or quoted as needed. */
export function mailbox({ name, address }) {
  if (!name) return `<${address}>`;
  return `${isAscii(name) ? QUOTE(name) : encodeWords(name)} <${address}>`;
}

/** Quoted-printable (RFC 2045) of UTF-8 text, lines at most 76 characters. */
export function quotedPrintable(text) {
  const out = [];
  for (const line of text.replace(/\r\n|\r/g, '\n').split('\n')) {
    let enc = '';
    const bytes = Buffer.from(line, 'utf8');
    bytes.forEach((b, i) => {
      const last = i === bytes.length - 1;
      const plain = (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last);
      enc += plain ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
    });
    // soft line breaks, never inside an =XX escape
    while (enc.length > 76) {
      let cut = 75;
      const esc = enc.lastIndexOf('=', cut);
      if (esc > cut - 3) cut = esc;
      out.push(`${enc.slice(0, cut)}=`);
      enc = enc.slice(cut);
    }
    out.push(enc);
  }
  return out.join(CRLF);
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** RFC 5322 date in IST: "Wed, 18 Nov 2026 10:00:00 +0530". */
export function rfc5322Date(at) {
  const d = new Date(at.getTime() + 5.5 * 3_600_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0530`;
}

export const newMessageId = (domain) => `<${randomUUID()}@${domain}>`;

/** Header injection guard: a header value must not contain a line break. */
const oneLine = (v, name) => {
  if (/[\r\n]/.test(String(v))) throw new TypeError(`${name} must not contain a line break`);
  return String(v);
};

/**
 * Builds the message. `from` and `to` are { name, address }; `unsubscribe` is { url, mailto } (null only
 * for the team's own mail);
 * `inReplyTo` threads a follow-up under the first email. Returns { raw, messageId }.
 */
export function buildEmail({ from, to, subject, text, unsubscribe, inReplyTo = null, at = new Date(), messageId = null }) {
  const domain = from.address.split('@')[1];
  const id = messageId ?? newMessageId(domain);
  const headers = [
    ['From', mailbox({ name: oneLine(from.name ?? '', 'from name'), address: oneLine(from.address, 'from') })],
    ['To', mailbox({ name: oneLine(to.name ?? '', 'to name'), address: oneLine(to.address, 'to') })],
    ['Subject', encodeWords(oneLine(subject, 'subject'))],
    ['Date', rfc5322Date(at)],
    ['Message-ID', id],
    ...(inReplyTo ? [['In-Reply-To', oneLine(inReplyTo, 'in-reply-to')], ['References', oneLine(inReplyTo, 'references')]] : []),
    // every outreach email has one; only the team's own mail (the daily summary) goes without
    ...(unsubscribe ? [
      ['List-Unsubscribe', `<${oneLine(unsubscribe.url, 'unsubscribe url')}>, <mailto:${oneLine(unsubscribe.mailto, 'unsubscribe mailto')}?subject=unsubscribe>`],
      ['List-Unsubscribe-Post', 'List-Unsubscribe=One-Click'],
    ] : []),
    ['MIME-Version', '1.0'],
    ['Content-Type', 'text/plain; charset=UTF-8'],
    ['Content-Transfer-Encoding', 'quoted-printable'],
  ];
  const raw = `${headers.map(([k, v]) => `${k}: ${v}`).join(CRLF)}${CRLF}${CRLF}${quotedPrintable(text)}${CRLF}`;
  return { raw, messageId: id };
}

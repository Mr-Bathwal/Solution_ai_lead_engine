/**
 * Reading an email that arrived in an outreach mailbox (RFC 5322 and MIME): headers with encoded
 * words, multipart bodies, base64 and quoted-printable, any charset the runtime can decode; delivery
 * status reports (RFC 3464) for bounces, abuse reports (RFC 5965) for complaints, and the marks of
 * an automatic reply (RFC 3834 Auto-Submitted and the headers Outlook and others use).
 *
 * parseMessage() never throws on a malformed email: it returns what it could read, so one strange
 * message cannot stop the mailbox from being read.
 */

const MAX_TEXT = 20_000;

function decoderFor(charset) {
  const cs = String(charset ?? 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '') || 'utf-8';
  try {
    return new TextDecoder(cs === 'us-ascii' || cs === 'ascii' ? 'utf-8' : cs);
  } catch {
    return new TextDecoder('utf-8');
  }
}

export const decodeBytes = (buf, charset) => decoderFor(charset).decode(buf);

function qpBytes(s, { header = false } = {}) {
  const src = header ? s.replace(/_/g, ' ') : s.replace(/=\r?\n/g, '');
  const out = [];
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(src.slice(i + 1, i + 3))) {
      out.push(Number.parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const code = c.charCodeAt(0);
      if (code < 256) out.push(code);
      else out.push(...Buffer.from(c, 'utf8'));
    }
  }
  return Buffer.from(out);
}

/** RFC 2047: "=?UTF-8?B?...?=" and "=?ISO-8859-1?Q?...?=" in a header value. */
export function decodeWords(value) {
  return String(value ?? '')
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1')        // whitespace between encoded words is dropped
    .replace(/=\?([^?*]+)(?:\*[^?]*)?\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, text) => {
      try {
        const bytes = enc.toUpperCase() === 'B' ? Buffer.from(text, 'base64') : qpBytes(text, { header: true });
        return decodeBytes(bytes, cs);
      } catch {
        return text;
      }
    });
}

/** Unfolded headers: name (lower case) -> [values], in order. */
export function parseHeaders(text) {
  const out = new Map();
  const lines = String(text).split(/\r?\n/);
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const i = cur.indexOf(':');
    if (i > 0) {
      const name = cur.slice(0, i).trim().toLowerCase();
      if (!out.has(name)) out.set(name, []);
      out.get(name).push(cur.slice(i + 1).trim());
    }
    cur = null;
  };
  for (const line of lines) {
    if (/^[ \t]/.test(line) && cur !== null) cur += ` ${line.trim()}`;
    else {
      flush();
      cur = line;
    }
  }
  flush();
  return out;
}

/** "text/plain; charset=utf-8; format=flowed" -> { type: 'text/plain', params: { charset, format } }. */
export function parseContentType(value) {
  const v = String(value ?? 'text/plain');
  const [type, ...rest] = v.split(';');
  const params = {};
  for (const p of rest) {
    const m = /^\s*([A-Za-z0-9*_.-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]*))/.exec(p);
    if (m) params[m[1].toLowerCase().replace(/\*$/, '')] = (m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1');
  }
  return { type: type.trim().toLowerCase() || 'text/plain', params };
}

function splitHead(buf) {
  let i = buf.indexOf('\r\n\r\n');
  let sep = 4;
  if (i < 0) {
    i = buf.indexOf('\n\n');
    sep = 2;
  }
  if (i < 0) return { head: buf.toString('latin1'), body: Buffer.alloc(0) };
  return { head: buf.subarray(0, i).toString('latin1'), body: buf.subarray(i + sep) };
}

function transferDecode(body, encoding) {
  const enc = String(encoding ?? '').trim().toLowerCase();
  if (enc === 'base64') return Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (enc === 'quoted-printable') return qpBytes(body.toString('latin1'));
  return body;
}

/** Header values arrive as bytes; a raw 8-bit (UTF-8) header is read as UTF-8, then encoded words decoded. */
const headerText = (v) => decodeWords(Buffer.from(v ?? '', 'latin1').toString('utf8'));

/** A MIME part: { headers, type, params, body (decoded Buffer), parts (for multipart) }. */
function parsePart(buf, depth = 0) {
  const { head, body } = splitHead(buf);
  const headers = parseHeaders(head);
  const ct = parseContentType(headers.get('content-type')?.[0]);
  const part = { headers, type: ct.type, params: ct.params, body: null, parts: [] };
  if (ct.type.startsWith('multipart/') && ct.params.boundary && depth < 8) {
    const text = body.toString('latin1');
    const delim = `--${ct.params.boundary}`;
    const pieces = text.split(new RegExp(`(?:^|\\r?\\n)${delim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*(?:\\r?\\n|$)`));
    for (const p of pieces.slice(1)) {
      if (!p.trim()) continue;
      part.parts.push(parsePart(Buffer.from(p, 'latin1'), depth + 1));
    }
    return part;
  }
  part.body = transferDecode(body, headers.get('content-transfer-encoding')?.[0]);
  return part;
}

function* walk(part) {
  yield part;
  for (const p of part.parts) yield* walk(p);
}

/** Readable text from HTML: no tags, no scripts or styles, entities for the common characters. */
export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

const textOf = (p) => decodeBytes(p.body ?? Buffer.alloc(0), p.params.charset);

/** "Name <a@b.c>" -> { name, address }; the address lower-cased. */
export function parseAddress(value) {
  const v = headerText(value).trim();
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(v);
  const address = (angle?.[1] ?? /[^\s<>"',;:()]+@[^\s<>"',;:()]+/.exec(v)?.[0] ?? '').toLowerCase().replace(/^mailto:/, '') || null;
  const name = angle ? v.slice(0, angle.index).trim().replace(/^"|"$/g, '').trim() || null : null;
  return { name, address };
}

const ids = (v) => (String(v ?? '').match(/<[^<>\s]+>/g) ?? []).map((s) => s.toLowerCase());

/** "Status: 5.1.1" style fields of one block of a delivery report. */
function fields(text) {
  return parseHeaders(String(text).trim());
}

function parseDsn(reportText) {
  const blocks = String(reportText).split(/\r?\n\s*\r?\n/).map(fields);
  const recipients = [];
  for (const b of blocks.slice(1).length ? blocks.slice(1) : blocks) {
    const status = /(\d\.\d{1,3}\.\d{1,3})/.exec(b.get('status')?.[0] ?? '')?.[1] ?? null;
    const recipient = (b.get('final-recipient')?.[0] ?? b.get('original-recipient')?.[0] ?? '').split(';').pop().trim().toLowerCase() || null;
    if (!status && !recipient) continue;
    recipients.push({ recipient, action: (b.get('action')?.[0] ?? '').toLowerCase() || null, status, diagnostic: b.get('diagnostic-code')?.[0]?.slice(0, 500) ?? null });
  }
  return recipients;
}

const BOUNCE_FROM = /^(mailer-daemon|postmaster|mail-daemon|mailer|bounce[s]?)@/i;
const BOUNCE_SUBJECT = /undeliver|delivery status notification|delivery (has )?failed|mail delivery (failed|subsystem)|returned mail|failure notice|delivery failure|could not be delivered|non-?delivery/i;
const AUTO_SUBJECT = /^(auto(matic)?\s*(reply|response|antwort)|out of (the )?office|ooo\b|away from (the )?office|on leave|i am (currently )?(out|away)|autoreply|auto:)|स्वचालित (उत्तर|जवाब)/i;

/**
 * Everything the engine reads from one raw email. Returns:
 *   { messageId, inReplyTo, references, from, to, subject, date, text, auto: { yes, why },
 *     report: null | { kind: 'delivery' | 'feedback', recipients, originalMessageId, feedbackType },
 *     looksLikeBounce }
 */
export function parseMessage(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
  let root;
  try {
    root = parsePart(buf);
  } catch {
    root = { headers: new Map(), type: 'text/plain', params: {}, body: buf, parts: [] };
  }
  const h = (name) => root.headers.get(name)?.[0] ?? null;
  const subject = headerText(h('subject') ?? '').replace(/\s+/g, ' ').trim();
  const from = parseAddress(h('from') ?? '');
  const date = h('date') ? new Date(h('date')) : null;

  let plain = null;
  let html = null;
  let report = null;
  for (const p of walk(root)) {
    if (p.parts.length) continue;
    const disposition = String(p.headers.get('content-disposition')?.[0] ?? '').toLowerCase();
    if (p.type === 'text/plain' && plain === null && !disposition.startsWith('attachment')) plain = textOf(p);
    else if (p.type === 'text/html' && html === null && !disposition.startsWith('attachment')) html = textOf(p);
    else if (p.type === 'message/delivery-status' || p.type === 'message/global-delivery-status') {
      report = { kind: 'delivery', recipients: parseDsn(textOf(p)), originalMessageId: null, feedbackType: null };
    } else if (p.type === 'message/feedback-report') {
      const f = fields(textOf(p));
      report = { kind: 'feedback', recipients: [], originalMessageId: null, feedbackType: (f.get('feedback-type')?.[0] ?? 'abuse').toLowerCase() };
    }
  }
  // the original message (or its headers) inside a report tells which of our emails it is about
  if (report) {
    for (const p of walk(root)) {
      if (['message/rfc822', 'text/rfc822-headers', 'message/rfc822-headers', 'message/global', 'message/global-headers'].includes(p.type)) {
        const inner = parseHeaders(splitHead(p.body ?? Buffer.alloc(0)).head);
        const mid = ids(inner.get('message-id')?.[0])[0];
        if (mid) report.originalMessageId = mid;
      }
    }
  }
  let text = plain ?? (html ? htmlToText(html) : '');
  text = text.replace(/\r\n?/g, '\n');
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);

  const autoWhy = [];
  const autoSubmitted = (h('auto-submitted') ?? '').toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') autoWhy.push(`Auto-Submitted: ${autoSubmitted}`);
  if (h('x-autoreply') || h('x-autorespond') || h('x-autoresponse')) autoWhy.push('an auto-reply header');
  if (/^(auto_reply|auto-reply|bulk|junk|list)$/i.test(h('precedence') ?? '')) autoWhy.push(`Precedence: ${h('precedence')}`);
  if (/\boof\b|\bautoreply\b|\ball\b/i.test(h('x-auto-response-suppress') ?? '') && AUTO_SUBJECT.test(subject)) autoWhy.push('an Outlook automatic reply');
  if (AUTO_SUBJECT.test(subject)) autoWhy.push('the subject says it is automatic');

  // a bounce without a proper report: the sender and subject say so, and the text names a status
  let looksLikeBounce = Boolean(report?.kind === 'delivery');
  if (!report && (BOUNCE_FROM.test(from.address ?? '') || BOUNCE_SUBJECT.test(subject)) && BOUNCE_SUBJECT.test(`${subject}\n${text.slice(0, 2000)}`)) {
    looksLikeBounce = true;
    const status = /\b([245]\.\d{1,3}\.\d{1,3})\b/.exec(text)?.[1] ?? (/\b(5[0-5]\d)\b/.exec(text) ? `5.0.0` : null);
    const recipient = /(?:to|recipient|address)[^@\n]{0,40}?<?([^\s<>@]+@[^\s<>@]+\.[a-z]{2,})>?/i.exec(text)?.[1]?.toLowerCase() ?? null;
    report = { kind: 'delivery', recipients: [{ recipient, action: status?.startsWith('5') ? 'failed' : 'delayed', status, diagnostic: null }],
      originalMessageId: ids(/message-id:\s*(<[^>]+>)/i.exec(text)?.[1])[0] ?? null, feedbackType: null, heuristic: true };
  }

  return {
    messageId: ids(h('message-id'))[0] ?? null,
    inReplyTo: ids(h('in-reply-to'))[0] ?? null,
    references: ids(h('references')),
    from,
    to: parseAddress(h('to') ?? ''),
    subject,
    date: date && !Number.isNaN(date.getTime()) ? date : null,
    text,
    auto: { yes: autoWhy.length > 0, why: autoWhy },
    report,
    looksLikeBounce,
  };
}

const QUOTE_HEAD = [
  /^\s*On .{3,200}(wrote|écrit)\s*:\s*$/im,                 // Gmail, Apple Mail
  /^\s*-{2,}\s*Original Message\s*-{2,}/im,                  // Outlook
  /^\s*_{10,}\s*$/m,                                          // Outlook web
  /^\s*From:\s.+\n\s*(Sent|Date):\s.+/im,                    // Outlook headers block
  /^\s*को .{3,200}ने लिखा\s*:?\s*$/m,                          // Gmail in Hindi
  /^\s*-{2,}\s*Forwarded message\s*-{2,}/im,
];

/** The new part of a reply: quoted history, '>' lines and the signature are left out. */
export function newText(text) {
  let t = String(text ?? '').replace(/\r\n?/g, '\n');
  let cut = t.length;
  for (const rx of QUOTE_HEAD) {
    const m = rx.exec(t);
    if (m && m.index < cut) cut = m.index;
  }
  t = t.slice(0, cut);
  t = t.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n');
  const sig = t.search(/^-- ?$/m);
  if (sig > 0) t = t.slice(0, sig);
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

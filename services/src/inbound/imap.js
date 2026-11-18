import net from 'node:net';
import tls from 'node:tls';

/**
 * A small, read-only IMAP client (RFC 3501) for the outreach mailboxes on Zoho Mail: implicit TLS on
 * port 993, LOGIN, EXAMINE, UID SEARCH and UID FETCH of BODY.PEEK[]. EXAMINE opens the folder
 * read-only and BODY.PEEK leaves the \Seen flag alone, so reading never changes the mailbox: the
 * person who answers replies still sees every new email as unread in Zoho.
 *
 * Kept in the engine, like the SMTP client, because it needs exactly this much: a few dozen emails a
 * day, fetched by UID after the last one read. Each fetch is cut at `maxBytes`, which is plenty for
 * the text of a reply or a delivery report and keeps a large attachment out of memory.
 *
 * Plain, unencrypted IMAP is refused unless `insecurePlain` is set, which only the tests do.
 */

export class ImapError extends Error {
  constructor(message, { stage = null, status = null } = {}) {
    super(message);
    this.name = 'ImapError';
    this.stage = stage;
    this.status = status;
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A Date as IMAP's search date, "18-Nov-2026" (IST calendar day). */
export function imapDate(at) {
  const d = new Date(at.getTime() + 5.5 * 3_600_000);
  return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

/** "02-Nov-2026 10:15:00 +0530" -> Date, or null. */
export function parseInternalDate(s) {
  const m = /^\s?(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(s ?? '');
  if (!m) return null;
  const month = MONTHS.indexOf(m[2][0].toUpperCase() + m[2].slice(1).toLowerCase());
  if (month < 0) return null;
  const utc = Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]));
  const offset = (Number(m[8]) * 60 + Number(m[9])) * 60_000 * (m[7] === '+' ? 1 : -1);
  return new Date(utc - offset);
}

/** A quoted IMAP string. Refuses what cannot be quoted, rather than sending a command it changed. */
function quote(s) {
  const v = String(s ?? '');
  if (/[\r\n\0]/.test(v)) throw new ImapError('a login value contains a line break', { stage: 'login' });
  return `"${v.replace(/["\\]/g, (c) => `\\${c}`)}"`;
}

/**
 * Reads IMAP responses from a socket as units: one line, and for every literal ("{123}" at the end of
 * a line) the 123 bytes that follow and the rest of the line after them. Returns
 * { line, literals: [Buffer] }, where `line` has each literal replaced by "{n}".
 */
class ResponseReader {
  constructor(socket, timeoutMs) {
    this.buf = Buffer.alloc(0);
    this.waiting = null;
    this.error = null;
    this.timeoutMs = timeoutMs;
    socket.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.wake();
    });
    socket.on('error', (err) => { this.error = err; this.wake(); });
    socket.on('close', () => { this.error ??= new Error('the connection closed'); this.wake(); });
  }

  wake() {
    const w = this.waiting;
    this.waiting = null;
    w?.();
  }

  async #more(stage) {
    if (this.error) throw new ImapError(`${stage}: ${this.error.message}`, { stage });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new ImapError(`${stage}: no answer from the server`, { stage })), this.timeoutMs);
      this.waiting = () => { clearTimeout(t); resolve(); };
    });
    if (this.error && !this.buf.length) throw new ImapError(`${stage}: ${this.error.message}`, { stage });
  }

  async #line(stage) {
    for (;;) {
      const i = this.buf.indexOf('\r\n');
      if (i >= 0) {
        const line = this.buf.subarray(0, i).toString('latin1');
        this.buf = this.buf.subarray(i + 2);
        return line;
      }
      await this.#more(stage);
    }
  }

  async #bytes(n, stage) {
    while (this.buf.length < n) await this.#more(stage);
    const out = Buffer.from(this.buf.subarray(0, n));
    this.buf = this.buf.subarray(n);
    return out;
  }

  async read(stage) {
    let line = '';
    const literals = [];
    for (;;) {
      const part = await this.#line(stage);
      line += part;
      const m = /\{(\d+)\}$/.exec(part);
      if (!m) return { line, literals };
      literals.push(await this.#bytes(Number(m[1]), stage));
    }
  }
}

export class ImapClient {
  /** `opts`: { host, port = 993, user, pass, timeoutMs = 30000, insecurePlain = false }. */
  constructor(opts) {
    this.opts = { port: 993, timeoutMs: 30_000, insecurePlain: false, ...opts };
    this.tagN = 0;
    this.socket = null;
    this.reader = null;
  }

  async connect() {
    const { host, port, timeoutMs, insecurePlain } = this.opts;
    if (!host) throw new ImapError('no IMAP host configured', { stage: 'connect' });
    this.socket = await new Promise((resolve, reject) => {
      const s = insecurePlain
        ? net.connect({ host, port }, () => resolve(s))
        : tls.connect({ host, port, servername: host }, () => resolve(s));
      s.setTimeout(timeoutMs, () => s.destroy(new Error('timed out')));
      s.once('error', reject);
    });
    this.socket.on('error', () => {});
    this.reader = new ResponseReader(this.socket, timeoutMs);
    const greeting = await this.reader.read('greeting');
    if (!/^\* (OK|PREAUTH)\b/i.test(greeting.line)) throw new ImapError(`the server refused the connection: ${greeting.line}`, { stage: 'greeting' });
    await this.command(`LOGIN ${quote(this.opts.user)} ${quote(this.opts.pass)}`, 'login');
  }

  /** Sends one command and collects its untagged responses. Throws unless the server answers OK. */
  async command(text, stage) {
    this.tagN += 1;
    const tag = `L${this.tagN}`;
    this.socket.write(`${tag} ${text}\r\n`);
    const untagged = [];
    for (;;) {
      const r = await this.reader.read(stage);
      if (r.line.startsWith(`${tag} `)) {
        const status = r.line.slice(tag.length + 1).split(' ')[0].toUpperCase();
        if (status !== 'OK') throw new ImapError(`${stage}: ${r.line.slice(tag.length + 1)}`, { stage, status });
        return { untagged, text: r.line };
      }
      if (r.line.startsWith('+')) throw new ImapError(`${stage}: the server asked for more than this client sends`, { stage });
      untagged.push(r);
    }
  }

  /** Opens a folder read-only. Returns { uidvalidity, uidnext, exists }. */
  async examine(folder = 'INBOX') {
    const r = await this.command(`EXAMINE ${quote(folder)}`, 'examine');
    const all = r.untagged.map((u) => u.line).join('\n');
    const num = (rx) => { const m = rx.exec(all); return m ? Number(m[1]) : null; };
    return { uidvalidity: num(/\[UIDVALIDITY (\d+)\]/i) ?? 0, uidnext: num(/\[UIDNEXT (\d+)\]/i), exists: num(/^\* (\d+) EXISTS/im) ?? 0 };
  }

  /** UIDs of messages with UID >= `fromUid`, or received on or after `since` (a Date). */
  async searchUids({ fromUid = null, since = null } = {}) {
    const criteria = fromUid ? `UID ${fromUid}:*` : since ? `SINCE ${imapDate(since)}` : 'ALL';
    const r = await this.command(`UID SEARCH ${criteria}`, 'search');
    const uids = [];
    for (const u of r.untagged) {
      const m = /^\* SEARCH\b(.*)$/i.exec(u.line);
      if (m) uids.push(...m[1].trim().split(/\s+/).filter(Boolean).map(Number));
    }
    // "n:*" always includes the newest message, even when its UID is below n
    return [...new Set(uids)].filter((n) => Number.isInteger(n) && n > 0 && (!fromUid || n >= fromUid)).sort((a, b) => a - b);
  }

  /** One message: { uid, internalDate, size, raw (Buffer, at most maxBytes), truncated }. */
  async fetch(uid, { maxBytes = 262_144 } = {}) {
    const r = await this.command(`UID FETCH ${uid} (UID INTERNALDATE RFC822.SIZE BODY.PEEK[]<0.${maxBytes}>)`, 'fetch');
    for (const u of r.untagged) {
      if (!/^\* \d+ FETCH \(/i.test(u.line)) continue;
      const got = Number(/\bUID (\d+)/i.exec(u.line)?.[1]);
      if (got !== uid) continue;
      const size = Number(/RFC822\.SIZE (\d+)/i.exec(u.line)?.[1] ?? 0);
      const raw = u.literals[0] ?? Buffer.alloc(0);
      return { uid, internalDate: parseInternalDate(/INTERNALDATE "([^"]+)"/i.exec(u.line)?.[1]), size, raw, truncated: size > raw.length };
    }
    return null;
  }

  async logout() {
    try {
      await this.command('LOGOUT', 'logout');
    } catch {
      // the server may close the connection before answering; the session is over either way
    } finally {
      this.socket?.end();
      this.socket?.destroy();
    }
  }
}

/**
 * Reads the new messages of one folder: those after `afterUid` when the folder's UIDVALIDITY is still
 * `uidvalidity`, otherwise those received since `since`. Returns { uidvalidity, messages }, at most
 * `limit` of them, oldest first.
 */
export async function readNew(opts, { folder = 'INBOX', uidvalidity = null, afterUid = null, since, limit = 200, maxBytes } = {}) {
  const client = new ImapClient(opts);
  await client.connect();
  try {
    const box = await client.examine(folder);
    const sameBox = uidvalidity !== null && box.uidvalidity === uidvalidity && afterUid;
    const uids = await client.searchUids(sameBox ? { fromUid: afterUid + 1 } : { since });
    const messages = [];
    for (const uid of uids.slice(0, limit)) {
      const m = await client.fetch(uid, { maxBytes });
      if (m) messages.push(m);
    }
    return { uidvalidity: box.uidvalidity, messages, more: uids.length > limit };
  } finally {
    await client.logout();
  }
}

import net from 'node:net';
import os from 'node:os';
import tls from 'node:tls';

/**
 * A small SMTP client (RFC 5321) for the outreach mailboxes on Zoho Mail: implicit TLS on port 465
 * or STARTTLS on 587, AUTH PLAIN or LOGIN, one message to one recipient per connection. Kept in the
 * engine instead of a mail library because the engine sends a few dozen emails a day and needs
 * exactly this, with every reply code visible: a 5xx on RCPT is a hard bounce the engine must act on
 * at once (suppress the address, count it against the mailbox), and a 4xx is a temporary failure to
 * retry later.
 *
 * Plain, unencrypted SMTP is refused unless `insecurePlain` is set, which only the tests do.
 */

export class SmtpError extends Error {
  constructor(message, { code = null, stage = null, permanent = false } = {}) {
    super(message);
    this.name = 'SmtpError';
    this.code = code;
    this.stage = stage;
    this.permanent = permanent;
  }
}

/** Reads SMTP replies (possibly multi-line: "250-..." continued, "250 ..." last) from a socket. */
class ReplyReader {
  constructor(socket, timeoutMs) {
    this.buf = '';
    this.lines = [];
    this.waiting = null;
    this.error = null;
    this.timeoutMs = timeoutMs;
    this.attach(socket);
  }

  attach(socket) {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        this.lines.push(this.buf.slice(0, i).replace(/\r$/, ''));
        this.buf = this.buf.slice(i + 1);
      }
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

  /** The next complete reply: { code, text, lines }. */
  async read(stage) {
    const deadline = Date.now() + this.timeoutMs;
    const got = [];
    for (;;) {
      while (this.lines.length) {
        const line = this.lines.shift();
        got.push(line);
        if (/^\d{3}(?: |$)/.test(line)) {
          const code = Number(line.slice(0, 3));
          return { code, text: got.map((l) => l.slice(4)).join('\n'), lines: got };
        }
        if (!/^\d{3}-/.test(line)) throw new SmtpError(`unreadable SMTP reply at ${stage}: ${line.slice(0, 200)}`, { stage });
      }
      if (this.error) throw new SmtpError(`SMTP connection failed at ${stage}: ${this.error.message}`, { stage });
      const left = deadline - Date.now();
      if (left <= 0) throw new SmtpError(`no SMTP reply within ${this.timeoutMs} ms at ${stage}`, { stage });
      await new Promise((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiting = () => { clearTimeout(t); resolve(); };
      });
    }
  }
}

function connect({ host, port, secure, timeoutMs, tlsOptions }) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(new SmtpError(`could not connect to ${host}:${port}: ${err.message}`, { stage: 'connect' }));
    const socket = secure
      ? tls.connect({ host, port, servername: host, ...tlsOptions }, () => resolve(socket))
      : net.connect({ host, port }, () => resolve(socket));
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('timed out')));
    socket.once('error', onError);
  });
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

/** Dot-stuffing (RFC 5321 4.5.2) and CRLF line ends for the DATA phase. */
export function dataBlock(raw) {
  return `${raw.replace(/\r?\n/g, '\r\n').split('\r\n').map((l) => (l.startsWith('.') ? `.${l}` : l)).join('\r\n').replace(/\r\n$/, '')}\r\n.\r\n`;
}

/**
 * Sends one message. Returns { code, response } from the server's answer to the message (its queue
 * id is in the response). Throws SmtpError; `permanent` is true for a 5xx, and `stage` says where
 * ('rcpt' for a recipient the server refused: a hard bounce).
 */
export async function sendSmtp({
  host, port = 465, secure = port === 465, starttls = !secure, user, pass, from, to, raw,
  timeoutMs = 30_000, insecurePlain = false, tlsOptions = {}, clientName = os.hostname(), loginOnly = false,
}) {
  if (!secure && !starttls && !insecurePlain) throw new SmtpError('refusing to send over unencrypted SMTP', { stage: 'connect' });
  let socket = await connect({ host, port, secure, timeoutMs, tlsOptions });
  let reader = new ReplyReader(socket, timeoutMs);
  const write = (line) => socket.write(`${line}\r\n`);
  const expect = async (stage, ok, line) => {
    if (line !== undefined) write(line);
    const r = await reader.read(stage);
    if (!ok.includes(r.code)) {
      throw new SmtpError(`SMTP ${stage} refused: ${r.code} ${r.text}`.slice(0, 500), { code: r.code, stage, permanent: r.code >= 500 });
    }
    return r;
  };
  try {
    await expect('greeting', [220]);
    let ehlo = await expect('ehlo', [250], `EHLO ${clientName}`);
    if (!secure && starttls) {
      if (!/\bSTARTTLS\b/i.test(ehlo.text)) throw new SmtpError('the server does not offer STARTTLS', { stage: 'starttls' });
      await expect('starttls', [220], 'STARTTLS');
      socket.removeAllListeners('data');
      socket = await new Promise((resolve, reject) => {
        const s = tls.connect({ socket, servername: host, ...tlsOptions }, () => resolve(s));
        s.once('error', (err) => reject(new SmtpError(`TLS failed: ${err.message}`, { stage: 'starttls' })));
      });
      reader = new ReplyReader(socket, timeoutMs);
      ehlo = await expect('ehlo', [250], `EHLO ${clientName}`);
    }
    if (user) {
      const auth = /AUTH[ =]([^\n]*)/i.exec(ehlo.text)?.[1]?.toUpperCase() ?? '';
      if (/\bPLAIN\b/.test(auth) || !auth) {
        await expect('auth', [235], `AUTH PLAIN ${b64(`\u0000${user}\u0000${pass}`)}`);
      } else {
        await expect('auth', [334], 'AUTH LOGIN');
        await expect('auth', [334], b64(user));
        await expect('auth', [235], b64(pass));
      }
    }
    if (loginOnly) {
      write('QUIT');
      return { code: 235, response: 'signed in; nothing was sent' };
    }
    await expect('mail', [250], `MAIL FROM:<${from}>`);
    await expect('rcpt', [250, 251], `RCPT TO:<${to}>`);
    await expect('data', [354], 'DATA');
    socket.write(dataBlock(raw));
    const done = await expect('message', [250]);
    write('QUIT');
    return { code: done.code, response: done.text.slice(0, 500) };
  } finally {
    socket.end();
    socket.destroy();
  }
}

/** Connects and signs in, then quits: checks a mailbox's SMTP settings without sending anything. */
export function verifySmtp(opts) {
  return sendSmtp({ ...opts, from: '', to: '', raw: '', loginOnly: true });
}

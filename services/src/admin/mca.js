import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Uploading MCA's monthly incorporation file (design 6.1; ingest/src/leadengine/mca_inbox.py).
 *
 * mca.gov.in blocks scripted downloads, so each month a person downloads "Companies and LLPs
 * registered in <month>" and uploads it here (admin role). The file goes into the MCA inbox
 * (MCA_INBOX, default data/mca/inbox), the nightly run at 05:00 IST loads it, and it is filed under
 * loaded/<month>/ (or failed/, with the reason). Every upload is written to audit_log first.
 *
 * Checks here are the cheap ones: an .xlsx name, a ZIP signature, a sensible size, and not the same
 * file as one already loaded or waiting (by SHA-256). Whether it really is MCA's report is decided
 * by the loader, which reads it.
 */

export const MAX_UPLOAD = 30 * 1024 * 1024;        // MCA's monthly workbook is 2-6 MB
const MIN_UPLOAD = 1024;
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export const inboxDir = (cfg) => cfg.mcaInbox;

/** The fields and files of a multipart/form-data body (the upload form: csrf and file). */
export function parseMultipart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? '');
  if (!/^multipart\/form-data/i.test(contentType ?? '') || !m) throw new RangeError('expected a multipart/form-data upload');
  const delimiter = Buffer.from(`--${m[1] ?? m[2]}`);
  const fields = {};
  const files = [];
  let at = body.indexOf(delimiter);
  while (at !== -1) {
    const start = at + delimiter.length;
    if (body.subarray(start, start + 2).toString() === '--') break;                 // the closing delimiter
    const headEnd = body.indexOf('\r\n\r\n', start);
    if (headEnd === -1) break;
    const next = body.indexOf(Buffer.concat([Buffer.from('\r\n'), delimiter]), headEnd + 4);
    if (next === -1) throw new RangeError('the upload was cut short');
    const head = body.subarray(start, headEnd).toString('utf8');
    const data = body.subarray(headEnd + 4, next);
    const name = /\bname="([^"]*)"/i.exec(head)?.[1];
    const filename = /\bfilename="([^"]*)"/i.exec(head)?.[1];
    if (name != null) {
      if (filename != null) files.push({ field: name, filename: path.basename(filename.replace(/\\/g, '/')), data });
      else fields[name] = data.toString('utf8');
    }
    at = next + 2;
  }
  return { fields, files };
}

/** A name that is safe on any file system and still recognisable. */
function safeName(name) {
  const base = path.basename(String(name ?? '').replace(/\\/g, '/')).replace(/[^A-Za-z0-9._() -]/g, '_').replace(/^\.+/, '');
  return base.slice(-100) || 'mca.xlsx';
}

async function waitingFiles(inbox) {
  let names;
  try {
    names = await readdir(inbox);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const name of names) {
    if (name.startsWith('.') || !name.toLowerCase().endsWith('.xlsx')) continue;
    const s = await stat(path.join(inbox, name));
    if (s.isFile()) out.push({ name, size: s.size, at: s.mtime });
  }
  return out.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
}

/**
 * Puts an uploaded file into the inbox. Throws RangeError (shown to the person) for a file that is
 * not acceptable, with `status` 409 when it is the same as one already loaded or waiting.
 */
export async function saveMcaFile(db, { inbox, filename, data, user, clock = () => new Date() }) {
  if (!/\.xlsx$/i.test(filename ?? '')) throw new RangeError('choose the .xlsx file MCA publishes ("Companies and LLPs registered in <month>")');
  if (data.length < MIN_UPLOAD) throw new RangeError('that file is empty or nearly so');
  if (data.length > MAX_UPLOAD) throw new RangeError(`that file is larger than ${MAX_UPLOAD / 1024 / 1024} MB; MCA's workbook is a few MB`);
  if (!data.subarray(0, 4).equals(ZIP)) throw new RangeError('that is not an Excel workbook (.xlsx)');
  const digest = sha256(data);
  const loaded = await db.collection('ingest_runs').findOne({ source: 'mca_monthly', status: { $in: ['ok', 'partial'] }, 'params.sha256': digest },
    { sort: { started_at: -1 } });
  if (loaded) {
    throw Object.assign(new RangeError(`this exact file was already loaded on ${loaded.started_at.toISOString().slice(0, 10)} (${loaded.params.file})`), { status: 409 });
  }
  for (const w of await waitingFiles(inbox)) {
    if (sha256(await readFile(path.join(inbox, w.name))) === digest) {
      throw Object.assign(new RangeError(`this exact file is already waiting to be loaded (${w.name})`), { status: 409 });
    }
  }
  const now = clock();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const name = `${stamp}-${safeName(filename)}`;
  // logged first: an upload that cannot be logged is not kept
  await db.collection('audit_log').insertOne({ at: now, actor: user.email, role: user.role, action: 'upload_mca_file',
    target: { type: 'mca_file', id: name }, fields: null, detail: { file: name, original: safeName(filename), size: data.length, sha256: digest, via: user.via } });
  await mkdir(inbox, { recursive: true });
  const part = path.join(inbox, `.upload-${randomBytes(6).toString('hex')}.part`);
  try {
    await writeFile(part, data, { flag: 'wx' });
    await rename(part, path.join(inbox, name));             // the loader never sees a half-written file
  } catch (err) {
    await unlink(part).catch(() => {});
    throw err;
  }
  return { file: name, size: data.length, sha256: digest };
}

/** What the MCA file page shows: what waits, what failed and why, and the latest loads. */
export async function mcaState(db, { inbox }) {
  const failedDir = path.join(inbox, 'failed');
  const failed = [];
  for (const w of await waitingFiles(failedDir)) {
    const why = await readFile(path.join(failedDir, `${w.name}.why.txt`), 'utf8').catch(() => '');
    failed.push({ ...w, why: why.trim().split('\n').at(-1) ?? '' });
  }
  const runs = await db.collection('ingest_runs').find({ source: 'mca_monthly' }, { projection: { params: 1, status: 1, stats: 1, notes: 1, started_at: 1 } })
    .sort({ started_at: -1 }).limit(8).toArray();
  const uploads = await db.collection('audit_log').find({ action: 'upload_mca_file' }).sort({ at: -1 }).limit(20).toArray();
  const by = new Map(uploads.map((u) => [u.detail.file, u]));
  return {
    inbox,
    waiting: (await waitingFiles(inbox)).map((w) => ({ ...w, uploaded_by: by.get(w.name)?.actor ?? null })),
    failed,
    loaded: runs.map((r) => ({ run: r._id, file: r.params?.file ?? null, via: r.params?.via ?? 'command line', status: r.status, at: r.started_at,
      companies_up: r.stats?.companies_up ?? null, period: /: period (\d{4}-\d{2})/.exec((r.notes ?? []).join(' '))?.[1] ?? null,
      uploaded_by: by.get(r.params?.file)?.actor ?? null })),
  };
}

import { appendFileSync, existsSync, readFileSync } from 'node:fs';

/**
 * Anchors for the consent ledger: copies of its head ({ seq, hash }) kept outside the database.
 *
 * The hash chain shows that nothing before the head was edited, but someone with write access to the
 * database could cut entries off the end, or recompute every hash after an edit. An anchor taken
 * earlier catches both: the anchored seq must still exist, with the same hash.
 *
 * The anchor file (LEDGER_ANCHOR_FILE) is only ever appended to, one JSON line per anchor. Put it
 * where the people who administer the database cannot rewrite it: an append-only mount (chattr +a),
 * an object-locked (WORM) bucket, or a disk on another machine. `lead-engine ledger:anchor` appends
 * the current head after checking the chain against every earlier anchor; run it daily, and copy its
 * output into the daily summary email as a second, independent record.
 */

const HEX64 = /^[0-9a-f]{64}$/;

/** Every anchor in the file, oldest first. A malformed line is an error, never skipped. */
export function readAnchors(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((line, i) => {
    let a;
    try {
      a = JSON.parse(line);
    } catch {
      a = null;
    }
    if (!Number.isInteger(a?.seq) || a.seq < 0 || !HEX64.test(a?.hash ?? '')) {
      throw new Error(`${file} line ${i + 1} is not a ledger anchor`);
    }
    return a;
  });
}

/** Appends one anchor line. The file is opened for appending only; earlier lines are never touched. */
export function appendAnchor(file, head, at = new Date()) {
  const line = { seq: head.seq, hash: head.hash, recorded_at: head.recorded_at ?? null, anchored_at: at.toISOString() };
  appendFileSync(file, `${JSON.stringify(line)}\n`, { flag: 'a' });
  return line;
}

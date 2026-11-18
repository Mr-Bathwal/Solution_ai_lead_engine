import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeEmail, normalizePhone } from '../util/normalize.js';

/**
 * The end-to-end run on staging (design 12; ops/WEEK4_ACTIONS.md, item 4): one fictional company
 * whose registered email is one of our own addresses, in a database of its own, so the whole path
 * (draft, approval, gate, the real SMTP send, the reply read back, the page and claim, the call
 * back, a platform event, unsubscribe and erasure) runs exactly as it will for founders, without
 * touching the real data.
 *
 *   staging:seed --email you@solutionai.in   the test company and its lead, rules marked confirmed,
 *                                            on this month's shortlist; and data/staging/caps.json,
 *                                            today's caps with the warm-up already over
 *   staging:smoke                            the whole email loop with the real mailboxes (ops/smoke.js)
 *   staging:clear                            drops the staging database
 *
 * Both refuse to run unless LEAD_DB ends in "_staging", and CAPS_FILE (the warm-up-free caps) is
 * accepted by loadConfig only for such a database, so neither can reach the real database.
 */

export const STAGING_CID = 'U99999UP2026PTC000001';
const DAY = 86_400_000;
const istDay = (at) => new Date(at.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const addDays = (day, n) => istDay(new Date(Date.parse(`${day}T00:00:00+05:30`) + n * DAY));

export function assertStaging(dbName) {
  if (!/_staging$/.test(dbName ?? '')) throw new TypeError(`this only runs on a staging database (LEAD_DB ending in _staging), not "${dbName}"`);
}

export async function seedStaging(db, { dbName, email, phone = null, caps, root, clock = () => new Date() }) {
  assertStaging(dbName);
  const address = normalizeEmail(email);
  if (!address) throw new TypeError('--email must be one of our own addresses');
  const mobile = phone ? normalizePhone(phone) : null;
  if (phone && !mobile) throw new TypeError('--phone must be an Indian mobile number');
  const now = clock();
  const today = istDay(now);
  const month = today.slice(0, 7);
  const attr = (value, source = 'staging') => ({ value, source, seen_at: now });
  const company = {
    _id: STAGING_CID, kind: 'company', state: 'UP', name: 'SOLUTIONAI STAGING TEST PRIVATE LIMITED', name_norm: 'solutionai staging test',
    ids: { cin: STAGING_CID, uplc: [] }, cohort: addDays(today, -20).slice(0, 7), sources: ['staging'], first_seen_at: now, updated_at: now,
    schema_version: 2, former_names: [],
    attrs: { incorporation_date: attr(addDays(today, -20)), company_type: attr('Private Limited Company'), registered_district: attr('Lucknow'),
      registered_email: attr(address) },
  };
  const needs = {
    rules_confirmed: true, rules_version: 'staging (not real rules)', verdicts_by: 'staging', computed_at: now,
    deadlines: [
      { id: 'first_board_meeting', title: 'Hold the first board meeting', form: 'Minutes (no MCA form)', due: addDays(today, 10), status: 'upcoming',
        law: 'Companies Act 2013 s.173(1)', source_url: 'https://www.indiacode.nic.in/' },
      { id: 'inc_20a', title: 'File the declaration for commencement of business', form: 'INC-20A', due: addDays(today, 160), status: 'upcoming',
        law: 'Companies Act 2013 s.10A', source_url: 'https://www.mca.gov.in/' },
    ],
    schemes: [{ scheme_id: 'udyam_registration', name: 'Udyam (MSME) registration', verdict: 'eligible', benefit: 'Free registration.', missing: [],
      source_url: 'https://udyamregistration.gov.in/' }],
  };
  await db.collection('companies').replaceOne({ _id: STAGING_CID }, company, { upsert: true });
  await db.collection('leads').updateOne({ company_id: STAGING_CID }, {
    $set: { stage: 'shortlisted', holdout: false, eligible: true, eligibility_reasons: [], cohort: company.cohort, needs,
      shortlist: { month, rank: 1 }, score: { fit: 90, components: [], version: 'staging' }, updated_at: now },
    $setOnInsert: { company_id: STAGING_CID, created_at: now },
  }, { upsert: true });
  // today's caps with the warm-up over, so the staging email is not held until the real warm-up ends
  const stagingCaps = structuredClone(caps);
  stagingCaps.email.warmup_start = addDays(today, -(stagingCaps.email.warmup_days + 10));
  // and the whole day open, so the test can run at any hour (only ever to our own mailbox)
  stagingCaps.email.send_window_ist = ['00:00', '23:59'];
  const capsFile = path.join(root, 'data', 'staging', 'caps.json');
  mkdirSync(path.dirname(capsFile), { recursive: true });
  writeFileSync(capsFile, `${JSON.stringify({ _comment: `Written by staging:seed on ${today} for ${dbName} only: the warm-up is over. Never use it for the real database.`, ...stagingCaps }, null, 2)}\n`);
  return { company: STAGING_CID, month, email: address, phone: mobile, caps_file: capsFile };
}

export async function clearStaging(db, { dbName }) {
  assertStaging(dbName);
  await db.dropDatabase();
  return { dropped: dbName };
}

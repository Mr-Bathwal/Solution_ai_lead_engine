/**
 * Campus and other campaigns (design 3, item 5: "Tracked in the engine as a campaign source with its
 * own codes and landing pages"). Each campaign in config/outreach.json `campaigns` has a code; its
 * landing page is PUBLIC_BASE_URL/j/<code> (printed on posters, QR codes and E-Cell mailers).
 *
 * A founder finds their company there, by name or CIN, among the UP companies the engine holds, and
 * opens its page. The page link carries the campaign, so the visit, the claim and any later sign-up
 * or payment are counted for it (Results, "Campaigns"). Only company-level facts from the MCA register
 * are shown, as on every company page. A company the engine does not hold yet is sent to sign up on
 * the platform directly, with the campaign code.
 */

const CIN_OR_LLPIN = /^([UL][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}|[A-Z]{3}-[0-9]{4})$/;
const CODE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const istDay = (at) => new Date(at.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);

/** The campaign for a code if it is configured and running today; otherwise null. */
export function activeCampaign(cfg, code, now = new Date()) {
  if (!CODE.test(code ?? '')) return null;
  const c = (cfg.campaigns ?? []).find((x) => x.code === code);
  if (!c || c.active === false) return null;
  const today = istDay(now);
  if ((c.from && today < c.from) || (c.to && today > c.to)) return null;
  return c;
}

/** "Gomti Foods Pvt. Ltd." -> "gomtifoods", the way the knowledge base keys names (name_norm). */
export function nameKey(q) {
  return String(q ?? '').toLowerCase()
    .replace(/\b(private\s+limited|pvt\.?\s*ltd\.?|p\.?\s*ltd\.?|limited|ltd\.?|llp|opc)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '');
}

/** Up to `limit` companies whose name starts with the query, or the one with that CIN. */
export async function findCompanies(db, query, { limit = 5 } = {}) {
  const q = String(query ?? '').trim();
  if (CIN_OR_LLPIN.test(q.toUpperCase())) {
    const c = await db.collection('companies').findOne({ _id: q.toUpperCase() }, { projection: { name: 1, kind: 1, 'attrs.incorporation_date.value': 1, 'attrs.registered_district.value': 1, 'attrs.district.value': 1 } });
    return c ? [view(c)] : [];
  }
  const key = nameKey(q);
  if (key.length < 3) return null;                           // too short to search
  const rows = await db.collection('companies').find({ name_norm: { $regex: `^${key}` } },
    { projection: { name: 1, kind: 1, 'attrs.incorporation_date.value': 1, 'attrs.registered_district.value': 1, 'attrs.district.value': 1 } })
    .sort({ name: 1 }).limit(limit).toArray();
  return rows.map(view);
}

function view(c) {
  return { id: c._id, name: c.name, kind: c.kind, incorporated: c.attrs?.incorporation_date?.value ?? null,
    district: c.attrs?.registered_district?.value ?? c.attrs?.district?.value ?? null };
}

export const campaignKey = (code) => `campaign:${code}`;

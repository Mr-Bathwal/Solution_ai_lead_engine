"""UP LLPs, found without a paid lookup.

An LLPIN carries no state, so the MCA monthly file cannot say which new LLPs are in Uttar Pradesh.
The UP startup portals can: both list only startups registered in UP, and about 430 of their
startups are LLPs. MCA does not register two LLPs under the same name, so a portal LLP whose name
(legal form included) equals exactly one LLP in an MCA file is that LLP, and it is in UP.

That conclusion is only as good as the link. So the LLPs found here are first offered to the matcher
as candidates (`candidates`), and only those a startup is actually linked to are written to the
database (`store`). An LLP stored on an earlier run whose link has since gone (a reviewer said
"different", the startup was renamed or left the portal) has nothing left saying it is in UP; the
companies collection holds UP companies only, so it is removed again.

The LLP sheets are read straight from the MCA files kept in the raw store. A file never changes
under its raw key, so its parsed LLP rows are kept in enrichment_cache (provider "kb", op
"llp_sheet") and each file is parsed once, not on every nightly run. The other ~10,000 LLPs a month
from the rest of India are never written to companies.
"""
from dataclasses import dataclass, field
from datetime import datetime, timezone

from pymongo import UpdateOne

from .. import SCHEMA_VERSION
from ..enrich import cache
from ..ids import LLPIN_RX, NIC_DIVISIONS
from ..names import normalize_name
from ..sources.mca import PAGE_URL, parse_report
from .apply import PORTAL_SOURCES
from .entities import Startup
from .match import company_from

SOURCE = "mca_monthly"
CACHE_PROVIDER, CACHE_OP = "kb", "llp_sheet"
ROW_FIELDS = ("name", "llpin", "registered_on", "activity_code")


@dataclass
class LlpCandidates:
    companies: list = field(default_factory=list)   # match.Company objects for the matcher
    rows: dict = field(default_factory=dict)        # llpin -> (MCA row, raw key)
    stats: dict = field(default_factory=dict)


def mca_files(db):
    """Raw keys of every MCA monthly file loaded so far, newest first."""
    return sorted(db.source_records.distinct("raw_ref.key", {"source": SOURCE}), reverse=True)


def llp_rows(db, rawstore, key: str, stats: dict) -> list[dict] | None:
    """The LLP sheet of one MCA file, from the cache or parsed once and cached."""
    hit = cache.get(db, CACHE_PROVIDER, CACHE_OP, key)
    if hit and hit.get("status") == "found":
        stats["llp_sheets_cached"] = stats.get("llp_sheets_cached", 0) + 1
        return hit["result"]["rows"]
    try:
        data = rawstore.get({"key": key})
    except FileNotFoundError:
        return None
    rows = [{f: str(r.get(f) or "") for f in ROW_FIELDS} for r in parse_report(data).llps]
    cache.put(db, CACHE_PROVIDER, CACHE_OP, key, status="found", result={"rows": rows}, raw_ref={"key": key})
    stats["llp_sheets_parsed"] = stats.get("llp_sheets_parsed", 0) + 1
    return rows


def candidates(db, rawstore, startups: dict[str, Startup], *, log=print) -> LlpCandidates:
    """Portal LLPs whose name (form included) is exactly one LLP's in the MCA files we hold."""
    wanted = {}
    for s in startups.values():
        for clean, form, _ in s.name_keys():
            if form == "llp":
                wanted.setdefault(clean, set()).add(s.key)
    out = LlpCandidates(stats={"portal_llps": len({k for v in wanted.values() for k in v}), "llp_rows_read": 0,
                               "llp_candidates": 0})
    if not wanted:
        return out
    found = {}          # llpin -> (row, raw key)
    by_name = {}        # clean name -> set of llpins (to refuse a name shared by two LLPs)
    for key in mca_files(db):
        rows = llp_rows(db, rawstore, key, out.stats)
        for row in rows or ():
            out.stats["llp_rows_read"] += 1
            k = normalize_name(row.get("name", ""))
            llpin = (row.get("llpin") or "").strip().upper()
            if k.legal_form != "llp" or k.clean not in wanted or not LLPIN_RX.match(llpin):
                continue
            by_name.setdefault(k.clean, set()).add(llpin)
            found.setdefault(llpin, (row, key))
    for llpin, (row, key) in found.items():
        if len(by_name[normalize_name(row["name"]).clean]) > 1:
            continue        # two LLPs with one name cannot happen in MCA's register; refuse to guess
        out.rows[llpin] = (row, key)
        out.companies.append(company_from(llpin, row["name"].strip(), "llp", row.get("registered_on") or None,
                                          (row.get("activity_code") or "")[:2] or None))
    out.stats["llp_candidates"] = len(out.companies)
    return out


def store(db, cands: LlpCandidates, *, log=print) -> dict:
    """Writes the LLPs a startup is linked to; removes portal-found LLPs no link holds any more."""
    linked = {}
    for d in db.entity_links.find({"entity_type": "startup", "status": "linked"}, {"entity_key": 1, "company_id": 1}):
        linked.setdefault(d["company_id"], []).append(d["entity_key"])
    now = datetime.now(timezone.utc)
    ops = []
    for llpin, (row, key) in cands.rows.items():
        if llpin not in linked:
            continue
        k = normalize_name(row["name"])
        inc = row.get("registered_on") or None
        evidence = {"value": "UP", "source": "startup_portals", "confidence": "medium", "seen_at": now,
                    "ref": {"startups": sorted(linked[llpin])}}
        attrs = {
            "legal_name": row["name"].strip(), "incorporation_date": inc, "company_type": "Limited Liability Partnership",
            "nic_division": (row.get("activity_code") or "")[:2] or None,
            "sector": NIC_DIVISIONS.get((row.get("activity_code") or "")[:2]) or None,
        }
        sets = {f"attrs.{a}": {"value": v, "source": SOURCE, "ref": {"raw": key, "url": PAGE_URL},
                               "confidence": "high", "seen_at": now} for a, v in attrs.items() if v}
        sets |= {"attrs.state_evidence": evidence, "name": row["name"].strip(), "name_norm": k.key, "updated_at": now}
        on_insert = {"kind": "llp", "state": "UP", "ids": {"llpin": llpin}, "former_names": [], "first_seen_at": now,
                     "schema_version": SCHEMA_VERSION}
        if inc:
            on_insert["cohort"] = inc[:7]
        ops.append(UpdateOne({"_id": llpin}, {"$setOnInsert": on_insert, "$set": sets,
                                              "$addToSet": {"sources": {"$each": [SOURCE, "startup_portals"]}}}, upsert=True))
    if ops:
        db.companies.bulk_write(ops, ordered=False)
    # An LLP is in UP only because a portal startup is linked to it. Once no link holds, nothing says
    # it is in UP; it goes, unless some other source (a paid lookup, say) has vouched for it since.
    own = {SOURCE, "startup_portals", *PORTAL_SOURCES}
    stale = [d["_id"] for d in db.companies.find({"kind": "llp", "attrs.state_evidence.source": "startup_portals"},
                                                 {"sources": 1})
             if d["_id"] not in linked and set(d.get("sources") or []) <= own]
    removed = db.companies.delete_many({"_id": {"$in": stale}}).deleted_count if stale else 0
    stats = {"llps_found": len(ops), "llps_withdrawn": removed}
    log(f"llp: {len(ops)} UP LLPs linked from {cands.stats.get('llp_rows_read', 0)} LLP rows in the MCA files"
        + (f"; {removed} no longer linked removed" if removed else ""))
    return stats

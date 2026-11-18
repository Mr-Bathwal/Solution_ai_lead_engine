"""Retention of bought company data (design 7.7: "Enrichment data for companies we never contacted is
deleted after a fixed period (I propose 12 months)"), and the raw half of an erasure request.

`leadengine privacy retention [--months 12] [--apply]` finds every company whose vendor data is older
than the period and that the engine never contacted (no email sent, no reply, claim, call or
payment), and then, with --apply:

    companies      the vendor's registered email, registered office address and pincode, director
                   count and the profile's date are removed (the district, the MCA register's own
                   facts and the portals' facts stay)
    people         the company is removed from its directors' records; a director left with no
                   company and no contact details is removed
    raw store      every vendor answer about the company (kept exactly as received, so it can hold a
                   director's name or a person's own email) is deleted, every stored version of it
    cache          the vendor cache entries for the company are deleted

A company that is shortlisted again later is simply looked up again. Without --apply it only counts.

`leadengine privacy erase-raw CIN [CIN ...]` deletes the vendor answers for named companies. Run it
after `lead-engine erase email <address>` when that command reports a company whose registered email
was the person's own: the database copy is blanked by the erasure, the raw answers by this.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from .enrich.infyner import PROVIDER
from .util import sha256_text

VENDOR_ATTRS = ("registered_email", "registered_office", "registered_pincode", "directors_count", "full_profile_at")
ENGAGED = ["sent", "replied", "claimed", "call_requested", "call_completed", "signed_up", "service_request", "paid"]


def vendor_prefixes(cid: str, provider: str = PROVIDER) -> list[str]:
    """The raw store folders holding the vendor's answers about one company (see enrich/waterfall.py _keep_raw)."""
    return [f"vendor_{provider}/{sha256_text(f'{provider}://{op}/{cid}')[:16]}/" for op in ("lookup", "profile")]


def erase_vendor_raw(raw, cid: str) -> int:
    """Deletes every stored vendor answer about `cid`. Returns how many objects were removed."""
    n = 0
    for prefix in vendor_prefixes(cid):
        for key in list(raw.keys_under(prefix)):
            if raw.delete(key):
                n += 1
    return n


def due_for_retention(db, cutoff: datetime) -> list[str]:
    """Companies whose vendor data was seen before `cutoff` and that the engine never engaged."""
    old = {"$or": [{f"attrs.{k}.source": PROVIDER, f"attrs.{k}.seen_at": {"$lt": cutoff}} for k in VENDOR_ATTRS]}
    candidates = [d["_id"] for d in db.companies.find(old, {"_id": 1})]
    if not candidates:
        return []
    engaged = set(db.activities.distinct("company_id", {"company_id": {"$in": candidates}, "type": {"$in": ENGAGED}}))
    return [c for c in candidates if c not in engaged]


def run_retention(db, raw, *, months: int = 12, apply: bool = False, now: datetime | None = None, actor: str = "retention") -> dict:
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(days=round(months * 30.44))
    due = due_for_retention(db, cutoff)
    out = {"months": months, "cutoff": cutoff.date().isoformat(), "companies": len(due), "applied": apply,
           "people_unlinked": 0, "people_removed": 0, "raw_removed": 0, "cache_removed": 0}
    if not apply or not due:
        return out
    db.audit_log.insert_one({"at": now, "actor": actor, "role": None, "action": "erasure", "target": None, "fields": list(VENDOR_ATTRS),
                             "detail": {"retention_months": months, "companies": len(due), "started": True}})
    for cid in due:
        db.companies.update_one({"_id": cid}, {"$unset": {f"attrs.{k}": "" for k in VENDOR_ATTRS}, "$set": {"updated_at": now}})
        r = db.people.update_many({"company_ids": cid, "din": {"$type": "string"}}, {"$pull": {"company_ids": cid}, "$set": {"updated_at": now}})
        out["people_unlinked"] += r.modified_count
        out["raw_removed"] += erase_vendor_raw(raw, cid)
        out["cache_removed"] += db.enrichment_cache.delete_many({"provider": PROVIDER, "key": cid}).deleted_count
    out["people_removed"] = db.people.delete_many({"company_ids": {"$size": 0}, "contacts": {"$size": 0}}).deleted_count
    db.audit_log.insert_one({"at": datetime.now(timezone.utc), "actor": actor, "role": None, "action": "erasure", "target": None, "fields": list(VENDOR_ATTRS),
                             "detail": {k: v for k, v in out.items() if k != "applied"} | {"done": True}})
    return out

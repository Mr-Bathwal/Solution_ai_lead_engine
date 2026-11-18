"""The enrichment cache (design 7.3 "Caching"). Every answer is cached, so nothing is bought twice:
lookups and full profiles (registered email included) for 90 days, "not found" for 30, an answer we
could not read ("unparsed": the vendor's fields were not where the adapter looked) for 1 day, so a
corrected adapter re-reads it soon, and errors for 1 day. ("contact", 30 days, is reserved for
person-level contact data, which the engine does not buy.) MongoDB's TTL index deletes expired
entries; reads also check the expiry, because the TTL monitor runs only once a minute."""
from datetime import datetime, timedelta, timezone

TTL_DAYS = {"company": 90, "contact": 30, "not_found": 30, "unparsed": 1, "error": 1}


def _id(provider: str, op: str, key: str) -> str:
    return f"{provider}:{op}:{key}"


def get(db, provider: str, op: str, key: str, now: datetime | None = None) -> dict | None:
    now = now or datetime.now(timezone.utc)
    d = db.enrichment_cache.find_one({"_id": _id(provider, op, key)})
    if not d:
        return None
    exp = d["expires_at"] if d["expires_at"].tzinfo else d["expires_at"].replace(tzinfo=timezone.utc)
    return d if exp > now else None


def put(db, provider: str, op: str, key: str, *, status: str, result: dict | None, kind: str = "company",
        raw_ref: dict | None = None, cost_inr: float | None = None, now: datetime | None = None, ttl_days: int | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    # ttl_days: a record that must outlive the usual period (the website search's retry schedule)
    ttl = ttl_days or TTL_DAYS[status if status in ("not_found", "unparsed", "error") else kind]
    doc = {"_id": _id(provider, op, key), "provider": provider, "op": op, "key": key, "status": status, "result": result,
           "raw_ref": raw_ref, "cost_inr": cost_inr, "fetched_at": now, "expires_at": now + timedelta(days=ttl)}
    db.enrichment_cache.replace_one({"_id": doc["_id"]}, doc, upsert=True)
    return doc

"""Writes the knowledge base's links onto company records.

For every company linked to a portal startup, the portal facts are copied onto the company as
attributes with their own source, date and a "medium" confidence (they are what the founder told
the portal, not what the registry says). The registry's own attributes are never overwritten.

The run is a full rebuild, so it is reproducible: a company that is no longer linked (a reviewer said
"different") loses its portal attributes, its UPLC numbers and the portal sources in the same write.
"""
from collections import defaultdict
from datetime import datetime, timezone

from pymongo import UpdateOne

from ..web import company_domain
from .entities import Startup

PORTAL_SOURCES = ("startinup", "upsm", "incubator_portfolio")
# attribute -> the Startup field it comes from
PORTAL_ATTRS = {
    "brand": "brand", "website": "website", "district": "district", "pincode": "pincode", "portal_sector": "sector",
    "portal_industry": "industry", "stage": "stage", "incubators": "incubators", "women_led": "women_led",
    "startinup_listed": None, "upsm_listed": None, "portal_since": "since", "domain": None,
}


def _attrs_for(s: Startup) -> dict:
    """Portal facts for one startup, each with the portal it really came from (Startup.field_sources):
    a district only UP Startup Mission gave is labelled "upsm", not "startinup"."""
    src = "startinup" if "startinup" in s.sources else "upsm"
    latest = max(s.sources.values()) if s.sources else datetime.now(timezone.utc)
    out = {}
    for attr, field in PORTAL_ATTRS.items():
        if field is None:
            continue
        v = getattr(s, field)
        if v in (None, "", []):
            continue
        source = s.field_sources.get(field) or ("upsm" if field == "women_led" else src)
        if field == "incubators":
            v = [i["name"] for i in v]
        out[attr] = (v, source, s.sources.get(source, latest))
    for name in ("startinup", "upsm"):
        if name in s.sources:
            out[f"{name}_listed"] = (True, name, s.sources[name])
    d = company_domain(s.website)
    if d:
        source = s.field_sources.get("website") or src
        out["domain"] = (d, source, s.sources.get(source, latest))
    return out


def apply_links(db, startups: dict[str, Startup], *, log=print) -> dict:
    links = defaultdict(list)                                  # company_id -> [startup keys]
    for d in db.entity_links.find({"entity_type": "startup", "status": "linked"}, {"entity_key": 1, "company_id": 1}):
        if d["entity_key"] in startups:
            links[d["company_id"]].append(d["entity_key"])
    touched = set(links) | {c["_id"] for c in db.companies.find({"sources": {"$in": list(PORTAL_SOURCES)}}, {"_id": 1})}
    now = datetime.now(timezone.utc)
    ops, stats = [], defaultdict(int)
    projection = {"sources": 1, "ids": 1, **{f"attrs.{a}.source": 1 for a in PORTAL_ATTRS}}
    for c in db.companies.find({"_id": {"$in": list(touched)}}, projection):
        keys = sorted(links.get(c["_id"], []))
        desired = {}
        for k in keys:                       # with several portal entries for one company, the first wins per field
            for attr, val in _attrs_for(startups[k]).items():
                desired.setdefault(attr, val)
        sets = {"updated_at": now, "ids.uplc": [k for k in keys if k.startswith("UPLC_")]}
        unset = {}
        current = c.get("attrs") or {}
        for attr in PORTAL_ATTRS:
            # an attribute another source set (the registry, a paid profile) is never touched here
            owner = (current.get(attr) or {}).get("source")
            portal_owned = owner is None or owner in PORTAL_SOURCES
            if attr in desired and portal_owned:
                v, source, seen = desired[attr]
                sets[f"attrs.{attr}"] = {"value": v, "source": source, "confidence": "medium", "seen_at": seen,
                                         "ref": {"startups": keys}}
            elif attr not in desired and owner in PORTAL_SOURCES:
                unset[f"attrs.{attr}"] = ""
        domain_owner = (current.get("domain") or {}).get("source")
        if domain_owner is None or domain_owner in PORTAL_SOURCES:
            sets["ids.domain"] = desired["domain"][0] if "domain" in desired else None
        portal_used = sorted({v[1] for v in desired.values()})
        sets["sources"] = sorted({s for s in c.get("sources", []) if s not in PORTAL_SOURCES} | set(portal_used))
        update = {"$set": sets}
        if unset:
            update["$unset"] = unset
        ops.append(UpdateOne({"_id": c["_id"]}, update))
        stats["companies_with_portal_facts" if keys else "companies_unlinked_cleared"] += 1
        if len(keys) > 1:
            stats["companies_with_several_portal_entries"] += 1
    for i in range(0, len(ops), 1000):
        db.companies.bulk_write(ops[i:i + 1000], ordered=False)
    log(f"apply: portal facts on {stats['companies_with_portal_facts']} companies")
    return dict(stats)

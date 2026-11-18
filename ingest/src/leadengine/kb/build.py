"""The nightly knowledge-base rebuild: LLP candidates, matching, the LLPs that were linked, then
writing the links onto companies.

It is a full rebuild from source_records, source_state and match_reviews, so running it twice gives
the same result, and a change to the matching rules takes effect on every company at once.
"""
from datetime import datetime, timezone

from pymongo import UpdateOne

from ..names import normalize_name
from ..sink import MongoSink, new_run_id
from . import apply, llp, match
from .entities import load_startups


def refresh_name_keys(db) -> int:
    """Recomputes companies.name_norm when the name-cleaning rules change."""
    ops = []
    for c in db.companies.find({}, {"name": 1, "name_norm": 1}):
        key = normalize_name(c["name"]).key
        if key != c.get("name_norm"):
            ops.append(UpdateOne({"_id": c["_id"]}, {"$set": {"name_norm": key}}))
    for i in range(0, len(ops), 1000):
        db.companies.bulk_write(ops[i:i + 1000], ordered=False)
    return len(ops)


def build(db, rawstore, *, log=print, use_splink: bool = True) -> dict:
    sink = MongoSink(db)
    run_id = new_run_id("kb")
    sink.start_run(run_id, "kb", {"splink": use_splink, "model": match.MODEL_VERSION})
    try:
        stats = {"name_keys_refreshed": refresh_name_keys(db)}
        startups = load_startups(sink)
        log(f"kb: {len(startups)} portal startups")
        # UP LLPs are offered to the matcher first and stored only if a link to them survives
        cands = llp.candidates(db, rawstore, startups, log=log)
        stats["match"] = match.run(db, startups, log=log, use_splink=use_splink, extra_companies=cands.companies)
        stats["llp"] = cands.stats | llp.store(db, cands, log=log)
        stats["apply"] = apply.apply_links(db, startups, log=log)
    except BaseException as exc:
        sink.finish_run(run_id, "failed", {}, [f"failed: {type(exc).__name__}: {exc}"])
        raise
    m = stats["match"]
    notes = [f"{m.get('linked', 0)} linked, {m.get('review', 0)} for review, {m.get('unlinked', 0)} without a CIN yet",
             f"{stats['llp']['llps_found']} UP LLPs found from the MCA files' LLP sheets"]
    sink.finish_run(run_id, "ok", _flat(stats), notes)
    stats["run_id"] = run_id
    stats["finished_at"] = datetime.now(timezone.utc).isoformat()
    return stats


def _flat(d, prefix=""):
    out = {}
    for k, v in d.items():
        if isinstance(v, dict):
            out.update(_flat(v, f"{prefix}{k}_"))
        elif isinstance(v, (int, float, str, bool)) or v is None:
            out[f"{prefix}{k}"] = v
    return out

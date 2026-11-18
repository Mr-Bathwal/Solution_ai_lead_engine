"""Writes ingestion output to MongoDB.

source_records are only ever inserted (the application role cannot update them). A record whose
content hash is already stored is a duplicate-key no-op, so re-running a source is always safe and
only real changes create new versions.

source_state points at the current version of each (source, natural key) and says when it was last
seen. It is what readers use to get "the record as it is now", and it stays right when a record
changes back to an earlier version (A -> B -> A: the third observation stores nothing new in
source_records, but moves the pointer back to A). An observation older than the one already held
(a backfill from an old cache after a live run) is stored as a version and can make first_seen_at
earlier, but never moves the pointer. A key that appears twice in one run keeps its first
observation, so a source that lists one startup twice cannot make it flap between two versions.

Records are written in batches as the source yields them, and a run that stops early (budget used
up, a crash in the source) still writes everything it read before stopping.

Registry records (MCA) also create or refresh the company record, keyed on the CIN, with the source
and date of every attribute. Portal records carry no CIN; the knowledge base links them to companies
(kb/), never this module.
"""
import secrets
from collections import Counter
from datetime import datetime, timezone
from itertools import islice

from pymongo import UpdateOne
from pymongo.database import Database
from pymongo.errors import BulkWriteError

from . import SCHEMA_VERSION
from .records import Record
from .sources import mca

COMPANY_BUILDERS = {"mca_monthly": mca.to_company}
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def new_run_id(source: str) -> str:
    return f"{source}-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}-{secrets.token_hex(2)}"


def state_id(source: str, natural_key: str) -> str:
    return f"{source}|{natural_key}"


def _batches(it, n):
    it = iter(it)
    while batch := list(islice(it, n)):
        yield batch


def _lit(v):
    return {"$literal": v}


def _get(doc: dict, dotted: str):
    for part in dotted.split("."):
        doc = doc.get(part) if isinstance(doc, dict) else None
    return doc


def _aware(dt: datetime) -> datetime:
    """pymongo returns naive UTC datetimes unless the client is tz_aware; compare like with like."""
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _state_update(r: Record, run_id: str) -> list:
    """Pipeline update for one observation. Every $-expression reads the document as it was before
    this update, so `newer` and `differs` are judged against the previous pointer."""
    at = r.fetched_at
    newer = {"$gte": [_lit(at), {"$ifNull": ["$last_seen_at", _lit(EPOCH)]}]}
    moves = {"$and": [newer, {"$ne": ["$content_hash", _lit(r.content_hash)]}]}
    return [{"$set": {
        "source": _lit(r.source),
        "natural_key": _lit(r.natural_key),
        "first_seen_at": {"$min": [{"$ifNull": ["$first_seen_at", _lit(at)]}, _lit(at)]},
        "versions": {"$cond": [moves, {"$add": [{"$ifNull": ["$versions", 0]}, 1]}, "$versions"]},
        "last_changed_at": {"$cond": [moves, _lit(at), "$last_changed_at"]},
        "content_hash": {"$cond": [newer, _lit(r.content_hash), "$content_hash"]},
        "last_seen_at": {"$cond": [newer, _lit(at), "$last_seen_at"]},
        "last_run_id": {"$cond": [newer, _lit(run_id), "$last_run_id"]},
    }}]


class MongoSink:
    def __init__(self, db: Database, batch_size: int = 500):
        self.db = db
        self.batch_size = batch_size

    # ---- runs -------------------------------------------------------------------------------
    def start_run(self, run_id: str, source: str, params: dict):
        self.db.ingest_runs.insert_one({"_id": run_id, "source": source, "status": "running", "params": params,
                                        "stats": {}, "notes": [], "started_at": datetime.now(timezone.utc),
                                        "finished_at": None})

    def finish_run(self, run_id: str, status: str, stats: dict, notes: list):
        self.db.ingest_runs.update_one({"_id": run_id}, {"$set": {
            "status": status, "stats": {k: v for k, v in stats.items()}, "notes": notes[-200:],
            "finished_at": datetime.now(timezone.utc)}})

    def known_keys(self, source: str, where: dict | None = None) -> set:
        """Natural keys stored for a source; `where` narrows it to keys whose CURRENT version matches
        that filter (for example {"payload.profile_parsed": True}). An older version matching does not
        count: a startup whose current record lost its profile must be re-read."""
        if not where:
            return set(self.db.source_state.distinct("natural_key", {"source": source}))
        return {r["natural_key"] for r in self.current(source, projection={"natural_key": 1, **{k: 1 for k in where}})
                if all(_get(r, k) == v for k, v in where.items())}

    def touch(self, source: str, keys, at: datetime, run_id: str) -> int:
        """Marks keys a run saw but did not re-read (known cards on a weekly run) as still listed."""
        ops = [UpdateOne({"_id": state_id(source, k), "last_seen_at": {"$lt": at}},
                         {"$set": {"last_seen_at": at, "last_run_id": run_id}}) for k in keys]
        n = 0
        for batch in _batches(ops, self.batch_size):
            n += self.db.source_state.bulk_write(batch, ordered=False).modified_count
        return n

    # ---- records ----------------------------------------------------------------------------
    def write(self, records, run_id: str, stats: Counter | None = None) -> Counter:
        """Writes as the source yields. If the source raises part-way, the records already yielded
        are written before the exception goes on, and `stats` (pass your own Counter to keep it)
        counts them."""
        stats = Counter() if stats is None else stats
        batch, in_run = [], set()

        def flush():
            if batch:
                self._write_source_records(batch, run_id, stats)
                self._write_companies(batch, stats)
                batch.clear()

        try:
            for r in records:
                sid = state_id(r.source, r.natural_key)
                if sid in in_run:
                    stats["records_repeated_in_run"] += 1
                    continue
                in_run.add(sid)
                batch.append(r)
                if len(batch) >= self.batch_size:
                    flush()
        finally:
            flush()
        return stats

    def _write_source_records(self, batch: list[Record], run_id: str, stats: Counter):
        ids = list({state_id(r.source, r.natural_key) for r in batch})
        current = {d["_id"]: d for d in self.db.source_state.find({"_id": {"$in": ids}},
                                                                  {"content_hash": 1, "last_seen_at": 1})}
        docs = [{
            "source": r.source, "natural_key": r.natural_key, "content_hash": r.content_hash, "payload": r.payload,
            "legal_basis": r.legal_basis, "personal_fields": list(r.personal_fields), "company_id": r.company_id,
            "url": r.url, "raw_ref": r.raw_ref.to_doc() if r.raw_ref else None, "fetched_at": r.fetched_at,
            "run_id": run_id, "schema_version": SCHEMA_VERSION,
        } for r in batch]
        try:
            self.db.source_records.insert_many(docs, ordered=False)
        except BulkWriteError as exc:
            if any(err.get("code") != 11000 for err in exc.details.get("writeErrors", [])):
                raise
        ops = []
        for r in batch:
            sid = state_id(r.source, r.natural_key)
            cur = current.get(sid)
            if cur is None:
                stats["records_new"] += 1
            elif _aware(r.fetched_at) < _aware(cur["last_seen_at"]):
                # never moves the pointer (the update checks `newer`), but can make first_seen_at earlier
                stats["records_older_than_current"] += 1
                ops.append(UpdateOne({"_id": sid}, _state_update(r, run_id), upsert=True))
                continue
            elif cur["content_hash"] == r.content_hash:
                stats["records_unchanged"] += 1
            else:
                stats["records_changed"] += 1
            current[sid] = {"content_hash": r.content_hash, "last_seen_at": r.fetched_at}  # a key repeated in a batch
            ops.append(UpdateOne({"_id": sid}, _state_update(r, run_id), upsert=True))
        if ops:
            self.db.source_state.bulk_write(ops, ordered=True)

    def _write_companies(self, batch: list[Record], stats: Counter):
        ops = []
        now = datetime.now(timezone.utc)
        for r in batch:
            build = COMPANY_BUILDERS.get(r.source)
            if not build or not r.company_id:
                continue
            c = build(r)
            ref = {"raw": r.raw_ref.key if r.raw_ref else None, "url": r.url}
            sets = {"name": c["name"], "name_norm": c["name_norm"], "updated_at": now}
            for k, v in c["attrs"].items():
                sets[f"attrs.{k}"] = {"value": v, "source": r.source, "ref": ref, "confidence": c["confidence"],
                                      "seen_at": r.fetched_at}
            on_insert = {"kind": c["kind"], "state": "UP", "ids": c["ids"], "former_names": [],
                         "first_seen_at": now, "schema_version": SCHEMA_VERSION}
            if c.get("cohort"):
                on_insert["cohort"] = c["cohort"]
            ops.append(UpdateOne({"_id": c["_id"]},
                                 {"$setOnInsert": on_insert, "$set": sets, "$addToSet": {"sources": r.source}},
                                 upsert=True))
        if ops:
            res = self.db.companies.bulk_write(ops, ordered=False)
            stats["companies_new"] += res.upserted_count
            stats["companies_refreshed"] += res.matched_count

    # ---- maintenance ------------------------------------------------------------------------
    def rebuild_state(self) -> int:
        """Creates the source_state entries that are missing (the first run after the v2 schema, or
        after a restore of source_records alone), from the newest stored version of each key. Existing
        entries are left alone: source_records holds each version once, at the time it was first seen,
        so it cannot tell when a key was last seen or that it changed back to an earlier version
        (A -> B -> A would come out as B). Only source_state knows that. Returns how many were created."""
        pipeline = [
            {"$sort": {"source": 1, "natural_key": 1, "fetched_at": 1}},
            {"$group": {"_id": {"s": "$source", "k": "$natural_key"},
                        "first": {"$first": "$fetched_at"}, "last": {"$last": "$fetched_at"},
                        "hash": {"$last": "$content_hash"}, "run": {"$last": "$run_id"}, "n": {"$sum": 1}}},
        ]
        ops = [UpdateOne({"_id": state_id(g["_id"]["s"], g["_id"]["k"])}, {"$setOnInsert": {
            "source": g["_id"]["s"], "natural_key": g["_id"]["k"], "content_hash": g["hash"],
            "first_seen_at": g["first"], "last_seen_at": g["last"], "last_changed_at": g["last"],
            "versions": g["n"], "last_run_id": g["run"]}}, upsert=True)
            for g in self.db.source_records.aggregate(pipeline, allowDiskUse=True)]
        created = 0
        for batch in _batches(ops, 1000):
            created += self.db.source_state.bulk_write(batch, ordered=False).upserted_count
        return created

    def current(self, source: str, where: dict | None = None, projection: dict | None = None):
        """The current version of every record of a source (joined through source_state)."""
        pipeline = [
            {"$match": {"source": source, **(where or {})}},
            {"$lookup": {"from": "source_records", "let": {"s": "$source", "k": "$natural_key", "h": "$content_hash"},
                         "pipeline": [{"$match": {"$expr": {"$and": [
                             {"$eq": ["$source", "$$s"]}, {"$eq": ["$natural_key", "$$k"]},
                             {"$eq": ["$content_hash", "$$h"]}]}}},
                             {"$sort": {"fetched_at": -1}}, {"$limit": 1}] + ([{"$project": projection}] if projection else []),
                         "as": "rec"}},
            {"$unwind": "$rec"},
        ]
        for d in self.db.source_state.aggregate(pipeline, allowDiskUse=True):
            rec = d["rec"]
            rec["last_seen_at"] = d["last_seen_at"]
            rec["first_seen_at"] = d["first_seen_at"]
            yield rec

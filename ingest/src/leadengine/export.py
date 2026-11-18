"""Nightly Parquet exports for analysis (design 7.9: "Heavy analysis runs on nightly Parquet exports in
S3, queried with DuckDB. A separate data warehouse is not needed at this volume").

`leadengine export parquet` writes one Parquet file per table into data/exports/<date>/ (and
EXPORT_S3_URI, synced by the schedule, in production). Only what analysis needs, and nothing about
any person: no names, addresses, numbers, message bodies, reply text or transcripts. Each column is
listed here on purpose, so a field added to a collection later never leaks into the exports.

    duckdb -c "SELECT stage, holdout, count(*) FROM 'data/exports/2026-11-26/leads.parquet' GROUP BY ALL"
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from .config import ROOT


def _get(d: dict, path: str):
    for part in path.split("."):
        if not isinstance(d, dict):
            return None
        d = d.get(part)
    return d


# table -> (collection, filter, [(column, path in the document)])
TABLES = {
    "leads": ("leads", {}, [
        ("company_id", "company_id"), ("cohort", "cohort"), ("stage", "stage"), ("holdout", "holdout"), ("eligible", "eligible"),
        ("fit", "score.fit"), ("theme", "score.theme.name"), ("fit_version", "score.version"), ("shortlist_month", "shortlist.month"),
        ("shortlist_rank", "shortlist.rank"), ("rules_confirmed", "needs.rules_confirmed"), ("updated_at", "updated_at")]),
    "companies": ("companies", {}, [
        ("company_id", "_id"), ("kind", "kind"), ("cohort", "cohort"), ("incorporated", "attrs.incorporation_date.value"),
        ("company_type", "attrs.company_type.value"), ("nic_division", "attrs.nic_division.value"),
        ("district", "attrs.registered_district.value"), ("portal_district", "attrs.district.value")]),
    "activities": ("activities", {}, [
        ("at", "at"), ("type", "type"), ("channel", "channel"), ("company_id", "company_id"), ("holdout", "holdout"), ("campaign", "campaign"),
        ("template_version", "template_version"), ("model_version", "model_version"), ("kind", "data.kind"), ("mailbox", "data.mailbox"),
        ("need_id", "data.need_id"), ("bounce", "data.bounce"), ("label", "data.label"), ("call_status", "data.status"), ("call_outcome", "data.outcome"),
        ("duration_s", "data.duration_s"), ("amount_paise", "data.amount_paise"), ("service", "data.service"),
        ("contacted_before", "data.attribution.contacted"), ("days_since_first_touch", "data.attribution.days_since_first_touch")]),
    "messages": ("messages", {}, [
        ("company_id", "company_id"), ("kind", "kind"), ("language", "language"), ("status", "status"), ("mailbox", "mailbox"), ("need_id", "need_id"),
        ("drafter", "draft.drafter"), ("prompt_version", "draft.prompt_version"), ("model", "draft.model"), ("qc_passed", "qc.passed"),
        ("approved_by_edit", "approval.edited"), ("gate_code", "gate.code"), ("created_at", "created_at"), ("sent_at", "send.at")]),
    "calls": ("calls", {}, [
        ("company_id", "company_id"), ("status", "status"), ("outcome", "outcome"), ("attempt", "attempt"), ("language", "language"), ("slot", "slot"),
        ("duration_s", "duration_s"), ("cost_paise", "cost_paise"), ("script_version", "script_version"), ("placed_at", "placed_at"), ("created_at", "created_at")]),
    "inbound": ("inbound", {}, [
        ("mailbox", "mailbox"), ("kind", "kind"), ("label", "label"), ("label_by", "classification.by"), ("confidence", "classification.confidence"),
        ("classifier", "classification.version"), ("company_id", "matched.company_id"), ("matched_how", "matched.how"), ("status", "status"),
        ("received_at", "received_at")]),
    "llm_calls": ("llm_calls", {}, [
        ("at", "at"), ("task", "task"), ("model", "model"), ("prompt_version", "prompt_version"), ("input_tokens", "input_tokens"),
        ("output_tokens", "output_tokens"), ("cost_inr", "cost_inr"), ("latency_ms", "latency_ms"), ("ok", "ok"), ("company_id", "company_id")]),
    "usage": ("usage", {}, [("meter", "meter"), ("period", "period"), ("count", "count"), ("cap", "cap")]),
}


def _column(values: list):
    """An Arrow array from Python values, as a string column when the types are mixed."""
    try:
        return pa.array(values)
    except (pa.ArrowInvalid, pa.ArrowTypeError):
        return pa.array([None if v is None else str(v) for v in values], type=pa.string())


def export_parquet(db, out_dir: Path | None = None, *, now: datetime | None = None) -> dict:
    """Writes every table. Returns {table: rows}."""
    now = now or datetime.now(timezone.utc)
    out = Path(out_dir) if out_dir else ROOT / "data" / "exports" / now.strftime("%Y-%m-%d")
    out.mkdir(parents=True, exist_ok=True)
    counts = {}
    for table, (collection, query, columns) in TABLES.items():
        projection = {path.split(".")[0]: 1 for _, path in columns}
        docs = list(db[collection].find(query, projection))
        data = {name: _column([_get(d, path) for d in docs]) for name, path in columns}
        pq.write_table(pa.table(data), out / f"{table}.parquet", compression="zstd")
        counts[table] = len(docs)
    return {"dir": str(out), "tables": counts}

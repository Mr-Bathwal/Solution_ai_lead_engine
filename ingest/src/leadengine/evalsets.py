"""The extraction test set (design 7.10: "about 200 pages for extraction").

The portal parsers turn stored pages into records. Whenever a parser changes, the same pages must
still give the same fields, or the change must be meant. This module keeps a golden set of 200
stored pages, chosen the same way every time across the four kinds the engine parses:

    startinup_listing    60   the Startup in UP directory pages (cards)
    startinup_detail     60   a startup's profile page
    upsm_district        50   the UP Startup Mission district API (JSON)
    incubator_portfolio  30   an incubator's profile and portfolio

For each page it records the parser's output as fingerprints only: each field's path and a hash of
its value, never the value itself, because a profile page can name a founder. `leadengine eval
extraction` parses the pages again and reports, per kind, the pages whose output is unchanged and
the fields that changed, appeared or disappeared. It is a regression test, not a measure of
accuracy: a person checking a sample against the live pages is what measures that.
"""
from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from pathlib import Path

from .config import ROOT
from .sources import incubators, startinup, upsm

GOLDEN = ROOT / "data" / "testsets" / "extraction_golden.jsonl"


def _json(data: bytes):
    return json.loads(data.decode("utf-8"))


KINDS = [
    # name, source folder, url pattern, how many, parser(bytes) -> output
    ("startinup_listing", "startinup", re.compile(r"/connect_network/(\d+/)?$"), 60, lambda b: startinup.parse_cards(b)),
    ("startinup_detail", "startinup", re.compile(r"/startup_user_details/"), 60, lambda b: startinup.parse_detail(b)),
    ("upsm_district", "upsm", re.compile(r"/api/get-district-wise-startup/"), 50, lambda b: upsm.rows_of(upsm.clean_body(_json(b)))[0]),
    ("incubator_portfolio", "incubator_portfolio", re.compile(r"/incubator_user_details/"), 30, lambda b: incubators.parse_portfolio(b)),
]


def _h(v) -> str:
    return hashlib.sha256(json.dumps(v, ensure_ascii=False, sort_keys=True, default=str).encode()).hexdigest()[:16]


def fingerprint(output) -> dict:
    """{path: hash of the value} for every leaf of the output; lists are indexed (cards.3.name)."""
    out = {}

    def walk(v, path):
        if isinstance(v, dict):
            for k, x in v.items():
                walk(x, f"{path}.{k}" if path else str(k))
        elif isinstance(v, list) and v and all(isinstance(x, (dict, list)) for x in v):
            for i, x in enumerate(v):
                walk(x, f"{path}.{i}" if path else str(i))
        else:
            out[path or "_"] = _h(v)

    walk(output, "")
    return out


def _index(raw_root: Path, source: str) -> list[dict]:
    p = raw_root / source / "_index.jsonl"
    if not p.exists():
        return []
    rows = [json.loads(line) for line in p.read_text(encoding="utf-8").splitlines() if line.strip()]
    return sorted({r["key"]: r for r in rows}.values(), key=lambda r: r["sha256"])       # stable, spread across time


def build_golden(rawstore, raw_root: Path, out: Path = GOLDEN) -> dict:
    """Chooses the pages and writes their fingerprints. Returns counts per kind."""
    lines, counts = [], Counter()
    for name, source, pattern, n, parse in KINDS:
        for row in _index(raw_root, source):
            if counts[name] >= n:
                break
            if not pattern.search(row["url"].split("?")[0]):
                continue
            try:
                data = rawstore.get({"key": row["key"]})
            except FileNotFoundError:
                continue
            try:
                fp = fingerprint(parse(data))
            except Exception as e:                          # a page the parser cannot read is still a case
                fp = {"_error": type(e).__name__}
            lines.append(json.dumps({"kind": name, "key": row["key"], "url_hash": _h(row["url"]), "fields": fp}, ensure_ascii=False))
            counts[name] += 1
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return dict(counts)


def eval_extraction(rawstore, golden: Path = GOLDEN) -> dict:
    """Parses every golden page again. Returns {kinds: {name: {pages, same, changed, missing}}, changes: [...]}."""
    parsers = {name: parse for name, _, _, _, parse in KINDS}
    kinds: dict[str, Counter] = {}
    changes = []
    for line in golden.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        g = json.loads(line)
        c = kinds.setdefault(g["kind"], Counter())
        c["pages"] += 1
        try:
            data = rawstore.get({"key": g["key"]})
        except FileNotFoundError:
            c["missing"] += 1                               # erased or expired since the set was built
            continue
        try:
            now = fingerprint(parsers[g["kind"]](data))
        except Exception as e:
            now = {"_error": type(e).__name__}
        if now == g["fields"]:
            c["same"] += 1
            continue
        c["changed"] += 1
        before = g["fields"]
        diff = {"changed": sorted(k for k in before if k in now and now[k] != before[k]),
                "gone": sorted(k for k in before if k not in now), "new": sorted(k for k in now if k not in before)}
        if len(changes) < 50:
            changes.append({"kind": g["kind"], "key": g["key"], **{k: v[:10] for k, v in diff.items()}})
    return {"kinds": {k: dict(v) for k, v in kinds.items()}, "pages": sum(v["pages"] for v in kinds.values()),
            "same": sum(v["same"] for v in kinds.values()), "changes": changes}

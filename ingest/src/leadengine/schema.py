"""Applies schema/collections.json from Python (tests and local set-up).

Production uses `npm run migrate` in services/; both read the same JSON file, so the rules cannot drift.
"""
import json

from pymongo.database import Database
from pymongo.errors import CollectionInvalid

from .config import SCHEMA_PATH


def load_spec() -> dict:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def apply(db: Database, spec: dict | None = None) -> dict:
    spec = spec or load_spec()
    existing = set(db.list_collection_names())
    report = {"created": [], "updated": []}
    for name, d in spec["collections"].items():
        opts = {"validator": d["validator"], "validationLevel": "strict", "validationAction": "error"}
        if name in existing:
            db.command({"collMod": name, **opts})
            report["updated"].append(name)
        else:
            try:
                db.create_collection(name, **opts)
                report["created"].append(name)
            except CollectionInvalid:
                db.command({"collMod": name, **opts})
        have = {ix["name"] for ix in db[name].list_indexes()}
        for ix in d.get("indexes", []):
            if ix["name"] not in have:
                db[name].create_index(list(ix["key"].items()), name=ix["name"], **ix.get("options", {}))
    return report

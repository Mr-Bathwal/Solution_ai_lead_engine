"""The MCA inbox: the monthly incorporation file, loaded without anyone running a command.

mca.gov.in blocks scripted downloads, so a person downloads "Companies and LLPs registered in
<month>" each month. They put it in the inbox, either through the Admin pages (Data health, "Upload
the MCA file", admin role) or by copying it into the folder (MCA_INBOX, default data/mca/inbox).
The nightly run (and `ingest inbox`, to do it now) then:

  * reads every *.xlsx in the folder, oldest first (names starting with "." are uploads still being
    written, and are left alone);
  * skips a file whose SHA-256 was already loaded (the same file uploaded twice);
  * loads it as `ingest mca <file>` would, recording the file name and its SHA-256 on the run;
  * refuses a workbook with no companies in it (not an MCA incorporation report);
  * moves the file to loaded/<YYYY-MM>/ or failed/, so the folder shows at a glance what is waiting.

Nothing is deleted: a failed file stays in failed/ with a note beside it, for a person to look at.
"""
from __future__ import annotations

import hashlib
import shutil
from datetime import datetime, timezone
from pathlib import Path

from .config import ROOT
from .pipeline import run_source
from .sources.mca import SOURCE, McaMonthlySource

DEFAULT_INBOX = ROOT / "data" / "mca" / "inbox"


def inbox_path(env: dict) -> Path:
    p = Path(env.get("MCA_INBOX") or DEFAULT_INBOX)
    return p if p.is_absolute() else (ROOT / p).resolve()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def waiting(inbox: Path) -> list[Path]:
    """The files waiting in the inbox, oldest first."""
    if not inbox.is_dir():
        return []
    files = [p for p in inbox.iterdir() if p.is_file() and p.suffix.lower() == ".xlsx" and not p.name.startswith(".")]
    return sorted(files, key=lambda p: (p.stat().st_mtime, p.name))


def _move(path: Path, folder: Path) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / path.name
    n = 1
    while target.exists():                        # never overwrite: the same name uploaded twice is two files
        target = folder / f"{path.stem}.{n}{path.suffix}"
        n += 1
    shutil.move(str(path), str(target))
    return target


def _period(notes: list[str]) -> str | None:
    for note in notes:
        if ": period " in note:
            p = note.split(": period ", 1)[1][:7]
            if len(p) == 7 and p[4] == "-":
                return p
    return None


def load_inbox(db, *, sink, rawstore, inbox: Path, log=print, now=None) -> dict:
    """Loads every waiting file. Returns what happened to each, for the nightly run's record."""
    now = now or datetime.now(timezone.utc)
    out = {"loaded": [], "duplicates": [], "failed": []}
    for path in waiting(inbox):
        digest = sha256_file(path)
        before = db.ingest_runs.find_one({"source": SOURCE, "status": {"$in": ["ok", "partial"]}, "params.sha256": digest},
                                         sort=[("started_at", -1)])
        if before:
            moved = _move(path, inbox / "loaded" / "duplicates")
            log(f"mca inbox: {path.name} was already loaded by {before['_id']}; moved to {moved.relative_to(inbox)}")
            out["duplicates"].append({"file": path.name, "sha256": digest, "run": before["_id"]})
            continue
        try:
            s = run_source(McaMonthlySource(path), sink=sink, rawstore=rawstore, log=log,
                           params={"file": path.name, "sha256": digest, "via": "inbox", "size": path.stat().st_size})
        except Exception as exc:                 # a damaged workbook, or not a workbook at all
            why = f"{type(exc).__name__}: {exc}"[:300]
            moved = _move(path, inbox / "failed")
            moved.with_name(moved.name + ".why.txt").write_text(f"{now.isoformat()} could not be read: {why}\n", encoding="utf-8")
            log(f"mca inbox: {path.name} failed ({why}); moved to {moved.relative_to(inbox)}")
            out["failed"].append({"file": path.name, "sha256": digest, "why": why})
            continue
        if not s.stats.get("companies_india"):
            why = "no companies in it: not MCA's monthly incorporation report"
            db.ingest_runs.update_one({"_id": s.run_id}, {"$set": {"status": "failed"}, "$push": {"notes": why}})
            moved = _move(path, inbox / "failed")
            moved.with_name(moved.name + ".why.txt").write_text(f"{now.isoformat()} {why}\n", encoding="utf-8")
            log(f"mca inbox: {path.name}: {why}; moved to {moved.relative_to(inbox)}")
            out["failed"].append({"file": path.name, "sha256": digest, "why": why, "run": s.run_id})
            continue
        period = _period(s.notes) or now.strftime("%Y-%m")
        moved = _move(path, inbox / "loaded" / period)
        log(f"mca inbox: {path.name} loaded ({s.stats.get('companies_up', 0)} UP companies, period {period}); moved to {moved.relative_to(inbox)}")
        out["loaded"].append({"file": path.name, "sha256": digest, "run": s.run_id, "period": period,
                              "companies_up": s.stats.get("companies_up", 0)})
    return out


def inbox_status(inbox: Path) -> dict:
    return {"inbox": str(inbox), "waiting": [p.name for p in waiting(inbox)],
            "failed": sorted(p.name for p in (inbox / "failed").glob("*.xlsx")) if (inbox / "failed").is_dir() else []}


__all__ = ["DEFAULT_INBOX", "inbox_path", "inbox_status", "load_inbox", "sha256_file", "waiting"]

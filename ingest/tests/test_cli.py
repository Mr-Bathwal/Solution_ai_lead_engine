"""The nightly batch: one at a time, and one failing step never stops the need engine."""
from datetime import datetime, timedelta, timezone

from leadengine import cli
from leadengine.config import load_settings


def _settings(tmp_path):
    return load_settings({"LEADENGINE_ENV": "development", "RAW_STORE": str(tmp_path / "raw"), "MCA_INBOX": str(tmp_path / "inbox")})


def test_only_one_nightly_runs_at_a_time_and_a_dead_one_is_cleared(db):
    assert cli._nightly_lock(db, "nightly-a", "2026-11") is True
    assert cli._nightly_lock(db, "nightly-b", "2026-11") is False, "a second nightly must not start"
    db.ingest_runs.update_one({"_id": "nightly-a"}, {"$set": {"started_at": datetime.now(timezone.utc) - timedelta(hours=7)}})
    assert cli._nightly_lock(db, "nightly-c", "2026-11") is True, "a 'running' run older than six hours is a dead process"
    dead = db.ingest_runs.find_one({"_id": "nightly-a"})
    assert dead["status"] == "failed" and "process died" in dead["notes"][-1]


def test_a_failing_step_is_recorded_and_the_need_engine_still_runs(db, tmp_path, monkeypatch):
    import leadengine.enrich.waterfall as waterfall
    import leadengine.kb.build as kb_build
    import leadengine.need.leads as leads

    calls = []

    def broken_build(*a, **kw):
        calls.append("kb")
        raise RuntimeError("matcher crashed")

    class Vendorless:
        def __init__(self, *a, **kw):
            pass

        def run(self, month):
            calls.append("enrich")
            return {"vendor": "not configured"}

    def need_run(db_, **kw):
        calls.append("need")
        assert kw["env"]["LEADENGINE_ENV"] == "development", "settings.env reaches the need engine"
        return {"leads_written": 0}

    monkeypatch.setattr(kb_build, "build", broken_build)
    monkeypatch.setattr(waterfall, "Waterfall", Vendorless)
    monkeypatch.setattr(leads, "run", need_run)
    code = cli.nightly(db, _settings(tmp_path), month="2026-11")
    assert calls == ["kb", "enrich", "need"] and code == 1
    run = db.ingest_runs.find_one({"source": "nightly"})
    assert run["status"] == "partial" and run["stats"]["steps"] == {"mca_inbox": "ok", "kb": "failed", "enrich": "ok", "websites": "ok", "need": "ok"}
    assert "matcher crashed" in run["notes"][0]
    assert cli._nightly_lock(db, "next", "2026-11") is True, "the finished run released the lock"


def test_this_month_is_the_ist_month(monkeypatch):
    import leadengine.util as util

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 10, 31, 23, 30, tzinfo=timezone.utc).astimezone(tz) if tz else datetime(2026, 10, 31, 23, 30)

    monkeypatch.setattr(util, "datetime", Clock)
    assert cli.this_month() == "2026-11", "05:00 IST on 1 November is still 31 October in UTC"

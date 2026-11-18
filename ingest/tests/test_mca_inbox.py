"""The MCA inbox: an uploaded monthly file is loaded once, by the nightly run, and filed away."""
from leadengine import cli
from leadengine.config import load_settings
from leadengine.mca_inbox import inbox_status, load_inbox, sha256_file, waiting
from leadengine.sink import MongoSink

from test_mca import ROWS, make_report


def _quiet(*_a, **_k):
    pass


def test_a_new_file_is_loaded_once_and_filed_by_its_month(db, raw, tmp_path):
    inbox = tmp_path / "inbox"
    inbox.mkdir()
    f = inbox / "Incorporation-Report-20261005.xlsx"
    data = make_report(ROWS)                  # built once: openpyxl stamps the time into every workbook it writes
    f.write_bytes(data)
    (inbox / ".upload-123.part.xlsx").write_bytes(b"half written")       # an upload in progress is left alone
    (inbox / "notes.txt").write_text("not a workbook")
    digest = sha256_file(f)

    r = load_inbox(db, sink=MongoSink(db), rawstore=raw, inbox=inbox, log=_quiet)
    assert [x["file"] for x in r["loaded"]] == [f.name] and not r["failed"] and not r["duplicates"]
    assert r["loaded"][0]["period"] == "2026-09" and r["loaded"][0]["companies_up"] == 2
    assert (inbox / "loaded" / "2026-09" / f.name).exists() and not f.exists()
    run = db.ingest_runs.find_one({"_id": r["loaded"][0]["run"]})
    assert run["source"] == "mca_monthly" and run["status"] == "ok"
    assert run["params"] == {"file": f.name, "sha256": digest, "via": "inbox", "size": len(data)}
    assert db.source_records.count_documents({"source": "mca_monthly"}) == 2

    # the same file again, under another name: recognised by its content, not loaded twice
    again = inbox / "Incorporation-Report-20261005 (1).xlsx"
    again.write_bytes(data)
    assert sha256_file(again) == digest
    r2 = load_inbox(db, sink=MongoSink(db), rawstore=raw, inbox=inbox, log=_quiet)
    assert r2["duplicates"] == [{"file": again.name, "sha256": digest, "run": run["_id"]}] and not r2["loaded"]
    assert (inbox / "loaded" / "duplicates" / again.name).exists()
    assert db.ingest_runs.count_documents({"source": "mca_monthly"}) == 1
    assert waiting(inbox) == [] and inbox_status(inbox)["waiting"] == []


def test_a_file_that_is_not_the_report_is_set_aside_with_the_reason(db, raw, tmp_path):
    import io

    import openpyxl
    inbox = tmp_path / "inbox"
    inbox.mkdir()
    wb = openpyxl.Workbook()
    wb.active.append(["Some other spreadsheet"])
    buf = io.BytesIO()
    wb.save(buf)
    (inbox / "budget.xlsx").write_bytes(buf.getvalue())
    (inbox / "broken.xlsx").write_bytes(b"PK\x03\x04 not really a zip")

    r = load_inbox(db, sink=MongoSink(db), rawstore=raw, inbox=inbox, log=_quiet)
    assert sorted(x["file"] for x in r["failed"]) == ["broken.xlsx", "budget.xlsx"] and not r["loaded"]
    why = {x["file"]: x["why"] for x in r["failed"]}
    assert "not MCA's monthly incorporation report" in why["budget.xlsx"]
    assert (inbox / "failed" / "budget.xlsx").exists() and (inbox / "failed" / "budget.xlsx.why.txt").exists()
    assert (inbox / "failed" / "broken.xlsx").exists(), "nothing is deleted"
    assert inbox_status(inbox)["failed"] == ["broken.xlsx", "budget.xlsx"]
    assert db.ingest_runs.count_documents({"source": "mca_monthly", "status": {"$in": ["ok", "partial"]}}) == 0


def test_the_nightly_loads_the_inbox_first_and_alerts_on_a_bad_file(db, tmp_path, monkeypatch):
    import leadengine.enrich.waterfall as waterfall
    import leadengine.kb.build as kb_build
    import leadengine.need.leads as leads

    inbox = tmp_path / "inbox"
    inbox.mkdir()
    (inbox / "Incorporation-Report-20261105.xlsx").write_bytes(make_report(ROWS))
    (inbox / "wrong.xlsx").write_bytes(b"not a workbook")
    seen = {}

    class Vendorless:
        def __init__(self, *a, **kw):
            pass

        def run(self, month):
            return {}

    def need_run(db_, **kw):
        seen["mca_runs_before_need"] = db_.ingest_runs.count_documents({"source": "mca_monthly", "status": "ok"})
        return {}

    monkeypatch.setattr(kb_build, "build", lambda *a, **kw: {"match": {}})
    monkeypatch.setattr(waterfall, "Waterfall", Vendorless)
    monkeypatch.setattr(leads, "run", need_run)
    st = load_settings({"LEADENGINE_ENV": "development", "RAW_STORE": str(tmp_path / "raw"), "MCA_INBOX": str(inbox)})
    code = cli.nightly(db, st, month="2026-11")
    assert seen["mca_runs_before_need"] == 1, "the uploaded file is in tonight's shortlist"
    run = db.ingest_runs.find_one({"source": "nightly"})
    assert run["stats"]["steps"]["mca_inbox"] == "failed" and run["status"] == "partial" and code == 1
    assert any("wrong.xlsx" in n for n in run["notes"])

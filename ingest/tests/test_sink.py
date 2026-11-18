from datetime import datetime

import pytest
from pymongo.errors import WriteError

from leadengine.pipeline import run_source
from leadengine.records import Record
from leadengine.sink import MongoSink
from leadengine.sources.mca import McaMonthlySource
from test_mca import ROWS, make_report


class ListSource:
    def __init__(self, name, records):
        self.name, self.records = name, records

    def collect(self, ctx):
        yield from self.records


def test_mca_load_is_idempotent_and_creates_up_companies(db, raw, tmp_path):
    f = tmp_path / "Incorporation-Report-20261005.xlsx"
    f.write_bytes(make_report(ROWS))
    sink = MongoSink(db)
    first = run_source(McaMonthlySource(f), sink=sink, rawstore=raw, log=lambda m: None)
    assert first.status == "ok"
    assert first.stats["records_new"] == 2 and first.stats["companies_new"] == 2
    second = run_source(McaMonthlySource(f), sink=sink, rawstore=raw, log=lambda m: None)
    assert second.stats["records_unchanged"] == 2 and second.stats.get("records_new", 0) == 0
    assert second.stats["companies_new"] == 0 and second.stats["companies_refreshed"] == 2
    assert db.source_records.count_documents({}) == 2
    c = db.companies.find_one({"_id": "U62099UW2026PTC259408"})
    assert c["state"] == "UP" and c["cohort"] == "2026-09" and c["sources"] == ["mca_monthly"]
    assert c["attrs"]["incorporation_date"]["value"] == "2026-09-30"
    assert c["attrs"]["incorporation_date"]["source"] == "mca_monthly"
    assert db.companies.count_documents({}) == 2, "the Telangana company never enters"
    runs = list(db.ingest_runs.find())
    assert len(runs) == 2 and all(r["status"] == "ok" for r in runs)


def test_a_changed_record_is_a_new_version_and_the_old_one_stays(db, raw):
    sink = MongoSink(db)
    v1 = Record("upsm", "UPLC_00004164", {"startup_name": "3Sutra", "startup_current_stage": "2"}, "published_by_company")
    v2 = Record("upsm", "UPLC_00004164", {"startup_name": "3Sutra", "startup_current_stage": "4"}, "published_by_company")
    s1 = run_source(ListSource("upsm", [v1]), sink=sink, rawstore=raw, log=lambda m: None)
    s2 = run_source(ListSource("upsm", [v2]), sink=sink, rawstore=raw, log=lambda m: None)
    assert s1.stats["records_new"] == 1 and s2.stats["records_changed"] == 1
    stages = [d["payload"]["startup_current_stage"] for d in db.source_records.find().sort("fetched_at", 1)]
    assert stages == ["2", "4"]
    assert sink.known_keys("upsm") == {"UPLC_00004164"}


def test_portal_records_do_not_create_companies(db, raw):
    rec = Record("startinup", "UPLC_00000001", {"legal_name": "X PRIVATE LIMITED"}, "published_by_company")
    run_source(ListSource("startinup", [rec]), sink=MongoSink(db), rawstore=raw, log=lambda m: None)
    assert db.companies.count_documents({}) == 0


def test_database_refuses_a_record_with_an_unknown_legal_basis(db):
    with pytest.raises(WriteError):
        db.source_records.insert_one({"source": "upsm", "natural_key": "k", "content_hash": "0" * 64, "payload": {},
                                      "legal_basis": "scraped_from_linkedin", "fetched_at": datetime.now(),
                                      "run_id": "r", "schema_version": 1})


def test_a_failing_source_marks_the_run_failed(db, raw):
    class Boom:
        name = "upsm"

        def collect(self, ctx):
            yield Record("upsm", "UPLC_00000002", {"a": 1}, "published_by_company")
            raise RuntimeError("portal changed its layout")

    with pytest.raises(RuntimeError):
        run_source(Boom(), sink=MongoSink(db), rawstore=raw, log=lambda m: None)
    run = db.ingest_runs.find_one()
    assert run["status"] == "failed" and "layout" in run["notes"][-1]


def _at(day):
    from datetime import timezone
    return datetime(2026, 10, day, tzinfo=timezone.utc)


def _upsm(stage, day):
    return Record("upsm", "UPLC_00004164", {"startup_name": "3Sutra", "startup_current_stage": stage},
                  "published_by_company", fetched_at=_at(day))


def test_a_record_that_changes_back_is_current_again(db, raw):
    """A -> B -> A: nothing new is stored the third time, but the current version is A again."""
    sink = MongoSink(db)
    stats = [run_source(ListSource("upsm", [_upsm(s, d)]), sink=sink, rawstore=raw, log=lambda m: None).stats
             for s, d in (("2", 1), ("4", 8), ("2", 15))]
    assert stats[2]["records_changed"] == 1, "a revert is a change, not 'unchanged'"
    assert db.source_records.count_documents({}) == 2
    [cur] = list(sink.current("upsm"))
    assert cur["payload"]["startup_current_stage"] == "2"
    st = db.source_state.find_one()
    assert st["versions"] == 3 and st["last_changed_at"].day == 15 and st["first_seen_at"].day == 1


def test_an_older_observation_never_moves_the_pointer(db, raw):
    """A backfill from an old cache, run after a live crawl, must not make old data current."""
    sink = MongoSink(db)
    run_source(ListSource("upsm", [_upsm("4", 26)]), sink=sink, rawstore=raw, log=lambda m: None)
    s = run_source(ListSource("upsm", [_upsm("2", 8)]), sink=sink, rawstore=raw, log=lambda m: None).stats
    assert s["records_older_than_current"] == 1
    assert db.source_records.count_documents({}) == 2, "the old version is still kept"
    assert next(sink.current("upsm"))["payload"]["startup_current_stage"] == "4"


def test_seen_but_not_reread_keys_stay_current(db, raw):
    sink = MongoSink(db)
    run_source(ListSource("upsm", [_upsm("4", 1)]), sink=sink, rawstore=raw, log=lambda m: None)

    class Lister:
        name = "upsm"

        def collect(self, ctx):
            ctx.saw("upsm", "UPLC_00004164")
            return iter(())

    s = run_source(Lister(), sink=sink, rawstore=raw, log=lambda m: None)
    assert s.stats["listed_not_reread"] == 1
    assert db.source_state.find_one()["last_seen_at"] > _at(1).replace(tzinfo=None)


def test_an_interrupted_run_is_not_left_running(db, raw):
    class CtrlC:
        name = "upsm"

        def collect(self, ctx):
            raise KeyboardInterrupt
            yield

    with pytest.raises(KeyboardInterrupt):
        run_source(CtrlC(), sink=MongoSink(db), rawstore=raw, log=lambda m: None)
    run = db.ingest_runs.find_one()
    assert run["status"] == "failed" and run["notes"][-1] == "interrupted"


def test_rebuild_state_from_existing_records(db, raw):
    sink = MongoSink(db)
    for s, d in (("2", 1), ("4", 8)):
        run_source(ListSource("upsm", [_upsm(s, d)]), sink=sink, rawstore=raw, log=lambda m: None)
    db.source_state.delete_many({})
    assert sink.rebuild_state() == 1
    assert next(sink.current("upsm"))["payload"]["startup_current_stage"] == "4"


def test_rebuild_state_never_overwrites_live_state(db, raw):
    """source_records cannot tell when a key was last seen or that it reverted; source_state can."""
    sink = MongoSink(db)
    for s, d in (("2", 1), ("4", 8), ("2", 22)):          # A -> B -> A, last seen on the 22nd
        run_source(ListSource("upsm", [_upsm(s, d)]), sink=sink, rawstore=raw, log=lambda m: None)
    before = db.source_state.find_one()
    assert sink.rebuild_state() == 0
    after = db.source_state.find_one()
    assert after == before and after["last_seen_at"].day == 22 and after["versions"] == 3
    assert next(sink.current("upsm"))["payload"]["startup_current_stage"] == "2"


def test_a_run_that_stops_early_keeps_what_it_read(db, raw):
    from leadengine.net.fetcher import BudgetExhausted

    class TenThenStop:
        name = "upsm"

        def __init__(self, exc):
            self.exc = exc

        def collect(self, ctx):
            for i in range(10):
                yield Record("upsm", f"UPLC_{i:08d}", {"i": i}, "published_by_company")
            raise self.exc

    s = run_source(TenThenStop(BudgetExhausted("budget")), sink=MongoSink(db, batch_size=500), rawstore=raw, log=lambda m: None)
    assert s.status == "partial" and s.stats["records_new"] == 10
    assert db.source_records.count_documents({}) == 10
    with pytest.raises(ValueError):
        run_source(TenThenStop(ValueError("an HTML page where JSON was expected")), sink=MongoSink(db), rawstore=raw,
                   log=lambda m: None)
    run = db.ingest_runs.find_one({"status": "failed"})
    assert run["stats"]["records_unchanged"] == 10, "the failed run still reports what it wrote"


def test_a_backfill_after_a_live_run_still_corrects_first_seen(db, raw):
    sink = MongoSink(db)
    run_source(ListSource("upsm", [_upsm("4", 26)]), sink=sink, rawstore=raw, log=lambda m: None)
    run_source(ListSource("upsm", [_upsm("4", 7)]), sink=sink, rawstore=raw, log=lambda m: None)
    st = db.source_state.find_one()
    assert st["first_seen_at"].day == 7 and st["last_seen_at"].day == 26


def test_a_key_listed_twice_in_one_run_keeps_its_first_observation(db, raw):
    sink = MongoSink(db)
    s = run_source(ListSource("upsm", [_upsm("2", 1), _upsm("4", 1)]), sink=sink, rawstore=raw, log=lambda m: None).stats
    assert s["records_repeated_in_run"] == 1 and s["records_new"] == 1
    again = run_source(ListSource("upsm", [_upsm("2", 2), _upsm("4", 2)]), sink=sink, rawstore=raw, log=lambda m: None).stats
    assert again["records_unchanged"] == 1 and "records_changed" not in again, "no flapping between the two"


def test_known_keys_looks_at_the_current_version_only(db, raw):
    sink = MongoSink(db)
    parsed = Record("startinup", "UPLC_00000001", {"profile_parsed": True, "team": []}, "published_by_company", fetched_at=_at(1))
    card = Record("startinup", "UPLC_00000001", {"profile_parsed": False}, "published_by_company", fetched_at=_at(2))
    run_source(ListSource("startinup", [parsed]), sink=sink, rawstore=raw, log=lambda m: None)
    assert sink.known_keys("startinup", {"payload.profile_parsed": True}) == {"UPLC_00000001"}
    run_source(ListSource("startinup", [card]), sink=sink, rawstore=raw, log=lambda m: None)
    assert sink.known_keys("startinup", {"payload.profile_parsed": True}) == set(), \
        "an older parsed version does not count once the current one has lost its profile"

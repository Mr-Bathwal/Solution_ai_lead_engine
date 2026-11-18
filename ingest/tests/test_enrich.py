"""Enrichment: hard caps, the cache, the vendor adapter and the waterfall, against a fake vendor."""
import json
from datetime import datetime, timedelta, timezone

import pytest

import requests

from leadengine.enrich import cache, places
from leadengine.enrich.caps import Meter, period
from leadengine.enrich.infyner import InfynerClient, NotConfigured, extract
from leadengine.enrich.waterfall import Waterfall, client_from_env

CAPS = {"daily": {"free_basic_lookups": 3, "free_name_searches": 2}, "monthly": {"paid_profile_lookups": 1}}
LIVE = "pk_live_fake"     # a live-style key (the adapter treats pk_test_ keys as the sandbox)


class Resp:
    def __init__(self, status, body=None, headers=None):
        self.status_code, self.headers = status, headers or {}
        self.content = json.dumps(body).encode() if body is not None else b""

    def json(self):
        return json.loads(self.content)


class FakeVendor:
    """Answers like a plausible MCA-data API; records every call."""

    def __init__(self, companies, search=None):
        self.companies, self.search_hits, self.calls, self.headers = companies, search or {}, [], {}

    def get(self, url, params=None, timeout=None):
        self.calls.append((url, params))
        path = url.split("api.infyner.com")[1]
        if path == "/v1/companies/search":
            return Resp(200, {"data": self.search_hits.get(params["q"], [])})
        cin = path.split("/")[3]
        if cin not in self.companies:
            return Resp(404, {"error": "not found"})
        rec = self.companies[cin]
        if path.endswith("/profile"):
            return Resp(200, {"data": {**rec, "authorisedCapital": 100000, "paidUpCapital": 10000, "emailId": "Info@Vezras.in",
                                       "directors": [{"din": "01234567", "name": "A Founder", "designation": "Director"},
                                                     {"name": "No DIN Person"}]}})
        return Resp(200, {"data": rec})


def _company(cin, name, cohort="2026-09"):
    now = datetime.now(timezone.utc)
    return {"_id": cin, "kind": "company", "state": "UP", "name": name, "ids": {"cin": cin}, "cohort": cohort,
            "sources": ["mca_monthly"], "first_seen_at": now, "updated_at": now, "schema_version": 2, "former_names": [],
            "attrs": {"incorporation_date": {"value": f"{cohort}-10", "source": "mca_monthly", "seen_at": now}}}


VEZRAS = "U62099UP2026PTC100001"
VENDOR_RECORDS = {VEZRAS: {"cin": VEZRAS, "companyName": "VEZRAS TECHNOLOGIES PRIVATE LIMITED", "companyStatus": "Active",
                           "dateOfIncorporation": "11/06/2026", "registeredOfficeAddress": "12 Gomti Nagar, Lucknow, Uttar Pradesh 226010",
                           "roc": "ROC Uttar Pradesh-I"}}


def test_meter_never_passes_its_cap(db):
    m = Meter(db, "x", cap=2, kind="daily")
    assert [m.take(), m.take(), m.take()] == [True, True, False]
    assert m.used() == 2 and m.left() == 0
    tomorrow = Meter(db, "x", cap=2, kind="daily", clock=lambda: datetime.now(timezone.utc) + timedelta(days=1))
    assert tomorrow.take(), "a daily cap resets the next day"


def test_cache_expires_and_remembers_not_found(db):
    now = datetime.now(timezone.utc)
    cache.put(db, "v", "lookup", "A", status="not_found", result=None, now=now)
    assert cache.get(db, "v", "lookup", "A", now + timedelta(days=29))["status"] == "not_found"
    assert cache.get(db, "v", "lookup", "A", now + timedelta(days=31)) is None


def test_extract_reads_common_field_spellings():
    f = extract({"Company Name": "X PVT LTD", "CIN": "U1", "company_status": "Active", "Registered Office Address": "Agra 282001",
                 "Directors": [{"DIN": "01234567", "Name": "A"}]})
    assert f["name"] == "X PVT LTD" and f["status"] == "Active" and f["directors"][0]["din"] == "01234567"


def test_no_key_means_no_calls():
    with pytest.raises(NotConfigured):
        InfynerClient(None)


def test_waterfall_basic_then_profile_within_caps(db, raw):
    db.companies.insert_many([_company(VEZRAS, "VEZRAS TECHNOLOGIES PRIVATE LIMITED"),
                              _company("U62099UP2026PTC100002", "SECOND PRIVATE LIMITED"),
                              _company("U62099UP2026PTC100003", "THIRD PRIVATE LIMITED")])
    db.leads.insert_one({"company_id": VEZRAS, "stage": "shortlisted", "holdout": False, "eligible": True, "cohort": "2026-09",
                         "shortlist": {"month": "2026-10", "rank": 1}, "created_at": datetime.now(timezone.utc),
                         "updated_at": datetime.now(timezone.utc)})
    vendor = FakeVendor(VENDOR_RECORDS)
    w = Waterfall(db, raw, CAPS, client=InfynerClient(LIVE, session=vendor, sleep=lambda s: None), log=lambda m: None)
    out = w.run("2026-10", steps=("basic", "profile"))
    c = db.companies.find_one({"_id": VEZRAS})
    assert c["attrs"]["company_status"]["value"] == "Active" and c["attrs"]["registered_district"]["value"] == "Lucknow"
    assert c["attrs"]["registered_pincode"]["value"] == "226010"
    assert c["attrs"]["registered_email"]["value"] == "info@vezras.in"
    assert c["attrs"]["registered_email"]["ref"]["legal_basis"] == "published_under_law"
    assert db.people.count_documents({}) == 1, "only directors with a DIN are stored, with no contact details"
    assert db.people.find_one()["contacts"] == []
    assert out["profile_found"] == 1 and out["full_profiles_left_this_month"] == 0
    assert out["lookup_not_found"] == 2, "the other two are cached as not found"
    # a second run spends nothing: everything is cached
    calls = len(vendor.calls)
    Waterfall(db, raw, CAPS, client=InfynerClient(LIVE, session=vendor), log=lambda m: None).run("2026-10")
    assert len(vendor.calls) == calls


def test_daily_cap_stops_lookups(db, raw):
    db.companies.insert_many([_company(f"U62099UP2026PTC2000{i:02d}", f"C{i} PRIVATE LIMITED") for i in range(6)])
    vendor = FakeVendor({})
    out = Waterfall(db, raw, CAPS, client=InfynerClient(LIVE, session=vendor), log=lambda m: None).run(None, steps=("basic",))
    assert len(vendor.calls) == 3 and out["lookup_cap_reached"] == 1


def test_resolve_creates_a_company_for_a_portal_startup_with_an_exact_up_match(db, raw):
    now = datetime.now(timezone.utc)
    db.source_records.insert_one({"source": "startinup", "natural_key": "UPLC_00000009", "content_hash": "a" * 64,
                                  "payload": {"uplc": "UPLC_00000009", "legal_name": "Vezras Technologies Pvt Ltd",
                                              "entity_type": "Private Limited"},
                                  "legal_basis": "published_by_company", "fetched_at": now, "run_id": "r", "schema_version": 2})
    db.source_state.insert_one({"_id": "startinup|UPLC_00000009", "source": "startinup", "natural_key": "UPLC_00000009",
                                "content_hash": "a" * 64, "first_seen_at": now, "last_seen_at": now, "last_changed_at": now,
                                "versions": 1})
    db.entity_links.insert_one({"_id": "startup:UPLC_00000009", "entity_type": "startup", "entity_key": "UPLC_00000009",
                                "status": "unlinked", "model_version": "t", "updated_at": now, "evidence": {"reason": "no company"}})
    hits = {"Vezras Technologies Pvt Ltd": [{"cin": VEZRAS, "companyName": "VEZRAS TECHNOLOGIES PRIVATE LIMITED"},
                                            {"cin": "U62099DL2026PTC999999", "companyName": "VEZRAS TECHNOLOGIES PRIVATE LIMITED"}]}
    vendor = FakeVendor(VENDOR_RECORDS, hits)
    out = Waterfall(db, raw, CAPS, client=InfynerClient(LIVE, session=vendor), log=lambda m: None).run(None, steps=("resolve",))
    assert out["resolve_companies_created"] == 1, "the Delhi CIN is ignored: UP only"
    c = db.companies.find_one({"_id": VEZRAS})
    assert c["state"] == "UP" and c["cohort"] == "2026-06" and c["attrs"]["incorporation_date"]["value"] == "2026-06-11"
    assert db.companies.count_documents({}) == 1


def test_places():
    assert places.district("Sector 62, Noida, Uttar Pradesh 201309") == "Gautam Buddha Nagar"
    assert places.district("Mall Road, Kanpur Dehat") == "Kanpur Dehat"
    assert places.pincode("Civil Lines, Allahabad 211 001") == "211001"


# ---- failures, envelopes and the sandbox ----------------------------------------------------------

class Scripted:
    """A vendor session that answers every call with the next scripted response (or raises it)."""

    def __init__(self, *answers):
        self.answers, self.calls, self.headers = list(answers), [], {}

    def get(self, url, params=None, timeout=None):
        self.calls.append(url)
        a = self.answers[0] if len(self.answers) == 1 else self.answers.pop(0)
        if isinstance(a, Exception):
            raise a
        return a


def _client(session, key=LIVE):
    return InfynerClient(key, session=session, sleep=lambda s: None)


def test_an_error_envelope_with_a_200_is_an_error_not_data():
    a = _client(Scripted(Resp(200, {"status": "error", "message": "quota exceeded", "data": None}))).lookup(VEZRAS)
    assert a.status == "error" and "quota" in a.error and not a.fields
    gone = _client(Scripted(Resp(200, {"success": False, "message": "Company not found"}))).lookup(VEZRAS)
    assert gone.status == "not_found"
    empty = _client(Scripted(Resp(200, {"status": "success", "data": None}))).lookup(VEZRAS)
    assert empty.status == "not_found"


def test_the_envelope_is_unwrapped_but_sibling_sections_are_kept():
    body = {"data": {"company": {"cin": VEZRAS, "companyName": "VEZRAS TECHNOLOGIES PRIVATE LIMITED", "status": "Active"},
                     "directors": [{"din": "01234567", "name": "A Founder"}], "authorisedCapital": 100000}}
    a = _client(Scripted(Resp(200, body))).profile(VEZRAS)
    assert a.status == "found" and a.fields["directors"][0]["din"] == "01234567" and a.fields["authorised_capital"] == 100000
    rec = {"cin": VEZRAS, "companyName": "X PRIVATE LIMITED", "result": "ok", "items": 3}
    assert _client(Scripted(Resp(200, rec))).lookup(VEZRAS).fields["name"] == "X PRIVATE LIMITED", \
        "a field called 'result' inside a record is data, not an envelope"


def test_an_answer_the_adapter_cannot_read_is_unparsed_and_cached_for_a_day(db, raw):
    db.companies.insert_one(_company(VEZRAS, "VEZRAS TECHNOLOGIES PRIVATE LIMITED"))
    s = Scripted(Resp(200, {"data": {"weird_field": 1}}))
    out = Waterfall(db, raw, CAPS, client=_client(s), log=lambda m: None).run(None, steps=("basic",))
    assert out["lookup_unparsed"] == 1
    doc = db.enrichment_cache.find_one({"_id": f"infyner:lookup:{VEZRAS}"})
    assert doc["status"] == "unparsed" and (doc["expires_at"] - doc["fetched_at"]) == timedelta(days=1)


def test_a_refused_key_stops_the_step_instead_of_burning_the_quota(db, raw):
    db.companies.insert_many([_company(f"U62099UP2026PTC3000{i:02d}", f"C{i} PRIVATE LIMITED") for i in range(20)])
    s = Scripted(Resp(401, {"error": "invalid key"}))
    out = Waterfall(db, raw, {**CAPS, "daily": {"free_basic_lookups": 500, "free_name_searches": 500}},
                    client=_client(s), log=lambda m: None).run(None, steps=("basic",))
    assert len(s.calls) == 1 and out["stopped_vendor_unavailable"] == 1 and out["stopped_at_step"] == "basic"
    overloaded = Scripted(Resp(429, {}))
    out = Waterfall(db, raw, {**CAPS, "daily": {"free_basic_lookups": 500, "free_name_searches": 500}},
                    client=_client(overloaded), log=lambda m: None).run(None, steps=("basic",))
    assert len(overloaded.calls) == 3, "429 is retried, then the step stops"


def test_any_requests_error_is_an_error_answer_not_a_crash():
    a = _client(Scripted(requests.exceptions.ChunkedEncodingError("broken"))).lookup(VEZRAS)
    assert a.status == "error" and a.error == "ChunkedEncodingError"


def test_a_sandbox_key_never_writes_company_records(db, raw):
    db.companies.insert_one(_company(VEZRAS, "VEZRAS TECHNOLOGIES PRIVATE LIMITED"))
    out = Waterfall(db, raw, CAPS, client=_client(FakeVendor(VENDOR_RECORDS), key="pk_test_x"), log=lambda m: None).run(None, steps=("basic",))
    assert out["sandbox"] and out["sandbox_answers_not_applied"] == 1
    assert "company_status" not in db.companies.find_one({"_id": VEZRAS})["attrs"]
    assert db.enrichment_cache.find_one({"_id": f"infyner_sandbox:lookup:{VEZRAS}"}), "cached apart from live answers"
    assert db.enrichment_cache.find_one({"_id": f"infyner:lookup:{VEZRAS}"}) is None


def test_a_cache_hit_keeps_the_date_the_vendor_gave_the_fact(db, raw):
    db.companies.insert_one(_company(VEZRAS, "VEZRAS TECHNOLOGIES PRIVATE LIMITED"))
    then = datetime.now(timezone.utc) - timedelta(days=60)
    cache.put(db, "infyner", "lookup", VEZRAS, status="found", result={"fields": {"status": "Active"}, "items": [], "error": None}, now=then)
    Waterfall(db, raw, CAPS, client=_client(Scripted(Resp(500, {}))), log=lambda m: None).run(None, steps=("basic",))
    seen = db.companies.find_one({"_id": VEZRAS})["attrs"]["company_status"]["seen_at"]
    assert abs((seen.replace(tzinfo=timezone.utc) - then).total_seconds()) < 1


def test_an_llp_is_created_only_when_the_vendor_places_it_in_up(db, raw):
    now = datetime.now(timezone.utc)
    for key, name in (("UPLC_00000011", "Delhi Ventures LLP"), ("UPLC_00000012", "Lucknow Ventures LLP")):
        db.source_records.insert_one({"source": "startinup", "natural_key": key, "content_hash": key[-1] * 64, "payload": {
            "uplc": key, "legal_name": name, "entity_type": "LLP"}, "legal_basis": "published_by_company", "fetched_at": now,
            "run_id": "r", "schema_version": 2})
        db.source_state.insert_one({"_id": f"startinup|{key}", "source": "startinup", "natural_key": key, "content_hash": key[-1] * 64,
                                    "first_seen_at": now, "last_seen_at": now, "last_changed_at": now, "versions": 1})
        db.entity_links.insert_one({"_id": f"startup:{key}", "entity_type": "startup", "entity_key": key, "status": "unlinked",
                                    "model_version": "t", "updated_at": now, "evidence": {"reason": "no company"}})
    llps = {"AAA-1111": {"llpin": "AAA-1111", "llpName": "DELHI VENTURES LLP", "dateOfIncorporation": "01/05/2026",
                         "registeredOfficeAddress": "Connaught Place, New Delhi 110001", "roc": "ROC Delhi"},
            "AAA-2222": {"llpin": "AAA-2222", "llpName": "LUCKNOW VENTURES LLP", "dateOfIncorporation": "01/05/2026",
                         "registeredOfficeAddress": "Hazratganj, Lucknow, Uttar Pradesh 226001", "roc": "ROC Kanpur"}}
    hits = {"Delhi Ventures LLP": [{"llpin": "AAA-1111", "llpName": "DELHI VENTURES LLP"}],
            "Lucknow Ventures LLP": [{"llpin": "AAA-2222", "llpName": "LUCKNOW VENTURES LLP"}]}
    out = Waterfall(db, raw, {**CAPS, "daily": {"free_basic_lookups": 10, "free_name_searches": 10}},
                    client=_client(FakeVendor(llps, hits)), log=lambda m: None).run(None, steps=("resolve",))
    assert out["resolve_llp_not_shown_in_up"] == 1 and out["resolve_companies_created"] == 1
    assert db.companies.find_one({"_id": "AAA-2222"})["kind"] == "llp" and db.companies.find_one({"_id": "AAA-1111"}) is None


def test_registered_emails_are_flagged_personal_unless_a_role_address(db, raw):
    for email, personal in (("rahul.verma@vezras.in", True), ("founder@gmail.com", True), ("accounts@vezras.in", False)):
        db.companies.delete_many({})
        db.enrichment_cache.delete_many({})
        db.companies.insert_one(_company(VEZRAS, "VEZRAS TECHNOLOGIES PRIVATE LIMITED"))
        rec = {**VENDOR_RECORDS[VEZRAS], "emailId": email}
        Waterfall(db, raw, CAPS, client=_client(FakeVendor({VEZRAS: rec})), log=lambda m: None).run(None, steps=("basic",))
        assert db.companies.find_one({"_id": VEZRAS})["attrs"]["registered_email"]["personal"] is personal, email


def test_caps_count_indian_days_and_months():
    nightly = datetime(2026, 10, 31, 23, 30, tzinfo=timezone.utc)      # 05:00 IST on 1 November
    assert period("daily", nightly) == "2026-11-01" and period("monthly", nightly) == "2026-11"
    assert period("daily", datetime(2026, 11, 1, 4, 30, tzinfo=timezone.utc)) == "2026-11-01"   # 10:00 IST, same day


def test_the_vendor_key_in_dotenv_reaches_the_client():
    from leadengine.config import load_settings
    st = load_settings({"INFYNER_API_KEY": "pk_test_from_dotenv"})
    assert client_from_env(st.env).sandbox is True
    assert "pk_test_from_dotenv" not in repr(st), "secrets never appear in the settings' repr"

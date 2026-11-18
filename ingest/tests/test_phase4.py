"""Phase 4 on the data side: the extraction test set and the Parquet exports."""
import json
from datetime import datetime, timezone

import pyarrow.parquet as pq
from bson import ObjectId

from leadengine import evalsets
from leadengine.evalsets import build_golden, eval_extraction, fingerprint
from leadengine.export import TABLES, export_parquet
from leadengine.rawstore import FileRawStore

CARD = """<html><body><div class="startup-card"><h4>Vezras Technologies</h4><p>Lucknow</p></div></body></html>"""
DETAIL = """<html><body><div class="company-name"><h3>Vezras Technologies Private Limited</h3><span class="active-since">10/09/2026</span></div>
<table><tr><td>Entity Type</td><td>Private Limited</td></tr><tr><td>District</td><td>Lucknow</td></tr></table></body></html>"""
UPSM = {"data": {"records": [{"startup_name": "Vezras", "district_name": "Lucknow", "sector": "IT"}], "pagination": {"total": 1}}}


def test_fingerprints_hash_every_field_and_keep_no_value():
    fp = fingerprint({"title": "Rahul Verma's startup", "cards": [{"name": "A"}, {"name": "B"}], "tags": ["x", "y"]})
    assert set(fp) == {"title", "cards.0.name", "cards.1.name", "tags"}
    assert all(len(v) == 16 for v in fp.values())
    assert "Rahul" not in json.dumps(fp), "a value is never stored, only its hash"


def test_the_golden_set_finds_parser_changes(tmp_path, monkeypatch):
    raw = FileRawStore(tmp_path / "raw")
    raw.put(DETAIL.encode(), source="startinup", url="https://www.startinup.up.gov.in/crm/Welcome/startup_user_details/abc", content_type="text/html")
    raw.put(CARD.encode(), source="startinup", url="https://www.startinup.up.gov.in/crm/welcome/connect_network/2/", content_type="text/html")
    raw.put(json.dumps(UPSM).encode(), source="upsm", url="https://www.startupmission.up.gov.in/en/api/get-district-wise-startup/645?page=1", content_type="application/json")
    golden = tmp_path / "golden.jsonl"
    counts = build_golden(raw, tmp_path / "raw", out=golden)
    assert counts == {"startinup_detail": 1, "startinup_listing": 1, "upsm_district": 1}
    r = eval_extraction(raw, golden)
    assert (r["pages"], r["same"], r["changes"]) == (3, 3, [])
    # a parser that starts reading one more field, and loses another
    kinds = [list(k) for k in evalsets.KINDS]
    for k in kinds:
        if k[0] == "upsm_district":
            orig = k[4]
            k[4] = lambda b, orig=orig: [{**row, sorted(row)[0]: "changed", "new_field": 1} for row in orig(b)]
    monkeypatch.setattr(evalsets, "KINDS", [tuple(k) for k in kinds])
    r = eval_extraction(raw, golden)
    assert r["same"] == 2
    change = r["changes"][0]
    assert change["kind"] == "upsm_district"
    assert change["new"] == ["0.new_field"] and len(change["changed"]) == 1 and change["gone"] == []


def test_retention_deletes_old_bought_data_only_for_companies_never_contacted(db, tmp_path):
    from datetime import timedelta
    from leadengine.retention import erase_vendor_raw, run_retention
    now = datetime(2027, 12, 1, tzinfo=timezone.utc)
    old = now - timedelta(days=400)
    raw = FileRawStore(tmp_path / "raw")

    def vendor(v):
        return {"value": v, "source": "infyner", "confidence": "high", "seen_at": old, "ref": {"op": "profile", "raw": None, "legal_basis": "published_under_law"}}

    for cid, contacted in (("U62099UP2026PTC300001", False), ("U62099UP2026PTC300002", True)):
        db.companies.insert_one({"_id": cid, "kind": "company", "state": "UP", "name": f"COMPANY {cid[-1]} PRIVATE LIMITED", "ids": {"cin": cid},
                                 "sources": ["mca_monthly", "infyner"], "first_seen_at": old, "updated_at": old, "schema_version": 2,
                                 "attrs": {"registered_email": vendor("rahul.verma@gmail.com"), "registered_office": vendor("12 Gomti Nagar, Lucknow"),
                                           "registered_district": vendor("Lucknow"), "full_profile_at": vendor("2026-11-20")}})
        raw.put(b'{"directors": [{"name": "Rahul Verma"}]}', source="vendor_infyner", url=f"infyner://profile/{cid}", content_type="application/json", redact=False)
        if contacted:
            db.activities.insert_one({"at": old, "type": "sent", "channel": "email", "company_id": cid, "holdout": False, "idem_key": f"sent:{cid}", "data": {}})
    db.people.insert_one({"din": "01234567", "name": "Rahul Verma", "company_ids": ["U62099UP2026PTC300001"], "contacts": [], "created_at": old, "updated_at": old})

    dry = run_retention(db, raw, months=12, now=now)
    assert (dry["companies"], dry["applied"]) == (1, False)
    assert db.companies.find_one({"_id": "U62099UP2026PTC300001"})["attrs"].get("registered_email"), "a dry run changes nothing"
    r = run_retention(db, raw, months=12, apply=True, now=now)
    assert (r["companies"], r["raw_removed"], r["people_removed"]) == (1, 1, 1)
    gone = db.companies.find_one({"_id": "U62099UP2026PTC300001"})["attrs"]
    assert "registered_email" not in gone and "registered_office" not in gone and gone["registered_district"]["value"] == "Lucknow"
    kept = db.companies.find_one({"_id": "U62099UP2026PTC300002"})["attrs"]
    assert kept["registered_email"]["value"] == "rahul.verma@gmail.com", "a contacted company keeps its outreach record"
    assert len(list(raw.keys_under("vendor_infyner/"))) == 1
    assert db.audit_log.count_documents({"action": "erasure", "actor": "retention"}) == 2
    assert erase_vendor_raw(raw, "U62099UP2026PTC300002") == 1, "erase-raw after an erasure request"
    assert list(raw.keys_under("vendor_infyner/")) == []


def test_the_exports_hold_no_personal_data(db, tmp_path):
    now = datetime(2026, 11, 26, tzinfo=timezone.utc)
    db.leads.insert_one({"company_id": "U62099UP2026PTC300001", "cohort": "2026-10", "stage": "customer", "holdout": False, "eligible": True,
                         "score": {"fit": 70, "theme": {"name": "SaaS"}}, "shortlist": {"month": "2026-11", "rank": 1}, "needs": {"rules_confirmed": True},
                         "created_at": now, "updated_at": now})
    db.activities.insert_many([
        {"at": now, "type": "paid", "channel": "platform", "company_id": "U62099UP2026PTC300001", "holdout": False, "idem_key": "platform:1",
         "data": {"amount_paise": 499900, "service": "gst", "attribution": {"contacted": True, "days_since_first_touch": 6}}},
        {"at": now, "type": "claimed", "channel": "page", "company_id": "U62099UP2026PTC300001", "holdout": False, "idem_key": "claimed:1",
         "data": {"person_id": "p1", "consents": [{"channel": "voice"}]}},
    ])
    db.messages.insert_one({"idem_key": "msg:U62099UP2026PTC300001:first_touch", "company_id": "U62099UP2026PTC300001", "kind": "first_touch", "channel": "email",
                            "status": "sent", "language": "en", "recipient": {"address": "rahul.verma@gmail.com"},
                            "evidence": {"version": "pack-v1", "hash": "0" * 64, "pack": {}},
                            "draft": {"subject": "s", "body": "Dear Rahul", "drafter": "template"}, "qc": {"passed": True}, "send": {"at": now},
                            "created_at": now, "updated_at": now, "expires_at": now})
    db.inbound.insert_one({"idem_key": "in:mailbox-1:7:5", "mailbox": "mailbox-1", "uid": 5, "uidvalidity": 7, "kind": "reply", "label": "interested",
                           "text": "Call me on 98765 43210", "from": {"address": "rahul.verma@gmail.com"},
                           "matched": {"company_id": "U62099UP2026PTC300001", "how": "in_reply_to"}, "status": "needs_person", "actions": [],
                           "received_at": now, "created_at": now, "updated_at": now, "expires_at": now})
    db.calls.insert_one({"idem_key": "call:U62099UP2026PTC300001:p:1", "company_id": "U62099UP2026PTC300001", "person_id": ObjectId(), "purpose": "callback",
                         "to": "+919876543210", "transcript": [{"role": "user", "text": "I am Rahul"}], "status": "connected", "outcome": "interested",
                         "attempt": 1, "duration_s": 95, "cost_paise": 780, "history": [], "created_at": now, "updated_at": now, "expires_at": now})
    r = export_parquet(db, tmp_path, now=now)
    assert r["tables"]["activities"] == 2 and r["tables"]["messages"] == 1
    every = ""
    for table in TABLES:
        t = pq.read_table(tmp_path / f"{table}.parquet")
        every += json.dumps(t.to_pylist(), default=str)
    for secret in ["rahul.verma@gmail.com", "98765", "+919876543210", "Dear Rahul", "I am Rahul", "p1"]:
        assert secret not in every, secret
    paid = [row for row in pq.read_table(tmp_path / "activities.parquet").to_pylist() if row["type"] == "paid"][0]
    assert (paid["amount_paise"], paid["contacted_before"], paid["days_since_first_touch"]) == (499900, True, 6)

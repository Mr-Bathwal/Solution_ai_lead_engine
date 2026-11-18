"""The need engine: calendar dates, scheme verdicts, the fit score, holdout and the shortlist."""
from datetime import date, datetime, timezone

from leadengine.need import deadlines, fit, leads, schemes
from leadengine.need.classify import classify


# ---- deadlines --------------------------------------------------------------------------------

def _by_id(items):
    return {d.id: d for d in items}


def test_design_example_food_company_incorporated_14_october():
    """Design section 6: a private limited company incorporated in Lucknow on 14 October."""
    cal = _by_id(deadlines.calendar_for("company", "PTC", date(2026, 10, 14), as_of=date(2026, 10, 20)))
    assert cal["first_board_meeting"].due == date(2026, 11, 13)
    assert cal["first_auditor"].due == date(2026, 11, 13)
    assert cal["share_certificates"].due == date(2026, 12, 14), "two calendar months"
    assert cal["inc_20a"].due == date(2027, 4, 12)
    assert cal["first_agm"].due == date(2027, 12, 31), "nine months after the first FY ends on 31 March 2027"
    assert cal["aoc_4"].due == date(2028, 1, 30) and cal["annual_return"].due == date(2028, 2, 29)
    assert cal["income_tax_return_company"].due == date(2027, 10, 31)
    assert cal["first_board_meeting"].status == "due_soon" and cal["first_board_meeting"].days_left == 24
    assert cal["inc_20a"].status == "upcoming"
    assert cal["director_kyc"].status == "advisory" and cal["gst_registration"].status == "conditional"
    assert "s.10A" in cal["inc_20a"].law and "₹50,000" in cal["inc_20a"].penalty


def test_company_incorporated_in_february_has_a_long_first_year_but_a_short_tax_year():
    cal = _by_id(deadlines.calendar_for("company", "PTC", date(2026, 2, 10), as_of=date(2026, 10, 26)))
    assert cal["first_agm"].due == date(2027, 12, 31), "s.2(41): first FY runs to 31 March 2027"
    # first tax year ends 31 March 2026: 31 October 2026 by statute, extended by the CBDT to 21 November 2026,
    # and that year is still governed by the Income-tax Act 1961
    itr = cal["income_tax_return_company"]
    assert itr.due == date(2026, 11, 21) and itr.extended_by == "cbdt_2026_09_28_audit_case_itr"
    assert "Income-tax Act 1961" in itr.law and "s.234F" in itr.penalty
    assert cal["inc_20a"].status == "was_due", "past dates are shown as 'was due', never as missed"


def test_opc_has_no_agm_and_files_on_its_own_dates():
    cal = _by_id(deadlines.calendar_for("company", "OPC", date(2026, 9, 1), as_of=date(2026, 9, 2)))
    assert "first_agm" not in cal and cal["aoc_4_opc"].due == date(2027, 9, 27)
    assert cal["annual_return_opc"].due == date(2027, 11, 29)
    assert "only one director" in cal["first_board_meeting"].note


def test_llp_calendar():
    cal = _by_id(deadlines.calendar_for("llp", None, date(2026, 6, 10), as_of=date(2026, 6, 11)))
    assert cal["llp_agreement"].due == date(2026, 7, 10)
    assert cal["llp_form_11"].due == date(2027, 5, 30) and cal["llp_form_8"].due == date(2027, 10, 30)
    late = _by_id(deadlines.calendar_for("llp", None, date(2026, 11, 5), as_of=date(2026, 11, 6)))
    assert "a year later" in late["llp_form_11"].note


def test_add_months_clamps_to_the_month_end():
    assert deadlines.add_months(date(2026, 12, 31), 2) == date(2027, 2, 28)
    assert deadlines.add_months(date(2027, 12, 31), 2) == date(2028, 2, 29)


# ---- schemes ----------------------------------------------------------------------------------

def _facts(**kw):
    base = dict(kind="company", type_code="PTC", incorporated=date(2026, 9, 1), as_of=date(2026, 10, 26))
    return schemes.Facts(**(base | kw))


def _verdicts(f):
    return {v["scheme_id"]: v for v in schemes.evaluate(f)}


def test_unknown_facts_never_make_a_company_ineligible():
    v = _verdicts(_facts(stage=None))
    assert v["dpiit_recognition"]["verdict"] == "check_required" and "turnover in each year" in v["dpiit_recognition"]["missing"]
    assert v["up_sustenance_allowance"]["verdict"] == "check_required"
    assert v["sisfs"]["verdict"] == "check_required", "no official notice says the seed fund is closed"
    assert all(x["by"] == "provisional_rules" for x in v.values())


def test_scheme_rules_fail_on_facts_we_hold():
    old = _verdicts(_facts(incorporated=date(2012, 1, 1)))
    assert old["dpiit_recognition"]["verdict"] == "check_required" and "deep-tech" in old["dpiit_recognition"]["reason"]
    assert old["startup_tax_holiday"]["verdict"] == "not_eligible"
    public = _verdicts(_facts(type_code="PLC"))
    assert public["dpiit_recognition"]["verdict"] == "not_eligible"
    scaling = _verdicts(_facts(stage="Scaling", startinup_listed=True))
    # the portal's stage is self-declared and may be stale, so a later stage asks for a check, not a refusal
    assert scaling["up_sustenance_allowance"]["verdict"] == "check_required" and "(Scaling)" in scaling["up_sustenance_allowance"]["reason"]
    assert scaling["up_startup_recognition"]["verdict"] == "held"
    assert _verdicts(_facts(as_of=date(2027, 8, 1)))["pm_vbry_employer"]["verdict"] == "closed"


def test_platform_verdicts_are_used_when_connected_and_fall_back_when_not():
    class Down:
        def verdicts(self, f):
            import requests
            raise requests.ConnectionError("down")

    class Up:
        def verdicts(self, f):
            assert f.public()["state"] == "UP" and "district" in f.public()
            return [{"scheme_id": "x", "verdict": "eligible", "by": "platform_rules_engine"}]

    assert schemes.verdicts_for(_facts(), client=Down())[1] == "provisional_rules"
    assert schemes.verdicts_for(_facts(), client=Up())[1] == "platform_rules_engine"


# ---- fit ------------------------------------------------------------------------------------------

def test_fit_is_explained_point_by_point():
    cfg = fit.load_config()
    x = fit.FitInput(type_code="PTC", age_days=20, innovation=80, theme_id="T01", near_deadlines=2,
                     startup_portal=True, incubated=True, has_domain=True)
    total, parts = fit.score(x, cfg)
    assert total == round(80 * 0.35 + 20 + 10 + 10 + 10 + 5)
    assert {p["key"] for p in parts} == {"innovation", "recency", "deadlines", "startup_portal", "incubator", "domain"}
    trader = fit.score(fit.FitInput("NPL", 900, 0, None, 0, False, False, False), cfg)
    assert trader[0] == 0 and any(p["key"] == "type" and p["points"] < 0 for p in trader[1])


def test_classifier_reads_name_and_activity():
    assert classify("ERTA ROBOTICS PRIVATE LIMITED", nic="62099").innovation >= 60
    assert classify("SHREE RAM TRADERS PRIVATE LIMITED", nic="46101").innovation == 0


# ---- leads, holdout and shortlist ----------------------------------------------------------------

def _company(i, cohort="2026-09", nic="62099", name=None):
    cin = f"U{nic}UP2026PTC{100000 + i:06d}"
    inc = f"{cohort}-15"
    now = datetime.now(timezone.utc)
    return {"_id": cin, "kind": "company", "state": "UP", "name": name or f"COMPANY {i} TECHNOLOGIES PRIVATE LIMITED",
            "ids": {"cin": cin}, "cohort": cohort, "sources": ["mca_monthly"], "first_seen_at": now, "updated_at": now,
            "schema_version": 2, "former_names": [],
            "attrs": {"incorporation_date": {"value": inc, "source": "mca_monthly", "seen_at": now},
                      "nic_code": {"value": nic, "source": "mca_monthly", "seen_at": now},
                      "listing": {"value": "unlisted", "source": "mca_monthly", "seen_at": now}}}


def test_holdout_is_stable_random_and_about_ten_percent():
    us = [leads.holdout_u(f"U62099UP2026PTC{i:06d}", "salt") for i in range(5000)]
    share = sum(u < 0.10 for u in us) / len(us)
    assert 0.085 < share < 0.115
    assert leads.holdout_u("X", "salt") == leads.holdout_u("X", "salt") != leads.holdout_u("X", "other")


def test_shortlist_takes_n_non_holdout_and_keeps_holdout_ranks(db):
    db.companies.insert_many([_company(i) for i in range(60)] + [_company(100 + i, cohort="2026-08") for i in range(5)])
    env = {"HOLDOUT_SALT": "test-salt"}
    one_theme = fit.load_config() | {"shortlist_theme_cap_pct": None}    # every company here has the same theme
    r = leads.run(db, month="2026-10", cohorts=["2026-09"], as_of=date(2026, 10, 1), shortlist_size=20,
                  holdout_pct=30, cfg=one_theme, env=env, log=lambda m: None)
    assert r["shortlisted"] == 20 and "warning" not in r
    short = list(db.leads.find({"shortlist.month": "2026-10"}).sort("shortlist.rank", 1))
    assert [l["shortlist"]["rank"] for l in short] == list(range(1, len(short) + 1))
    assert sum(not l["holdout"] for l in short) == 20 and all(l["stage"] == "discovered" for l in short if l["holdout"])
    assert all(l["cohort"] == "2026-09" for l in short), "only the month's cohorts"
    assert all(l["next_action"]["type"] == "none" for l in short if l["holdout"])
    # a re-run keeps the shortlist and every holdout draw, even with a different salt
    before = {l["company_id"]: (l["holdout"], l["shortlist"]["rank"]) for l in short}
    leads.run(db, month="2026-10", cohorts=["2026-09"], as_of=date(2026, 10, 2), shortlist_size=20,
              holdout_pct=30, cfg=one_theme, env={"HOLDOUT_SALT": "another"}, log=lambda m: None)
    after = {l["company_id"]: (l["holdout"], l["shortlist"]["rank"]) for l in db.leads.find({"shortlist.month": "2026-10"})}
    assert after == before


def test_stages_never_move_backwards(db):
    db.companies.insert_one(_company(1))
    leads.run(db, month="2026-10", as_of=date(2026, 10, 1), env={"HOLDOUT_SALT": "s"}, log=lambda m: None)
    db.leads.update_one({}, {"$set": {"stage": "engaged"}})
    leads.run(db, month="2026-11", cohorts=["2026-07"], as_of=date(2026, 11, 1), env={"HOLDOUT_SALT": "s"}, log=lambda m: None)
    assert db.leads.find_one()["stage"] == "engaged"


def test_unconfirmed_rules_block_outreach(db):
    db.companies.insert_one(_company(1))
    leads.run(db, month="2026-10", as_of=date(2026, 10, 1), env={"HOLDOUT_SALT": "s"}, log=lambda m: None)
    lead = db.leads.find_one()
    assert lead["needs"]["rules_confirmed"] is False
    assert lead["holdout"] or lead["next_action"]["type"] == "confirm_rules"


def test_ineligible_companies_are_never_shortlisted(db):
    gov = _company(2)
    gov["_id"] = gov["ids"]["cin"] = "U62099UP2026SGC100002"
    db.companies.insert_many([gov, _company(3)])
    leads.run(db, month="2026-10", as_of=date(2026, 10, 1), env={"HOLDOUT_SALT": "s"}, log=lambda m: None)
    g = db.leads.find_one({"company_id": "U62099UP2026SGC100002"})
    assert g["eligible"] is False and "shortlist" not in g and g["stage"] == "discovered"
    assert "company type SGC" in g["eligibility_reasons"][0]


def test_no_shortlist_before_the_cohorts_mca_file_is_loaded(db):
    db.companies.insert_many([_company(i, cohort="2026-10") for i in range(3)])
    r = leads.run(db, month="2026-11", as_of=date(2026, 11, 2), env={"HOLDOUT_SALT": "s"}, require_mca_file=True,
                  log=lambda m: None)
    assert r["cohorts_waiting_for_mca_file"] == ["2026-10"] and r["shortlisted"] == 0
    assert db.leads.count_documents({"shortlist": {"$exists": True}}) == 0
    db.ingest_runs.insert_one({"_id": "mca", "source": "mca_monthly", "status": "ok", "started_at": datetime.now(timezone.utc),
                               "notes": ["Incorporation-Report-20261105.xlsx: period 2026-10, generated 2026-11-05 00:20"]})
    r = leads.run(db, month="2026-11", as_of=date(2026, 11, 6), env={"HOLDOUT_SALT": "s"}, require_mca_file=True,
                  log=lambda m: None)
    assert "cohorts_waiting_for_mca_file" not in r and r["shortlisted"] >= 2

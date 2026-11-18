"""The October 2026 review of the need engine: date arithmetic, the legal corrections, the three-valued
rules language, the fit score's timing component and the shortlist's safeguards. Expected values are the
legal answer, with the source in config/rules/*.json."""
from collections import Counter
from datetime import date, datetime, timedelta, timezone

import pytest

from leadengine.need import deadlines, fit, leads, schemes
from leadengine.util import IST

D = date


def cal(kind, tc, inc, as_of=None):
    return {d.id: d for d in deadlines.calendar_for(kind, tc, inc, as_of or inc)}


# ---- date arithmetic: corresponding date, clamped to the month end; "from" excludes the first day ----

@pytest.mark.parametrize("d,m,exp", [
    (D(2026, 1, 31), 1, D(2026, 2, 28)), (D(2028, 1, 31), 1, D(2028, 2, 29)), (D(2026, 8, 31), 6, D(2027, 2, 28)),
    (D(2026, 3, 31), 9, D(2026, 12, 31)), (D(2026, 3, 31), 6, D(2026, 9, 30)), (D(2026, 12, 30), 2, D(2027, 2, 28)),
    (D(2026, 11, 30), 3, D(2027, 2, 28)), (D(2028, 2, 29), 12, D(2029, 2, 28)), (D(2026, 3, 15), -3, D(2025, 12, 15)),
])
def test_add_months(d, m, exp):
    assert deadlines.add_months(d, m) == exp


def test_day_counts_exclude_the_day_of_incorporation():
    assert cal("company", "PTC", D(2026, 1, 1))["first_board_meeting"].due == D(2026, 1, 31)
    c = cal("company", "PTC", D(2027, 9, 1))
    assert c["inc_20a"].due == D(2028, 2, 28), "180 days across a leap February"
    assert c["share_certificates"].due == D(2027, 11, 1)


def test_share_certificates_at_the_month_end():
    assert cal("company", "PTC", D(2026, 12, 31))["share_certificates"].due == D(2027, 2, 28)
    assert cal("company", "PTC", D(2027, 12, 31))["share_certificates"].due == D(2028, 2, 29)


def test_first_financial_year_and_first_tax_year():
    c = cal("company", "PTC", D(2026, 3, 31))
    assert c["first_agm"].due == D(2027, 12, 31), "s.2(41): incorporated on or after 1 January"
    assert c["dpt_3"].due == D(2026, 6, 30)
    c = cal("company", "PTC", D(2026, 4, 1))
    assert c["income_tax_return_company"].due == D(2027, 10, 31) and c["first_agm"].due == D(2027, 12, 31)
    assert "Income-tax Act 2025" in c["income_tax_return_company"].law, "tax year 2026-27 is under the 2025 Act"
    assert c["income_tax_return_company"].extended_by is None


def test_annual_return_across_a_leap_year():
    assert cal("company", "PTC", D(2026, 5, 1))["annual_return"].due == D(2028, 2, 29)
    assert cal("company", "PTC", D(2025, 5, 1))["annual_return"].due == D(2027, 3, 1)


def test_status_boundaries():
    assert cal("company", "PTC", D(2026, 10, 1), as_of=D(2026, 10, 31))["first_board_meeting"].status == "due_soon"
    assert cal("company", "PTC", D(2026, 10, 1), as_of=D(2026, 11, 1))["first_board_meeting"].status == "was_due"


# ---- legal corrections -------------------------------------------------------------------------

def test_llp_return_is_due_31_august_when_no_audit_is_needed():
    itr = cal("llp", None, D(2026, 6, 10))["income_tax_return_llp"]
    assert itr.due == D(2027, 8, 31) and "31 October" in itr.note and "Finance Act 2026" in itr.law
    early = cal("llp", None, D(2026, 2, 10))["income_tax_return_llp"]
    assert early.due == D(2026, 8, 31) and "Income-tax Act 1961" in early.law
    assert "21 November 2026" in early.note, "the audit-case extension is noted, the non-audit date kept"


def test_company_return_for_tax_year_2025_26_carries_the_cbdt_extension():
    itr = cal("company", "OPC", D(2026, 1, 5))["income_tax_return_company"]
    assert itr.due == D(2026, 11, 21) and itr.extended_by and "CBDT" in itr.note
    assert itr.source_url == "https://www.indiabudget.gov.in/doc/memo.pdf"


def test_overrides_apply_only_to_the_year_they_name():
    rules = deadlines.load_rules()
    for o in rules["overrides"]:
        assert o["source_url"].startswith("https://") and o["verified_on"]
    assert cal("company", "PTC", D(2025, 6, 1))["income_tax_return_company"].due == D(2026, 11, 21), "same tax year"
    other = cal("company", "PTC", D(2024, 6, 1))["income_tax_return_company"]
    assert other.due == D(2025, 10, 31) and other.extended_by is None, "the override names tax year 2025-26 only"


def test_llp_registered_from_january_to_march_carries_a_note():
    c = cal("llp", None, D(2026, 2, 15))
    assert c["llp_form_11"].due == D(2026, 5, 30) and "CA should confirm" in c["llp_form_11"].note
    assert "s.76A(1)" in c["llp_form_8"].penalty and "76A(3)" not in c["llp_form_8"].penalty
    assert "within 30 days" in c["llp_form_11"].penalty


def test_conditional_rules_keep_their_date_but_are_never_firm():
    c = deadlines.calendar_for("company", "PTC", D(2026, 4, 10), D(2027, 6, 1))
    dpt3 = next(d for d in c if d.id == "dpt_3")
    assert dpt3.due == D(2027, 6, 30) and dpt3.status == "conditional"
    assert deadlines.next_deadline(c).id != "dpt_3"
    assert deadlines.timing(c, 45, 60) == (0, 0), "nothing firm falls around June 2027 except DPT-3"


def test_opc_note_and_auditor_for_five_years():
    c = cal("company", "OPC", D(2026, 6, 1))
    assert "s.122(5)" in c["first_board_meeting"].note and "only one director" in c["first_board_meeting"].note
    assert c["adt_1_opc"].status == "conditional" and "15 days" in c["adt_1_opc"].note
    assert "adt_1" not in c and "first_agm" not in c


def test_public_and_section_8_companies_get_their_calendar():
    plc = cal("company", "PLC", D(2026, 9, 10))
    assert {"first_board_meeting", "first_auditor", "inc_20a", "first_agm", "aoc_4", "annual_return"} <= set(plc)
    assert plc["annual_return"].form == "MGT-7" and plc["inc_20a"].status != "conditional"
    assert "demat" in plc["share_certificates"].form
    npl = cal("company", "NPL", D(2026, 9, 10))
    assert npl["inc_20a"].status == npl["share_certificates"].status == "conditional", "only with a share capital"
    assert npl["first_board_meeting"].status == "conditional" and "466(E)" in npl["first_board_meeting"].note
    assert npl["annual_return"].form == "MGT-7" and npl["first_auditor"].status != "conditional"


def test_gst_text_leaves_the_e_commerce_case_to_the_ca():
    note = cal("company", "PTC", D(2026, 9, 10))["gst_registration"].note
    assert "CA must confirm" in note and "pan masala" in note


def test_every_rule_says_when_it_was_checked():
    rules = deadlines.load_rules()
    assert rules["confirmed_by"] is None, "nothing is confirmed until the CA signs"
    for r in rules["rules"]:
        assert "verified_on" in r, r["id"]
        if r.get("changed_on"):
            assert r.get("change_note"), r["id"]


# ---- scheme verdicts --------------------------------------------------------------------------

def facts(**kw):
    base = dict(kind="company", type_code="PTC", incorporated=D(2026, 9, 1), as_of=D(2026, 10, 27))
    return schemes.Facts(**(base | kw))


def verdicts(f, rules=None):
    return {v["scheme_id"]: v for v in schemes.evaluate(f, rules)}


@pytest.mark.parametrize("stage", ["validation", "Validation", "prototype", "IDEATION"])
def test_sustenance_allowance_stages_up_to_the_prototype_are_never_refused(stage):
    v = verdicts(facts(stage=stage, startinup_listed=True))["up_sustenance_allowance"]
    assert v["verdict"] == "check_required" and "later stage" not in v["reason"]


def test_sustenance_allowance_later_stage_asks_for_a_check():
    v = verdicts(facts(stage="Early Traction"))["up_sustenance_allowance"]
    assert v["verdict"] == "check_required" and "(Early Traction)" in v["reason"] and "current stage" in v["missing"]


@pytest.mark.parametrize("tc", ["FTC", "NPL", "SGC"])
def test_entity_forms_the_cin_cannot_settle_are_check_required(tc):
    v = verdicts(facts(type_code=tc))
    assert v["dpiit_recognition"]["verdict"] == "check_required" and "entity form" in v["dpiit_recognition"]["missing"]
    assert v["startup_tax_holiday"]["verdict"] == "check_required"


def test_public_companies_and_old_companies_are_refused_on_facts():
    v = verdicts(facts(type_code="PLC"))
    assert v["dpiit_recognition"]["verdict"] == v["startup_tax_holiday"]["verdict"] == "not_eligible"
    assert "Inter-Ministerial Board" in v["startup_tax_holiday"]["reason"]
    assert verdicts(facts(type_code="NPL", incorporated=D(2012, 1, 1)))["startup_tax_holiday"]["verdict"] == "not_eligible"


def test_seed_fund_is_check_required_unless_the_company_is_too_old():
    assert verdicts(facts())["sisfs"]["verdict"] == "check_required"
    old = verdicts(facts(incorporated=D(2023, 9, 1)))["sisfs"]
    assert old["verdict"] == "not_eligible" and "two years" in old["reason"]


def test_closed_verdicts_expire():
    assert verdicts(facts(as_of=D(2027, 10, 31)))["pm_vbry_employer"]["verdict"] == "closed"
    late = verdicts(facts(as_of=D(2027, 11, 1)))["pm_vbry_employer"]
    assert late["verdict"] == "check_required" and "checked again" in late["reason"]
    undated = {"version": "t", "schemes": [{"id": "x", "name": "x", "level": "x", "benefit": "x", "law": "x",
                                            "source_url": "x", "rules": [],
                                            "default": {"verdict": "closed", "reason": "no call"}}]}
    assert verdicts(facts(), undated)["x"]["verdict"] == "check_required", "a closed verdict needs valid_until"


def test_three_valued_logic():
    f = facts(incorporated=None, stage=None)
    assert schemes._holds({"not": {"incorporated_before": "2016-04-01"}}, f) is None
    assert schemes._holds({"all": [{"as_of_after": "2030-01-01"}, {"age_years_over": 1}]}, f) is False
    assert schemes._holds({"all": [{"as_of_after": "2020-01-01"}, {"age_years_over": 1}]}, f) is None
    assert schemes._holds({"any": [{"as_of_after": "2020-01-01"}, {"age_years_over": 1}]}, f) is True
    assert schemes._holds({"not": {"fact": "startinup_listed", "is": True}}, facts()) is None, "not seen is not 'No'"
    rules = {"version": "t", "schemes": [{"id": "x", "name": "x", "level": "x", "benefit": "x", "law": "x",
                                          "source_url": "x", "default": {"verdict": "check_required", "reason": "d"},
                                          "rules": [{"if": {"not": {"fact": "startinup_listed", "is": True}},
                                                     "verdict": "not_eligible", "reason": "r"}]}]}
    assert verdicts(facts(), rules)["x"]["verdict"] == "check_required"
    assert verdicts(facts(startinup_listed=False), rules)["x"]["verdict"] == "not_eligible"


# ---- fit -----------------------------------------------------------------------------------------

def _company(cin, inc, name="NOVA TECHNOLOGIES PRIVATE LIMITED", nic="62099", **attrs):
    now = datetime.now(timezone.utc)
    a = {"incorporation_date": {"value": inc, "source": "mca_monthly", "seen_at": now},
         "nic_code": {"value": nic, "source": "mca_monthly", "seen_at": now},
         "listing": {"value": "unlisted", "source": "mca_monthly", "seen_at": now}}
    a |= {k: {"value": v, "source": "startinup", "seen_at": now} for k, v in attrs.items()}
    return {"_id": cin, "kind": "company", "state": "UP", "name": name, "ids": {"cin": cin}, "cohort": inc[:7],
            "sources": ["mca_monthly"], "first_seen_at": now, "updated_at": now, "schema_version": 2,
            "former_names": [], "attrs": a}


def _assess(c, as_of):
    return leads.assess(c, as_of, fit.load_config(), deadlines.load_rules(), schemes.load_rules())


def _deadline_points(a):
    return next((p["points"] for p in a["score"]["components"] if p["key"] == "deadlines"), 0)


@pytest.mark.parametrize("as_of", [D(2026, 10, 3), D(2026, 10, 6), D(2026, 10, 27)])
def test_early_and_late_incorporations_in_a_cohort_get_the_same_deadline_points(as_of):
    """Whichever day of the following month the shortlist is made (the MCA file lands on the 1st-5th)."""
    early = _assess(_company("U62099UP2026PTC300001", "2026-09-02"), as_of)
    late = _assess(_company("U62099UP2026PTC300002", "2026-09-29"), as_of)
    assert _deadline_points(early) == _deadline_points(late) == 10
    assert early["score"]["fit"] == late["score"]["fit"]
    assert "in the last 60 days" in next(p["reason"] for p in early["score"]["components"] if p["key"] == "deadlines")


def test_one_due_date_counts_once():
    # on the day of incorporation only the 30-day date (board meeting and first auditor) is within 60 days
    a = _assess(_company("U62099UP2026PTC300003", "2026-10-01"), D(2026, 10, 1))
    assert _deadline_points(a) == 5, "board meeting and first auditor fall on one day: one event"


def test_portal_facts_we_do_not_hold_are_unknown(monkeypatch):
    seen = {}

    def capture(f, client=None, rules=None):
        seen["f"] = f
        return schemes.evaluate(f, rules), "provisional_rules"

    monkeypatch.setattr(schemes, "verdicts_for", capture)
    _assess(_company("U62099UP2026PTC300004", "2026-09-10"), D(2026, 10, 27))
    assert seen["f"].startinup_listed is None and seen["f"].incubated is None and seen["f"].women_led is None
    _assess(_company("U62099UP2026PTC300005", "2026-09-10", startinup_listed=True, incubators=["AIC"]), D(2026, 10, 27))
    assert seen["f"].startinup_listed is True and seen["f"].incubated is True


# ---- holdout salt, tie-break, shortlist audit fields, next action ---------------------------------------

def test_holdout_salt_refuses_to_run_without_a_salt():
    with pytest.raises(RuntimeError):
        leads.holdout_salt({})
    with pytest.raises(RuntimeError):
        leads.holdout_salt({"HOLDOUT_SALT": leads.DEV_SALT})
    assert leads.holdout_salt({"LEADENGINE_ENV": "development"})[2] is True
    assert leads.holdout_salt({"HOLDOUT_SALT": "prod-secret"})[0] == "prod-secret"


def test_run_writes_nothing_without_a_salt(db):
    db.companies.insert_one(_company("U62099UP2026PTC300006", "2026-09-10"))
    with pytest.raises(RuntimeError):
        leads.run(db, month="2026-10", env={}, log=lambda m: None)
    assert db.leads.count_documents({}) == 0


def test_tiebreak_is_keyed_and_independent_of_the_holdout_draw():
    assert leads.tiebreak_u("X", "s") == leads.tiebreak_u("X", "s") != leads.tiebreak_u("X", "t")
    assert leads.tiebreak_u("X", "s") != leads.holdout_u("X", "s")


def test_equal_scores_are_ordered_by_the_keyed_hash(db):
    cos = [_company(f"U62099UP2026PTC{400000 + i:06d}", "2026-09-15", name="SAME TECHNOLOGIES PRIVATE LIMITED")
           for i in range(30)]
    db.companies.insert_many(cos)
    no_cap = fit.load_config() | {"shortlist_theme_cap_pct": None}    # 30 companies of one theme
    leads.run(db, month="2026-10", cohorts=["2026-09"], as_of=D(2026, 10, 3), shortlist_size=10, holdout_pct=0,
              cfg=no_cap, env={"HOLDOUT_SALT": "tie"}, log=lambda m: None)
    short = [l["company_id"] for l in db.leads.find({"shortlist.month": "2026-10"}).sort("shortlist.rank", 1)]
    expected = sorted((c["_id"] for c in cos), key=lambda cid: leads.tiebreak_u(cid, "tie"))[:10]
    assert short == expected


def test_new_shortlist_entries_record_day_and_fit_and_kept_ones_do_not_change(db):
    db.companies.insert_many([_company(f"U62099UP2026PTC{500000 + i:06d}", "2026-09-15") for i in range(5)])
    env = {"HOLDOUT_SALT": "audit"}
    leads.run(db, month="2026-10", cohorts=["2026-09"], as_of=D(2026, 10, 3), shortlist_size=50, holdout_pct=0,
              env=env, log=lambda m: None)
    first = {l["company_id"]: l["shortlist"] for l in db.leads.find({"shortlist.month": "2026-10"})}
    assert all(s["as_of"] == "2026-10-03" and s["fit"] > 0 for s in first.values())
    db.companies.insert_one(_company("U62099UP2026PTC500099", "2026-09-20"))
    leads.run(db, month="2026-10", cohorts=["2026-09"], as_of=D(2026, 10, 8), shortlist_size=50, holdout_pct=0,
              env=env, log=lambda m: None)
    again = {l["company_id"]: l["shortlist"] for l in db.leads.find({"shortlist.month": "2026-10"})}
    assert {k: again[k] for k in first} == first
    assert again["U62099UP2026PTC500099"]["as_of"] == "2026-10-08" and again["U62099UP2026PTC500099"]["rank"] == 6


def test_an_earlier_months_shortlist_has_no_next_action_this_month(db):
    db.companies.insert_one(_company("U62099UP2026PTC600001", "2026-09-15"))
    env = {"HOLDOUT_SALT": "next"}
    leads.run(db, month="2026-10", as_of=D(2026, 10, 3), holdout_pct=0, env=env, log=lambda m: None)
    assert db.leads.find_one()["next_action"]["type"] == "confirm_rules"
    leads.run(db, month="2026-11", as_of=D(2026, 11, 3), holdout_pct=0, env=env, log=lambda m: None)
    lead = db.leads.find_one()
    assert lead["stage"] == "shortlisted" and lead["next_action"]["type"] == "none" and "2026-10" in lead["next_action"]["why"]


def test_default_as_of_is_the_ist_day(db):
    before = datetime.now(IST).date()
    out = leads.run(db, month="2026-10", env={"HOLDOUT_SALT": "ist"}, log=lambda m: None)
    assert out["as_of"] in {before.isoformat(), (before + timedelta(days=1)).isoformat()}


def test_a_lead_whose_company_is_gone_is_kept_but_never_contacted(db):
    db.companies.insert_many([_company("U62099UP2026PTC700001", "2026-09-15"),
                              _company("U62099UP2026PTC700002", "2026-09-16")])
    env = {"HOLDOUT_SALT": "gone"}
    leads.run(db, month="2026-10", cohorts=["2026-09"], as_of=D(2026, 10, 3), holdout_pct=0, env=env, log=lambda m: None)
    db.companies.delete_one({"_id": "U62099UP2026PTC700002"})
    out = leads.run(db, month="2026-10", cohorts=["2026-09"], as_of=D(2026, 10, 4), holdout_pct=0, env=env,
                    log=lambda m: None)
    gone = db.leads.find_one({"company_id": "U62099UP2026PTC700002"})
    assert out["company_gone"] == 1 and out["leads_written"] == 1
    assert gone["eligible"] is False and gone["eligibility_reasons"] == [leads.NO_COMPANY]
    assert gone["next_action"]["type"] == "none" and gone["holdout_draw"]       # history is kept
    again = leads.run(db, month="2026-10", cohorts=["2026-09"], as_of=D(2026, 10, 5), holdout_pct=0, env=env,
                      log=lambda m: None)
    assert again["company_gone"] == 1 and db.leads.count_documents({}) == 2



def test_no_sector_theme_takes_more_than_its_cap_of_the_shortlist(db):
    tech = [_company(f"U62099UP2026PTC{800000 + i:06d}", "2026-09-15") for i in range(10)]
    food = [_company(f"U10799UP2026PTC{810000 + i:06d}", "2026-09-15", name=f"ANNAPURNA FOODS {i} PRIVATE LIMITED",
                     nic="10799") for i in range(10)]
    pharma = [_company(f"U21002UP2026PTC{820000 + i:06d}", "2026-09-15", name=f"SANJEEVANI PHARMA {i} PRIVATE LIMITED",
                       nic="21002") for i in range(10)]
    db.companies.insert_many(tech + food + pharma)
    cfg = fit.load_config() | {"shortlist_theme_cap_pct": 40}
    out = leads.run(db, month="2026-10", cohorts=["2026-09"], as_of=D(2026, 10, 3), shortlist_size=10, holdout_pct=0,
                    cfg=cfg, env={"HOLDOUT_SALT": "cap"}, log=lambda m: None)
    short = list(db.leads.find({"shortlist.month": "2026-10"}))
    themes = Counter(l["score"]["theme"]["id"] for l in short)
    assert len(short) == 10 and out["skipped_theme_cap"] > 0
    assert len(themes) == 3 and max(themes.values()) == 4     # the tech names alone would have taken all ten
    assert all(l["shortlist"]["theme_cap_pct"] == 40 for l in short)

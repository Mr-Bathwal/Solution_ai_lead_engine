"""The knowledge base's matching rules after the review of 27 Oct 2026: generic words count, one fact
is counted once, the year gate, labels, precision after a rebuild, the self-tests, reviews, one
company per startup, LLPs that lose their link, stale links and provenance."""
import csv
from datetime import datetime, timezone

import pytest

from leadengine.kb import apply, build, labels, llp, match
from leadengine.kb.entities import Startup, load_startups
from leadengine.names import near_generic, normalize_name, typo_of
from leadengine.pipeline import run_source
from leadengine.sink import MongoSink
from leadengine.sources import upsm
from leadengine.sources.mca import McaMonthlySource
from test_kb import COMPANIES, LLPS, ListSource, _link, _sui
from test_mca import make_report


def C(cid, name, inc="2026-06-10", kind="company", nic=None):
    return match.company_from(cid, name, kind, inc, nic)


def S(name, *, key="S", year=2026, since="2026-08-01", entity_type="Private Limited", **kw):
    return Startup(key=key, names=[name], entity_type=entity_type, year=year, since=since, **kw)


def splink(cid, p, w):
    return match.Candidate(cid, p, "splink", {}, weight=w)


# ---- names ----------------------------------------------------------------------------------------

@pytest.mark.parametrize("name, clean, form", [
    ("ABC Pvt-Ltd", "abc", "pvt ltd"),
    ("ABC (Pvt) Ltd", "abc", "pvt ltd"),                       # was read as a public "ltd"
    ("ABC P Ltd", "abc", "pvt ltd"),
    ("MOPPO FACILITY(OPC) PRIVATE LIMITED", "moppo facility", "opc pvt ltd"),   # real MCA spelling
    ("ABC Private Limited OPC", "abc", "opc pvt ltd"),
    ("ABC One Person Company Private Limited", "abc", "opc pvt ltd"),
    ("ANUMAN SOFTECH PRIVATE LIMITED i", "anuman softech", "pvt ltd"),         # stray token after the form
    ("Nautomation Pvt Ltd-1464", "nautomation", "pvt ltd"),
    ("Getinroadz innovations private limited (FarmLokal)", "getinroadz innovations", "pvt ltd"),
    ("CULTRE (CULTECH WAVE PRIVATE LIMITED)", "cultech wave", "pvt ltd"),      # brand, then the registered name
    ("ABC LLP (formerly ABC Pvt Ltd)", "abc", "llp"),
    ("M/s.ABC Pvt Ltd", "abc", "pvt ltd"),
    ("SafepikPrivate Limited", "safepik", "pvt ltd"),
    ("QUALIFIED RESOURCES PVT.TD", "qualified resources", "pvt ltd"),
    ("The Mitti Tech Private Limited", "mitti tech", "pvt ltd"),               # MCA: "The X" is "X"
    ("Grow brothers Farmer producer company limited", "grow brothers farmer producer company", "ltd"),
])
def test_legal_forms_read_whatever_the_punctuation(name, clean, form):
    k = normalize_name(name)
    assert (k.clean, k.legal_form) == (clean, form)


def test_mca_identity_folds_only_what_mca_ignores():
    assert normalize_name("KAIROS AI TECHNOLOGIES PRIVATE LIMITED").ident == normalize_name("KAIROSAI TECHNOLOGY PVT LTD").ident
    assert normalize_name("Vezras Techologies Pvt Ltd").ident == normalize_name("VEZRAS TECHNOLOGIES PRIVATE LIMITED").ident
    # MCA registered both FLIPTOSOLAR and FLIPTOSOLAR INDIA, so "India" is not ignored
    assert normalize_name("FLIPTOSOLAR PRIVATE LIMITED").ident != normalize_name("FLIPTOSOLAR INDIA PRIVATE LIMITED").ident


def test_generic_slips_and_distinctive_typos():
    assert near_generic("techologies") == "technologies" and near_generic("inovations") == "innovations"
    assert near_generic("centure") is None, "first letter differs: not 'venture'"
    assert near_generic("nanovations") is None, "two edits from 'innovations', not one"
    assert typo_of("moors", "motors") and typo_of("yagnawealthh", "yagnawealth")
    assert not typo_of("fgev", "fiev"), "four letters is too short to call a slip"
    assert not typo_of("matrix", "datrix"), "first letter differs"
    assert not typo_of("kavachx", "kavach"), "a letter added as a suffix is how brands are made"


def test_generic_words_count_when_names_are_compared():
    pravaron = C("U62099UP2026PTC000001", "PRAVARON TECHNOLOGIES PRIVATE LIMITED")
    assert match.name_agreement(S("Pravaron Holdings Pvt Ltd"), pravaron) == "generic_differs"
    assert match.name_agreement(S("Pravaron Technology Pvt Ltd"), pravaron) == "same"          # plural only
    assert match.name_agreement(S("Pravaron Techologies Pvt Ltd"), pravaron) == "same"         # generic slip
    assert match.name_agreement(S("Pravarn Technologies Pvt Ltd"), pravaron) == "typo"
    assert match.name_agreement(S("Ascendo Pvt Ltd"), C("U62099UP2026PTC000002", "ASCENDIO GLOBAL PRIVATE LIMITED")) \
        == "generic_differs"
    assert not match.names_consistent(S("Mitti Tech Pvt Ltd"), C("U62099UP2026PTC000003", "MITTI WORKS PRIVATE LIMITED"))


# ---- decide -----------------------------------------------------------------------------------------

def _index(*companies):
    return match.CompanyIndex(list(companies))


def test_a_sibling_company_is_never_linked_automatically():
    sib = C("U62099UP2026PTC000001", "PRAVARON TECHNOLOGIES PRIVATE LIMITED")
    d = match.decide(S("Pravaron Holdings Pvt Ltd"), _index(sib), [], [splink(sib.id, 0.9999, 30.0)], {})
    assert d.status == "review" and "generic word differs" in d.evidence["why_review"]


def test_the_founders_year_decides_and_the_listing_year_alone_does_not():
    c = C("U62010RJ2026PTC114208", "KUNJAL INDUSTRIES PRIVATE LIMITED", inc="2026-05-12")
    cand = [splink(c.id, 0.9999, 30.0)]
    late = S("Kunjal Industries Pvt Ltd", year=2022, since="2026-07-06")      # listed in 2026, founded 2022
    d = match.decide(late, _index(c), [], cand, {})
    assert d.status == "review" and "year of establishment" in d.evidence["why_review"]
    assert match.decide(S("Kunjal Industries Pvt Ltd", year=2026), _index(c), [], cand, {}).status == "linked"
    # no founder year: a recent listing counts only with a sector or website that fits
    bare = S("Kunjal Industries Pvt Ltd", year=None, since="2026-07-06")
    assert match.decide(bare, _index(c), [], cand, {}).status == "review"
    fits = S("Kunjal Industries Pvt Ltd", year=None, since="2026-07-06", website="https://kunjal.in")
    assert match.decide(fits, _index(c), [], cand, {}).status == "linked"


def test_a_legal_form_that_differs_is_a_reason_to_review():
    c = C("U62099UP2026OPC000004", "ZETAWAVE (OPC) PRIVATE LIMITED")
    d = match.decide(S("Zetawaev Pvt Ltd"), _index(c), [], [splink(c.id, 0.999, 30.0)], {})
    assert d.status == "review" and "legal form" in d.evidence["why_review"]


def test_review_holes_are_closed():
    a = C("U62099UP2026PTC000005", "ORBITAL WAVE PRIVATE LIMITED")
    b = C("U62099UP2026PTC000006", "ORBITAL WAVES PRIVATE LIMITED")
    s = S("Orbital Wave Pvt Ltd")
    both = [splink(a.id, 0.99999, 30.0), splink(b.id, 0.99, 28.0)]
    idx = _index(a, b)
    assert match.decide(s, idx, [], both, {}).status == "review", "two close candidates"
    # (b) rejecting the best does not let the runner-up through: it must beat the rejected one too
    rejected = {a.id: {"decision": "different", "decided_by": "r@x.in"}}
    assert match.decide(s, idx, [], both, rejected).status == "review"
    # (a) "unsure" stops an automatic link on that pair
    unsure = {a.id: {"decision": "unsure", "decided_by": "r@x.in"}}
    assert match.decide(s, idx, [], both[:1], unsure).status == "review"
    # (c) the margin is in bits, not probability: 0.99999 against 0.79 is only 2 bits apart here
    close = [splink(a.id, 0.99999, 25.0), splink(b.id, 0.79, 23.0)]
    assert match.decide(s, idx, [], close, {}).status == "review"
    # (g) a reviewer's link to a company we no longer hold, or to two companies, goes to a person
    gone = {"U62099UP2026PTC999999": {"decision": "same", "decided_by": "r@x.in"}}
    assert match.decide(s, idx, [], both, gone).status == "review"
    two = {a.id: {"decision": "same", "decided_by": "r@x.in"}, b.id: {"decision": "same", "decided_by": "q@x.in"}}
    assert match.decide(s, idx, [], both, two).status == "review"


def test_a_name_with_a_legal_form_outranks_the_dropdown_in_contradictions():
    llp_ = C("ACX-1234", "VALLABHIES DIAGNOSTIC LLP", kind="llp")
    s = S("VALLABHIES DIAGNOSTIC LLP", entity_type="Private Limited")
    assert match.contradictions(s, llp_) == []


def test_a_bare_name_needs_something_that_dates_it():
    c = C("U62099UP2026PTC000007", "SHRAMIK ROJGAR PRIVATE LIMITED", inc="2026-07-08")
    exact = match.exact_candidates(S("Shramik Rojgar", year=None, since=None), _index(c))
    assert exact and not exact[0].evidence["form_in_name"]
    assert match.decide(S("Shramik Rojgar", year=None, since=None), _index(c), exact, [], {}).status == "review"
    dated = S("Shramik Rojgar", year=2026, since="2026-08-21")
    assert match.decide(dated, _index(c), match.exact_candidates(dated, _index(c)), [], {}).status == "linked"


def test_tied_candidates_are_shown_in_the_same_order_on_every_run():
    a = C("U62099UP2026PTC000021", "STAR VEDA LIFESCIENCES PRIVATE LIMITED")
    b = C("U62099UP2026PTC000020", "NEW STAR INDUSTRIES PRIVATE LIMITED")
    s = S("Star Nova Pvt Ltd")
    one = match.decide(s, _index(a, b), [], [splink(a.id, 0.24, -1.6), splink(b.id, 0.24, -1.6)], {})
    two = match.decide(s, _index(a, b), [], [splink(b.id, 0.24, -1.6), splink(a.id, 0.24, -1.6)], {})
    assert one.candidates == two.candidates and one.evidence == two.evidence


def test_one_company_is_one_startup():
    c = C("U62099UP2026PTC000008", "NOVARIS LABS PRIVATE LIMITED")
    ds = {"A": match.Decision("A", "linked", c.id, "exact_name", 1.0),
          "B": match.Decision("B", "linked", c.id, "splink", 0.99, evidence={})}
    assert match.one_to_one(ds, _index(c)) == 1
    assert ds["A"].status == "linked" and ds["B"].status == "review" and ds["B"].evidence["also_claimed_by"] == ["A"]


# ---- the model --------------------------------------------------------------------------------------

def _universe():
    return _index(C("U62099UP2026PTC000011", "VEZRAS TECHNOLOGIES PRIVATE LIMITED", nic="62"),
                  C("U62099UP2026PTC000012", "AGROBRICKS TECHNOLOGIES PRIVATE LIMITED"),
                  C("U62099UP2026PTC000013", "PRAVARON TECHNOLOGIES PRIVATE LIMITED"),
                  C("U62099UP2026PTC000014", "PRAVARON GLOBAL PRIVATE LIMITED"),
                  *[C(f"U62099UP2026PTC1{i:05d}", f"FILLER{chr(97 + i % 26)}{chr(97 + i // 26)} WORKS PRIVATE LIMITED")
                    for i in range(200)])


def test_one_fact_is_counted_once_and_u_is_counted_not_sampled():
    idx = _universe()
    startups = [S("Vezars Technologies Pvt Ltd", key="T1"), S("Pravaron Holdings Pvt Ltd", key="T2")]
    p1 = match.fit(startups, idx, prior=1e-3)
    p2 = match.fit(list(reversed(startups)), idx, prior=1e-3)
    assert p1["u"] == p2["u"], "the same input gives the same model"
    assert len(p1["u"]["name"]) == len(match.NAME_LEVELS) + 1 and abs(sum(p1["u"]["name"]) - 1) < 1e-9
    names = [c["output_column_name"] for c in match.splink_settings(1e-3).get_settings("duckdb").as_dict()["comparisons"]]
    assert names.count("name") == 1 and "rare_token" not in names
    # a transposed letter in the only distinctive word still lands in a block: the deletion keys meet
    assert set(match._deletion_keys("vezars")) & set(match._deletion_keys("vezras"))
    fz, _ = match.splink_candidates(startups, idx, prior=0.2, log=lambda m: None)
    assert fz["T1"][0].company_id == "U62099UP2026PTC000011"


def test_label_training_uses_only_same_pairs_and_the_right_name(db):
    now = datetime.now(timezone.utc)
    docs = [{"_id": f"startup:K{i}|C{i}", "entity_type": "startup", "entity_key": f"K{i}", "company_id": f"U62099UP2026PTC{i:06d}",
             "decision": "same" if i % 2 else "different", "decided_by": "r@x.in", "decided_at": now, "source": "label_set"}
            for i in range(40)]
    db.match_reviews.insert_many(docs)
    got = match.training_labels(db)
    assert got and all(int(x["entity_key"][1:]) % 2 for x in got), "never a 'different' pair"
    assert not any(match.holdout(x["entity_key"]) for x in got), "the held-out fold never trains"
    c = C("U62099UP2026PTC000009", "ORBITAL WAVE PRIVATE LIMITED")
    s = Startup(key="K", names=["Orbit Brand", "Orbital Wave Pvt Ltd"], entity_type="Private Limited")
    assert match.label_rows({"K": s}, _index(c), [{"entity_key": "K", "company_id": c.id}]) == [("K#1", c.id)]
    blended = match._blend([0.5, 0.5], [10, 0])
    assert blended[1] > 0 and abs(sum(blended) - 1) < 1e-9, "an unseen level keeps part of its prior"


# ---- the database side --------------------------------------------------------------------------------

@pytest.fixture
def loaded2(db, raw, tmp_path):
    f = tmp_path / "Incorporation-Report-20261005.xlsx"
    f.write_bytes(make_report(COMPANIES, LLPS))
    sink = MongoSink(db)
    run_source(McaMonthlySource(f), sink=sink, rawstore=raw, log=lambda m: None)
    recs = [_sui("UPLC_00000001", "VEZRAS TECHNOLOGIES PRIVATE LIMITED", website="https://www.vezras.in/"),
            _sui("UPLC_00000004", "SPTIX AI LLP", entity_type="LLP")]
    run_source(ListSource("startinup", recs), sink=sink, rawstore=raw, log=lambda m: None)
    row = {"id": "9", "user_acknowledgement_no": "A/STARTUP/UP/UPLC/00000001", "startup_name": "Vezras",
           "startup_address_district": "Agra", "startup_current_stage": "4", "nature_of_entity": "6", "women_led_startup": "1"}
    run_source(ListSource("upsm", [upsm.record_for(row, "https://api", fetched_at=datetime(2026, 10, 26, tzinfo=timezone.utc))]),
               sink=sink, rawstore=raw, log=lambda m: None)
    return sink


def test_precision_is_measured_on_the_matchers_own_decision_after_a_rebuild(db, raw, loaded2, tmp_path):
    build.build(db, raw, log=lambda m: None, use_splink=False)
    f = tmp_path / "labels.csv"
    with open(f, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, labels.LABEL_FIELDS)
        w.writeheader()
        w.writerow({"entity_key": "UPLC_00000001", "company_id": "U62099UP2026PTC100001", "label": "same"})
    labels.import_labels(db, f, decided_by="labeller@solutionai.in")
    build.build(db, raw, log=lambda m: None, use_splink=False)
    link = _link(db, "UPLC_00000001")
    assert link["method"] == "manual" and link["matcher"]["method"] == "exact_name"
    ev = labels.evaluate_labels(db)
    assert ev["all_labels"]["precision"]["exact_name"] == {"links_judged": 1, "precision": 1.0, "wilson_95": [0.2065, 1.0]}


def test_importing_labels_is_audited_and_never_overwrites_a_reviewer(db, tmp_path):
    now = datetime.now(timezone.utc)
    db.match_reviews.insert_one({"_id": "startup:UPLC_00000001|U62099UP2026PTC100001", "entity_type": "startup",
                                 "entity_key": "UPLC_00000001", "company_id": "U62099UP2026PTC100001", "decision": "different",
                                 "decided_by": "admin@solutionai.in", "decided_at": now, "source": "admin"})
    f = tmp_path / "labels.csv"
    with open(f, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, labels.LABEL_FIELDS)
        w.writeheader()
        w.writerow({"entity_key": "UPLC_00000001", "company_id": "U62099UP2026PTC100001", "label": "same"})
        w.writerow({"entity_key": "UPLC_00000002", "company_id": "U62099UW2026PTC100002", "label": "different"})
    stats = labels.import_labels(db, f, decided_by="labeller@solutionai.in")
    assert stats["conflicts_with_admin"] == 1 and stats["different"] == 1 and stats["same"] == 0
    assert db.match_reviews.find_one({"_id": "startup:UPLC_00000001|U62099UP2026PTC100001"})["decision"] == "different"
    audit = db.audit_log.find_one({"action": "label_import"})
    assert audit["actor"] == "labeller@solutionai.in" and audit["detail"]["file"] == "labels.csv"
    assert audit["detail"]["counts"]["conflicts_with_admin"] == 1


def test_an_llp_is_stored_only_while_a_link_holds_and_its_sheet_is_parsed_once(db, raw, loaded2):
    stats = build.build(db, raw, log=lambda m: None, use_splink=False)
    assert db.companies.find_one({"_id": "ACX-9818"})["state"] == "UP"
    assert db.companies.find_one({"_id": "ACX-0001"}) is None, "an LLP from elsewhere in India is never stored"
    assert stats["llp"]["llp_sheets_parsed"] == 1
    db.match_reviews.insert_one({"_id": "startup:UPLC_00000004|ACX-9818", "entity_type": "startup", "entity_key": "UPLC_00000004",
                                 "company_id": "ACX-9818", "decision": "different", "decided_by": "r@x.in",
                                 "decided_at": datetime.now(timezone.utc), "source": "admin"})
    stats = build.build(db, raw, log=lambda m: None, use_splink=False)
    assert stats["llp"]["llp_sheets_cached"] == 1 and not stats["llp"].get("llp_sheets_parsed")
    assert stats["llp"]["llps_withdrawn"] == 1 and db.companies.find_one({"_id": "ACX-9818"}) is None


def test_stale_links_and_superseded_name_cards_are_dropped(db, raw, loaded2):
    sink = loaded2
    run_source(ListSource("startinup", [_sui("name:vezras-technologies", "VEZRAS TECHNOLOGIES PRIVATE LIMITED")]),
               sink=sink, rawstore=raw, log=lambda m: None)
    assert "name:vezras-technologies" not in load_startups(sink)
    db.entity_links.insert_one({"_id": "startup:UPLC_00009999", "entity_type": "startup", "entity_key": "UPLC_00009999",
                                "company_id": None, "status": "unlinked", "model_version": "x", "updated_at": datetime.now(timezone.utc)})
    stats = build.build(db, raw, log=lambda m: None, use_splink=False)
    assert stats["match"]["stale_links_deleted"] == 1 and _link(db, "UPLC_00009999") is None


def test_portal_facts_name_the_portal_they_came_from(db, raw, loaded2):
    s = load_startups(loaded2)["UPLC_00000001"]
    assert s.district == "Lucknow" and s.field_sources["district"] == "startinup"
    assert s.field_sources["women_led"] == "upsm"
    t = Startup(key="T", names=["X Pvt Ltd"], district="Agra", sources={"startinup": datetime(2026, 10, 1), "upsm": datetime(2026, 10, 7)},
                field_sources={"district": "upsm"})
    assert apply._attrs_for(t)["district"][1:] == ("upsm", datetime(2026, 10, 7))


def test_the_self_tests_score_with_the_nightly_model_and_report_honestly(db, raw, loaded2):
    build.build(db, raw, log=lambda m: None, use_splink=False)
    startups = load_startups(loaded2)
    r = labels.perturbation_eval(db, startups, log=lambda m: None)
    assert r["solved_by_normaliser"] >= 4, "trailing dot, typo in the form, no form and '&' never reach Splink"
    assert r["wrong_links"] == 0
    for kind in labels.CHANGED_NAME_KINDS:
        assert "wrong_link" not in r["by_kind"].get(kind, {}), f"{kind}: a different registered name is never linked"
    index = _index(*list(_universe().by_id.values())[:4])
    loo = labels.leave_one_out_eval(index, params=match.fit([S("Agrobricks Technologies Pvt Ltd")], _universe(), prior=1e-4),
                                    sample=4, folds=4)
    assert loo["cases"] == 4 and loo["cases_with_sibling"] == 2
    assert loo["wrong_links"] == 0, "PRAVARON TECHNOLOGIES is never taken for PRAVARON GLOBAL, nor the other way"

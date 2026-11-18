"""The knowledge base: exact links, the cases that must go to a person, reviews, LLPs and provenance."""
from datetime import datetime, timezone

import pytest

from leadengine.kb import build, match
from leadengine.kb.entities import Startup, load_startups
from leadengine.pipeline import run_source
from leadengine.records import Record
from leadengine.sink import MongoSink
from leadengine.sources.mca import McaMonthlySource
from leadengine.web import company_domain
from test_mca import make_report

COMPANIES = [
    ("U62099UP2026PTC100001", "Private", "VEZRAS TECHNOLOGIES PRIVATE LIMITED", "11-06-2026", "Non-government company", "62"),
    ("U62099UW2026PTC100002", "Private", "AGROBRICKS TECHNOLOGIES PRIVATE LIMITED", "23-06-2026", "Non-government company", "62"),
    ("U85500UP2026PTC100003", "Private", "FRONTIER LABS PRIVATE LIMITED", "11-08-2026", "Non-government company", "85"),
    ("U10799UP2026PTC100004", "Private", "RIVIKA ORGANIC FOODS PRIVATE LIMITED", "10-05-2026", "Non-government company", "10"),
]
LLPS = [("ACX-9818", "SPTIX AI LLP", "08-05-2026", "62"), ("ACX-0001", "SOMEWHERE ELSE LLP", "08-05-2026", "46")]


class ListSource:
    def __init__(self, name, records):
        self.name, self.records = name, records

    def collect(self, ctx):
        yield from self.records


def _sui(uplc, legal_name, **extra):
    payload = {"uplc": uplc, "legal_name": legal_name, "entity_type": "Private Limited", "year_established": "2026",
               "active_since": "2026-09-01", "district": "Lucknow", "profile_parsed": True, **extra}
    return Record("startinup", uplc, payload, "published_by_company",
                  fetched_at=datetime(2026, 10, 26, tzinfo=timezone.utc), personal_fields=("team",))


@pytest.fixture
def loaded(db, raw, tmp_path):
    f = tmp_path / "Incorporation-Report-20261005.xlsx"
    f.write_bytes(make_report(COMPANIES, LLPS))
    sink = MongoSink(db)
    run_source(McaMonthlySource(f), sink=sink, rawstore=raw, log=lambda m: None)
    recs = [
        _sui("UPLC_00000001", "VEZRAS TECHNOLOGIES PRIVATE LIMITED", website="https://www.vezras.in/", brand="Vezras"),
        _sui("UPLC_00000002", "Agrobricks Technologies LLP", entity_type="LLP", active_since="2024-06-09"),
        _sui("UPLC_00000003", "Frontier Ops Private Limited"),
        _sui("UPLC_00000004", "SPTIX AI LLP", entity_type="LLP"),
        _sui("UPLC_00000005", "Rivika Organic Foods Pvt. Ltd.", website="https://instagram.com/rivika", active_since="2026-01-02"),
        _sui("UPLC_00000006", "Hamlet Bakers", entity_type="Partnership"),
    ]
    run_source(ListSource("startinup", recs), sink=sink, rawstore=raw, log=lambda m: None)
    return sink


def _link(db, uplc):
    return db.entity_links.find_one({"_id": f"startup:{uplc}"})


def test_build_links_exactly_and_sends_doubtful_pairs_to_a_person(db, raw, loaded):
    stats = build.build(db, raw, log=lambda m: None, use_splink=False)
    assert _link(db, "UPLC_00000001")["status"] == "linked" and _link(db, "UPLC_00000001")["method"] == "exact_name"
    conv = _link(db, "UPLC_00000002")
    assert conv["status"] == "review" and conv["evidence"]["possible_conversion"], "LLP -> company with the same name"
    assert _link(db, "UPLC_00000003")["status"] == "unlinked", "Frontier Ops is not Frontier Labs"
    assert _link(db, "UPLC_00000004")["company_id"] == "ACX-9818", "a portal LLP finds its LLPIN"
    early = _link(db, "UPLC_00000005")
    assert early["status"] == "review" and "before this company" in early["evidence"]["why_review"]
    assert _link(db, "UPLC_00000006")["evidence"]["reason"].startswith("a partnership has no CIN")
    assert stats["llp"]["llps_found"] == 1 and db.companies.count_documents({"kind": "llp"}) == 1, \
        "the LLP from elsewhere in India is never stored"


def test_portal_facts_carry_their_source_and_never_overwrite_the_registry(db, raw, loaded):
    build.build(db, raw, log=lambda m: None, use_splink=False)
    c = db.companies.find_one({"_id": "U62099UP2026PTC100001"})
    assert c["ids"]["uplc"] == ["UPLC_00000001"] and c["ids"]["domain"] == "vezras.in"
    assert c["attrs"]["district"] == {"value": "Lucknow", "source": "startinup", "confidence": "medium",
                                      "seen_at": c["attrs"]["district"]["seen_at"], "ref": {"startups": ["UPLC_00000001"]}}
    assert c["attrs"]["legal_name"]["source"] == "mca_monthly"
    assert set(c["sources"]) == {"mca_monthly", "startinup"}
    llp_company = db.companies.find_one({"_id": "ACX-9818"})
    assert llp_company["state"] == "UP" and llp_company["attrs"]["state_evidence"]["source"] == "startup_portals"


def test_a_reviewers_decision_wins_and_unlinking_clears_the_portal_facts(db, raw, loaded):
    build.build(db, raw, log=lambda m: None, use_splink=False)
    now = datetime.now(timezone.utc)
    db.match_reviews.insert_many([
        {"_id": "startup:UPLC_00000001|U62099UP2026PTC100001", "entity_type": "startup", "entity_key": "UPLC_00000001",
         "company_id": "U62099UP2026PTC100001", "decision": "different", "decided_by": "reviewer@solutionai.in",
         "decided_at": now, "source": "admin"},
        {"_id": "startup:UPLC_00000002|U62099UW2026PTC100002", "entity_type": "startup", "entity_key": "UPLC_00000002",
         "company_id": "U62099UW2026PTC100002", "decision": "same", "decided_by": "reviewer@solutionai.in",
         "decided_at": now, "source": "admin"},
    ])
    build.build(db, raw, log=lambda m: None, use_splink=False)
    assert _link(db, "UPLC_00000001")["status"] == "unlinked"
    c = db.companies.find_one({"_id": "U62099UP2026PTC100001"})
    assert "district" not in c["attrs"] and c["ids"]["uplc"] == [] and c["ids"]["domain"] is None
    assert c["sources"] == ["mca_monthly"]
    conv = _link(db, "UPLC_00000002")
    assert conv["status"] == "linked" and conv["method"] == "manual" and conv["decided_by"] == "reviewer@solutionai.in"


def test_rebuild_is_repeatable(db, raw, loaded):
    build.build(db, raw, log=lambda m: None, use_splink=False)
    first = {d["_id"]: (d["status"], d["company_id"]) for d in db.entity_links.find()}
    build.build(db, raw, log=lambda m: None, use_splink=False)
    assert {d["_id"]: (d["status"], d["company_id"]) for d in db.entity_links.find()} == first


def test_splink_finds_a_typo_and_links_only_with_the_words_accounted_for(db, raw, loaded):
    sink = loaded
    run_source(ListSource("startinup", [_sui("UPLC_00000007", "Vezras Techologies Private Limited")]),
               sink=sink, rawstore=raw, log=lambda m: None)
    startups = load_startups(sink)
    index = match.CompanyIndex.load(db)
    fuzzy, _ = match.splink_candidates([startups["UPLC_00000007"], startups["UPLC_00000003"]], index,
                                       expected_links=2, log=lambda m: None)
    assert fuzzy["UPLC_00000007"][0].company_id == "U62099UP2026PTC100001"
    frontier = [c.company_id for c in fuzzy.get("UPLC_00000003", [])]
    if frontier:   # Frontier Ops may be scored against Frontier Labs, but never linked to it
        d = match.decide(startups["UPLC_00000003"], index, [], fuzzy["UPLC_00000003"], {})
        assert d.status != "linked"


def test_words_must_be_accounted_for():
    from leadengine.names import normalize_name

    def c(name):
        k = normalize_name(name)
        return match.Company("X", name, "company", k.clean, k.legal_form, k.key, k.core, None, None)

    def s(name):
        return Startup(key="S", names=[name], entity_type="Private Limited")

    assert match.names_consistent(s("Ishmin Moors Private Limited"), c("ISHMIN MOTORS PRIVATE LIMITED"))
    assert match.names_consistent(s("Vastusmart LLP"), c("VASTU SMART LLP"))
    assert not match.names_consistent(s("Frontier Ops Private Limited"), c("FRONTIER LABS PRIVATE LIMITED"))
    assert not match.names_consistent(s("Credinfinite Technologies Pvt Ltd"), c("CREDINFINITY FINTECH PRIVATE LIMITED"))


def test_shared_platforms_are_not_company_domains():
    assert company_domain("https://www.Vezras.in/about") == "vezras.in"
    assert company_domain("instagram.com/rivika") is None
    assert company_domain("https://sites.google.com/view/x") is None
    assert company_domain("not a url") is None


def test_a_legal_form_in_the_name_outranks_the_portals_dropdown():
    s = Startup(key="S", names=["Dihaan Services Groups LLP"], entity_type="Partnership")
    assert s.is_registered_entity
    assert not Startup(key="T", names=["Hamlet Bakers"], entity_type="Partnership").is_registered_entity

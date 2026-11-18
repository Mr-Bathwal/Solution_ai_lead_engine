import json

import pytest

from conftest import ATLAS
from leadengine.records import RunContext
from leadengine.sources import incubators, startinup, upsm

CARD_PAGE = """
<div id="tab_default_1">
 <a href="https://www.startinup.up.gov.in/crm/Welcome/startup_user_details/abc123">
  <img src="https://www.startinup.up.gov.in/crm/assets/user/images/Documents/Startup/A_STARTUP_UP_UPLC_00004164/startup_logo/1673005179123.png">
  <h3>3Sutra RetailTech Pvt. Ltd.</h3><p>Agra , Agra</p><p>IT/ITeS , Retail&nbsp;Tech</p>
 </a>
</div>
<a href="https://www.startinup.up.gov.in/crm/welcome/connect_network/2/">2</a>
<a href="https://www.startinup.up.gov.in/crm/welcome/connect_network/231/">Last</a>
"""

DETAIL = """
<div class="company-name"><h3>THREESUTRA RETAILTECH PRIVATE LIMITED , 3Sutra</h3>
 <span class="active-since">06 Jan 2023</span> Industry : IT/ITeS, FinTech &amp; Emerging Technologies
 <a href="https://3sutra.in">site</a></div>
<img src="/Documents/Startup/A_STARTUP_UP_UPLC_00004164/startup_logo/1.png">
<div>Entity Type</div><div>Private Limited Company</div>
<div>Sectors</div><div>Retail Tech</div>
<div>Startup Stage</div><div>Validation</div>
<div>Startup Teams</div><div>1</div><div>Asha Verma</div><div>(Founder)</div>
<div>Incubation Details</div><div>Incubator Name</div><div>Not Available</div>
<div>Year of Establishment</div><div>2022</div>
<div>Location</div><div>Disctrict</div><div>Agra</div><div>Pincode</div><div>282001</div>
<div>Email</div><div>founder@example.com</div>
"""


def test_cards_and_last_page():
    cards = startinup.parse_cards(CARD_PAGE)
    assert startinup.last_page(CARD_PAGE) == 231
    assert cards == [{
        "name": "3Sutra RetailTech Pvt. Ltd.", "place": "Agra , Agra", "industry_sector": "IT/ITeS , Retail Tech",
        "url": "https://www.startinup.up.gov.in/crm/Welcome/startup_user_details/abc123",
        "uplc": "UPLC_00004164", "logo_date": "2023-01-06",
    }]


def test_profile_payload_is_stable_and_has_no_contacts():
    card = startinup.parse_cards(CARD_PAGE)[0]
    p = startinup.build_payload(card, startinup.parse_detail(DETAIL))
    assert p["uplc"] == "UPLC_00004164" and p["legal_name"] == "THREESUTRA RETAILTECH PRIVATE LIMITED"
    assert p["brand"] == "3Sutra" and p["entity_type"] == "Private Limited" and p["district"] == "Agra"
    assert p["team"] == [{"name": "Asha Verma", "role": "Founder"}]
    assert "incubator" not in p, "'Not Available' is dropped"
    assert "url" not in p and "founder@example.com" not in json.dumps(p), "no profile URL (unstable) and no email"
    # the profile URL is re-encrypted on every load; the payload, and so its hash, must not change
    card2 = dict(card, url="https://www.startinup.up.gov.in/crm/Welcome/startup_user_details/zzz999")
    assert startinup.build_payload(card2, startinup.parse_detail(DETAIL)) == p


def test_an_empty_field_is_not_read_as_the_next_label():
    html = DETAIL.replace("<div>Private Limited Company</div>", "") \
                 .replace("<div>2022</div>", "<div>0022</div>") \
                 .replace("Industry : IT/ITeS, FinTech &amp; Emerging Technologies", "Industry : , Others")
    p = startinup.build_payload(startinup.parse_cards(CARD_PAGE)[0], startinup.parse_detail(html))
    assert "entity_type" not in p or p["entity_type"] != "Sectors"
    assert "year_established" not in p, "'0022' is not a year"
    assert p["industry"] == "Others"


def test_weekly_run_retries_a_startup_whose_profile_failed(raw):
    from leadengine.net.fetcher import FetchResult

    class Fetcher:
        def __init__(self):
            self.urls = []

        def get(self, url):
            self.urls.append(url)
            body = CARD_PAGE if "connect_network" in url else DETAIL
            return FetchResult(url, url, 200, body.encode(), "text/html", None, 0.1)

    seen = []

    def known(source, where=None):
        seen.append(where)
        return set()   # UPLC_00004164 is stored, but only as a card: not "known" for a weekly run

    f = Fetcher()
    ctx = RunContext(run_id="t", fetcher=f, rawstore=raw, known_keys=known, log=lambda m: None)
    recs = list(startinup.StartinupSource("new", max_pages=1).collect(ctx))
    assert seen == [{"payload.profile_parsed": True}]
    assert recs[0].payload["profile_parsed"] is True and ctx.stats["profiles_fetched"] == 1


def test_one_failed_incubator_profile_does_not_fail_the_run(raw):
    import requests
    from leadengine.net.fetcher import FetchResult

    directory = ('<a href="https://x/incubator_user_details/1"><h3>A</h3></a>'
                 '<a href="https://x/incubator_user_details/2"><h3>B</h3></a>')
    profile = ('<div class="company-name">06 Jan 2023|AIC BIMTECH|BIMTECH</div><div id="menu1">'
               '<div class="col-md-3"><a href="startup_user_details/z"><img src="/A_STARTUP_UP_UPLC_00000007/x.png">'
               '<h4>Seven</h4></a></div></div>')

    class Fetcher:
        def get(self, url):
            if url.endswith("/1"):
                raise requests.ReadTimeout("slow")
            body = {"recognized": "<table><tr><th>Incubator Name</th></tr><tr><td>AIC</td></tr></table>",
                    "connect_network": directory}.get(next((k for k in ("recognized", "connect_network") if k in url), ""), profile)
            return FetchResult(url, url, 200, body.encode(), "text/html", None, 0.1)

    ctx = RunContext(run_id="t", fetcher=Fetcher(), rawstore=raw, log=lambda m: None)
    recs = list(incubators.IncubatorSource(sisfs=False).collect(ctx))
    assert ctx.stats["profiles_failed"] == 1 and ctx.stats["profiles"] == 1
    assert [r.natural_key.split("|")[-1] for r in recs if r.source == "incubator_portfolio"] == ["UPLC_00000007"]


def test_upsm_scrubs_personal_fields():
    row = {"id": "4164", "user_acknowledgement_no": "A/STARTUP/UP/UPLC/00004164", "startup_name": "3Sutra",
           "email": "x@y.in", "mobile_no": "9876543210", "founder_name": "Asha", "startup_address": "12 MG Road",
           "startup_address_district": "Agra", "startup_current_stage": "4", "nature_of_entity": "6", "women_led_startup": "1"}
    rec = upsm.record_for(row, "https://api")
    assert rec.natural_key == "UPLC_00004164"
    assert set(rec.payload) == {"id", "user_acknowledgement_no", "startup_name", "startup_address_district",
                                "startup_current_stage", "nature_of_entity", "women_led_startup"}
    v = upsm.view(rec.payload)
    assert v["stage"] == "Validation" and v["entity_type"] == "Private Limited" and v["women_led"] is True


def test_upsm_skips_only_the_failed_page(raw):
    import requests
    from leadengine.net.fetcher import FetchResult

    def page(n, has_next):
        rows = [{"id": str(n), "user_acknowledgement_no": f"A/STARTUP/UP/UPLC/{n:08d}", "startup_name": f"S{n}"}]
        return {"data": {"records": rows, "pagination": {"has_next": has_next, "last_page": 3}}}

    class Fetcher:
        def get(self, url):
            if url == upsm.DIRECTORY_PAGE:
                body = b'<select id="districtFilter"><option value="">All</option><option value="9">Prayagraj</option></select>'
            elif "page=2" in url:
                raise requests.ReadTimeout("slow")
            else:
                n = 1 if "page=1&" in url else 3
                body = json.dumps(page(n, n == 1)).encode()
            return FetchResult(url, url, 200, body, "application/json", None, 0.1)

    ctx = RunContext(run_id="t", fetcher=Fetcher(), rawstore=raw, log=lambda m: None)
    keys = [r.natural_key for r in upsm.UpsmSource().collect(ctx)]
    assert keys == ["UPLC_00000001", "UPLC_00000003"], "page 3 is still read after page 2 fails"
    assert ctx.stats["api_pages_failed"] == 1


def test_recognised_incubator_table_drops_contacts():
    html = """<table><tr><th>Sr.No</th><th>Incubator Name</th><th>Educational Institute/Host Institution Name</th>
    <th>Representative Name</th><th>Email</th><th>Number of Startups Count</th></tr>
    <tr><td>1</td><td>AIC BIMTECH</td><td>BIMTECH - Greater Noida</td><td>Mr X</td><td>x@y.in</td><td>40</td></tr></table>"""
    rows = incubators.parse_recognised(html)
    assert rows == [{"name": "AIC BIMTECH", "host": "BIMTECH - Greater Noida", "startups_count": "40"}]


def test_incubators_with_the_same_name_stay_apart():
    a = incubators.incubator_key("Software Technology Parks of India", "STPI - Noida")
    b = incubators.incubator_key("Software Technology Parks of India", "STPI - Lucknow")
    assert a != b
    assert incubators.incubator_key("AIC BIMTECH") != incubators.incubator_key("AIC Technologies")


def test_sisfs_keeps_up_only():
    body = {"data": [{"Id": 1, "state": "Goa", "incubator_name": "A"},
                     {"Id": 2, "state": "Uttar Pradesh", "incubator_name": "B", "description": "long", "image": "/x.jpg"}]}
    recs = list(incubators.sisfs_records(body, None))
    assert [r.natural_key for r in recs] == ["sisfs:2"] and "description" not in recs[0].payload


def test_sisfs_keeps_only_the_fields_on_its_allow_list():
    body = {"data": [{"Id": 2, "state": "Uttar Pradesh", "incubator_name": "B", "contact_person": "Mr X",
                      "contactEmail": "x@y.in", "mobile": "9876543210"}]}
    [rec] = incubators.sisfs_records(body, None)
    assert set(rec.payload) == {"Id", "state", "incubator_name"}


@pytest.mark.parametrize("key", ["first_name", "firstName", "owner_name", "founderName", "applicant_name", "whatsapp",
                                 "whatsapp_no", "mob_no", "panNumber", "dateOfBirth", "linkedin_url", "promoter_name",
                                 "landline", "alternate_number", "userName"])
def test_the_deny_list_catches_snake_and_camel_case_personal_keys(key):
    assert key not in upsm.scrub({key: "x", "startup_name": "S"}), key


def test_upsm_keeps_only_allow_listed_fields_even_if_the_api_adds_some():
    row = {"id": "1", "user_acknowledgement_no": "A/STARTUP/UP/UPLC/00000001", "startup_name": "S",
           "startup_address_city": "Agra", "startup_address_pincode": "282001", "new_field_tomorrow": "?",
           "owner_name": "Mr X", "contact_us_url": "https://x"}
    p = upsm.record_for(row, "https://api").payload
    assert set(p) == {"id", "user_acknowledgement_no", "startup_name", "startup_address_city", "startup_address_pincode"}


def _profile_fetcher(fail_profiles=False, page1=200):
    from leadengine.net.fetcher import FetchResult

    class Fetcher:
        def get(self, url):
            if "connect_network" in url:
                return FetchResult(url, url, page1, CARD_PAGE.encode(), "text/html", None, 0.1)
            if fail_profiles:
                return FetchResult(url, url, 503, b"", "text/html", None, 0.1)
            return FetchResult(url, url, 200, DETAIL.encode(), "text/html", None, 0.1)
    return Fetcher()


def test_a_failed_profile_on_the_monthly_reread_keeps_the_good_record(raw):
    """A profile-host outage must not replace every parsed profile with a bare card for a month."""
    ctx = RunContext(run_id="t", fetcher=_profile_fetcher(fail_profiles=True), rawstore=raw,
                     known_keys=lambda source, where=None: {"UPLC_00004164"}, log=lambda m: None)
    recs = list(startinup.StartinupSource("all", max_pages=1).collect(ctx))
    assert recs == [] and ctx.stats["profiles_failed_kept_previous"] == 1
    assert ("startinup", "UPLC_00004164") in ctx.seen, "still listed, so its last-seen date moves on"


def test_a_run_whose_first_page_fails_is_partial_not_ok(raw):
    from leadengine.pipeline import PARTIAL_MARKERS
    ctx = RunContext(run_id="t", fetcher=_profile_fetcher(page1=503), rawstore=raw, log=lambda m: None)
    assert list(startinup.StartinupSource("new", max_pages=1).collect(ctx)) == []
    assert ctx.stats["unavailable"] == 1 and "unavailable" in PARTIAL_MARKERS


def test_profiles_are_stored_without_contacts_and_marked_personal(raw):
    from leadengine.rawstore import raw_key
    ctx = RunContext(run_id="t", fetcher=_profile_fetcher(), rawstore=raw, log=lambda m: None)
    [rec] = list(startinup.StartinupSource("all", max_pages=1).collect(ctx))
    assert rec.raw_ref.personal and rec.raw_ref.redacted
    stored = raw.get(rec.raw_ref).decode()
    assert "founder@example.com" not in stored and "Asha Verma" in stored, "contacts go, the published team stays (flagged)"
    folder = raw_key("startinup", "profile:UPLC_00004164", "x").split("/")[1]
    assert rec.raw_ref.key.split("/")[1] == folder, "profiles are filed under their UPLC number, not the encrypted URL"


def test_incubator_profile_pages_lose_emails_and_mobiles_before_storage(raw):
    from leadengine.net.fetcher import FetchResult
    page = ('<div class="company-name">06 Jan 2023|AIC BIMTECH|BIMTECH</div><p>Contact: Mr X, x.ceo@gmail.com, '
            '(+91) 98765-43210, 0120 4567890</p><div id="menu1"><div class="col-md-3"><a href="startup_user_details/z">'
            '<img src="/A_STARTUP_UP_UPLC_00000007/x.png"><h4>Seven</h4></a></div></div>')

    class Fetcher:
        def get(self, url):
            body = {"recognized": "<table><tr><th>Incubator Name</th></tr><tr><td>AIC</td></tr></table>",
                    "connect_network": '<a href="https://x/incubator_user_details/1"><h3>A</h3></a>'}.get(
                next((k for k in ("recognized", "connect_network") if k in url), ""), page)
            return FetchResult(url, url, 200, body.encode(), "text/html", None, 0.1)

    ctx = RunContext(run_id="t", fetcher=Fetcher(), rawstore=raw, log=lambda m: None)
    recs = [r for r in incubators.IncubatorSource(sisfs=False).collect(ctx) if r.source == "incubator_portfolio"]
    stored = raw.get(recs[0].raw_ref).decode()
    assert "gmail" not in stored and "98765" not in stored and "4567890" not in stored
    assert "UPLC_00000007" in stored, "identifiers the parser needs survive redaction"
    assert recs[0].raw_ref.personal


def test_name_keys_for_cards_without_a_number_do_not_collide():
    a = startinup.natural_key({"name": "Abc Technologies Pvt Ltd", "uplc": None}, None)
    b = startinup.natural_key({"name": "ABC Solutions Pvt Ltd", "uplc": None}, None)
    assert a != b and a.startswith("name:")


def test_python_and_node_agree_on_shared_mail_domains():
    import re
    from pathlib import Path
    from leadengine.privacy import SHARED_MAIL_DOMAINS
    js = (Path(__file__).resolve().parents[2] / "services" / "src" / "util" / "normalize.js").read_text(encoding="utf-8")
    block = re.search(r"SHARED_MAIL_DOMAINS\s*=\s*new Set\(\[(.*?)\]\)", js, re.S)[1]
    assert set(re.findall(r"'([^']+)'", block)) == set(SHARED_MAIL_DOMAINS)


# ---- against the real October 2026 crawl caches, when present --------------------------------

SUI = ATLAS / "raw" / "L3_startinup" / "_cache"
need_cache = pytest.mark.skipif(not (SUI / "_index.jsonl").exists(), reason="Atlas caches not on this machine")


@need_cache
def test_real_directory_pages_parse(raw):
    pages = sorted(SUI.glob("sui_cn_p00*.html"))[:5]
    cards = [c for p in pages for c in startinup.parse_cards(p.read_bytes())]
    assert len(cards) >= 40
    assert sum(1 for c in cards if c["uplc"]) / len(cards) > 0.9


@need_cache
def test_real_profiles_parse():
    files = sorted(SUI.glob("sui_sd_UPLC_*.html"))[:40]
    parsed = [startinup.parse_detail(f.read_bytes()) for f in files]
    assert sum(1 for d in parsed if d.get("title")) >= 38
    assert sum(1 for d in parsed if d.get("district")) >= 30
    # cache files are named with the portal's own padding (often 9 digits); keys compare by value
    assert all(d["uplc"] == f"UPLC_{int(f.stem.split('UPLC_')[1]):08d}" for d, f in zip(parsed, files) if d["uplc"])
    assert len({d["uplc"] for d in parsed}) == len(parsed), "no two profiles may share a key"

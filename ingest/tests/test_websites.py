"""Company websites and the contacts they publish (design 7.1, 7.3): found through a search API,
confirmed by name, searched again at day 7, 30 and 90; role addresses only, never a person's."""
from datetime import datetime, timedelta, timezone

from leadengine.enrich import cache
from leadengine.enrich.websites import Websites, contacts_in, domain_fits, page_names_company
from leadengine.net.fetcher import Disallowed, FetchResult

NOW = datetime(2026, 11, 16, 6, 0, tzinfo=timezone.utc)
MONTH = "2026-11"
CAPS = {"monthly": {"web_searches": 1000}}


class Search:
    provider = "test"

    def __init__(self, results):
        self.results, self.queries = results, []

    def search(self, q):
        self.queries.append(q)
        return self.results.get(q, [])


class Fetcher:
    """Pages by URL; a URL mapped to Disallowed is refused as robots.txt would."""

    def __init__(self, pages):
        self.pages, self.asked = pages, []

    def get(self, url):
        self.asked.append(url)
        page = self.pages.get(url)
        if page is Disallowed:
            raise Disallowed(url)
        status, html = page if page else (404, "")
        return FetchResult(url, url, status, html.encode(), "text/html", NOW, 0.1)


def _company(db, cin, name, district="Lucknow", **attrs):
    db.companies.insert_one({"_id": cin, "kind": "company", "state": "UP", "name": name, "ids": {"cin": cin, "uplc": [], "domain": None},
                             "attrs": {"registered_district": {"value": district, "source": "infyner", "seen_at": NOW}, **attrs},
                             "sources": ["mca_monthly"], "first_seen_at": NOW, "updated_at": NOW, "schema_version": 2, "cohort": "2026-10", "former_names": []})
    db.leads.insert_one({"company_id": cin, "stage": "shortlisted", "holdout": False, "eligible": True, "cohort": "2026-10",
                         "shortlist": {"month": MONTH, "rank": 1}, "created_at": NOW, "updated_at": NOW})


GOMTI = "U10799UP2026PTC200001"
HOME = "<html><head><title>Gomti Agro Foods</title></head><body><h1>Gomti Agro Foods Pvt Ltd</h1><a href='/contact-us'>Contact us</a></body></html>"
CONTACT = ("<html><body><p>Write to info@gomtiagro.in or rahul.verma@gomtiagro.in, or our agency hello@agency.in.</p>"
           "<a href='mailto:sales@gomtiagro.in?subject=Hi'>Sales</a><form><input type='email' name='e'><textarea></textarea></form></body></html>")


def test_a_site_is_taken_only_when_its_domain_and_home_page_name_the_company(db):
    assert domain_fits("gomtiagro.in", "GOMTI AGRO FOODS PRIVATE LIMITED")
    assert not domain_fits("agrofoods.in", "GOMTI AGRO FOODS PRIVATE LIMITED"), "only generic words in common"
    assert page_names_company("<p>CIN U10799UP2026PTC200001</p>", "ANY NAME PRIVATE LIMITED", GOMTI)
    assert not page_names_company("<p>Gomti Traders</p>", "GOMTI AGRO FOODS PRIVATE LIMITED", GOMTI)
    _company(db, GOMTI, "GOMTI AGRO FOODS PRIVATE LIMITED")
    q = '"GOMTI AGRO FOODS" Lucknow'
    search = Search({q: [{"url": "https://www.zaubacorp.com/company/GOMTI-AGRO"}, {"url": "https://gomtitraders.in/"},
                         {"url": "https://www.gomtiagro.in/about"}]})
    fetcher = Fetcher({"https://gomtitraders.in/": (200, "<p>Gomti Traders</p>"), "https://gomtiagro.in/": (200, HOME),
                       "https://gomtiagro.in/contact-us": (200, CONTACT)})
    stats = Websites(db, None, CAPS, fetcher=fetcher, search=search, log=lambda *_: None, clock=lambda: NOW).run(MONTH)
    assert search.queries == [q]
    assert "https://www.zaubacorp.com/company/GOMTI-AGRO" not in fetcher.asked, "a directory is never taken for the company's site"
    c = db.companies.find_one({"_id": GOMTI})
    assert c["attrs"]["website"]["value"] == "https://gomtiagro.in" and c["attrs"]["website"]["source"] == "web_discovery"
    assert c["ids"]["domain"] == "gomtiagro.in"
    # and the contacts step read the site the same night
    assert c["attrs"]["website_email"]["value"] == "info@gomtiagro.in"
    assert c["attrs"]["website_email"]["ref"]["legal_basis"] == "published_by_company"
    assert c["attrs"]["contact_form"]["value"] == "https://gomtiagro.in/contact-us"
    assert "rahul.verma@gomtiagro.in" not in str(c), "a person's address is never kept"
    assert stats["websites_found"] == 1 and stats["emails_found"] == 1


def test_contacts_keep_role_addresses_on_the_companys_own_domain_only():
    found = contacts_in(CONTACT, "https://gomtiagro.in/contact-us", "gomtiagro.in")
    assert found["emails"] == ["info@gomtiagro.in", "sales@gomtiagro.in"]
    assert found["form"] is True
    links = contacts_in(HOME, "https://gomtiagro.in/", "gomtiagro.in")["links"]
    assert links == ["https://gomtiagro.in/contact-us"]


def test_a_company_not_found_is_searched_again_at_day_7_30_and_90_then_no_more(db):
    _company(db, GOMTI, "GOMTI AGRO FOODS PRIVATE LIMITED")
    search = Search({})
    t = [NOW]
    w = lambda: Websites(db, None, CAPS, fetcher=Fetcher({}), search=search, log=lambda *_: None, clock=lambda: t[0])
    w().run(MONTH)
    w().run(MONTH)
    assert len(search.queries) == 1, "not twice the same day"
    rec = cache.get(db, "web", "website", GOMTI, t[0])
    assert (rec["expires_at"].replace(tzinfo=timezone.utc) - NOW).days == 120, "kept past the last retry"
    for day, expected in [(6, 1), (7, 2), (20, 2), (30, 3), (89, 3), (90, 4), (200, 4)]:
        t[0] = NOW + timedelta(days=day)
        if day == 200:
            # past the record's life: still never a fifth search, because the fourth is the last
            cache.put(db, "web", "website", GOMTI, status="not_found", result={"attempts": [NOW.isoformat()] * 4}, now=t[0], ttl_days=120)
        w().run(MONTH)
        assert len(search.queries) == expected, (day, search.queries)


def test_no_guessing_robots_and_caps_are_respected_and_no_provider_means_contacts_only(db):
    _company(db, GOMTI, "GOMTI AGRO FOODS PRIVATE LIMITED")
    _company(db, "U62099UP2026PTC200002", "SARNATH LEARNING PRIVATE LIMITED", website={"value": "https://sarnathlearning.in", "source": "startinup", "seen_at": NOW})
    db.companies.update_one({"_id": "U62099UP2026PTC200002"}, {"$set": {"ids.domain": "sarnathlearning.in"}})
    q = '"GOMTI AGRO FOODS" Lucknow'
    fetcher = Fetcher({"https://gomtiagro.in/": Disallowed, "https://sarnathlearning.in/": (200, "<p>Write to contact@sarnathlearning.in</p>")})
    Websites(db, None, CAPS, fetcher=fetcher, search=Search({q: [{"url": "https://gomtiagro.in/"}]}), log=lambda *_: None, clock=lambda: NOW).run(MONTH)
    assert "website" not in db.companies.find_one({"_id": GOMTI})["attrs"], "robots.txt said no: nothing is guessed"
    assert db.companies.find_one({"_id": "U62099UP2026PTC200002"})["attrs"]["website_email"]["value"] == "contact@sarnathlearning.in"
    # no search provider: the search is skipped and said so; a website from a portal is still read for contacts
    db.companies.update_one({"_id": "U62099UP2026PTC200002"}, {"$unset": {"attrs.website_email": ""}})
    db.enrichment_cache.delete_many({})
    stats = Websites(db, None, CAPS, fetcher=fetcher, search=None, log=lambda *_: None, clock=lambda: NOW).run(MONTH)
    assert stats["search_skipped_not_configured"] == 1 and stats["emails_found"] == 1
    # a cap of two searches a month, one already spent above: one more company is searched, the other waits
    _company(db, "U62099UP2026PTC200003", "KASHI CRAFTS PRIVATE LIMITED")
    db.enrichment_cache.delete_many({})
    s = Search({})
    stats = Websites(db, None, {"monthly": {"web_searches": 2}}, fetcher=Fetcher({}), search=s, log=lambda *_: None, clock=lambda: NOW).run(MONTH)
    assert len(s.queries) == 1 and stats["search_stopped_cap"] == 1


def test_initials_and_honorifics_fit_but_site_builders_never_count():
    # a name that starts with initials, or with an honorific the domain leaves out
    assert domain_fits("vnagro.in", "VN AGRO PRIVATE LIMITED")
    assert domain_fits("skfoods.com", "S.K. FOODS PRIVATE LIMITED")
    assert domain_fits("ramagro.in", "SHRI RAM AGRO PRIVATE LIMITED")
    assert not domain_fits("vnx.in", "VN AGRO PRIVATE LIMITED"), "initials alone are not enough"
    assert not domain_fits("ramagro.in", "SITA RAM AGRO PRIVATE LIMITED"), "only an honorific may be left out"
    # a subdomain of a free site builder belongs to the builder, not the company
    from leadengine.web import company_domain
    for url in ("https://vezras.weebly.com/", "https://vezras.myshopify.com", "https://vezras.netlify.app"):
        assert company_domain(url) is None, url


def test_a_changed_last_vowel_is_another_name_not_a_slip():
    from leadengine.names import typo_of
    assert not typo_of("hiranyo", "hiranya")
    assert typo_of("motors", "moors") and typo_of("yagnawealthh", "yagnawealth")

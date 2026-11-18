"""Funding news as proposed signals (design 7.1, 7.4): feeds parsed safely, a headline matched to
exactly one UP company by its cleaned name, only matches kept, and nothing decided by the engine."""
import json
from datetime import datetime, timezone
from urllib.parse import urlencode

import pytest
from lxml import etree

from leadengine import news
from leadengine.names import normalize_name
from leadengine.net.fetcher import Disallowed, FetchResult

NOW = datetime(2026, 11, 18, 1, 45, tzinfo=timezone.utc)
INC42 = "https://inc42.com/feed/"
ENTRACKR = "https://entrackr.com/feed/"
YOURSTORY = "https://yourstory.com/feed"

VEZRAS = "U62099UP2026PTC100001"
SHIELD = "U62099UP2026PTC100002"           # brand "Kavach" on the portal
GOMTI = "U10799UP2026PTC100003"
AGRO = "U10799UP2026PTC100004"
PARAKH_LABS = "U72900UP2026PTC100005"
PARAKH_SOL = "U72900UP2026PTC100006"

RSS = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>Inc42</title><atom:link href="https://inc42.com/feed/" rel="self" type="application/rss+xml"/>
<item><title>Lucknow-Based Fintech Startup Vezras Raises ₹5 Cr In Seed Round</title>
  <atom:link href="https://inc42.com/feed/x" rel="self"/>
  <link>https://inc42.com/buzz/vezras-raises/?utm_source=rss&amp;utm_medium=rss&amp;id=7</link>
  <pubDate>Wed, 18 Nov 2026 04:30:00 +0000</pubDate>
  <description><![CDATA[<p>The founders, Asha Verma and Kabir Rao, said the money goes into hiring.</p>]]></description></item>
<item><title>Zepto Raises $350 Mn In Series G</title><link>https://inc42.com/buzz/zepto/</link><pubDate>Wed, 18 Nov 2026 03:00:00 +0000</pubDate></item>
<item><title>Vezras Opens A New Office In Noida</title><link>https://inc42.com/buzz/vezras-office/</link></item>
<item><title>Parakh Labs Secures ₹2 Crore From Angels</title><link>https://inc42.com/buzz/parakh/</link></item>
<item><title>Vezra Raises ₹1 Cr</title><link>https://inc42.com/buzz/vezra/</link></item>
<item><title>Vezras Raises ₹9 Cr</title><link>javascript:alert(1)</link></item>
</channel></rss>""".encode()

ATOM = b"""<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Entrackr</title>
<entry><title type="html">Kavach &lt;b&gt;bags&lt;/b&gt; $1M from angel investors</title>
  <link rel="edit" href="https://entrackr.com/wp-admin/1"/><link rel="alternate" href="https://entrackr.com/2026/11/kavach-bags-1m/"/>
  <updated>2026-11-18T05:00:00Z</updated><published>2026-11-18T04:00:00+05:30</published></entry>
</feed>"""

GDELT = json.dumps({"articles": [
    {"url": "https://www.example-news.in/up/gomti-agro-foods?utm_campaign=x", "url_mobile": "", "title": "Gomti Agro Foods raises Rs 3 crore from angel investors",
     "seendate": "20261118T061500Z", "socialimage": "", "domain": "example-news.in", "language": "English", "sourcecountry": "India"},
    {"url": "ftp://example-news.in/x", "title": "Vezras raises Rs 1 crore", "seendate": "20261118T061500Z", "domain": "example-news.in"},
]}).encode()


class Fetcher:
    """Answers by URL: bytes are a 200, Disallowed is refused as robots.txt would, anything else a 404."""

    def __init__(self, pages):
        self.pages, self.asked = pages, []

    def get(self, url, params=None):
        self.asked.append((url, params))
        page = self.pages.get(url)
        if page is Disallowed:          # the fetcher names the whole URL, query string and all
            raise Disallowed(f"{url}{'?' + urlencode(params) if params else ''}: robots.txt disallows it")
        if page is None:
            return FetchResult(url, url, 404, b"", "text/html", NOW, 0.1)
        return FetchResult(url, url, 200, page, "application/xml", NOW, 0.1)


def _cfg(feeds=(("Inc42", INC42),), gdelt=False):
    return {**news.load_config(), "feeds": [{"name": n, "url": u} for n, u in feeds],
            "gdelt": {"enabled": gdelt, "query": "(raises OR funding) (Lucknow OR Noida)", "max_records": 75, "timespan": "1d"}}


def _company(db, cin, name, **attrs):
    db.companies.insert_one({"_id": cin, "kind": "company", "state": "UP", "name": name, "name_norm": normalize_name(name).key,
                             "ids": {"cin": cin, "uplc": []}, "attrs": {k: {"value": v, "source": "startinup", "seen_at": NOW} for k, v in attrs.items()},
                             "sources": ["mca_monthly"], "first_seen_at": NOW, "updated_at": NOW, "schema_version": 2, "cohort": "2026-10", "former_names": []})


@pytest.fixture
def companies(db):
    _company(db, VEZRAS, "VEZRAS TECHNOLOGIES PRIVATE LIMITED")
    _company(db, SHIELD, "SHIELDWORKS PRIVATE LIMITED", brand="Kavach")
    _company(db, GOMTI, "GOMTI AGRO FOODS PRIVATE LIMITED")
    _company(db, AGRO, "AGRO FOODS PRIVATE LIMITED")
    _company(db, PARAKH_LABS, "PARAKH LABS PRIVATE LIMITED")
    _company(db, PARAKH_SOL, "PARAKH SOLUTIONS PRIVATE LIMITED")
    return db


def test_rss_items_keep_title_link_and_date_and_drop_tracking_and_unsafe_links():
    items = news.parse_feed(RSS, "Inc42")
    assert [i.title for i in items][:2] == ["Lucknow-Based Fintech Startup Vezras Raises ₹5 Cr In Seed Round", "Zepto Raises $350 Mn In Series G"]
    first = items[0]
    assert first.url == "https://inc42.com/buzz/vezras-raises/?id=7", "the item's own <link>, not its atom:link, without utm_ parameters"
    assert first.published_at == datetime(2026, 11, 18, 4, 30, tzinfo=timezone.utc)
    assert first.publisher == "Inc42"
    assert not any("javascript" in i.url for i in items), "only http(s) links are kept"
    assert len(items) == 5


def test_atom_entries_use_the_alternate_link_and_lose_html_in_the_title():
    [e] = news.parse_feed(ATOM, "Entrackr")
    assert e.title == "Kavach bags $1M from angel investors"
    assert e.url == "https://entrackr.com/2026/11/kavach-bags-1m/"
    assert e.published_at == datetime(2026, 11, 17, 22, 30, tzinfo=timezone.utc), "published is preferred to updated"
    with pytest.raises(ValueError, match="not an RSS or Atom feed"):
        news.parse_feed(b"<html><body>moved</body></html>", "Inc42")


def test_entities_are_never_expanded_nor_files_read(tmp_path):
    secret = tmp_path / "secret.txt"
    secret.write_text("SECRET-MARKER-42", encoding="utf-8")
    payload = f"""<?xml version="1.0"?>
<!DOCTYPE rss [
 <!ENTITY lol "lol">
 <!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
 <!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">
 <!ENTITY xxe SYSTEM "{secret.as_uri()}">
]>
<rss version="2.0"><channel><item><title>Vezras raises &lol2; crore &xxe;</title><link>https://inc42.com/a</link></item></channel></rss>""".encode()
    [item] = news.parse_feed(payload, "Inc42")
    assert "lol" not in item.title and "SECRET-MARKER" not in item.title
    assert item.title == "Vezras raises crore"
    laughs = b'<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY a "aaaaaaaaaa">' + b"".join(
        b'<!ENTITY %s "%s">' % (chr(98 + i).encode(), (b"&" + chr(97 + i).encode() + b";") * 10) for i in range(9)) + \
        b']><rss version="2.0"><channel><item><title>&j;</title><link>https://x.in/a</link></item></channel></rss>'
    with pytest.raises(etree.XMLSyntaxError):
        news.parse_feed(laughs, "Inc42")              # libxml2 refuses the amplification rather than expanding it


def test_a_billion_laughs_feed_is_a_failed_feed_not_a_crash(companies):
    laughs = b'<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY a "aaaaaaaaaa">' + b"".join(
        b'<!ENTITY %s "%s">' % (chr(98 + i).encode(), (b"&" + chr(97 + i).encode() + b";") * 10) for i in range(9)) + \
        b']><rss version="2.0"><channel><item><title>&j;</title><link>https://x.in/a</link></item></channel></rss>'
    r = news.run(companies, Fetcher({INC42: laughs, ENTRACKR: ATOM}), _cfg([("Inc42", INC42), ("Entrackr", ENTRACKR)]), clock=lambda: NOW)
    assert (r["feeds_read"], r["feeds_failed"], r["signals_new"]) == (1, 1, 1)
    assert "Inc42: XMLSyntaxError" in r["failures"][0]


def test_names_come_from_the_words_before_the_funding_verb():
    keys = [k for _, k in news.candidates("Lucknow-Based Fintech Startup Vezras Raises ₹5 Cr In Seed Round")]
    assert keys[-1] == "vezras" and keys[0] == "fintechstartupvezras", "longest first, the place description dropped"
    assert [k for _, k in news.candidates("Exclusive: Gomti Agro Foods Bags ₹3 Cr")][0] == "gomtiagrofoods", "the section before the colon is not the name"
    assert news.candidates("Vezras Opens A New Office") == [], "no funding verb, no name"
    assert news.candidates("Technologies Raises ₹1 Cr") == [], "a generic word alone is never a name"
    assert news.candidates("ABC Raises ₹1 Cr") == [], "a key under five letters matches too much"


def test_only_an_exact_match_to_one_company_is_proposed_and_nothing_else_is_kept(companies):
    db = companies
    r = news.run(db, Fetcher({INC42: RSS}), _cfg(), clock=lambda: NOW)
    assert r["status"] == "ok"
    assert (r["items"], r["funding_items"], r["matched"], r["ambiguous"], r["signals_new"]) == (5, 4, 1, 1, 1)
    [s] = list(db.signals.find())
    assert s["company_id"] == VEZRAS and s["status"] == "proposed" and s["type"] == "funding"
    assert s["matched_name"] == "Vezras"
    assert s["url"] == "https://inc42.com/buzz/vezras-raises/?id=7" and s["_id"] == news.signal_id(s["url"])
    assert s["publisher"] == "Inc42" and s["published_at"].replace(tzinfo=timezone.utc) == datetime(2026, 11, 18, 4, 30, tzinfo=timezone.utc)
    assert set(s) == {"_id", "type", "company_id", "headline", "url", "publisher", "published_at", "matched_name", "status",
                      "created_at", "decided_by", "decided_at", "note"}
    assert "Asha Verma" not in str(s), "an article's text (here, people's names) is never stored"
    assert not db.signals.find_one({"headline": {"$regex": "Zepto|Vezra Raises|Parakh"}}), \
        "unmatched (Zepto), near-miss (Vezra) and ambiguous (Parakh: two companies share the key) headlines are not stored"
    run = db.ingest_runs.find_one({"source": "news"})
    assert run["status"] == "ok" and run["stats"]["signals_new"] == 1


def test_a_portal_brand_matches_and_the_longest_name_wins(companies):
    db = companies
    r = news.run(db, Fetcher({ENTRACKR: ATOM, news.GDELT_URL: GDELT}), _cfg([("Entrackr", ENTRACKR)], gdelt=True), clock=lambda: NOW)
    assert (r["feeds_read"], r["signals_new"]) == (2, 2)
    kavach = db.signals.find_one({"company_id": SHIELD})
    assert kavach["matched_name"] == "Kavach" and kavach["publisher"] == "Entrackr"
    gomti = db.signals.find_one({"publisher": "example-news.in"})
    assert gomti["company_id"] == GOMTI, "Gomti Agro Foods, not the Agro Foods company its last two words name"
    assert gomti["url"] == "https://www.example-news.in/up/gomti-agro-foods"
    assert not db.signals.find_one({"company_id": AGRO})


def test_gdelt_answers_are_parsed_and_its_query_is_sent_as_parameters():
    [a] = news.parse_gdelt(GDELT)
    assert a.title == "Gomti Agro Foods raises Rs 3 crore from angel investors"
    assert a.published_at == datetime(2026, 11, 18, 6, 15, tzinfo=timezone.utc)
    assert a.publisher == "example-news.in"
    assert news.parse_gdelt(b"{}") == [] and news.parse_gdelt(b"  ") == [], "GDELT's answer when nothing matched"
    with pytest.raises(ValueError):
        news.parse_gdelt(b"Your search contained a keyword that was too short")
    f = Fetcher({news.GDELT_URL: GDELT})
    news.collect(f, _cfg([], gdelt=True), dict.fromkeys(("feeds_read", "feeds_failed"), 0), [])
    url, params = f.asked[0]
    assert url == news.GDELT_URL and params["mode"] == "artlist" and params["format"] == "json" and params["maxrecords"] == 75


def test_a_refused_or_broken_feed_is_counted_and_the_others_still_read(companies):
    db = companies
    r = news.run(db, Fetcher({YOURSTORY: Disallowed, INC42: RSS}), _cfg([("YourStory", YOURSTORY), ("Inc42", INC42), ("Entrackr", ENTRACKR)]),
                 clock=lambda: NOW)
    assert (r["feeds_read"], r["feeds_failed"], r["signals_new"]) == (1, 2, 1)
    assert r["status"] == "partial"
    assert any(f.startswith("YourStory: Disallowed") for f in r["failures"]) and any(f.startswith("Entrackr: ValueError: HTTP 404") for f in r["failures"])
    run = db.ingest_runs.find_one({"source": "news"})
    assert run["status"] == "partial" and any("robots.txt" in n for n in run["notes"])
    every = news.run(db, Fetcher({news.GDELT_URL: Disallowed}), _cfg([("Inc42", INC42)], gdelt=True), clock=lambda: NOW)
    assert every["status"] == "failed"
    assert every["failures"][1] == "GDELT: Disallowed: https://api.gdeltproject.org/api/v2/doc/doc?…: robots.txt disallows it", \
        "the long query string is cut from the note, so the reason survives"


def test_reading_again_changes_nothing_and_keeps_a_persons_decision(companies):
    db = companies
    assert news.run(db, Fetcher({INC42: RSS}), _cfg(), clock=lambda: NOW)["signals_new"] == 1
    db.signals.update_one({}, {"$set": {"status": "confirmed", "decided_by": "reviewer@solutionai.in", "decided_at": NOW}})
    again = news.run(db, Fetcher({INC42: RSS}), _cfg(), clock=lambda: NOW)
    assert (again["matched"], again["signals_new"]) == (1, 0)
    assert db.signals.count_documents({}) == 1
    assert db.signals.find_one()["status"] == "confirmed"


def test_a_dry_run_prints_the_matches_and_writes_nothing(companies):
    db = companies
    r = news.run(db, Fetcher({INC42: RSS}), _cfg(), dry_run=True, clock=lambda: NOW)
    assert [p["company_id"] for p in r["proposed"]] == [VEZRAS]
    assert db.signals.count_documents({}) == 0 and db.ingest_runs.count_documents({}) == 0


def test_the_command_runs_the_news(companies, mongo_uri, monkeypatch, capsys):
    from leadengine import cli
    monkeypatch.setenv("MONGODB_URI", mongo_uri)
    monkeypatch.setenv("LEAD_DB", companies.name)
    monkeypatch.setattr(cli, "make_fetcher", lambda st, source: Fetcher({INC42: RSS}))
    cfg = _cfg()
    monkeypatch.setattr(news, "load_config", lambda: cfg)
    assert cli.main(["ingest", "news", "--dry-run"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["matched"] == 1 and companies.signals.count_documents({}) == 0
    assert cli.main(["ingest", "news"]) == 0
    assert companies.signals.count_documents({"status": "proposed"}) == 1

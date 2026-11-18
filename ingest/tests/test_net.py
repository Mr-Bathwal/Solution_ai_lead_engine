import pytest
import requests

from leadengine.net.fetcher import BudgetExhausted, Disallowed, PoliteFetcher, ResponseTooLarge
from leadengine.net.robots import RobotsCache, RobotsRules


class Resp:
    def __init__(self, status=200, text="", ctype="text/plain", headers=None, url="https://x.in/"):
        self.status_code, self.text, self.url = status, text, url
        self.content = text.encode()
        self.headers = {"content-type": ctype, **(headers or {})}

    def iter_content(self, size):
        for i in range(0, len(self.content), size):
            yield self.content[i:i + size]

    def close(self):
        pass


class FakeSession:
    """Answers robots.txt from `robots` and every other URL from `pages` (a list is consumed in order)."""

    def __init__(self, robots, pages=None):
        self.robots, self.pages, self.calls, self.headers, self.robots_kw = robots, pages or {}, [], {}, []

    def get(self, url, **kw):
        self.calls.append(("GET", url))
        self.robots_kw.append(kw)
        r = self.robots
        if isinstance(r, Exception):
            raise r
        return r

    def request(self, method, url, **kw):
        self.calls.append((method, url))
        p = self.pages[url]
        return p.pop(0) if isinstance(p, list) else p


UA = "SolutionAI-LeadEngine/1.0 (+https://solutionai.in)"


@pytest.mark.parametrize("robots, url, allowed", [
    (Resp(200, "User-agent: *\nDisallow: /wp-admin/\n"), "https://x.in/crm/page", True),
    (Resp(200, "User-agent: *\nDisallow: /wp-admin/\n"), "https://x.in/wp-admin/x", False),
    (Resp(200, "User-agent: SolutionAI-LeadEngine\nDisallow: /\n\nUser-agent: *\nAllow: /\n"), "https://x.in/a", False),
    (Resp(404, "nope"), "https://x.in/a", True),
    (Resp(410, ""), "https://x.in/a", True),
    (Resp(403, "blocked"), "https://x.in/a", False),
    (Resp(401, ""), "https://x.in/a", False),
    (Resp(429, ""), "https://x.in/a", False),
    (Resp(503, ""), "https://x.in/a", False),
    (requests.ConnectionError("dns"), "https://x.in/a", False),
    (Resp(200, "<html><body>Page Not Found</body></html>", ctype="text/html"), "https://x.in/a", True),
])
def test_robots_rules(robots, url, allowed):
    assert RobotsCache(FakeSession(robots), UA).allowed(url)[0] is allowed


def test_robots_cached_for_ttl_then_refetched():
    now = [0.0]
    s = FakeSession(Resp(200, "User-agent: *\nAllow: /\n"))
    rc = RobotsCache(s, UA, ttl_seconds=24 * 3600, clock=lambda: now[0])
    rc.allowed("https://x.in/a")
    rc.allowed("https://x.in/b")
    assert len(s.calls) == 1
    now[0] = 24 * 3600 + 1
    rc.allowed("https://x.in/c")
    assert len(s.calls) == 2


PUBLIC = "93.184.216.34"


def fake_resolver(table=None):
    """Every test host resolves to a public address unless `table` says otherwise; no real DNS."""
    def resolve(host, port, proto=0):
        return [(2, 1, 6, "", ((table or {}).get(host, PUBLIC), port))]
    return resolve


def make_fetcher(session, **kw):
    t = [0.0]
    slept = []

    def sleep(sec):
        slept.append(sec)
        t[0] += sec

    kw.setdefault("resolver", fake_resolver())
    f = PoliteFetcher(UA, session=session, clock=lambda: t[0], sleep=sleep, **kw)
    return f, slept


def test_gap_between_requests_to_one_host_including_robots():
    s = FakeSession(Resp(404), {"https://x.in/1": Resp(200, "a"), "https://x.in/2": Resp(200, "b"), "https://y.in/1": Resp(200, "c")})
    f, slept = make_fetcher(s, min_gap=2.0)
    f.get("https://x.in/1")   # robots.txt for x.in at t=0, then the page waits until t=2
    f.get("https://y.in/1")   # robots.txt for y.in at t=2, then the page waits until t=4
    f.get("https://x.in/2")   # x.in was last hit at t=2: the gap has already passed
    assert slept == [2.0, 2.0]


def test_crawl_delay_is_honoured():
    s = FakeSession(Resp(200, "User-agent: *\nCrawl-delay: 7\n"), {"https://x.in/1": Resp(200), "https://x.in/2": Resp(200)})
    f, slept = make_fetcher(s, min_gap=2.0)
    f.get("https://x.in/1")
    f.get("https://x.in/2")
    assert slept == [7.0, 7.0]   # robots.txt -> page 1 -> page 2, each 7 s apart


def test_disallowed_is_never_requested():
    s = FakeSession(Resp(200, "User-agent: *\nDisallow: /private\n"), {})
    f, _ = make_fetcher(s)
    with pytest.raises(Disallowed):
        f.get("https://x.in/private/data")
    assert ("GET", "https://x.in/private/data") not in s.calls
    assert f.stats.disallowed == 1


def test_retry_after_on_503():
    s = FakeSession(Resp(404), {"https://x.in/a": [Resp(503, headers={"Retry-After": "9"}), Resp(200, "ok")]})
    f, slept = make_fetcher(s, min_gap=0, retries=2)
    r = f.get("https://x.in/a")
    assert r.ok and r.text == "ok"
    assert 9.0 in slept and f.stats.retries == 1


def test_gives_up_after_retries_and_returns_the_error():
    s = FakeSession(Resp(404), {"https://x.in/a": [Resp(503), Resp(503), Resp(503)]})
    f, _ = make_fetcher(s, min_gap=0, retries=2)
    assert f.get("https://x.in/a").status == 503


def test_request_budget_counts_robots_txt_too():
    s = FakeSession(Resp(404), {"https://x.in/a": Resp(200)})
    f, _ = make_fetcher(s, min_gap=0, max_requests=3)
    f.get("https://x.in/a")          # robots.txt + the page: 2 of 3
    f.get("https://x.in/a")          # 3 of 3
    with pytest.raises(BudgetExhausted):
        f.get("https://x.in/a")
    assert f.stats.requests == 3 and f.stats.robots_requests == 1


# ---- RFC 9309 matching: the most specific rule wins ------------------------------------------

@pytest.mark.parametrize("robots, path, allowed", [
    ("User-agent: *\nAllow: /\nDisallow: /private\n", "/private/x", False),   # urllib.robotparser says True
    ("User-agent: *\nAllow: /\nDisallow: /private\n", "/public", True),
    ("User-agent: *\nDisallow: /\nAllow: /public\n", "/public/page", True),
    ("User-agent: *\nDisallow: /\nAllow: /public\n", "/other", False),
    ("User-agent: *\nDisallow: /*.pdf$\n", "/docs/a.pdf", False),
    ("User-agent: *\nDisallow: /*.pdf$\n", "/docs/a.pdf?download=1", True),
    ("User-agent: *\nDisallow: /api/*/private\n", "/api/v1/private/x", False),
    ("User-agent: *\nAllow: /page\nDisallow: /page\n", "/page", False),        # a tie goes to Disallow
    ("User-agent: *\nDisallow:\n", "/anything", True),                         # empty Disallow
    ("User-agent: *\nDisallow: /\n", "/robots.txt", True),                     # always readable
    ("User-agent: SolutionAI\nDisallow: /x\n\nUser-agent: *\nDisallow: /\n", "/y", True),
    ("User-agent: SolutionAI\nDisallow: /x\n\nUser-agent: *\nDisallow: /\n", "/x", False),
    ("User-agent: googlebot\nDisallow: /\n", "/a", True),                       # not our group
    ("User-agent: a\nUser-agent: *\nDisallow: /b\nUser-agent: c\nDisallow: /\n", "/b", False),
    ("User-agent: *\nDisallow: /b\n\nUser-agent: *\nDisallow: /c\n", "/c", False),  # groups combine
    ("User-agent: *\nDisallow: /caf%C3%A9\n", "/café", False),                 # percent-encoding
])
def test_rfc9309_matching(robots, path, allowed):
    assert RobotsRules.parse(robots).allowed("SolutionAI-LeadEngine", "https://x.in" + path) is allowed


def test_a_redirect_to_a_disallowed_path_is_refused_before_it_is_requested():
    s = FakeSession(Resp(200, "User-agent: *\nDisallow: /private\n"),
                    {"https://x.in/a": Resp(302, headers={"Location": "/private/b"})})
    f, _ = make_fetcher(s, min_gap=0)
    with pytest.raises(Disallowed):
        f.get("https://x.in/a")
    assert ("GET", "https://x.in/private/b") not in s.calls


def test_redirects_are_followed_and_reported():
    s = FakeSession(Resp(404), {"https://x.in/a": Resp(301, headers={"Location": "https://x.in/b"}, url="https://x.in/a"),
                                "https://x.in/b": Resp(200, "here", url="https://x.in/b")})
    f, _ = make_fetcher(s, min_gap=0)
    r = f.get("https://x.in/a")
    assert r.ok and r.text == "here" and r.url == "https://x.in/a" and r.final_url == "https://x.in/b"
    assert f.stats.redirects == 1


def test_size_limit():
    s = FakeSession(Resp(404), {"https://x.in/big": Resp(200, "x" * 5000)})
    f, _ = make_fetcher(s, min_gap=0, max_bytes=1000)
    with pytest.raises(ResponseTooLarge):
        f.get("https://x.in/big")
    assert issubclass(ResponseTooLarge, requests.RequestException), "callers that skip a bad page skip this one too"


def test_retry_after_as_an_http_date():
    from datetime import datetime, timedelta, timezone
    from email.utils import format_datetime
    when = format_datetime(datetime.now(timezone.utc) + timedelta(seconds=30), usegmt=True)
    assert 25 <= PoliteFetcher._backoff(1, when) <= 30
    zoneless = when.replace("GMT", "-0000")         # parses without a time zone; it still means UTC
    assert 25 <= PoliteFetcher._backoff(1, zoneless) <= 30


# ---- where the crawler may go -----------------------------------------------------------------

@pytest.mark.parametrize("target", ["127.0.0.1", "10.0.0.5", "169.254.169.254", "::1", "192.168.1.1"])
def test_a_redirect_into_a_non_public_address_is_refused_before_it_is_requested(target):
    s = FakeSession(Resp(404), {"https://x.in/a": Resp(302, headers={"Location": "http://internal.x.in/latest/meta-data"})})
    f, _ = make_fetcher(s, min_gap=0, resolver=fake_resolver({"internal.x.in": target}))
    with pytest.raises(Disallowed, match="non-public"):
        f.get("https://x.in/a")
    assert not any("internal" in u for _, u in s.calls)


def test_ip_literals_and_other_schemes_are_refused():
    f, _ = make_fetcher(FakeSession(Resp(404)), min_gap=0)
    for url in ("http://169.254.169.254/latest/meta-data", "http://[::1]/", "file:///etc/passwd", "ftp://x.in/a"):
        with pytest.raises(Disallowed):
            f.get(url)


def test_never_crawl_list_beats_a_permissive_robots_txt():
    s = FakeSession(Resp(200, "User-agent: *\nAllow: /\n"), {"https://api.startupindia.gov.in/x": Resp(200)})
    f, _ = make_fetcher(s, min_gap=0, blocked_hosts=frozenset({"startupindia.gov.in"}))
    with pytest.raises(Disallowed, match="never-crawl"):
        f.get("https://api.startupindia.gov.in/x")
    assert s.calls == [], "not even robots.txt is fetched"


def test_robots_is_checked_against_the_query_string_from_params():
    s = FakeSession(Resp(200, "User-agent: *\nDisallow: /*?page=\n"), {})
    f, _ = make_fetcher(s, min_gap=0)
    with pytest.raises(Disallowed):
        f.get("https://x.in/list", params={"page": 2})


def test_too_many_redirects_is_an_error_not_a_302():
    pages = {f"https://x.in/{i}": Resp(302, headers={"Location": f"/{i + 1}"}, url=f"https://x.in/{i}") for i in range(10)}
    f, _ = make_fetcher(FakeSession(Resp(404), pages), min_gap=0)
    with pytest.raises(requests.TooManyRedirects):
        f.get("https://x.in/0")


def test_a_prefix_of_our_token_does_not_name_us():
    rules = RobotsRules.parse("User-agent: S\nAllow: /\n\nUser-agent: *\nDisallow: /\n")
    assert rules.allowed("SolutionAI-LeadEngine", "https://x.in/a") is False


def test_robots_txt_is_read_in_a_stream_and_cut_at_500_kib():
    from leadengine.net.robots import MAX_ROBOTS_BYTES

    class Endless(Resp):
        read = 0

        def iter_content(self, size):
            while True:
                Endless.read += size
                yield b"# filler line\n" * (size // 14)

    rc = RobotsCache(FakeSession(Endless(200, "")), UA)
    assert rc.allowed("https://x.in/a")[0]
    assert Endless.read <= MAX_ROBOTS_BYTES + 64 * 1024


def test_robots_txt_for_an_insecure_host_skips_certificate_checks_only_there():
    s = FakeSession(Resp(404), {"https://bad-cert.in/a": Resp(200), "https://x.in/a": Resp(200)})
    f, _ = make_fetcher(s, min_gap=0, insecure_hosts=frozenset({"bad-cert.in"}))
    f.get("https://bad-cert.in/a")
    f.get("https://x.in/a")
    assert [kw["verify"] for kw in s.robots_kw] == [False, True]

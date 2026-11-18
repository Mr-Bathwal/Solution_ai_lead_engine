"""The only way ingestion talks to the web.

Every request:
  - goes only to http(s) URLs on public addresses: the host is resolved on every hop and refused if
    it points at a loopback, private, link-local (cloud metadata) or other non-public address, so a
    portal page cannot redirect the crawler into our own network; hosts on the never-crawl list
    (crawl.blocked_hosts, e.g. the Startup India API) are refused whatever their robots.txt says;
  - is checked against robots.txt first (see robots.py), with its query string, and refused if not
    allowed; so is every redirect hop, because a permitted URL may redirect to one that is not;
  - waits so that requests to one host start at least `min_gap` seconds apart (or the site's
    Crawl-delay, if larger); fetching robots.txt counts as a request to that host;
  - identifies itself honestly with our user agent;
  - is retried a few times on 429/502/503/504 or a dropped connection, with backoff that honours
    Retry-After (seconds or an HTTP date);
  - counts against a per-run request budget (robots.txt fetches included), so a bug cannot turn into
    a flood;
  - is read up to a size limit, so one huge file cannot exhaust the machine's memory.
No logins, no cookies carried between sites, no CAPTCHA handling.

The address check resolves the name just before the request; it does not pin the connection to that
address, so a hostile DNS server could still answer differently a moment later (DNS rebinding). The
check closes the ordinary redirect route, which is the one portal HTML can open.
"""
import ipaddress
import socket
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urljoin, urlsplit

import requests
from requests.models import PreparedRequest

from .robots import RobotsCache

RETRY_STATUS = {429, 502, 503, 504}
REDIRECT_STATUS = {301, 302, 303, 307, 308}
MAX_REDIRECTS = 5
SCHEMES = {"http", "https"}


class Disallowed(Exception):
    """robots.txt (or our own stricter reading of it), the never-crawl list or the address check says no."""


class BudgetExhausted(Exception):
    """The run used up its request budget."""


class ResponseTooLarge(requests.RequestException):
    """The response body passed the size limit. A RequestException, so callers that skip one bad
    page on a network error skip this page too."""


@dataclass
class FetchResult:
    url: str
    final_url: str
    status: int
    content: bytes
    content_type: str
    fetched_at: datetime
    elapsed_s: float

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300

    @property
    def text(self) -> str:
        return self.content.decode("utf-8", errors="replace")

    def json(self):
        import json
        return json.loads(self.content)


@dataclass
class FetchStats:
    requests: int = 0
    robots_requests: int = 0
    retries: int = 0
    redirects: int = 0
    disallowed: int = 0
    errors: int = 0
    by_status: dict = field(default_factory=dict)


def _public(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    ip = getattr(ip, "ipv4_mapped", None) or ip
    return ip.is_global and not ip.is_multicast


class PoliteFetcher:
    def __init__(self, user_agent: str, *, min_gap: float = 2.0, timeout: float = 40, retries: int = 2,
                 max_requests: int = 3000, robots_ttl: float = 24 * 3600, insecure_hosts: frozenset = frozenset(),
                 blocked_hosts: frozenset = frozenset(), max_bytes: int = 25 * 1024 * 1024,
                 session: requests.Session | None = None, allow_private: bool = False, resolver=socket.getaddrinfo,
                 clock=time.monotonic, sleep=time.sleep):
        self.user_agent = user_agent
        self.min_gap = min_gap
        self.timeout = timeout
        self.retries = retries
        self.max_requests = max_requests
        self.max_bytes = max_bytes
        self.insecure_hosts = frozenset(h.lower() for h in insecure_hosts)
        self.blocked_hosts = frozenset(h.lower().strip(".") for h in blocked_hosts)
        self.allow_private = allow_private      # only for tests against a local server
        self.resolver = resolver
        self.session = session or requests.Session()
        self.session.headers.update({"User-Agent": user_agent, "Accept-Language": "en-IN,en;q=0.9"})
        self.clock = clock
        self.sleep = sleep
        self._last: dict[str, float] = {}
        self.stats = FetchStats()
        self.robots = RobotsCache(self.session, user_agent, ttl_seconds=robots_ttl, before_fetch=self._robots_request,
                                  verify=lambda host: host not in self.insecure_hosts, guard=self.check_target)

    def get(self, url: str, *, params: dict | None = None, headers: dict | None = None) -> FetchResult:
        return self._request("GET", url, params=params, headers=headers)

    def post_json(self, url: str, body, *, headers: dict | None = None) -> FetchResult:
        return self._request("POST", url, json=body, headers=headers)

    def check_target(self, url: str):
        """Refuses anything but http(s) to a public address, and hosts on the never-crawl list."""
        parts = urlsplit(url)
        host = (parts.hostname or "").lower().strip(".")
        if parts.scheme.lower() not in SCHEMES or not host:
            raise Disallowed(f"{url}: only http and https URLs with a host are fetched")
        if any(host == b or host.endswith("." + b) for b in self.blocked_hosts):
            raise Disallowed(f"{url}: {host} is on the never-crawl list (crawl.blocked_hosts in caps.json)")
        if self.allow_private:
            return
        try:
            addrs = {ipaddress.ip_address(host)}
        except ValueError:
            port = parts.port or (443 if parts.scheme.lower() == "https" else 80)
            try:
                addrs = {ipaddress.ip_address(ai[4][0].split("%")[0]) for ai in self.resolver(host, port, proto=socket.IPPROTO_TCP)}
            except (socket.gaierror, UnicodeError):
                return      # the name does not resolve: the request itself fails as a connection error
        bad = sorted(str(a) for a in addrs if not _public(a))
        if bad:
            raise Disallowed(f"{url}: {host} resolves to a non-public address ({', '.join(bad)})")

    def _spend(self):
        if self.stats.requests >= self.max_requests:
            raise BudgetExhausted(f"request budget of {self.max_requests} used up")
        self.stats.requests += 1

    def _robots_request(self, netloc: str):
        """robots.txt fetches are paced and budgeted like any other request to the host."""
        self._spend()
        self.stats.robots_requests += 1
        self._wait(netloc.lower(), self.min_gap)

    def _request(self, method: str, url: str, **kw) -> FetchResult:
        params = kw.pop("params", None)
        if params:      # put the query string into the URL, so robots.txt is checked against all of it
            p = PreparedRequest()
            p.prepare_url(url, params)
            url = p.url
        first, t0 = url, time.monotonic()
        for _hop in range(MAX_REDIRECTS + 1):
            status, headers, content, final = self._one(method, url, **kw)
            location = headers.get("location") or headers.get("Location")
            if status not in REDIRECT_STATUS or not location:
                break
            self.stats.redirects += 1
            url = urljoin(final, location)
            if status == 303 or (status in (301, 302) and method == "POST"):
                method, kw = "GET", {k: v for k, v in kw.items() if k != "json"}   # what browsers do
        else:
            raise requests.TooManyRedirects(f"{first}: more than {MAX_REDIRECTS} redirects")
        return FetchResult(url=first, final_url=final, status=status, content=content,
                           content_type=headers.get("content-type", ""),
                           fetched_at=datetime.now(timezone.utc), elapsed_s=time.monotonic() - t0)

    def _one(self, method: str, url: str, **kw):
        """One URL, without following redirects: address and robots checks, pacing, retries, size limit."""
        try:
            self.check_target(url)
        except Disallowed:
            self.stats.disallowed += 1
            raise
        ok, why = self.robots.allowed(url)
        if not ok:
            self.stats.disallowed += 1
            raise Disallowed(f"{url}: {why}")
        host = urlsplit(url).netloc.lower()
        gap = max(self.min_gap, self.robots.crawl_delay(url) or 0)
        verify = urlsplit(url).hostname not in self.insecure_hosts
        attempt = 0
        while True:
            self._spend()
            self._wait(host, gap)
            try:
                r = self.session.request(method, url, timeout=self.timeout, verify=verify,
                                         allow_redirects=False, stream=True, **kw)
            except (requests.ConnectionError, requests.Timeout) as exc:
                self.stats.errors += 1
                if attempt >= self.retries:
                    raise
                attempt += 1
                self.stats.retries += 1
                self.sleep(self._backoff(attempt, None))
                continue
            self.stats.by_status[r.status_code] = self.stats.by_status.get(r.status_code, 0) + 1
            if r.status_code in RETRY_STATUS and attempt < self.retries:
                attempt += 1
                self.stats.retries += 1
                r.close()
                self.sleep(self._backoff(attempt, r.headers.get("Retry-After")))
                continue
            return r.status_code, r.headers, self._read(r, url), getattr(r, "url", url) or url

    def _read(self, r, url: str) -> bytes:
        declared = r.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > self.max_bytes:
            r.close()
            raise ResponseTooLarge(f"{url}: {declared} bytes declared, limit {self.max_bytes}")
        chunks, size = [], 0
        for chunk in r.iter_content(64 * 1024):
            size += len(chunk)
            if size > self.max_bytes:
                r.close()
                raise ResponseTooLarge(f"{url}: more than {self.max_bytes} bytes")
            chunks.append(chunk)
        return b"".join(chunks)

    def _wait(self, host: str, gap: float):
        last = self._last.get(host)
        if last is not None:
            wait = gap - (self.clock() - last)
            if wait > 0:
                self.sleep(wait)
        self._last[host] = self.clock()

    @staticmethod
    def _backoff(attempt: int, retry_after: str | None) -> float:
        if retry_after:
            ra = retry_after.strip()
            if ra.isdigit():
                return min(float(ra), 300.0)
            try:   # Retry-After may also be an HTTP date ("-0000" parses without a zone: it means UTC)
                when = parsedate_to_datetime(ra)
                when = when if when.tzinfo else when.replace(tzinfo=timezone.utc)
                return min(max((when - datetime.now(timezone.utc)).total_seconds(), 0.0), 300.0)
            except (TypeError, ValueError):
                pass
        return min(5.0 * 2 ** (attempt - 1), 120.0)

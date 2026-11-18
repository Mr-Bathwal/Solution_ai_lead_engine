"""robots.txt, read the way RFC 9309 describes, but erring on the side of not crawling.

  2xx            -> parse and obey the rules (and any Crawl-delay)
  404, 410, other 4xx -> no robots.txt: crawling is allowed
  401, 403       -> the server is refusing us: treated as "do not crawl" (stricter than the RFC)
  429, 5xx, timeout, DNS or TLS failure -> unreachable: "do not crawl"

Redirects are followed by hand (up to five), each hop passing the fetcher's address check, and the
file is read in a stream up to 500 KiB. Fetching it is paced and counted like any other request.
Each host's answer is cached for at most 24 hours.

The rules are matched by our own parser, not urllib.robotparser, because the standard library
applies the first rule that matches rather than the most specific one, and does not understand
the * and $ wildcards. Under it, "Allow: /" followed by "Disallow: /private" would let us into
/private. Here, as RFC 9309 section 2.2.2 requires, the longest matching rule wins. Where an Allow
and a Disallow rule are equally long, the RFC prefers Allow; we prefer Disallow.
"""
import re
import time
from dataclasses import dataclass, field
from typing import Callable
from urllib.parse import unquote, urljoin, urlsplit

import requests

MAX_ROBOTS_BYTES = 500 * 1024   # RFC 9309 section 2.5: parse at least 500 KiB; anything beyond is ignored
MAX_REDIRECTS = 5               # RFC 9309 section 2.3.1.2: follow at least five redirects


@dataclass(frozen=True)
class Rule:
    allow: bool
    pattern: str
    rx: re.Pattern

    @classmethod
    def make(cls, allow: bool, pattern: str) -> "Rule":
        p = unquote(pattern)
        anchored = p.endswith("$")
        body = re.escape(p[:-1] if anchored else p).replace(r"\*", ".*")
        return cls(allow, p, re.compile(body + ("$" if anchored else ""), re.S))

    def matches(self, path: str) -> bool:
        return bool(self.rx.match(path))


@dataclass
class RobotsRules:
    """The parsed groups of one robots.txt file."""
    groups: list = field(default_factory=list)   # [(set of lower-cased agents, [Rule], crawl_delay or None)]

    @classmethod
    def parse(cls, text: str) -> "RobotsRules":
        groups, agents, rules, delay, in_rules = [], set(), [], None, False

        def close():
            if agents:
                groups.append((set(agents), list(rules), delay))

        for raw in text.lstrip("﻿").splitlines():
            line = raw.split("#", 1)[0].strip()
            if ":" not in line:
                continue
            key, _, value = line.partition(":")
            key, value = key.strip().lower(), value.strip()
            if key == "user-agent":
                if in_rules:                 # a user-agent line after rules starts a new group
                    close()
                    agents, rules, delay, in_rules = set(), [], None, False
                agents.add(value.lower())
            elif key in ("allow", "disallow"):
                in_rules = True
                if value:                    # "Disallow:" with no path disallows nothing
                    rules.append(Rule.make(key == "allow", value))
            elif key == "crawl-delay":
                in_rules = True
                try:
                    delay = max(delay or 0.0, float(value))
                except ValueError:
                    pass
        close()
        return cls(groups)

    def _for(self, token: str) -> tuple[list, float | None]:
        """Rules and crawl delay for our product token. Every group naming us is combined; if none
        does, every '*' group is. A group naming our whole token or one of its hyphen-separated
        parts ("SolutionAI") counts as naming us; a mere prefix such as "S" does not."""
        token = token.lower()

        def names_us(a):
            return a not in ("", "*") and (a == token or a in token.split("-"))

        mine = [g for g in self.groups if any(names_us(a) for a in g[0])]
        chosen = mine or [g for g in self.groups if "*" in g[0]]
        rules = [r for g in chosen for r in g[1]]
        delays = [g[2] for g in chosen if g[2] is not None]
        return rules, (max(delays) if delays else None)

    def allowed(self, token: str, url: str) -> bool:
        parts = urlsplit(url)
        path = unquote(parts.path or "/") + (f"?{unquote(parts.query)}" if parts.query else "")
        if path == "/robots.txt":
            return True
        best = None
        for r in self._for(token)[0]:
            if r.matches(path):
                longer = best is None or len(r.pattern) > len(best.pattern)
                tie_goes_to_disallow = best is not None and len(r.pattern) == len(best.pattern) and not r.allow
                if longer or tie_goes_to_disallow:
                    best = r
        return best is None or best.allow

    def crawl_delay(self, token: str) -> float | None:
        return self._for(token)[1]


@dataclass
class RobotsEntry:
    mode: str                      # "rules", "allow_all" or "deny_all"
    reason: str
    fetched_at: float
    rules: RobotsRules | None = field(default=None, repr=False)


class _Refused(Exception):
    """The fetcher's address check refused a robots.txt hop."""


def origin_of(url: str) -> str:
    p = urlsplit(url)
    return f"{p.scheme}://{p.netloc}".lower()


class RobotsCache:
    def __init__(self, session: requests.Session, user_agent: str, ttl_seconds: float = 24 * 3600,
                 timeout: float = 20, clock=time.time, before_fetch: Callable[[str], None] | None = None,
                 verify: Callable[[str], bool] = lambda host: True, guard: Callable[[str], None] | None = None):
        self.session = session
        self.user_agent = user_agent
        self.agent_token = user_agent.split("/")[0].split()[0]
        self.ttl = ttl_seconds
        self.timeout = timeout
        self.clock = clock
        self.before_fetch = before_fetch     # lets the fetcher pace and count robots.txt requests like any other
        self.verify = verify                 # False for hosts whose TLS certificate is not checked (INSECURE_HOSTS)
        self.guard = guard                   # the fetcher's address check, run on every robots.txt hop too
        self._cache: dict[str, RobotsEntry] = {}

    def entry(self, url: str) -> RobotsEntry:
        origin = origin_of(url)
        e = self._cache.get(origin)
        if e is None or self.clock() - e.fetched_at > self.ttl:
            e = self._cache[origin] = self._load(origin)
        return e

    def allowed(self, url: str) -> tuple[bool, str]:
        e = self.entry(url)
        if e.mode == "allow_all":
            return True, e.reason
        if e.mode == "deny_all":
            return False, e.reason
        ok = e.rules.allowed(self.agent_token, url)
        return ok, "allowed by robots.txt" if ok else "disallowed by robots.txt"

    def crawl_delay(self, url: str) -> float | None:
        e = self.entry(url)
        return e.rules.crawl_delay(self.agent_token) if e.mode == "rules" else None

    def _get(self, url: str):
        """robots.txt, following up to five redirects by hand (RFC 9309 section 2.3.1.2) so that every
        hop passes the fetcher's address check; read in a stream and cut at MAX_ROBOTS_BYTES."""
        for _hop in range(MAX_REDIRECTS + 1):
            host = urlsplit(url).hostname or ""
            if self.guard:
                try:
                    self.guard(url)
                except Exception as exc:
                    raise _Refused(str(exc)) from exc
            if self.before_fetch:
                self.before_fetch(urlsplit(url).netloc)
            r = self.session.get(url, timeout=self.timeout, allow_redirects=False, stream=True,
                                 verify=self.verify(host.lower()), headers={"User-Agent": self.user_agent})
            location = r.headers.get("location") or r.headers.get("Location")
            if r.status_code in (301, 302, 303, 307, 308) and location:
                r.close()
                url = urljoin(url, location)
                continue
            body, size = [], 0
            for chunk in r.iter_content(64 * 1024):
                body.append(chunk)
                size += len(chunk)
                if size >= MAX_ROBOTS_BYTES:
                    break
            r.close()
            return r, b"".join(body)[:MAX_ROBOTS_BYTES]
        raise requests.TooManyRedirects(f"robots.txt redirected more than {MAX_REDIRECTS} times")

    def _load(self, origin: str) -> RobotsEntry:
        now = self.clock()
        try:
            r, content = self._get(origin + "/robots.txt")
        except requests.RequestException as exc:
            return RobotsEntry("deny_all", f"robots.txt unreachable ({type(exc).__name__})", now)
        except _Refused as exc:       # the fetcher's address check refused a hop
            return RobotsEntry("deny_all", f"robots.txt not fetched: {exc}", now)
        if 200 <= r.status_code < 300:
            text = content.decode("utf-8", errors="replace")
            if "html" in r.headers.get("content-type", "").lower() and "<html" in text[:500].lower():
                # some servers answer every path with an HTML page; that is not a robots file
                return RobotsEntry("allow_all", "robots.txt is an HTML page, so there are no rules", now)
            return RobotsEntry("rules", "robots.txt rules", now, RobotsRules.parse(text))
        if r.status_code in (401, 403):
            return RobotsEntry("deny_all", f"robots.txt answered {r.status_code}: the server is refusing us", now)
        if r.status_code == 429 or r.status_code >= 500:
            return RobotsEntry("deny_all", f"robots.txt answered {r.status_code}: treated as unreachable", now)
        return RobotsEntry("allow_all", f"no robots.txt ({r.status_code})", now)

"""Funding news as signals (design 7.1: "Funding news comes from RSS feeds and the free GDELT news
stream, matched to companies by name"; 7.4 lists "funding announced" as a signal).

Each morning the feeds in config/news.json and one GDELT query are read through the polite fetcher.
A headline goes further only if it reads as funding news (config `funding_words`). The company is
looked for in the headline itself: the words before the first funding verb ("raises", "secures",
"bags", ...), tried as the last six words, then five, and so on down to one, each cleaned the way
company names are cleaned (names.normalize_name). A candidate counts only if its cleaned key equals
the stored key (companies.name_norm, or the portal brand cleaned the same way) of exactly one company.
A key shared by two companies is skipped and counted, never guessed.

What is kept is deliberately little, and only for a match: the headline, the link, the publisher and
the date, as a *proposed* signal. A person confirms or rejects it in the Admin pages (Signals); nothing
acts on a signal by itself. News that matched no company, and the text of any article, are never stored.

Feeds are XML from outside, so they are parsed with entity expansion, network access and huge trees
all turned off: a feed cannot make the parser read a local file or expand a "billion laughs" payload.
"""
import hashlib
import html
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import requests
from lxml import etree
from pymongo.errors import DuplicateKeyError

from .config import ROOT
from .names import normalize_name
from .net.fetcher import BudgetExhausted, Disallowed
from .sink import MongoSink, new_run_id

NEWS_CONFIG = ROOT / "config" / "news.json"
GDELT_URL = "https://api.gdeltproject.org/api/v2/doc/doc"
SOURCE = "news"                     # ingest_runs.source, so Data health shows the morning's run

# The verbs that end a company name in a funding headline: "Vezras Raises ₹5 Cr", "Noida-based X bags $2M".
VERBS = re.compile(r"\b(?:raises|raised|secures|bags|lands|closes|gets|receives|picks\s+up|nets|snags)\b", re.I)
# A headline often has a section before the story: "Exclusive: X raises", "Funding | X raises", "Roundup – X raises".
SECTION = re.compile(r"\s*(?::|\||\s[-–—]\s)\s*")
# "Lucknow-based", "Info Edge-backed": the words up to and including one of these describe the company.
DESCRIBES = re.compile(r"^[\w.&'-]+-(?:based|backed|headquartered|founded|born)$", re.I)
EDGE = " \t,;:.!?'\"‘’“”()[]{}«»"
MAX_WORDS = 6
MIN_KEY = 5                         # shorter keys ("abc") match too many unrelated names
HEADLINE_MAX = 300
LEFTOVER_ENTITY = re.compile(r"&[A-Za-z_][\w.-]*;")
TAG = re.compile(r"<[^>]{0,200}>")
QUERY = re.compile(r"\?[^\s:]*")
FETCH_ERRORS = (Disallowed, BudgetExhausted, requests.RequestException, etree.XMLSyntaxError, ValueError)


def load_config(path=NEWS_CONFIG) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


@dataclass(frozen=True)
class Item:
    title: str
    url: str
    published_at: datetime | None
    publisher: str


# ---- reading feeds -----------------------------------------------------------------------------------

def _parser():
    # resolve_entities=False: an entity is left as a reference, never expanded or read from a file;
    # no_network: nothing a feed names is fetched; huge_tree=False keeps libxml2's size limits.
    return etree.XMLParser(resolve_entities=False, no_network=True, huge_tree=False)


def _local(el) -> str:
    return etree.QName(el).localname if isinstance(el.tag, str) else ""


def _text(el) -> str:
    """An element's text on one line: entities left unexpanded by the safe parser are dropped, and a
    headline sent as escaped HTML (Atom type="html") loses its tags."""
    if el is None:
        return ""
    s = html.unescape("".join(el.itertext()))
    s = TAG.sub(" ", LEFTOVER_ENTITY.sub("", s))
    return " ".join(s.split())


def web_url(u: str) -> str | None:
    """An http(s) link without its tracking parameters and fragment, or None. The same story reached
    through two feeds then has one URL, and so one signal."""
    u = (u or "").strip()
    try:
        p = urlsplit(u)
    except ValueError:
        return None
    if p.scheme.lower() not in ("http", "https") or not p.hostname:
        return None
    query = urlencode([(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True) if not k.lower().startswith("utm_")])
    return urlunsplit((p.scheme.lower(), p.netloc, p.path, query, ""))


def _date(s: str) -> datetime | None:
    s = (s or "").strip()
    if not s:
        return None
    for parse in (parsedate_to_datetime, datetime.fromisoformat):       # RSS's RFC 822, Atom's ISO 8601
        try:
            d = parse(s)
        except (TypeError, ValueError, IndexError):
            continue
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    return None


def _link(el) -> str:
    """Atom's <link rel="alternate" href>, or RSS's <link>text</link>; an RSS item may carry an
    atom:link as well, so neither is assumed to come first."""
    links = [c for c in el if _local(c) == "link"]
    for c in links:
        if c.get("href") and c.get("rel", "alternate") == "alternate":
            return c.get("href")
    return next((_text(c) for c in links if _text(c)), "")


def parse_feed(content: bytes, publisher: str) -> list[Item]:
    """RSS 2.0 (channel/item) or Atom (entry) items with a title and an http(s) link. Raises
    XMLSyntaxError for what is not XML, and ValueError for XML that is not a feed."""
    root = etree.fromstring(content, _parser())
    kind = _local(root)
    if kind not in ("rss", "feed", "RDF"):
        raise ValueError(f"not an RSS or Atom feed (root element <{kind}>)")
    out = []
    for el in root.iter():
        name = _local(el)
        if name not in ("item", "entry"):
            continue
        child = {}
        for c in el:
            child.setdefault(_local(c), c)
        title = _text(child.get("title"))
        url = web_url(_link(el))
        if not title or not url:
            continue
        when = next((_date(_text(child[k])) for k in ("pubDate", "published", "updated", "date") if k in child), None)
        out.append(Item(title, url, when, publisher))
    return out


def gdelt_params(g: dict) -> dict:
    return {"query": g["query"], "mode": "artlist", "format": "json", "maxrecords": int(g.get("max_records", 75)),
            "timespan": g.get("timespan", "1d")}


def parse_gdelt(content: bytes) -> list[Item]:
    """GDELT DOC 2.0 `artlist` JSON. An empty answer (GDELT sends `{}` or nothing when no article
    matched) is no articles; an answer that is not JSON raises ValueError."""
    if not content.strip():
        return []
    data = json.loads(content)
    out = []
    for a in (data.get("articles") or []) if isinstance(data, dict) else []:
        if not isinstance(a, dict):
            continue
        title = " ".join(html.unescape(str(a.get("title") or "")).split())
        url = web_url(str(a.get("url") or ""))
        if not title or not url:
            continue
        try:
            when = datetime.strptime(str(a.get("seendate") or ""), "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
        except ValueError:
            when = None
        out.append(Item(title, url, when, str(a.get("domain") or urlsplit(url).hostname or "GDELT")))
    return out


# ---- matching headlines to companies --------------------------------------------------------------

def candidates(title: str) -> list[tuple[str, str]]:
    """(the headline's words, their cleaned key) for each name the headline may give, longest first.
    Empty when the headline has no funding verb."""
    m = VERBS.search(title)
    if not m:
        return []
    before = SECTION.split(title[:m.start()])[-1]
    words = [w.strip(EDGE) for w in before.split()]
    words = [w for w in words if w]
    for i in range(len(words) - 1, -1, -1):
        if DESCRIBES.match(words[i]):
            words = words[i + 1:]
            break
    out, seen = [], set()
    for n in range(min(MAX_WORDS, len(words)), 0, -1):
        fragment = " ".join(words[-n:])
        k = normalize_name(fragment)
        if not k.core or len(k.key) < MIN_KEY or k.key in seen:
            continue
        seen.add(k.key)
        out.append((fragment, k.key))
    return out


class NameLookup:
    """Exact lookups of cleaned names: companies.name_norm (indexed), and the portal brands cleaned
    the same way (read once per run; only companies linked to a portal startup have one)."""

    def __init__(self, db):
        self.db = db
        self.brands: dict[str, set] = {}
        for c in db.companies.find({"attrs.brand.value": {"$type": "string"}}, {"attrs.brand.value": 1}):
            k = normalize_name(c["attrs"]["brand"]["value"])
            if k.core and len(k.key) >= MIN_KEY:
                self.brands.setdefault(k.key, set()).add(c["_id"])

    def ids(self, key: str) -> set:
        named = {c["_id"] for c in self.db.companies.find({"name_norm": key}, {"_id": 1}).limit(3)}
        return named | self.brands.get(key, set())


def match(lookup: NameLookup, title: str) -> tuple[str | None, str | None, str | None]:
    """("matched", fragment, company id), ("ambiguous", fragment, None) or (None, None, None).
    The longest candidate that names any company decides: a shorter one is less specific, so it is
    never tried after a longer one named a company ("Gomti Agro Foods" must not fall back to "Agro Foods").
    When no longer one names a company, a shorter one is tried ("Fintech Startup Vezras" comes down to
    "Vezras"). That is also how news about a company we do not hold can land on one named by its last
    words, which is why the Signals page shows the matched words beside the headline for the person deciding."""
    for fragment, key in candidates(title):
        ids = lookup.ids(key)
        if len(ids) == 1:
            return "matched", fragment, next(iter(ids))
        if ids:
            return "ambiguous", fragment, None
    return None, None, None


def signal_id(url: str) -> str:
    return "news:" + hashlib.sha256(url.encode("utf-8")).hexdigest()[:40]


def signal_doc(item: Item, company_id: str, fragment: str, now: datetime) -> dict:
    return {"_id": signal_id(item.url), "type": "funding", "company_id": company_id, "headline": item.title[:HEADLINE_MAX],
            "url": item.url, "publisher": item.publisher[:100], "published_at": item.published_at, "matched_name": fragment[:200],
            "status": "proposed", "created_at": now, "decided_by": None, "decided_at": None, "note": None}


# ---- the run ---------------------------------------------------------------------------------------

def _read(fetcher, url: str, *, params: dict | None = None):
    r = fetcher.get(url, params=params) if params else fetcher.get(url)
    if not r.ok:
        raise ValueError(f"HTTP {r.status}")
    return r.content


def collect(fetcher, cfg: dict, stats: dict, failures: list) -> list[Item]:
    """Every item from every source. A source that fails (robots.txt, the budget, the network, a
    page that is not a feed) is counted and skipped; the others are still read."""
    items = []
    sources = [(f["name"], lambda f=f: parse_feed(_read(fetcher, f["url"]), f["name"])) for f in cfg.get("feeds", [])]
    g = cfg.get("gdelt") or {}
    if g.get("enabled"):
        sources.append(("GDELT", lambda: parse_gdelt(_read(fetcher, GDELT_URL, params=gdelt_params(g)))))
    for name, read in sources:
        try:
            got = read()
        except FETCH_ERRORS as exc:
            stats["feeds_failed"] += 1
            # the reason comes after the URL, and GDELT's query string alone is longer than a note
            failures.append(f"{name}: {type(exc).__name__}: {QUERY.sub('?…', str(exc))}"[:300])
            continue
        stats["feeds_read"] += 1
        items.extend(got)
    return items


def run(db, fetcher, cfg: dict | None = None, *, dry_run: bool = False, clock=lambda: datetime.now(timezone.utc)) -> dict:
    """Reads the news and proposes signals. Returns the counts, the sources that failed, and (on a dry
    run, which writes nothing) the matches it would have proposed. A real run is recorded in ingest_runs."""
    cfg = cfg or load_config()
    funding = re.compile(cfg["funding_words"], re.I)
    stats = dict.fromkeys(("feeds_read", "feeds_failed", "items", "funding_items", "matched", "ambiguous", "signals_new"), 0)
    failures, proposed = [], []
    run_id = new_run_id(SOURCE)
    if not dry_run:
        MongoSink(db).start_run(run_id, SOURCE, {"feeds": [f["name"] for f in cfg.get("feeds", [])],
                                                 "gdelt": bool((cfg.get("gdelt") or {}).get("enabled"))})
    try:
        items = collect(fetcher, cfg, stats, failures)
        lookup = NameLookup(db)
        now = clock()
        seen = set()
        for it in items:
            if it.url in seen:
                continue
            seen.add(it.url)
            stats["items"] += 1
            if not funding.search(it.title):
                continue
            stats["funding_items"] += 1
            outcome, fragment, company_id = match(lookup, it.title)
            if outcome == "ambiguous":
                stats["ambiguous"] += 1
            if outcome != "matched":
                continue
            stats["matched"] += 1
            doc = signal_doc(it, company_id, fragment, now)
            if dry_run:
                proposed.append({k: doc[k] for k in ("company_id", "matched_name", "headline", "publisher", "url")})
                continue
            try:
                db.signals.insert_one(doc)            # an article seen before keeps its first record and decision
                stats["signals_new"] += 1
            except DuplicateKeyError:
                pass
    except BaseException as exc:                      # including Ctrl+C: the run is never left "running"
        if not dry_run:
            MongoSink(db).finish_run(run_id, "failed", stats, failures + [f"failed: {type(exc).__name__}: {exc}"[:300]])
        raise
    total = stats["feeds_read"] + stats["feeds_failed"]
    status = "ok" if not stats["feeds_failed"] else "failed" if stats["feeds_failed"] == total else "partial"
    if not dry_run:
        MongoSink(db).finish_run(run_id, status, stats, failures)
    return {**stats, "status": status, "failures": failures, **({"proposed": proposed} if dry_run else {"run": run_id})}

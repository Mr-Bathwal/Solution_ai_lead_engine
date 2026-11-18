"""UP incubators and who they incubate.

  1. Startup in UP's table of recognised incubators (startinup.up.gov.in/recognized-incubators/).
     Representatives' names, emails and phones in that table are not read.
  2. Each incubator's public profile on the Startup in UP directory, which lists its startups.
     These links (incubator -> UPLC number) are a strong fit signal for the need engine.
  3. Incubators selected under the Startup India Seed Fund Scheme (SISFS), filtered to UP.

The table and the profile pages print representatives' names, emails and mobile numbers. Emails and
numbers are removed before a page is kept in the raw store; the pages are marked as holding
personal data, because the names remain.
"""
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup

from ..ids import uplc_key
from ..names import normalize_name
from ..net.fetcher import Disallowed
from ..privacy import keep_only
from ..records import Record, RunContext
from ..util import ist_naive_to_utc
from .startinup import DIRECTORY

RECOGNISED_URL = "https://startinup.up.gov.in/recognized-incubators/"
SISFS_URL = "https://seedfundapi.startupindia.gov.in/api/portfoliofilter"
TABLE_FIELDS = {  # portal column -> stored field; any column not listed (contacts) is ignored
    "Incubator Name": "name", "Educational Institute/Host Institution Name": "host",
    "Incubation Space (Sq.Ft.)": "space_sqft", "Industry Name": "industry", "Sector Name": "sector",
    "PIU (Approval Date)": "piu_approval", "Number of Startups Count": "startups_count",
}
# SISFS portfolio rows: the incubator-level fields seen in October 2026 (an allow-list; the description
# and image were never kept).
SISFS_KEEP = {"Id", "incubator_name", "incubator_user_id", "city", "state", "sectors", "Evaluation",
              "first_total_approved_amt", "reapply_total_approved_amt", "totalGrantremainingAmount", "totalRemainingAmount"}


def incubator_key(name: str, host: str = "") -> str:
    """Name plus host institution. Several incubators share a name (STPI runs one in Noida, Lucknow and
    Prayagraj), and every word counts here, so the full cleaned name is used, not just its rare words."""
    part = lambda s: normalize_name(s).clean.replace(" ", "") or re.sub(r"\W+", "", s.lower())  # noqa: E731
    return "inc:" + part(name) + (f"@{part(host)}" if host.strip() else "")


def parse_recognised(html) -> list[dict]:
    s = BeautifulSoup(html, "lxml")
    tables = s.find_all("table")
    if not tables:
        return []
    t = max(tables, key=lambda x: len(x.find_all("tr")))
    rows = t.find_all("tr")
    head = [c.get_text(" ", strip=True) for c in rows[0].find_all(["th", "td"])]
    out = []
    for r in rows[1:]:
        cells = [" ".join(x.get_text(" ").split()) for x in r.find_all(["td", "th"])]
        if len(cells) < len(head):
            continue
        row = {TABLE_FIELDS[h]: v for h, v in zip(head, cells) if h in TABLE_FIELDS and v}
        if row.get("name"):
            out.append(row)
    return out


def incubator_links(directory_html) -> list[dict]:
    s = BeautifulSoup(directory_html, "lxml")
    out, seen = [], set()
    for a in s.find_all("a", href=re.compile(r"incubator_user_details/")):
        if a["href"] in seen:
            continue
        seen.add(a["href"])
        h3 = a.find("h3")
        out.append({"name": " ".join((h3 or a).get_text(" ").split()), "url": a["href"]})
    return out


def parse_portfolio(html) -> dict:
    """An incubator's public profile: its name, sector, website and the startups it lists."""
    s = BeautifulSoup(html, "lxml")
    for t in s(["script", "style", "noscript"]):
        t.decompose()
    banner = s.find(class_="company-name") or s
    parts = [" ".join(p.split()) for p in banner.get_text("|").split("|") if p.strip()]
    name, host = "", ""
    for i, p in enumerate(parts):
        if re.match(r"\d{2} \w{3} \d{4}$", p) and i + 1 < len(parts):
            name = parts[i + 1]
            if i + 2 < len(parts) and not parts[i + 2].startswith("Sector"):
                host = parts[i + 2]
            break
    sec = re.search(r"Sector\s*:\s*\|?\s*([^|]+)", banner.get_text("|"))
    web = [a["href"] for a in banner.find_all("a", href=True) if a["href"].startswith("http") and "startinup" not in a["href"]]
    startups, seen = [], set()
    pane = s.find(id="menu1") or s
    for a in pane.find_all("a", href=re.compile(r"startup_user_details/")):
        box = a.find_parent("div", class_=re.compile(r"col-md")) or a
        h = box.find(["h3", "h4", "h5"])
        img = box.find("img")
        key = uplc_key(img.get("src", "")) if img else None
        if not h or (key or a["href"]) in seen:
            continue
        seen.add(key or a["href"])
        startups.append({"uplc": key, "name": " ".join(h.get_text(" ").split())})
    return {"name": name, "host": host, "sector": " ".join(sec[1].split()) if sec else "",
            "website": web[0] if web else "", "startups": startups}


def portfolio_records(prof: dict, url: str, ref, fetched_at=None):
    if not prof["name"]:
        return
    ikey = incubator_key(prof["name"], prof.get("host", ""))
    for st in prof["startups"]:
        if not st["uplc"]:
            continue
        rec = Record(source="incubator_portfolio", natural_key=f"{ikey}|{st['uplc']}",
                     payload={"incubator": prof["name"], "incubator_host": prof.get("host", ""),
                              "uplc": st["uplc"], "startup_name": st["name"]},
                     legal_basis="published_by_company", url=url, raw_ref=ref)
        if fetched_at:
            rec.fetched_at = fetched_at
        yield rec


def sisfs_records(body: dict, ref, fetched_at=None):
    for it in body.get("data") or []:
        if (it.get("state") or "").strip().lower() != "uttar pradesh":
            continue
        payload = keep_only(it, SISFS_KEEP)
        rec = Record(source="sisfs_incubator", natural_key=f"sisfs:{it['Id']}", payload=payload,
                     legal_basis="published_by_company", url=SISFS_URL, raw_ref=ref)
        if fetched_at:
            rec.fetched_at = fetched_at
        yield rec


class IncubatorSource:
    name = "incubator"

    def __init__(self, portfolios: bool = True, sisfs: bool = True):
        self.portfolios = portfolios
        self.sisfs = sisfs

    def collect(self, ctx: RunContext):
        """Each request stands alone: one slow incubator profile is noted and skipped, and the rest of
        the run carries on."""
        f = ctx.fetcher

        def fetch(what, call, *args):
            try:
                r = call(*args)
            except (Disallowed, requests.RequestException) as exc:
                ctx.note(f"{what}: {type(exc).__name__}")
                return None
            if not r.ok:
                ctx.note(f"{what} answered {r.status}")
                return None
            return r

        r = fetch("recognised-incubator table", f.get, RECOGNISED_URL)
        if r:
            ref = ctx.rawstore.put(r.content, source="incubator", url=r.url, content_type=r.content_type, personal=True)
            for row in parse_recognised(r.content):
                ctx.stats["recognised"] += 1
                yield Record(source="incubator", natural_key=incubator_key(row["name"], row.get("host", "")), payload=row,
                             legal_basis="published_by_company", url=RECOGNISED_URL, raw_ref=ref)
        else:
            ctx.stats["unavailable"] += 1
        if self.portfolios:
            d = fetch("incubator directory", f.get, DIRECTORY)
            if d is None:
                ctx.stats["unavailable"] += 1
            for link in incubator_links(d.content) if d else []:
                p = fetch(f"incubator profile {link['name']}", f.get, link["url"])
                if p is None:
                    ctx.stats["profiles_failed"] += 1
                    continue
                ref = ctx.rawstore.put(p.content, source="incubator_portfolio", url=p.url, content_type=p.content_type,
                                       personal=True)
                ctx.stats["profiles"] += 1
                for rec in portfolio_records(parse_portfolio(p.content), p.url, ref):
                    ctx.stats["portfolio_links"] += 1
                    yield rec
        if self.sisfs:
            s = fetch("SISFS portfolio (the endpoint may have moved; it last worked on 8 Oct 2026)",
                      f.post_json, SISFS_URL, {})
            body = None
            if s:
                try:
                    body = s.json()
                except ValueError:
                    ctx.note("SISFS portfolio answered something other than JSON")
            if isinstance(body, dict):
                ref = ctx.rawstore.put(s.content, source="sisfs_incubator", url=SISFS_URL, content_type=s.content_type)
                for rec in sisfs_records(body, ref):
                    ctx.stats["sisfs_up"] += 1
                    yield rec
            else:
                ctx.stats["unavailable"] += 1


class IncubatorCacheSource:
    """Offline backfill from the Atlas caches."""
    name = "incubator"

    def __init__(self, sui_cache: Path, sisfs_file: Path | None):
        self.sui_cache = Path(sui_cache)
        self.sisfs_file = Path(sisfs_file) if sisfs_file else None

    def collect(self, ctx: RunContext):
        for line in (self.sui_cache / "_index.jsonl").read_text(encoding="utf-8").splitlines():
            try:
                m = json.loads(line)
            except ValueError:
                continue
            fn, path = m.get("file", ""), self.sui_cache / m.get("file", "")
            if m.get("status") != 200 or not path.exists():
                continue
            fetched = ist_naive_to_utc(m["retrieved_at"])     # the Atlas crawler wrote local (IST) time
            if fn == "sui_recognized-incubators.html":
                data = path.read_bytes()
                ref = ctx.rawstore.put(data, source="incubator", url=m["url"], content_type=m.get("ctype", ""), personal=True)
                for row in parse_recognised(data):
                    ctx.stats["recognised"] += 1
                    rec = Record(source="incubator", natural_key=incubator_key(row["name"], row.get("host", "")), payload=row,
                                 legal_basis="published_by_company", url=RECOGNISED_URL, raw_ref=ref)
                    rec.fetched_at = fetched
                    yield rec
            elif fn.startswith("sui_inc_"):
                data = path.read_bytes()
                ref = ctx.rawstore.put(data, source="incubator_portfolio", url=m["url"], content_type=m.get("ctype", ""),
                                       personal=True)
                ctx.stats["profiles"] += 1
                for rec in portfolio_records(parse_portfolio(data), m["url"], ref, fetched):
                    ctx.stats["portfolio_links"] += 1
                    yield rec
        if self.sisfs_file and self.sisfs_file.exists():
            data = self.sisfs_file.read_bytes()
            ref = ctx.rawstore.put(data, source="sisfs_incubator", url=SISFS_URL, content_type="application/json")
            fetched = datetime.fromtimestamp(self.sisfs_file.stat().st_mtime, timezone.utc)
            for rec in sisfs_records(json.loads(data), ref, fetched):
                ctx.stats["sisfs_up"] += 1
                yield rec

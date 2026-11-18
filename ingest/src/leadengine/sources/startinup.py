"""Startup in UP portal (startinup.up.gov.in): the state's directory of recognised startups.

The directory is paged (10 cards a page, about 230 pages). Each card links to a public profile.
The profile URLs are re-encrypted on every page load, so they are useless as keys; the stable key is
the UP application number (UPLC_xxxxxxxx), read from the logo path. The same number identifies the
startup on the UP Startup Mission portal, which lets the two sources join exactly.

Profiles list team members as the startup published them on this official portal. They are kept
in `team` and flagged as personal fields, so retention and erasure can find them. No email
addresses or phone numbers are read from the portal, and any on a page are removed before the page
is kept in the raw store (see privacy.py); profile pages are marked as holding personal data.
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
from ..records import Record, RunContext
from ..util import ist_naive_to_utc, parse_date

SOURCE = "startinup"
DIRECTORY = "https://www.startinup.up.gov.in/crm/welcome/connect_network/"
ENTITY_MAP = [(r"limited liability|\bllp\b", "LLP"), (r"one person|\bopc\b", "OPC"),
              (r"private limited|pvt", "Private Limited"), (r"partnership", "Partnership"),
              (r"proprietor", "Proprietorship")]
NOT_AVAILABLE = {"", "not available", "na", "n/a", "-", "nil"}
# Labels on a profile page. When a field is empty the page prints the next label straight after it,
# so a value that is itself a label means "no value", not an entity type called "Sectors".
LABELS = {"entity type", "sectors", "startup stage", "startup teams", "incubation details", "incubator name",
          "incubator host institution", "city", "approved incentive", "year of establishment", "location",
          "disctrict", "district", "pincode", "email", "mobile", "phone", "website", "industry", "state"}


def page_url(n: int) -> str:
    return DIRECTORY if n == 1 else f"{DIRECTORY}{n}/"


def _soup(html: bytes | str) -> BeautifulSoup:
    return BeautifulSoup(html, "lxml")


def _clean(v) -> str:
    v = " ".join(str(v or "").split())
    return "" if v.lower() in NOT_AVAILABLE else v


def _logo_date(src: str) -> str | None:
    m = re.search(r"/startup_logo/(\d{10})", src or "")
    if not m:
        return None
    d = datetime.fromtimestamp(int(m[1]), timezone.utc).date()
    return d.isoformat() if 2015 <= d.year <= datetime.now(timezone.utc).year else None


def last_page(html) -> int:
    pages = [int(x) for x in re.findall(r"connect_network/(\d+)/", str(html))]
    return max(pages or [1])


def parse_cards(html) -> list[dict]:
    """Startup cards on one directory page."""
    s = _soup(html)
    pane = s.find(id="tab_default_1") or s
    out = []
    for a in pane.find_all("a", href=re.compile(r"startup_user_details/")):
        h3 = a.find("h3")
        if not h3:
            continue
        ps = [p.get_text(" ", strip=True) for p in a.find_all("p")]
        img = a.find("img")
        src = img.get("src", "") if img else ""
        out.append({
            "name": " ".join(h3.get_text(" ").split()),
            "place": ps[0] if ps else "",
            "industry_sector": (ps[1] if len(ps) > 1 else "").replace("\xa0", " "),
            "url": a["href"],
            "uplc": uplc_key(src),
            "logo_date": _logo_date(src),
        })
    return out


def parse_detail(html) -> dict:
    """A public startup profile page. Email and phone are never read."""
    s = _soup(html)
    for t in s(["script", "style", "noscript"]):
        t.decompose()
    d = {}
    banner = s.find(class_="company-name")
    if banner:
        h3 = banner.find("h3")
        d["title"] = " ".join(h3.get_text(" ").split()) if h3 else ""
        act = banner.find(class_="active-since")
        dt = parse_date(act.get_text(strip=True)) if act else None
        d["active_since"] = dt.isoformat() if dt else ""
        ind = re.search(r"Industry\s*:\s*(.+)", banner.get_text(" "))
        d["industry"] = " ".join(ind[1].split())[:120] if ind else ""
        web = [a["href"] for a in banner.find_all("a", href=True) if a["href"].startswith("http")]
        d["website"] = web[0] if web else ""
    img = s.find("img", src=re.compile(r"UPLC_\d+"))
    d["uplc"] = uplc_key(img["src"]) if img else None
    lines = [ln.strip() for ln in s.get_text("\n").splitlines() if ln.strip()]

    def after(label, start=0):
        for i in range(max(start, 0), len(lines) - 1):
            if lines[i].rstrip(" :") == label:
                value = lines[i + 1]
                return ("" if value.rstrip(" :").lower() in LABELS else value), i + 1
        return "", -1

    d["entity_type_raw"], _ = after("Entity Type")
    d["sectors"], _ = after("Sectors")
    d["stage"], _ = after("Startup Stage")
    team = []
    try:
        a = lines.index("Startup Teams")
        b = next(i for i in range(a, len(lines)) if lines[i] in ("Incubation Details", "Location"))
        seg = lines[a + 1:b]
        for i, ln in enumerate(seg):
            if ln.startswith("(") and ln.endswith(")") and i > 0:
                team.append({"name": seg[i - 1], "role": ln.strip("()").strip()})
    except (ValueError, StopIteration):
        pass
    d["team"] = team
    inc, i_inc = after("Incubator Name")
    d["incubator"] = inc
    d["incubator_host"], _ = after("Incubator Host Institution")
    d["incubator_city"], _ = after("City", i_inc) if i_inc > 0 else ("", -1)
    d["approved_incentive"], _ = after("Approved Incentive")
    d["year_established"], _ = after("Year of Establishment")
    _, i_loc = after("Location")
    d["district"], _ = after("Disctrict", i_loc)  # sic: the portal's own spelling
    if not d["district"]:
        d["district"], _ = after("District", i_loc)
    d["pincode"], _ = after("Pincode", i_loc)
    if not re.fullmatch(r"\d{6}", d["pincode"] or ""):
        d["pincode"] = ""
    return d


def _year(raw: str) -> str:
    """A plausible year of establishment, or "" (the portal holds values such as "0022" and "1970",
    the second being an unset date shown as the Unix epoch)."""
    y = _clean(raw)
    ok = re.fullmatch(r"\d{4}", y) and 1950 <= int(y) <= datetime.now(timezone.utc).year and y != "1970"
    return y if ok else ""


def _list_text(raw: str) -> str:
    """", Others" -> "Others"; "IT/ITeS ,  FinTech" -> "IT/ITeS, FinTech"."""
    parts = [p.strip() for p in re.split(r"\s*,\s*", _clean(raw)) if p.strip()]
    return ", ".join(dict.fromkeys(parts))


def _entity(raw: str) -> str:
    for rx, v in ENTITY_MAP:
        if re.search(rx, raw or "", re.I):
            return v
    return ""


def build_payload(card: dict, detail: dict | None) -> dict:
    """Card plus profile -> the stored record. Only stable fields: the profile URL changes on every
    page load, so it is kept on the record's url, not in the payload (which is hashed)."""
    d = detail or {}
    title = d.get("title") or card["name"]
    legal, _, brand = title.partition(" ,")
    legal, brand = legal.strip(" ,"), brand.strip(" ,")
    if brand.lower() == legal.lower():
        brand = ""
    place = card["place"].split(",", 1)[1].strip() if "," in card["place"] else card["place"]
    ind, _, sec = card["industry_sector"].partition(" , ")
    payload = {
        "uplc": d.get("uplc") or card.get("uplc"),
        "legal_name": legal,
        "brand": brand,
        "entity_type": _entity(d.get("entity_type_raw", "")) or _clean(d.get("entity_type_raw")),
        "year_established": _year(d.get("year_established")),
        "active_since": d.get("active_since", ""),
        "industry": _list_text(d.get("industry")) or _list_text(ind),
        "sector": _list_text(d.get("sectors")).strip(" -,") or _list_text(sec),
        "stage": _clean(d.get("stage")),
        "district": (_clean(d.get("district")) or place).title(),
        "pincode": d.get("pincode", ""),
        "website": d.get("website", ""),
        "incubator": _clean(d.get("incubator")),
        "incubator_host": _clean(d.get("incubator_host")),
        "approved_incentive": _clean(d.get("approved_incentive")),
        "team": d.get("team", []),
        "logo_date": card.get("logo_date"),
        "profile_parsed": bool(d.get("title")),
    }
    return {k: v for k, v in payload.items() if v not in (None, "", [])} | {"profile_parsed": payload["profile_parsed"]}


def natural_key(card: dict, detail: dict | None) -> str:
    """The UPLC number; for the rare card without one, the full cleaned name (not the distinctive-word
    key, under which "Abc Technologies" and "ABC Solutions" would collide)."""
    if (detail or {}).get("uplc") or card.get("uplc"):
        return (detail or {}).get("uplc") or card.get("uplc")
    k = normalize_name(card["name"])
    return "name:" + (k.clean.replace(" ", "-") or k.key)


def _profile_locator(card: dict, detail: dict | None) -> str | None:
    """Profile URLs are re-encrypted on every page load, so profiles are filed under their UPLC number."""
    uplc = (detail or {}).get("uplc") or card.get("uplc")
    return f"profile:{uplc}" if uplc else None


class StartinupSource:
    """details: "new" fetches profiles only for startups we have not stored yet (weekly run),
    "all" re-reads every profile (monthly refresh), "none" reads the directory only."""
    name = SOURCE

    def __init__(self, details: str = "new", max_pages: int | None = None):
        assert details in ("new", "all", "none")
        self.details = details
        self.max_pages = max_pages

    def collect(self, ctx: RunContext):
        """Streams: each directory page is stored and its cards processed before the next is fetched,
        so a failure late in the run keeps everything read so far."""
        f = ctx.fetcher
        first = f.get(page_url(1))
        if not first.ok:
            ctx.note(f"directory page 1 answered {first.status}; stopping")
            ctx.stats["unavailable"] += 1
            return
        n_last = last_page(first.text)
        if self.max_pages:
            n_last = min(n_last, self.max_pages)
        ctx.stats["directory_pages"] = n_last
        # Startups whose current record has a parsed profile. "new" re-reads only the others, so a
        # card-only record left by a failed profile fetch is retried next week; and in every mode a
        # failed profile fetch for one of these keeps the good record instead of replacing it with
        # the bare card (a profile-host outage must not degrade every startup for a month).
        parsed = ctx.known_keys(SOURCE, {"payload.profile_parsed": True}) if self.details != "none" else set()
        seen = set()
        for n in range(1, n_last + 1):
            try:
                r = first if n == 1 else f.get(page_url(n))
            except requests.RequestException as exc:   # one bad page must not lose the run
                r = None
                ctx.note(f"directory page {n}: {type(exc).__name__}")
            if r is None or not r.ok:
                ctx.stats["directory_pages_failed"] += 1
                continue
            if n % 25 == 0:
                ctx.log(f"startinup: page {n} of {n_last}, {ctx.stats['profiles_fetched']} new profiles so far")
            ref = ctx.rawstore.put(r.content, source=SOURCE, url=r.url, content_type=r.content_type)
            for card in parse_cards(r.content):
                key = natural_key(card, None)
                if key in seen:
                    continue
                seen.add(key)
                ctx.stats["cards"] += 1
                detail, durl, dref = None, card["url"], ref
                if self.details == "all" or (self.details == "new" and key not in parsed):
                    try:
                        dr = f.get(card["url"])
                    except (Disallowed, requests.RequestException):
                        dr = None
                    if dr is not None and dr.ok:
                        detail = parse_detail(dr.content)
                        dref = ctx.rawstore.put(dr.content, source=SOURCE, url=dr.url, content_type=dr.content_type,
                                                personal=True, locator=_profile_locator(card, detail))
                        ctx.stats["profiles_fetched"] += 1
                    else:
                        ctx.stats["profiles_failed"] += 1
                        if key in parsed:
                            ctx.stats["profiles_failed_kept_previous"] += 1
                            ctx.saw(SOURCE, key)
                            continue
                elif key in parsed:
                    ctx.stats["known_cards_skipped"] += 1
                    ctx.saw(SOURCE, key)
                    continue
                yield Record(source=SOURCE, natural_key=natural_key(card, detail), payload=build_payload(card, detail),
                             legal_basis="published_by_company", url=durl, raw_ref=dref,
                             personal_fields=("team",))


class StartinupCacheSource(StartinupSource):
    """Offline backfill from the UP Startup Atlas crawl caches (October 2026), so the first load
    does not re-crawl pages we already hold. Each cached page is copied into the raw store with its
    original URL and fetch date."""

    def __init__(self, cache_dirs: list[Path]):
        super().__init__(details="none")
        self.cache_dirs = [Path(d) for d in cache_dirs]

    def _index(self, d: Path) -> list[dict]:
        out = []
        for line in (d / "_index.jsonl").read_text(encoding="utf-8").splitlines():
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
        return out

    def collect(self, ctx: RunContext):
        cards, details = {}, {}
        for d in self.cache_dirs:
            for m in self._index(d):
                fn, path = m.get("file", ""), d / m.get("file", "")
                if m.get("status") != 200 or not path.exists():
                    continue
                fetched = ist_naive_to_utc(m["retrieved_at"])     # the Atlas crawler wrote local (IST) time
                if re.match(r"(sui_)?cn_p\d+|sui_connect_network", fn):
                    data = path.read_bytes()
                    ref = ctx.rawstore.put(data, source=SOURCE, url=m["url"], content_type=m.get("ctype", ""))
                    for c in parse_cards(data):
                        key = natural_key(c, None)
                        if key not in cards or fetched >= cards[key][1]:
                            cards[key] = (c, fetched, ref)
                elif re.match(r"(sui_)?sd_", fn):
                    data = path.read_bytes()
                    det = parse_detail(data)
                    if det.get("uplc"):
                        ref = ctx.rawstore.put(data, source=SOURCE, url=m["url"], content_type=m.get("ctype", ""),
                                               personal=True, locator=f"profile:{det['uplc']}")
                        if det["uplc"] not in details or fetched >= details[det["uplc"]][1]:
                            details[det["uplc"]] = (det, fetched, ref, m["url"])
        ctx.stats["cards"] = len(cards)
        ctx.stats["profiles"] = len(details)
        for key, (card, fetched, ref) in cards.items():
            det = details.get(card.get("uplc"))
            detail, url, raw = (det[0], det[3], det[2]) if det else (None, card["url"], ref)
            ctx.stats["with_profile" if det else "card_only"] += 1
            yield Record(source=SOURCE, natural_key=natural_key(card, detail), payload=build_payload(card, detail),
                         legal_basis="published_by_company", url=url, raw_ref=raw,
                         fetched_at=det[1] if det else fetched, personal_fields=("team",))

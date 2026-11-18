"""UP Startup Mission portal (startupmission.up.gov.in, launched August 2026): district-wise directory.

The portal's own directory page calls a public JSON endpoint per district:
    GET /en/api/get-district-wise-startup/<district_id>?page=N&limit=L
District ids come from the directory page's district filter.

Rows can carry email, mobile, address and person-name fields. Only the fields listed in KEEP are
stored (an allow-list: a field the API adds later is dropped until someone decides to keep it), and
the deny-list below runs as a second line of defence. The UPLC application number links each row to
its Startup in UP profile.
"""
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup

from ..ids import uplc_key
from ..privacy import keep_only
from ..records import Record, RunContext
from ..util import ist_naive_to_utc

SOURCE = "upsm"
BASE = "https://www.startupmission.up.gov.in"
DIRECTORY_PAGE = f"{BASE}/en/pages/startup-directory"
# Company-level fields of a directory row (the set seen in October 2026, plus the startup's own address
# city, state and PIN code). user_id is the portal's opaque account number, kept for continuity.
KEEP = {"id", "user_id", "user_acknowledgement_no", "startup_name", "startup_logo", "startup_address_district",
        "startup_address_city", "startup_address_state", "startup_address_pincode", "sector_id", "sector_name",
        "industry_name", "innovation_model", "nature_of_entity", "startup_current_stage", "women_led_startup"}
PERSONAL = re.compile(r"mail|mob(ile|_|$)|phone|whats\s*app|contact|aadh?aar|pan(_|number|no)|password|otp|dob|birth|gender|"
                      r"father|founder|director|owner|promoter|applicant|first_?name|last_?name|full_?name|user_?name|"
                      r"linkedin|landline|alternate|^name$", re.I)

# The API sends codes. These meanings were inferred by the Atlas team from startups listed on both
# portals (at least 15 shared startups and at least 70% agreement per code), so they are applied
# when reading, never written into the stored payload.
STAGE = {"1": "Ideation", "2": "Prototype", "3": "Acceleration", "4": "Validation", "5": "Early Traction", "6": "Scaling"}
ENTITY = {"6": "Private Limited", "7": "LLP", "8": "Partnership"}


def _snake(k: str) -> str:
    """founderName -> founder_name, so the deny-list sees camelCase keys too (DPIIT uses them)."""
    return re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", k).lower()


def scrub(o):
    """Drops personal keys at every level (the deny-list; the allow-list is applied per row first)."""
    if isinstance(o, dict):
        return {k: scrub(v) for k, v in o.items() if not PERSONAL.search(_snake(k))}
    if isinstance(o, list):
        return [scrub(x) for x in o]
    return o


def clean_row(row: dict) -> dict:
    return scrub(keep_only(row, KEEP))


def clean_body(body: dict) -> dict:
    """An API page as it is kept: every row reduced to KEEP, everything else deny-list scrubbed."""
    body = scrub(body or {})
    data = body.get("data")
    if isinstance(data, dict) and isinstance(data.get("records"), list):
        data["records"] = [clean_row(r) for r in data["records"] if isinstance(r, dict)]
    return body


def district_ids(html) -> list[tuple[str, str]]:
    s = BeautifulSoup(html, "lxml")
    sel = s.find(id="districtFilter")
    return [(o["value"], o.get_text(strip=True)) for o in (sel.find_all("option") if sel else []) if o.get("value")]


def rows_of(body: dict) -> tuple[list, dict]:
    data = (body or {}).get("data") or {}
    return data.get("records") or [], data.get("pagination") or {}


def record_for(row: dict, url: str, fetched_at=None, raw_ref=None) -> Record | None:
    row = clean_row(row)
    key = uplc_key(row.get("user_acknowledgement_no")) or (f"upsm:{row['id']}" if row.get("id") else None)
    if not key:
        return None
    rec = Record(source=SOURCE, natural_key=key, payload=row, legal_basis="published_by_company", url=url, raw_ref=raw_ref)
    if fetched_at:
        rec.fetched_at = fetched_at
    return rec


def view(payload: dict) -> dict:
    """Readable fields from a stored UPSM payload."""
    logo = re.search(r"/startup_logo/(\d{10})", payload.get("startup_logo") or "")
    return {
        "uplc": uplc_key(payload.get("user_acknowledgement_no")),
        "name": (payload.get("startup_name") or "").strip(),
        "district": payload.get("startup_address_district"),
        "sector": payload.get("sector_name"),
        "industry": payload.get("industry_name"),
        "stage": STAGE.get(str(payload.get("startup_current_stage"))),
        "entity_type": ENTITY.get(str(payload.get("nature_of_entity"))),
        "women_led": str(payload.get("women_led_startup")) == "1",
        "logo_date": datetime.fromtimestamp(int(logo[1]), timezone.utc).date().isoformat() if logo else None,
    }


class UpsmSource:
    name = SOURCE

    def __init__(self, page_size: int = 50, max_districts: int | None = None):
        self.page_size = page_size
        self.max_districts = max_districts

    def collect(self, ctx: RunContext):
        f = ctx.fetcher
        home = f.get(DIRECTORY_PAGE)
        if not home.ok:
            ctx.note(f"directory page answered {home.status}; stopping")
            ctx.stats["unavailable"] += 1
            return
        ctx.rawstore.put(home.content, source=SOURCE, url=home.url, content_type=home.content_type)
        districts = district_ids(home.content)[: self.max_districts]
        ctx.stats["districts"] = len(districts)
        seen = set()
        for did, dname in districts:
            page, last = 1, None   # `last` is known once one page of the district has been read
            while True:
                url = f"{BASE}/en/api/get-district-wise-startup/{did}?page={page}&limit={self.page_size}"
                body = None
                try:
                    r = f.get(url)
                    failure = None if r.ok else f"answered {r.status}"
                    if not failure:
                        body = r.json()
                        failure = None if isinstance(body, dict) else "answered something other than a JSON object"
                except requests.RequestException as exc:
                    failure = type(exc).__name__
                except ValueError:           # an HTML error page with a 200
                    failure = "answered something other than JSON"
                if failure:
                    ctx.stats["api_pages_failed"] += 1
                    ctx.note(f"{dname} page {page}: {failure}")
                    if last and page < last:   # skip only the bad page, not the rest of the district
                        page += 1
                        continue
                    break
                body = clean_body(body)
                ref = ctx.rawstore.put(json.dumps(body, ensure_ascii=False).encode("utf-8"), source=SOURCE,
                                       url=url, content_type="application/json")
                rows, pag = rows_of(body)
                ctx.stats["api_pages"] += 1
                for row in rows:
                    rec = record_for(row, url, raw_ref=ref)
                    if rec and rec.natural_key not in seen:
                        seen.add(rec.natural_key)
                        yield rec
                last = pag.get("last_page") or last
                if not pag.get("has_next"):
                    break
                page += 1
        ctx.stats["startups"] = len(seen)


class UpsmCacheSource:
    """Offline backfill from the Atlas cache (scrubbed API pages fetched 7-8 October 2026)."""
    name = SOURCE

    def __init__(self, cache_dir: Path):
        self.cache_dir = Path(cache_dir)

    def collect(self, ctx: RunContext):
        seen = set()
        for p in sorted(self.cache_dir.glob("dir_*_p*.json")):
            d = json.loads(p.read_text(encoding="utf-8"))
            if d.get("_status") != 200:
                continue
            fetched = ist_naive_to_utc(d["_retrieved_at"])     # the Atlas crawler wrote local (IST) time
            body = clean_body(d["body"])
            ref = ctx.rawstore.put(json.dumps(body, ensure_ascii=False).encode("utf-8"), source=SOURCE,
                                   url=d["_url"], content_type="application/json")
            ctx.stats["api_pages"] += 1
            for row in rows_of(body)[0]:
                rec = record_for(row, d["_url"], fetched, ref)
                if rec and rec.natural_key not in seen:
                    seen.add(rec.natural_key)
                    yield rec
        ctx.stats["startups"] = len(seen)

"""Startup India (DPIIT) public endpoints, filtered to Uttar Pradesh.

  GET  /sih/api/noauth/dpiit/services/recognition/recent-statistics?stateId=<UP>   UP counters
  POST /sih/api/noauth/search/profiles   {states: [UP], roles: [Startup], ...}    recognised startups

NOT SCHEDULED, AND BLOCKED. Since October 2026 api.startupindia.gov.in/robots.txt reads
"User-agent: *" / "Disallow: /", which forbids automated access to the whole API. The host is also on
the engine's never-crawl list (crawl.blocked_hosts in config/caps.json), so the fetcher refuses every
request here, without even reading robots.txt, and the run ends "partial". If the site's rules ever
change, re-enabling this source is a deliberate edit of that list, never a side effect. Until then
DPIIT recognition comes from founders' own claims, the two UP portals, or an official data request.

Only the /noauth/ endpoints the public site itself calls are used; never anything that needs a login.
The search endpoint's row format has never been seen (it failed on every attempt in early October),
so only the fields in SEARCH_KEEP would be stored, under the first stable identifier a row carries.
"""
from datetime import date

from ..net.fetcher import Disallowed
from ..privacy import keep_only
from ..records import Record, RunContext
from ..util import sha256_text, canonical_json
from .upsm import scrub

API = "https://api.startupindia.gov.in/sih/api"
UP_STATE_ID = "5f48ce592a9bb065cdf9fb3f"
SEARCH_BODY = {
    "query": "", "focusSector": False, "industries": [], "sectors": [], "states": [UP_STATE_ID], "cities": [],
    "stages": [], "badges": [], "roles": ["Startup"], "page": 0,
    "sort": {"orders": [{"field": "registeredOn", "direction": "DESC"}]},
    "dpiitRecogniseUser": True, "internationalUser": False,
}
HEADERS = {"Accept": "application/json", "Origin": "https://www.startupindia.gov.in",
           "Referer": "https://www.startupindia.gov.in/content/sih/en/search.html?roles=Startup&page=0"}
ID_FIELDS = ("dpiitCertificateNo", "dippNumber", "dpiitNumber", "recognitionNumber", "id", "profileId", "userId")
# Company-level fields a search row might carry (names guessed, never seen): an allow-list, so an
# unexpected founder name or phone field is dropped rather than stored.
SEARCH_KEEP = set(ID_FIELDS) | {"name", "startupName", "companyName", "entityName", "stage", "industry", "industries",
                                "sector", "sectors", "city", "state", "registeredOn", "recognisedOn", "recognizedOn",
                                "website", "dpiitRecognised", "dpiitRecognized"}


class DpiitSource:
    name = "dpiit"

    def __init__(self, max_pages: int = 300, search: bool = True):
        self.max_pages = max_pages
        self.search = search

    def collect(self, ctx: RunContext):
        yield from self._counters(ctx)
        if self.search:
            yield from self._search(ctx)

    def _counters(self, ctx):
        url = f"{API}/noauth/dpiit/services/recognition/recent-statistics?stateId={UP_STATE_ID}"
        try:
            r = ctx.fetcher.get(url, headers=HEADERS)
        except Disallowed as exc:
            ctx.note(f"counters not fetched: {exc}")
            ctx.stats["unavailable"] += 1
            return
        if not r.ok:
            ctx.note(f"counters answered {r.status}")
            ctx.stats["unavailable"] += 1
            return
        ref = ctx.rawstore.put(r.content, source="dpiit_stats", url=url, content_type=r.content_type)
        data = (r.json() or {}).get("data") or {}
        ctx.stats["counters"] = 1
        yield Record(source="dpiit_stats", natural_key=f"UP:{date.today().isoformat()}", payload=data,
                     legal_basis="public_statistics", url=url, raw_ref=ref)

    def _search(self, ctx):
        url = f"{API}/noauth/search/profiles"
        for page in range(self.max_pages):
            try:
                r = ctx.fetcher.post_json(url, dict(SEARCH_BODY, page=page), headers=HEADERS)
            except Disallowed as exc:
                ctx.note(f"search not run: {exc}")
                ctx.stats["unavailable"] += 1
                return
            if not r.ok:
                ctx.note(f"search page {page} answered {r.status}; the endpoint has been failing since 1 Oct 2026")
                ctx.stats["unavailable"] += 1
                return
            ref = ctx.rawstore.put(r.content, source=self.name, url=f"{url}#page={page}", content_type=r.content_type,
                                   personal=True)
            body = r.json() or {}
            items = body.get("content") or []
            for item in items:
                item = scrub(keep_only(item, SEARCH_KEEP)) if isinstance(item, dict) else {}
                key = next((str(item[k]) for k in ID_FIELDS if item.get(k)), None) or sha256_text(canonical_json(item))[:24]
                ctx.stats["startups"] += 1
                yield Record(source=self.name, natural_key=key, payload=item, legal_basis="published_by_company",
                             url=url, raw_ref=ref)
            if not items or body.get("last"):
                return

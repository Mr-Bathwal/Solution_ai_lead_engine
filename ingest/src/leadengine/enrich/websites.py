"""Company websites and the contacts a company publishes on them (design 7.1 "Company websites" and
7.3 "Contacts we use").

  search    for this month's shortlisted companies with no known website: one web search through a
            search API's free tier (WEB_SEARCH_PROVIDER: google_cse or brave), within the monthly cap
            caps.json monthly.web_searches. A new company often has no website yet, so a company not
            found is searched again 7, 30 and 90 days after the first search, and then no more.
  confirm   a result is the company's site only if its domain carries the company's distinctive name
            and the home page names the company (its name or its CIN). Directories, marketplaces and
            social networks (web.SHARED_HOSTS, AGGREGATORS) are never taken for the company's site.
  contacts  for shortlisted companies with a website (from a portal or from the search): the home page
            and up to three contact or about pages on the same site, through the polite fetcher
            (robots.txt, one request every few seconds), for a role address on the company's own
            domain (info@, contact@ ...) and a contact form. A person's address is never kept.
            Looked at again after 30 days.

Search APIs are licensed services called through their APIs; search engines' result pages are never
fetched. Without a provider configured the search step is skipped and says so; the contacts step
still runs for websites the portals gave us. Pages are stored redacted, like every crawled page.
The website and contacts are written as attributes with their source; the address is used for a first
email only when config/outreach.json recipient.use_website_email is on (after the lawyer's review of
its wording).
"""
import re
from collections import Counter
from datetime import datetime, timedelta, timezone
from urllib.parse import urljoin, urlsplit

import requests
from bs4 import BeautifulSoup

from ..privacy import EMAIL_RX, is_role_address
from ..web import SHARED_HOSTS, company_domain
from . import cache
from .caps import Meter

PROVIDER = "web"
RETRY_DAYS = (7, 30, 90)
CONTACT_DAYS = 30
AGGREGATORS = (
    "zaubacorp.com", "tofler.in", "thecompanycheck.com", "indiafilings.com", "quickcompany.in", "falconebiz.com",
    "instafinancials.com", "companydetails.in", "cleartax.in", "crunchbase.com", "tracxn.com", "glassdoor.co.in", "glassdoor.com",
    "ambitionbox.com", "naukri.com", "mca.gov.in", "economictimes.indiatimes.com", "indiatimes.com", "wikipedia.org",
    "corporatedir.com", "companyhouse.in", "registeredcompanies.in", "comprhensive.in", "allcompanydata.com", "bizdb.co.in",
    "sulekha.com", "tradeindia.com", "exportersindia.com", "yellowpages.in", "grotal.com", "asklaila.com",
)
# words that name no company in particular: a domain must carry more than these
GENERIC = {"private", "limited", "pvt", "ltd", "opc", "llp", "india", "indian", "technologies", "technology", "tech", "solutions",
           "solution", "services", "service", "ventures", "enterprises", "enterprise", "industries", "global", "international",
           "infra", "projects", "foods", "food", "agro", "consultancy", "consulting", "digital", "systems", "labs", "innovations",
           "group", "and", "the", "of", "co", "company", "trading", "traders", "exports", "imports", "marketing"}
CONTACT_WORDS = ("contact", "about", "reach", "connect", "enquir", "support")
PREFERRED = ("info", "contact", "hello", "enquiry", "enquiries", "support", "sales", "office", "care", "admin")


class SearchNotConfigured(Exception):
    pass


# ---- search providers ------------------------------------------------------------------------------
class SearchClient:
    """One web search through a search API. Returns [{url, title, snippet}] (at most 5)."""

    def __init__(self, provider: str, key: str, cx: str | None = None, session: requests.Session | None = None, timeout: float = 20):
        if provider not in ("google_cse", "brave"):
            raise ValueError("WEB_SEARCH_PROVIDER must be google_cse or brave")
        if provider == "google_cse" and not cx:
            raise ValueError("google_cse needs WEB_SEARCH_CX (the Programmable Search Engine id)")
        self.provider, self.key, self.cx, self.timeout = provider, key, cx, timeout
        self.session = session or requests.Session()

    def search(self, q: str) -> list[dict]:
        if self.provider == "google_cse":
            r = self.session.get("https://www.googleapis.com/customsearch/v1",
                                 params={"key": self.key, "cx": self.cx, "q": q, "num": 5, "gl": "in"}, timeout=self.timeout)
            r.raise_for_status()
            return [{"url": i.get("link"), "title": i.get("title") or "", "snippet": i.get("snippet") or ""} for i in r.json().get("items", [])][:5]
        r = self.session.get("https://api.search.brave.com/res/v1/web/search", params={"q": q, "count": 5, "country": "IN"},
                             headers={"X-Subscription-Token": self.key, "Accept": "application/json"}, timeout=self.timeout)
        r.raise_for_status()
        return [{"url": i.get("url"), "title": i.get("title") or "", "snippet": i.get("description") or ""}
                for i in (r.json().get("web") or {}).get("results", [])][:5]


def search_client_from_env(env: dict) -> SearchClient | None:
    provider = (env.get("WEB_SEARCH_PROVIDER") or "").strip().lower()
    key = (env.get("WEB_SEARCH_KEY") or "").strip()
    if not provider or not key:
        return None
    return SearchClient(provider, key, (env.get("WEB_SEARCH_CX") or "").strip() or None)


# ---- names and domains -------------------------------------------------------------------------------
def distinctive(name: str) -> list[str]:
    """The words of a company's name that tell it apart: "GOMTI AGRO FOODS PRIVATE LIMITED" -> ["gomti"]."""
    words = re.findall(r"[a-z0-9]+", (name or "").lower())
    return [w for w in words if w not in GENERIC and len(w) >= 3]


HONORIFICS = {"shri", "shree", "sri", "sree", "ms", "m"}


def initials(name: str) -> str:
    """The initials a name starts with: "VN AGRO" or "V N AGRO" or "S.K. FOODS" -> "vn" or "sk"; "" if none."""
    out = ""
    for tok in re.findall(r"[a-z0-9.]+", (name or "").lower()):
        letters = tok.replace(".", "")
        if 0 < len(letters) <= 2 and (len(letters) == 1 or "." in tok or len(out) == 0) and letters.isalpha():
            out += letters
        else:
            break
    return out if len(out) >= 2 else ""


def domain_fits(domain: str, name: str) -> bool:
    """The domain carries the company's distinctive name: gomtiagro.in or gomti-foods.com for Gomti Agro Foods.
    With one distinctive word it must be in the domain; with more, the first and one other (or a first of five
    letters or more, which is rarely shared by chance). A name that starts with initials ("VN Agro") fits a
    domain that starts with them and carries another word of the name (vnagro.in); a name that starts with an
    honorific ("Shri Ram Agro") also fits a domain that leaves it out (ramagro.in)."""
    label = re.sub(r"[^a-z0-9]", "", domain.split(".")[0])      # company_domain() has already dropped "www."
    ini = initials(short_name(name))
    if ini and label.startswith(ini):
        rest = label[len(ini):]
        others = [w for w in re.findall(r"[a-z0-9]+", short_name(name).lower()) if len(w) >= 3]
        if rest and any(w in rest for w in others):
            return True
    words = distinctive(name)
    if words and words[0] in HONORIFICS and words[0] not in label:
        words = words[1:]
    if not words or words[0] not in label:
        return False
    return len(words) == 1 or any(w in label for w in words[1:]) or len(words[0]) >= 5


def _compact(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def short_name(name: str) -> str:
    """The name without its legal form: "GOMTI AGRO FOODS PRIVATE LIMITED" -> "GOMTI AGRO FOODS"."""
    return re.sub(r"\s+(PRIVATE\s+LIMITED|PVT\.?\s*LTD\.?|LIMITED|LTD\.?|LLP|\(OPC\))\s*$", "", name or "", flags=re.I).strip()


def page_names_company(html: str, name: str, cin: str) -> bool:
    """The page names the company: its CIN, or its whole name without the legal form."""
    if cin and cin.upper() in html.upper():
        return True
    key = _compact(short_name(name))
    return len(key) >= 4 and key in _compact(BeautifulSoup(html, "lxml").get_text(" "))


def excluded(domain: str) -> bool:
    return any(domain == h or domain.endswith("." + h) for h in (*SHARED_HOSTS, *AGGREGATORS))


# ---- contacts on a site --------------------------------------------------------------------------------
def contacts_in(html: str, page_url: str, domain: str) -> dict:
    """Role addresses on the company's own domain, a contact form, and links to likely contact pages."""
    soup = BeautifulSoup(html, "lxml")
    emails = set(m.group(0).lower() for m in EMAIL_RX.finditer(soup.get_text(" ")))
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if href.lower().startswith("mailto:"):
            emails.add(href[7:].split("?")[0].strip().lower())
    own = sorted(e for e in emails if (e.split("@")[-1] == domain or e.split("@")[-1].endswith("." + domain)) and is_role_address(e))
    form = any(f.find("textarea") or f.find("input", attrs={"type": "email"}) for f in soup.find_all("form"))
    links = []
    for a in soup.find_all("a", href=True):
        u = urljoin(page_url, a["href"].strip())
        p = urlsplit(u)
        if p.scheme in ("http", "https") and company_domain(u) == domain and any(w in (p.path + " " + a.get_text(" ")).lower() for w in CONTACT_WORDS):
            links.append(u.split("#")[0])
    return {"emails": own, "form": form, "links": list(dict.fromkeys(links))[:3]}


def best_email(emails: list[str]) -> str | None:
    def rank(e):
        local = e.split("@")[0]
        return next((i for i, p in enumerate(PREFERRED) if local.startswith(p)), len(PREFERRED)), e
    return sorted(emails, key=rank)[0] if emails else None


# ---- the step ------------------------------------------------------------------------------------------
class Websites:
    def __init__(self, db, rawstore, caps: dict, *, fetcher, search: SearchClient | None, log=print,
                 clock=lambda: datetime.now(timezone.utc)):
        self.db, self.raw, self.fetcher, self.search, self.log, self.clock = db, rawstore, fetcher, search, log, clock
        self.meter = Meter(db, "web.search", int(caps.get("monthly", {}).get("web_searches", 1000)), "monthly", clock=clock)
        self.stats = Counter()

    def _shortlisted(self, month: str) -> list[str]:
        return [l["company_id"] for l in self.db.leads.find({"shortlist.month": month, "holdout": False, "eligible": True}, {"company_id": 1})
                .sort("shortlist.rank", 1)]

    def search_targets(self, month: str) -> list[dict]:
        ids = self._shortlisted(month)
        out = []
        now = self.clock()
        for c in self.db.companies.find({"_id": {"$in": ids}, "attrs.website": {"$exists": False}, "ids.domain": {"$in": [None, ""]}},
                                        {"name": 1, "attrs.registered_district.value": 1, "attrs.district.value": 1}):
            hit = cache.get(self.db, PROVIDER, "website", c["_id"], now)
            if hit and hit["status"] == "found":
                continue
            attempts = (hit or {}).get("result", {}).get("attempts", []) if hit else []
            if attempts:
                first = datetime.fromisoformat(attempts[0])
                due = [d for d in RETRY_DAYS if len(attempts) <= RETRY_DAYS.index(d) + 1 and now - first >= timedelta(days=d)]
                if len(attempts) > len(RETRY_DAYS) or not due:
                    continue
            out.append({**c, "attempts": attempts})
        return out

    def contact_targets(self, month: str) -> list[dict]:
        ids = self._shortlisted(month)
        now = self.clock()
        out = []
        for c in self.db.companies.find({"_id": {"$in": ids}, "$or": [{"attrs.website": {"$exists": True}}, {"ids.domain": {"$nin": [None, ""]}}]},
                                        {"name": 1, "attrs.website": 1, "ids.domain": 1}):
            if cache.get(self.db, PROVIDER, "contacts", c["_id"], now):
                continue
            domain = (c.get("ids") or {}).get("domain") or company_domain((c.get("attrs", {}).get("website") or {}).get("value"))
            if domain:
                out.append({**c, "domain": domain})
        return out

    def run(self, month: str, limit: int | None = None) -> dict:
        if self.search is None:
            self.stats["search_skipped_not_configured"] += 1
            self.log("websites: no search provider (WEB_SEARCH_PROVIDER and WEB_SEARCH_KEY): searching skipped, contacts only")
        else:
            for c in self.search_targets(month)[:limit]:
                if not self.meter.take():
                    self.stats["search_stopped_cap"] += 1
                    break
                self._search_one(c)
        for c in self.contact_targets(month)[:limit]:
            self._contacts_one(c)
        return dict(self.stats)

    def _fetch(self, url: str):
        try:
            r = self.fetcher.get(url)
        except Exception as exc:                 # robots says no, budget, network: no guess is made
            self.stats["pages_not_fetched"] += 1
            self.log(f"websites: {url}: {type(exc).__name__}")
            return None
        if not r.ok:
            self.stats["pages_not_ok"] += 1
            return None
        self.stats["pages_fetched"] += 1
        return r

    def _search_one(self, c: dict):
        now = self.clock()
        name = c["name"]
        district = ((c.get("attrs") or {}).get("registered_district") or (c.get("attrs") or {}).get("district") or {}).get("value") or ""
        q = f'"{short_name(name)}" {district}'.strip()
        attempts = [*c["attempts"], now.isoformat()]
        try:
            results = self.search.search(q)
        except Exception as exc:
            self.stats["search_failed"] += 1
            self.log(f"websites: search failed: {type(exc).__name__}: {exc}")
            return
        self.stats["searched"] += 1
        for rank, res in enumerate(results, 1):
            domain = company_domain(res.get("url"))
            if not domain or excluded(domain) or not domain_fits(domain, name):
                continue
            page = self._fetch(f"https://{domain}/")
            if page is None or not page_names_company(page.text, name, c["_id"]):
                continue
            ref = self.raw.put(page.content, source="company_website", url=f"https://{domain}/", content_type="text/html").key if self.raw else None
            self.db.companies.update_one({"_id": c["_id"], "attrs.website": {"$exists": False}}, {"$set": {
                "attrs.website": {"value": f"https://{domain}", "source": "web_discovery", "confidence": "medium", "seen_at": now,
                                  "ref": {"query": q, "rank": rank, "provider": self.search.provider, "raw": ref}},
                "ids.domain": domain, "updated_at": now}})
            cache.put(self.db, PROVIDER, "website", c["_id"], status="found", result={"attempts": attempts, "domain": domain}, kind="company", now=now)
            self.stats["websites_found"] += 1
            return
        # kept past the last retry (day 90), so the schedule is never restarted by an expired record
        cache.put(self.db, PROVIDER, "website", c["_id"], status="not_found", result={"attempts": attempts}, kind="company", now=now, ttl_days=120)
        self.stats["websites_not_found"] += 1

    def _contacts_one(self, c: dict):
        now = self.clock()
        domain = c["domain"]
        seen, emails, form_url, pages = set(), [], None, [f"https://{domain}/"]
        while pages and len(seen) < 4:
            url = pages.pop(0)
            if url in seen:
                continue
            seen.add(url)
            r = self._fetch(url)
            if r is None:
                continue
            found = contacts_in(r.text, url, domain)
            emails += [e for e in found["emails"] if e not in emails]
            if found["form"] and not form_url:
                form_url = url
            pages += [u for u in found["links"] if u not in seen]
            if self.raw:
                self.raw.put(r.content, source="company_website", url=url, content_type="text/html")
        email = best_email(emails)
        sets = {"updated_at": now}
        if email:
            sets["attrs.website_email"] = {"value": email, "source": "company_website", "confidence": "medium", "seen_at": now,
                                           "ref": {"domain": domain, "legal_basis": "published_by_company"}}
            self.stats["emails_found"] += 1
        if form_url:
            sets["attrs.contact_form"] = {"value": form_url, "source": "company_website", "confidence": "medium", "seen_at": now}
            self.stats["contact_forms_found"] += 1
        self.db.companies.update_one({"_id": c["_id"]}, {"$set": sets})
        cache.put(self.db, PROVIDER, "contacts", c["_id"], status="found" if (email or form_url) else "not_found",
                  result={"email": bool(email), "form": form_url, "pages": len(seen)}, kind="contact", now=now)
        self.stats["sites_read"] += 1

"""The MCA data vendor (Infyner; research note "india_data_crm_whatsapp_ecosystem", design 7.3).

What is known (from www.infyner.com/openapi.json and /api-pricing, read 26 October 2026):
  base URL      https://api.infyner.com, HTTP bearer key (pk_test_... sandbox, pk_live_... live)
  GET /v1/companies/{cin}            company lookup: 0.1 credit, free up to 500 a day
  GET /v1/companies/search?q=...     search by name or CIN: 0.1 credit, free up to 500 a day
  GET /v1/companies/{cin}/directors  2 credits
  GET /v1/companies/{cin}/profile    "profile snapshot", the full profile: 5 credits
What is not known: the response fields. The spec declares none. So every response is kept whole
in the raw store, and fields are read defensively by the names such APIs commonly use. Before the
first live run, `leadengine enrich probe <CIN> --op lookup|search|profile` calls the free sandbox
once per operation and prints the shape, and FIELD_NAMES below is corrected if needed. An answer
whose fields the adapter cannot find is "unparsed" (cached for a day, never mistaken for "not
found"), so a corrected FIELD_NAMES takes effect at once.

Failures are told apart. 404, or an empty record, is "not found". A 200 that carries an error
envelope ({"status": "error"}, {"success": false}) is an error, never data. 401/403 (a bad or expired
key), and 429/5xx that outlast the retries, raise VendorUnavailable: the step stops instead of
spending the day's quota on calls that cannot succeed.

Data from this vendor is MCA master data, which companies file under the Companies Act, so its
legal basis is "published under law". Directors' personal phone numbers ("director contact") are
never requested.
"""
import re
import time
from dataclasses import dataclass, field

import requests

BASE = "https://api.infyner.com"
PROVIDER = "infyner"
COST_INR = {"lookup": 0.0, "search": 0.0, "profile": 5.0}      # within the free daily quota; profile at about Rs 5
FIELD_NAMES = {
    "cin": ["cin", "llpin", "corporateidentificationnumber", "companycin"],
    "name": ["companyname", "name", "llpname", "registeredname"],
    "status": ["companystatus", "status", "cinstatus", "llpstatus"],
    "incorporated": ["dateofincorporation", "incorporationdate", "dateofregistration", "registrationdate", "incorporatedon"],
    "address": ["registeredofficeaddress", "registeredaddress", "registeredoffice", "address", "roaddress"],
    "email": ["emailid", "email", "emailaddress", "registeredemail", "companyemail"],
    "roc": ["roc", "roccode", "registrarofcompanies", "registrar"],
    "category": ["companycategory", "category"],
    "subcategory": ["companysubcategory", "subcategory"],
    "class": ["companyclass", "class"],
    "authorised_capital": ["authorisedcapital", "authorizedcapital", "authorisedcapitalrs", "authorizedcapitalrs"],
    "paid_up_capital": ["paidupcapital", "paidupcapitalrs"],
    "directors": ["directors", "signatories", "directorlist", "currentdirectors"],
}
DIRECTOR_FIELDS = {"din": ["din", "dinpan", "directoridentificationnumber"], "name": ["name", "directorname", "fullname"],
                   "designation": ["designation", "role"], "appointed_on": ["appointmentdate", "dateofappointment", "appointedon"]}


class NotConfigured(Exception):
    """No API key: vendor steps are skipped, never faked."""


class VendorUnavailable(Exception):
    """The vendor refused the key (401/403) or stayed overloaded (429/5xx after retries): stop the step."""


ENVELOPES = ("data", "result")
SUB_RECORDS = ("company", "companydetails", "companymasterdata", "masterdata", "basicdetails", "details", "llp")
LIST_KEYS = ("items", "results", "companies", "records", "list")


def _norm(k: str) -> str:
    return re.sub(r"[^a-z0-9]", "", k.lower())


def _looks_like_record(d: dict) -> bool:
    return pick(d, FIELD_NAMES["cin"]) is not None or pick(d, FIELD_NAMES["name"]) is not None


def _envelope_error(body) -> str | None:
    """The message of a 200 response that is really an error ({"status": "error"}, {"success": false})."""
    if not isinstance(body, dict):
        return None
    msg = str(body.get("message") or body.get("error") or body.get("detail") or "")
    if body.get("success") is False or body.get("ok") is False:
        return msg or "success: false"
    st = body.get("status")
    if isinstance(st, str) and st.strip().lower() in ("error", "failed", "failure", "fail"):
        return msg or st
    if body.get("error") and not any(k in body for k in ENVELOPES) and not _looks_like_record(body):
        return msg
    return None


def _payload(body):
    """What is inside the API's envelope. Only "data" and "result" are envelopes (unwrapped, nested
    at most twice); everything else, a field that happens to be called "result" included, is data."""
    for _ in range(2):
        if not isinstance(body, dict) or _looks_like_record(body):
            return body
        k = next((k for k in ENVELOPES if k in body and (body[k] is None or isinstance(body[k], (dict, list)))), None)
        if k is None:
            return body
        body = body[k]
    return body


def _record(rec) -> dict:
    """One company as a flat dict: a sub-record such as {"company": {...}, "directors": [...]} is merged
    into its parent, so sibling sections (directors, capital) are kept, not dropped."""
    if not isinstance(rec, dict):
        return {}
    out = dict(rec)
    for k, v in rec.items():
        if _norm(k) in SUB_RECORDS and isinstance(v, dict):
            for kk, vv in v.items():
                out.setdefault(kk, vv)
    return out


def _items(payload) -> list:
    """The rows of a search answer: a bare list, or the first list under a usual key."""
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for k, v in payload.items():
            if _norm(k) in LIST_KEYS and isinstance(v, list):
                return v
        return [payload] if _looks_like_record(payload) else []
    return []


def pick(record: dict, names: list[str]):
    if not isinstance(record, dict):
        return None
    flat = {_norm(k): v for k, v in record.items()}
    for n in names:
        v = flat.get(n)
        if v not in (None, "", [], {}):
            return v
    return None


def extract(record: dict) -> dict:
    out = {k: pick(record, names) for k, names in FIELD_NAMES.items()}
    if isinstance(out.get("directors"), list):
        out["directors"] = [{k: pick(d, n) for k, n in DIRECTOR_FIELDS.items()} for d in out["directors"] if isinstance(d, dict)]
    return {k: v for k, v in out.items() if v not in (None, "", [])}


@dataclass
class VendorAnswer:
    status: str                 # found | not_found | unparsed | error
    fields: dict = field(default_factory=dict)
    items: list = field(default_factory=list)      # for a search: [{"cin", "name", ...}]
    raw: bytes = b""
    http_status: int | None = None
    error: str | None = None


class InfynerClient:
    def __init__(self, api_key: str | None, *, base: str = BASE, timeout: float = 20, retries: int = 2,
                 session: requests.Session | None = None, sleep=time.sleep):
        if not api_key:
            raise NotConfigured("set INFYNER_API_KEY (pk_test_... for the sandbox, pk_live_... for live)")
        self.base, self.timeout, self.retries, self.sleep = base.rstrip("/"), timeout, retries, sleep
        self.session = session or requests.Session()
        self.session.headers.update({"Authorization": f"Bearer {api_key}", "Accept": "application/json",
                                     "User-Agent": "SolutionAI-LeadEngine/1.0"})
        self.sandbox = api_key.startswith("pk_test_")

    def _get(self, path: str, params: dict | None = None) -> VendorAnswer:
        for attempt in range(self.retries + 1):
            try:
                r = self.session.get(f"{self.base}{path}", params=params, timeout=self.timeout)
            except requests.RequestException as exc:    # dropped connections, timeouts, broken chunked bodies ...
                if attempt == self.retries:
                    return VendorAnswer("error", error=type(exc).__name__)
                self.sleep(2 ** attempt * 2)
                continue
            if r.status_code in (401, 403):
                raise VendorUnavailable(f"HTTP {r.status_code}: the vendor refused the API key")
            if r.status_code in (429, 500, 502, 503, 504):
                if attempt < self.retries:
                    ra = r.headers.get("Retry-After", "")
                    self.sleep(min(float(ra), 60) if ra.isdigit() else 2 ** attempt * 2)
                    continue
                raise VendorUnavailable(f"HTTP {r.status_code} after {self.retries + 1} attempts")
            if r.status_code == 404:
                return VendorAnswer("not_found", raw=r.content, http_status=404)
            if not 200 <= r.status_code < 300:
                return VendorAnswer("error", raw=r.content, http_status=r.status_code, error=f"HTTP {r.status_code}")
            try:
                body = r.json()
            except ValueError:
                return VendorAnswer("error", raw=r.content, http_status=r.status_code, error="not JSON")
            if (msg := _envelope_error(body)) is not None:
                gone = re.search(r"not\s*found|no\s*(record|data|match)", msg, re.I)
                return VendorAnswer("not_found" if gone else "error", raw=r.content, http_status=r.status_code,
                                    error=None if gone else msg[:200])
            return VendorAnswer("found", raw=r.content, http_status=r.status_code, fields={"_body": body})
        return VendorAnswer("error", error="retries exhausted")

    def _one_company(self, path: str) -> VendorAnswer:
        a = self._get(path)
        if a.status == "found":
            rec = _payload(a.fields.pop("_body"))
            if rec in (None, {}, []):
                a.status = "not_found"
            else:
                a.fields = extract(_record(rec))
                if not a.fields:
                    a.status = "unparsed"      # an answer we could not read is not a "not found"
        return a

    def lookup(self, cin: str) -> VendorAnswer:
        return self._one_company(f"/v1/companies/{cin}")

    def profile(self, cin: str) -> VendorAnswer:
        return self._one_company(f"/v1/companies/{cin}/profile")

    def search(self, name: str) -> VendorAnswer:
        a = self._get("/v1/companies/search", {"q": name})
        if a.status == "found":
            items = [i for i in _items(_payload(a.fields.pop("_body"))) if isinstance(i, dict)]
            a.items = [x for x in (extract(_record(i)) for i in items) if x.get("cin")]
            a.status = "found" if a.items else "unparsed" if items else "not_found"
        return a

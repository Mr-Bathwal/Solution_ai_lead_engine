"""The current view of every startup on the UP portals.

Startup in UP and UP Startup Mission list the same startups under the same UPLC application number,
so they join exactly. Incubator portfolio pages add which incubators a startup is with. Everything
is read through source_state, so it is the record as it is now, not an old version.

Each field remembers which portal it came from (`field_sources`), so a fact the knowledge base copies
onto a company names its real source: a district that only UP Startup Mission gave is not labelled
Startup in UP.
"""
import re
from dataclasses import dataclass, field
from datetime import date, datetime

from ..names import normalize_name
from ..sink import MongoSink
from ..sources import upsm

ENTITY_FORMS = {"Private Limited": "pvt ltd", "OPC": "opc pvt ltd", "LLP": "llp"}
ENTITY_TYPES = {"Private Limited", "OPC", "LLP", "Partnership", "Proprietorship"}


@dataclass
class Startup:
    key: str                                  # UPLC_xxxxxxxx (or name:... when a card had no number)
    names: list = field(default_factory=list)  # registered-name candidates, best first
    brand: str = ""
    entity_type: str = ""                     # "Private Limited", "OPC", "LLP", "Partnership", ...
    year: int | None = None                   # year of establishment as the founder gave it
    since: str | None = None                  # earliest portal date (profile active-since or logo upload)
    district: str = ""
    pincode: str = ""
    sector: str = ""
    industry: str = ""
    stage: str = ""
    website: str = ""
    women_led: bool | None = None
    incubators: list = field(default_factory=list)   # [{"name", "host"}]
    sources: dict = field(default_factory=dict)      # source -> last_seen_at
    profile_parsed: bool = False
    field_sources: dict = field(default_factory=dict)  # field -> the portal it came from

    @property
    def legal_form(self) -> str | None:
        """The form the founder's own entity type implies, used when the name carries none."""
        return ENTITY_FORMS.get(self.entity_type)

    @property
    def is_registered_entity(self) -> bool:
        """Only companies and LLPs have a CIN or LLPIN to find. A legal form in the registered name
        outranks the portal's entity-type dropdown: founders of LLPs (limited liability partnerships)
        sometimes pick "Partnership" there."""
        if any(normalize_name(n).legal_form for n in self.names):
            return True
        return self.entity_type not in ("Partnership", "Proprietorship")

    @property
    def stated_forms(self) -> set:
        """The legal forms the founder stated. A form written in a name outranks the dropdown, as in
        is_registered_entity; the dropdown speaks only when no name carries a form."""
        in_names = {normalize_name(n).legal_form for n in self.names} - {None}
        return in_names or ({self.legal_form} if self.legal_form else set())

    def name_keys(self):
        """(clean name, legal form) for each candidate name; the form falls back to the entity type."""
        out = []
        for n in self.names:
            k = normalize_name(n)
            if k.clean:
                out.append((k.clean, k.legal_form or self.legal_form, k))
        return out


def _year(v) -> int | None:
    """A year of establishment a startup could really have: from 1990 to next year. "1970" and the
    like are an empty date field read as a timestamp, not a founder's answer."""
    m = re.fullmatch(r"\s*(\d{4})\s*", str(v or ""))
    return int(m[1]) if m and 1990 <= int(m[1]) <= date.today().year + 1 else None


def _date(v) -> str | None:
    """An ISO date the portals could really have produced (2015 to today); logo timestamps are
    sometimes in milliseconds and decode to years like 2091."""
    ok = isinstance(v, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", v) and "2015-01-01" <= v <= date.today().isoformat()
    return v if ok else None


def load_startups(sink: MongoSink) -> dict[str, Startup]:
    out: dict[str, Startup] = {}

    def get(key):
        return out.setdefault(key, Startup(key=key))

    def put(s, attr, value, source):
        """Sets a field once, remembering the portal that gave it; the first portal to give it wins."""
        if value and not getattr(s, attr):
            setattr(s, attr, value)
            s.field_sources[attr] = source

    for rec in sink.current("startinup"):
        p, s = rec["payload"], get(rec["natural_key"])
        s.sources["startinup"] = rec["last_seen_at"]
        if p.get("legal_name"):
            s.names.insert(0, p["legal_name"])
        put(s, "brand", p.get("brand"), "startinup")
        put(s, "entity_type", p.get("entity_type") if p.get("entity_type") in ENTITY_TYPES else "", "startinup")
        s.year = _year(p.get("year_established")) or s.year
        dates = [d for d in (_date(p.get("active_since")), _date(p.get("logo_date"))) if d]
        if dates:
            s.since, s.field_sources["since"] = min(dates), "startinup"
        for attr in ("district", "pincode", "sector", "industry", "stage", "website"):
            put(s, attr, p.get(attr), "startinup")
        s.profile_parsed = bool(p.get("profile_parsed"))
        if p.get("incubator"):
            s.incubators.append({"name": p["incubator"], "host": p.get("incubator_host", "")})
            s.field_sources.setdefault("incubators", "startinup")

    for rec in sink.current("upsm"):
        v, s = upsm.view(rec["payload"]), get(rec["natural_key"])
        s.sources["upsm"] = rec["last_seen_at"]
        if v["name"] and v["name"] not in s.names:
            s.names.append(v["name"])
        for attr in ("entity_type", "district", "stage", "sector", "industry"):
            put(s, attr, v[attr], "upsm")
        s.women_led, s.field_sources["women_led"] = v["women_led"], "upsm"
        logo = _date(v["logo_date"])
        if logo and (not s.since or logo < s.since):
            s.since, s.field_sources["since"] = logo, "upsm"

    for rec in sink.current("incubator_portfolio"):
        p = rec["payload"]
        s = out.get(p.get("uplc"))
        if s is None:
            continue
        inc = {"name": p.get("incubator", ""), "host": p.get("incubator_host", "")}
        if inc["name"] and all(normalize_name(i["name"]).clean != normalize_name(inc["name"]).clean for i in s.incubators):
            s.incubators.append(inc)
            s.field_sources.setdefault("incubators", "incubator_portfolio")
    return _drop_superseded(out)


def _drop_superseded(out: dict[str, Startup]) -> dict[str, Startup]:
    """A Startup in UP card first read without its UPLC number is stored under "name:<name>"; once a
    later run finds the number, the same startup is stored again under its UPLC key, and the old
    "name:" record stays in source_state. Two records for one startup would claim one company twice,
    so a "name:" startup whose name is also a numbered startup's name is dropped."""
    numbered = set()
    for k, s in out.items():
        if not k.startswith("name:"):
            numbered |= {normalize_name(n).clean for n in [*s.names, s.brand] if n}
            numbered |= {normalize_name(n).clean.replace(" ", "-") for n in [*s.names, s.brand] if n}
    return {k: s for k, s in out.items()
            if not k.startswith("name:") or (k[5:] not in numbered
                                              and not any(normalize_name(n).clean in numbered for n in [*s.names, s.brand] if n))}


def since_year(s: Startup) -> int | None:
    return int(s.since[:4]) if s.since else None


def as_of(dt: datetime | None) -> str | None:
    return dt.date().isoformat() if dt else None

"""MCA's monthly incorporation report ("Companies and LLPs registered in <month>").

mca.gov.in blocks scripted downloads at its CDN, so a team member downloads the file each month
(about ten minutes) and the engine reads it from disk (later: from the Admin upload page).

The workbook has three sheets: Indian companies, LLPs and foreign companies. Each sheet has a title
block, a few blank rows, then a header row whose cells carry stray spaces (" CIN", " Company Name").
Only six columns are given for companies: CIN, class, name, date of registration, company type and
activity code. Everything else we know at this point is decoded from the CIN (see ids.py).

UP companies are kept. LLPINs carry no state, so LLPs are only counted here; the knowledge base
(kb/llp.py) finds the UP ones by matching the portals' LLPs against these LLP sheets.
"""
import io
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import openpyxl

from ..ids import parse_cin
from ..names import normalize_name
from ..records import Record, RunContext
from ..util import parse_date

SOURCE = "mca_monthly"
PAGE_URL = "https://www.mca.gov.in/content/mca/global/en/data-and-reports/company-llp-info/incorporated-closed-month.html"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

COLUMN_ALIASES = {
    "cin": "cin", "llpin": "llpin", "fcin": "fcin",
    "class": "class", "company name": "name", "llp name": "name",
    "date of registration": "registered_on", "date of incorporation": "registered_on",
    "company type": "company_type", "activity code": "activity_code", "activity": "activity_code",
}


@dataclass
class McaReport:
    companies: list = field(default_factory=list)
    llps: list = field(default_factory=list)
    foreign: list = field(default_factory=list)
    generated_at: datetime | None = None

    @property
    def period(self) -> str | None:
        """The registration month the report covers (the most common month among its rows)."""
        months = Counter(r["registered_on"][:7] for r in self.companies + self.llps if r.get("registered_on"))
        return months.most_common(1)[0][0] if months else None


def _cells(row) -> list[str]:
    return ["" if v is None else (v.isoformat() if isinstance(v, datetime) else str(v)).strip() for v in row]


def parse_report(data: bytes) -> McaReport:
    wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    rep = McaReport()
    for ws in wb.worksheets:
        head, kind = None, None
        for row in ws.iter_rows(values_only=True):
            vals = _cells(row)
            if head is None:
                joined = " ".join(vals)
                m = re.search(r"Date:\s*(\d{2}-[A-Za-z]{3}-\d{4}\s+\d{2}:\d{2}:\d{2})", joined)
                if m and rep.generated_at is None:
                    rep.generated_at = datetime.strptime(m[1], "%d-%b-%Y %H:%M:%S")
                low = [re.sub(r"\s+", " ", v).lower() for v in vals]
                for k in ("cin", "llpin", "fcin"):
                    if k in low:
                        head, kind = [COLUMN_ALIASES.get(c, c.replace(" ", "_")) for c in low], k
                        break
                continue
            if not any(vals):
                continue
            rec = {h: v for h, v in zip(head, vals) if h}
            d = parse_date(rec.get("registered_on"))
            rec["registered_on"] = d.isoformat() if d else ""
            {"cin": rep.companies, "llpin": rep.llps, "fcin": rep.foreign}[kind].append(rec)
    wb.close()
    return rep


class McaMonthlySource:
    name = SOURCE

    def __init__(self, path: str | Path):
        self.path = Path(path)

    def collect(self, ctx: RunContext):
        data = self.path.read_bytes()
        # a register published under law, kept exactly as MCA issued it (and a binary workbook: nothing to redact)
        ref = ctx.rawstore.put(data, source=SOURCE, url=f"upload://mca/{self.path.name}", content_type=XLSX, redact=False)
        rep = parse_report(data)
        by_registrar = Counter()
        for row in rep.companies:
            cin = parse_cin(row.get("cin"))
            if cin is None:
                ctx.stats["rows_with_bad_cin"] += 1
                continue
            ctx.stats["companies_india"] += 1
            if not cin.is_up:
                continue
            by_registrar[cin.state] += 1
            payload = {k: v for k, v in row.items() if k != "cin"} | {"cin": cin.value}
            yield Record(source=SOURCE, natural_key=cin.value, payload=payload, legal_basis="published_under_law",
                         url=PAGE_URL, company_id=cin.value, raw_ref=ref)
        ctx.stats["companies_up"] = sum(by_registrar.values())
        for code, n in by_registrar.items():
            ctx.stats[f"companies_up_{code}"] = n
        ctx.stats["llps_india_state_unknown"] = len(rep.llps)
        ctx.stats["foreign_companies"] = len(rep.foreign)
        ctx.note(f"{self.path.name}: period {rep.period}, generated {rep.generated_at:%Y-%m-%d %H:%M}"
                 if rep.generated_at else f"{self.path.name}: period {rep.period}")
        if rep.llps:
            ctx.note(f"{len(rep.llps)} LLPs registered across India; an LLPIN has no state, so UP LLPs are "
                     f"found by the knowledge base from the portals and these LLP sheets")


def to_company(rec: Record) -> dict:
    """The company fields an MCA row establishes. All of them are published under law."""
    p = rec.payload
    cin = parse_cin(p["cin"])
    attrs = {
        "legal_name": p.get("name", "").strip(),
        "incorporation_date": p.get("registered_on") or None,
        "company_class": p.get("class") or None,
        "company_category": p.get("company_type") or None,
        "company_type": cin.company_type,
        "listing": "listed" if cin.listing == "L" else "unlisted",
        "registrar": cin.registrar,
        "registrar_code": cin.state,
        "nic_code": cin.nic5,
        "nic_division": cin.nic_division,
        "sector": cin.sector or None,
    }
    inc = attrs["incorporation_date"]
    return {
        "_id": cin.value,
        "kind": "company",
        "name": attrs["legal_name"],
        "name_norm": normalize_name(attrs["legal_name"]).key,
        "ids": {"cin": cin.value},
        "cohort": inc[:7] if inc else None,
        "attrs": {k: v for k, v in attrs.items() if v not in (None, "")},
        "confidence": "high",
    }

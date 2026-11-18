"""A company's first-year compliance calendar.

The rules are data (config/rules/deadlines.json), each with the section of law it comes from, the
penalty and a source. This module only does the date arithmetic. It never says a filing was missed:
we cannot see what a company has filed, so a past date is shown as "was due by", for the founder to
check.

Three refinements on top of the plain arithmetic, all driven by the rules file:
  - a rule with a condition (DPT-3, or INC-20A for a Section 8 company without a share capital) keeps
    its date but has the status "conditional": it is never counted as a firm deadline and never
    becomes the next deadline a reminder is about;
  - by_tax_year swaps the law, penalty and source for a first tax year that the Income-tax Act 1961
    still governs (one ending on or before 31 March 2026);
  - overrides apply an extension announced by the CBDT or the MCA to the years it covers, with its
    source, so a calendar is not left showing the statutory date after it has been extended.
"""
import calendar
import json
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

from ..config import ROOT

RULES_PATH = ROOT / "config" / "rules" / "deadlines.json"
FIRM = ("due_soon", "upcoming", "was_due")      # statuses of deadlines that apply for certain


def load_rules(path: Path = RULES_PATH) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def add_months(d: date, months: int) -> date:
    """Calendar months, as the Act counts them: 14 Oct + 2 months = 14 Dec; 31 Dec + 2 months = 28/29 Feb."""
    m = d.month - 1 + months
    y, m = d.year + m // 12, m % 12 + 1
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def anchors(kind: str, inc: date) -> dict:
    """The dates every rule counts from."""
    tax_year_end = date(inc.year + (1 if inc.month >= 4 else 0), 3, 31)
    return {
        "incorporation": inc,
        # s.2(41): a company incorporated on or after 1 January runs to 31 March of the next year,
        # one incorporated from April to December to the 31 March after; both are inc.year + 1
        "company_first_fy_end": date(inc.year + 1, 3, 31),
        "llp_first_fy_end": tax_year_end,
        "first_tax_year_end": tax_year_end,
    }


@dataclass
class Deadline:
    id: str
    title: str
    form: str | None
    due: date | None
    status: str                 # upcoming | due_soon | was_due | conditional | advisory
    days_left: int | None
    law: str
    penalty: str
    service: str
    note: str | None
    source_url: str
    verified_on: str | None = None
    extended_by: str | None = None     # the override that moved the date, if one did

    def to_doc(self) -> dict:
        d = dict(self.__dict__)
        d["due"] = self.due.isoformat() if self.due else None
        return d


def applies(rule: dict, kind: str, type_code: str | None) -> bool:
    a = rule.get("applies_to", {})
    if kind not in a.get("kinds", []):
        return False
    codes = a.get("type_codes")
    return codes is None or type_code in codes


def _overrides_for(rules: dict, rule_id: str, base: dict) -> list[dict]:
    out = []
    for o in rules.get("overrides", []):
        w = o["when"]
        if rule_id in o["rules"] and base[w["anchor"]] == date.fromisoformat(w["equals"]):
            out.append(o)
    return out


def calendar_for(kind: str, type_code: str | None, incorporated: date, as_of: date, rules: dict | None = None,
                 soon_days: int = 30) -> list[Deadline]:
    rules = rules or load_rules()
    base = anchors(kind, incorporated)
    out = []
    for r in rules["rules"]:
        if not applies(r, kind, type_code):
            continue
        condition = r.get("condition") or (r.get("conditional_for") or {}).get(type_code)
        notes = [condition, r.get("advisory"), r.get("note"), (r.get("notes_by_type") or {}).get(type_code)]
        if kind == "llp" and incorporated.month in (10, 11, 12):
            notes.append(r.get("notes_if_late_registration"))
        if kind == "llp" and incorporated.month in (1, 2, 3):
            notes.append(r.get("notes_if_jan_mar_registration"))
        form = (r.get("form_by_type") or {}).get(type_code, r.get("form"))
        law, penalty, source_url = r["law"], r["penalty"], r["source_url"]
        due, extended_by = None, None
        if r.get("due"):
            spec = r["due"]
            due = base[spec["anchor"]]
            if spec.get("months"):
                due = add_months(due, spec["months"])
            due = due + timedelta(days=spec.get("days", 0) + spec.get("plus_days", 0))
            for era in r.get("by_tax_year", []):
                if base["first_tax_year_end"] <= date.fromisoformat(era["tax_year_end_on_or_before"]):
                    law, penalty = era.get("law", law), era.get("penalty", penalty)
                    source_url = era.get("source_url", source_url)
                    break
            for o in _overrides_for(rules, r["id"], base):
                if o.get("due"):
                    due, extended_by = date.fromisoformat(o["due"]), o["id"]
                notes.append(o.get("note"))
        if due is None:
            status, days_left = ("advisory" if r.get("advisory") else "conditional"), None
        else:
            days_left = (due - as_of).days
            status = ("conditional" if condition else
                      "was_due" if days_left < 0 else "due_soon" if days_left <= soon_days else "upcoming")
        note = " ".join(n for n in notes if n) or None
        out.append(Deadline(r["id"], r["title"], form, due, status, days_left, law, penalty, r.get("service", ""),
                            note, source_url, r.get("verified_on"), extended_by))
    order = {"due_soon": 0, "upcoming": 1, "was_due": 2, "conditional": 3, "advisory": 4}
    return sorted(out, key=lambda d: (order[d.status], d.due or date.max))


def next_deadline(items: list[Deadline]) -> Deadline | None:
    """The earliest firm deadline still ahead: what a reminder would be about. Conditional rules never
    qualify, because we cannot tell whether they apply to the company."""
    ahead = [d for d in items if d.status in ("due_soon", "upcoming")]
    return min(ahead, key=lambda d: d.due) if ahead else None


def timing(items: list[Deadline], ahead_days: int, passed_days: int) -> tuple[int, int]:
    """(distinct firm due dates in the next `ahead_days`, distinct firm due dates in the last `passed_days`).
    Dates, not rules: the first board meeting and the first auditor fall on one day and are one event
    for the founder."""
    firm = [d for d in items if d.status in FIRM and d.days_left is not None]
    ahead = {d.due for d in firm if 0 <= d.days_left <= ahead_days}
    passed = {d.due for d in firm if -passed_days <= d.days_left < 0}
    return len(ahead), len(passed)

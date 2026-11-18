"""Scheme verdicts for a company.

Design 7.4: the engine asks the platform's rules engine, so a founder sees the same verdicts Mr. AI
shows. Until that endpoint exists (design question 6), verdicts come from the provisional rules in
config/rules/schemes.json, and every verdict says which of the two produced it.

The facts sent are public, company-level facts only; nothing personal leaves the engine.

The rules language is three-valued. Every predicate is True, False or None (unknown), and a rule fires
only when its condition is True. "not" of unknown is unknown, "all" is unknown unless some part is
False, "any" is unknown unless some part is True. So a fact we do not hold can never make a rule fire,
whichever way the rule is written, and a missing fact can only ever lead to the scheme's default.
"""
import json
import os
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import requests

from ..config import ROOT

RULES_PATH = ROOT / "config" / "rules" / "schemes.json"
VERDICTS = ("eligible", "check_required", "not_eligible", "closed", "held")


@dataclass
class Facts:
    kind: str                       # company | llp
    type_code: str | None           # PTC, OPC, PLC, NPL, ... or "LLP"
    incorporated: date | None
    as_of: date
    district: str | None = None
    sector: str | None = None
    stage: str | None = None
    startinup_listed: bool | None = None   # None: we have not seen it on the portal, which is not "No"
    incubated: bool | None = None          # None: no incubator known, which is not "No"
    women_led: bool | None = None
    dpiit_recognised: bool | None = None   # unknown until a founder tells us
    extra: dict = field(default_factory=dict)

    @property
    def age_years(self) -> float | None:
        return (self.as_of - self.incorporated).days / 365.25 if self.incorporated else None

    def public(self) -> dict:
        """What may be sent to the platform's rules engine."""
        return {"kind": self.kind, "type_code": self.type_code, "state": "UP",
                "incorporated": self.incorporated.isoformat() if self.incorporated else None,
                "as_of": self.as_of.isoformat(), "district": self.district, "sector": self.sector, "stage": self.stage,
                "startinup_listed": self.startinup_listed, "incubated": self.incubated,
                "dpiit_recognised": self.dpiit_recognised}


def load_rules(path: Path = RULES_PATH) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _fold(v):
    return v.strip().casefold() if isinstance(v, str) else v


def _holds(pred: dict, f: Facts) -> bool | None:
    """One predicate of the rules language: True, False, or None when it depends on a fact we do not hold."""
    if "all" in pred:
        parts = [_holds(p, f) for p in pred["all"]]
        return False if False in parts else None if None in parts else True
    if "any" in pred:
        parts = [_holds(p, f) for p in pred["any"]]
        return True if True in parts else None if None in parts else False
    if "not" in pred:
        inner = _holds(pred["not"], f)
        return None if inner is None else not inner
    if "type_code_in" in pred:
        return None if f.type_code is None else f.type_code in pred["type_code_in"]
    if "age_years_over" in pred:
        return None if f.age_years is None else f.age_years > pred["age_years_over"]
    if "incorporated_before" in pred:
        return None if f.incorporated is None else f.incorporated < date.fromisoformat(pred["incorporated_before"])
    if "incorporated_on_or_after" in pred:
        return None if f.incorporated is None else f.incorporated >= date.fromisoformat(pred["incorporated_on_or_after"])
    if "as_of_after" in pred:
        return f.as_of > date.fromisoformat(pred["as_of_after"])
    if "fact" in pred:
        v = _fold(getattr(f, pred["fact"], None))
        if v in (None, ""):
            return None
        if "is" in pred:
            return v == _fold(pred["is"])
        if "known_and_not_in" in pred:
            return v not in {_fold(x) for x in pred["known_and_not_in"]}
        if "in" in pred:
            return v in {_fold(x) for x in pred["in"]}
    raise ValueError(f"unknown predicate: {pred}")


def _expired_closed(hit: dict, f: Facts) -> dict | None:
    """A 'closed' verdict is trusted only until its valid_until date; after that (or without one) the
    scheme may have reopened, so the verdict becomes 'check required'."""
    until = hit.get("valid_until")
    if until and f.as_of <= date.fromisoformat(until):
        return None
    when = f"was valid until {until}" if until else "has no date until which it holds"
    return {"verdict": "check_required",
            "reason": f"Last recorded as closed ({hit['reason']}), but that finding {when}; whether the scheme is "
                      f"taking applications must be checked again.",
            "missing": ["whether applications are open"]}


def evaluate(f: Facts, rules: dict | None = None) -> list[dict]:
    rules = rules or load_rules()
    out = []
    for s in rules["schemes"]:
        hit = next((r for r in s.get("rules", []) if _holds(r["if"], f) is True), None) or s["default"]
        if hit["verdict"] == "closed":
            hit = _expired_closed(hit, f) or hit
        out.append({
            "scheme_id": s["id"], "name": s["name"], "level": s["level"], "benefit": s["benefit"],
            "verdict": hit["verdict"], "reason": hit["reason"].replace("{stage}", f.stage or ""),
            "missing": hit.get("missing", []), "law": s["law"], "source_url": s["source_url"],
            "apply_url": s.get("apply_url"), "checked_on": s.get("checked_on"), "verified_on": s.get("verified_on"),
            "valid_until": hit.get("valid_until"), "by": "provisional_rules", "rules_version": rules["version"],
        })
    return out


class PlatformRulesClient:
    """The platform's rules engine. Proposed contract (to agree with the platform team):

        POST {RULES_ENGINE_URL}/v1/verdicts      Authorization: Bearer {RULES_ENGINE_KEY}
        {"company": <Facts.public()>}
        -> {"rules_version": "...", "verdicts": [{"scheme_id", "name", "verdict", "reason", "missing", "source_url"}]}
    """

    # After this many failures in a row the client stops calling for the rest of the run, so an outage
    # costs a few timeouts, not one per company (12,700 x 10 s would hold the nightly up for 35 hours).
    MAX_CONSECUTIVE_FAILURES = 5

    def __init__(self, url: str, key: str, timeout: float = 10):
        self.url, self.key, self.timeout = url.rstrip("/"), key, timeout
        self.session = requests.Session()
        self.failures = 0

    @property
    def available(self) -> bool:
        return self.failures < self.MAX_CONSECUTIVE_FAILURES

    @classmethod
    def from_env(cls, env=None):
        env = env or os.environ
        url, key = env.get("RULES_ENGINE_URL"), env.get("RULES_ENGINE_KEY")
        return cls(url, key) if url and key else None

    def verdicts(self, f: Facts) -> list[dict]:
        r = self.session.post(f"{self.url}/v1/verdicts", json={"company": f.public()}, timeout=self.timeout,
                              headers={"Authorization": f"Bearer {self.key}"})
        r.raise_for_status()
        body = r.json()
        out = []
        for v in body.get("verdicts", []):
            if v.get("verdict") not in VERDICTS:
                continue
            out.append({**v, "by": "platform_rules_engine", "rules_version": body.get("rules_version")})
        return out


def verdicts_for(f: Facts, *, client: PlatformRulesClient | None = None, rules: dict | None = None) -> tuple[list[dict], str]:
    """(verdicts, source). Falls back to the provisional rules if the platform cannot answer, and for
    the rest of the run once it has failed several times in a row."""
    if client and getattr(client, "available", True):
        try:
            out = client.verdicts(f)
            client.failures = 0
            return out, "platform_rules_engine"
        except (requests.RequestException, ValueError):
            client.failures = getattr(client, "failures", 0) + 1
    return evaluate(f, rules), "provisional_rules"

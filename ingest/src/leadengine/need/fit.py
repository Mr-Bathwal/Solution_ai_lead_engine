"""The fit score: how well a company fits what SolutionAI offers, and how timely contact would be.

Rules only (config/fit.json), with every point explained. Design 7.4: once 300-500 outcomes exist, a
calibrated model (logistic regression or gradient-boosted trees) is trained on real results; an AI
model's own "score out of 100" is never used, because such scores are overconfident.
"""
import json
from dataclasses import dataclass
from pathlib import Path

from ..config import ROOT

FIT_PATH = ROOT / "config" / "fit.json"


def load_config(path: Path = FIT_PATH) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


@dataclass
class FitInput:
    type_code: str | None
    age_days: int | None
    innovation: int
    theme_id: str | None
    near_deadlines: int          # distinct firm due dates within the configured window ahead
    startup_portal: bool
    incubated: bool
    has_domain: bool
    passed_deadlines: int = 0    # distinct firm due dates that passed within the configured window behind


def score(x: FitInput, cfg: dict) -> tuple[int, list[dict]]:
    parts = []

    def add(points, reason, key):
        if points:
            parts.append({"key": key, "points": round(points, 1), "reason": reason})

    add(x.innovation * cfg["innovation_weight"], f"looks like a technology or innovation business ({x.innovation}/100 "
        "on the Atlas classifier)" if x.innovation >= 40 else f"innovation signal {x.innovation}/100 on the Atlas classifier",
        "innovation")
    if x.age_days is not None:
        for days, pts in cfg["recency_points"]:
            if x.age_days <= days:
                add(pts, f"incorporated {x.age_days} days ago: its first-year obligations are still ahead", "recency")
                break
    if x.near_deadlines or x.passed_deadlines:
        # a date that has just passed counts as much as one ahead: the founder may still need to act
        # (we cannot see what was filed, so this never says a deadline was missed)
        timing = []
        if x.near_deadlines:
            timing.append(f"{x.near_deadlines} first-year deadline date(s) in the next {cfg['deadline_window_days']} days")
        if x.passed_deadlines:
            timing.append(f"{x.passed_deadlines} first-year deadline date(s) in the last "
                          f"{cfg.get('passed_deadline_window_days', 0)} days, which the founder may still need to act on")
        add(min(cfg["max_deadline_points"], x.near_deadlines * cfg["points_per_near_deadline"]
                + x.passed_deadlines * cfg.get("points_per_passed_deadline", 0)), " and ".join(timing), "deadlines")
    if x.startup_portal:
        add(cfg["startup_portal_points"], "listed on a UP startup portal", "startup_portal")
    if x.incubated:
        add(cfg["incubator_points"], "with a recognised incubator", "incubator")
    if x.has_domain:
        add(cfg["domain_points"], "has its own website, so it can be reached and checked", "domain")
    add(cfg["type_points"].get(x.type_code or "", 0), {"PLC": "a public company, rarely a startup",
                                                       "NPL": "a not-for-profit (Section 8) company"}.get(x.type_code, ""), "type")
    if x.theme_id and cfg["theme_points"].get(x.theme_id):
        add(cfg["theme_points"][x.theme_id], f"sector theme {x.theme_id} is a focus", "theme")
    total = int(round(max(0.0, min(100.0, sum(p["points"] for p in parts)))))
    return total, parts

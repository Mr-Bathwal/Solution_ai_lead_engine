"""Leads: one per company, rebuilt nightly (design 7.4 and 7.8).

For every company the engine works out:
  - whether it is eligible for outreach at all, and if not, why;
  - its first-year deadline calendar and its scheme verdicts (its "needs");
  - its fit score, every point explained;
  - whether it is in the holdout group, which is never contacted;
  - for the month being planned, whether it is on the shortlist of the top N.

Holdout. A keyed hash of the company id (HMAC-SHA256 with a secret salt) gives each company a
number u in [0, 1); u < 10% means holdout. That is random with respect to everything the score
looks at, the same on every run, and cannot be steered by anyone who does not hold the salt. Once
drawn it is stored and never redrawn, even if the salt or the percentage changes later.

Shortlist. The eligible companies of the month's cohorts are ranked by fit. Walking down the
ranking, every company gets its rank; non-holdout companies become "shortlisted" until N of them
are. The holdout companies met on the way keep their rank, so "contacted top N" can be compared
with "holdout companies that would have been in the top N", which is the honest measure of lift.
Equal scores are ordered by a second keyed hash of the company id (same salt, another label), so a
tie is broken at random rather than by incorporation date or CIN. A shortlist, once made for a
month, is kept: a re-run fills only the places still open. Each new entry records the day it was
ranked and its fit at that moment, so the comparison can be reproduced later.

Sector cap. No sector theme takes more than shortlist_theme_cap_pct of the N places (config/fit.json);
once a theme is full, its next companies are passed over, holdout or not, and the walk goes on.
Without it, technology names and NIC codes took three quarters of the list.

Stages only ever move forward.
"""
import hashlib
import hmac
import math
import os
from collections import Counter
from datetime import date, datetime, timezone

from pymongo import UpdateOne

from ..ids import parse_cin
from ..util import IST
from . import classify, deadlines, fit, schemes

STAGES = ["discovered", "shortlisted", "contacted", "engaged", "claimed", "customer", "closed"]
HOLDOUT_METHOD = "hmac-sha256-v1"
DEV_SALT = "lead-engine-development-salt"
TIEBREAK_LABEL = "shortlist-tiebreak:"
NO_COMPANY = "the company record is no longer held"


def holdout_salt(env=None) -> tuple[str, str, bool]:
    """(salt, salt id, is the development default). Production sets HOLDOUT_SALT once and never changes it.

    Draws are stored and never redrawn, so a first production run with the public development salt
    would fix a predictable holdout for good. Without HOLDOUT_SALT this therefore refuses to run,
    unless LEADENGINE_ENV is "development"."""
    env = env if env is not None else os.environ
    salt = env.get("HOLDOUT_SALT")
    if salt and salt != DEV_SALT:
        return salt, hashlib.sha256(salt.encode()).hexdigest()[:8], False
    if env.get("LEADENGINE_ENV") == "development":
        return DEV_SALT, hashlib.sha256(DEV_SALT.encode()).hexdigest()[:8], True
    raise RuntimeError("HOLDOUT_SALT is not set. It decides, once and for good, which companies are never contacted: "
                       "set it before the first run on this database (or set LEADENGINE_ENV=development on a laptop).")


def holdout_u(company_id: str, salt: str) -> float:
    digest = hmac.new(salt.encode(), company_id.encode(), hashlib.sha256).digest()
    return int.from_bytes(digest[:8], "big") / 2 ** 64


def tiebreak_u(company_id: str, salt: str) -> float:
    """A second keyed hash, independent of the holdout draw, that orders companies with equal fit."""
    return holdout_u(TIEBREAK_LABEL + company_id, salt)


def _attr(c, name, default=None):
    return ((c.get("attrs") or {}).get(name) or {}).get("value", default)


def _known(v) -> bool | None:
    """A yes/no fact as the rules need it: None when we hold nothing (not seen is not 'No')."""
    return None if v in (None, "", []) else bool(v)


def type_code(c) -> str | None:
    if c.get("kind") == "llp":
        return "LLP"
    cin = parse_cin(c["_id"])
    return cin.type_code if cin else None


def eligibility(c, inc: date | None, as_of: date, cfg: dict) -> list[str]:
    """Reasons a company must not be contacted. An empty list means it is eligible."""
    e = cfg["eligibility"]
    out = []
    tc = type_code(c)
    if tc not in e["type_codes"]:
        out.append(f"company type {tc or 'unknown'} is not one we contact (government, foreign or unlimited companies)")
    if e.get("exclude_listed") and _attr(c, "listing") == "listed":
        out.append("listed company")
    if inc is None:
        out.append("no incorporation date")
    elif (as_of - inc).days > e["max_age_years"] * 365.25:
        out.append(f"older than {e['max_age_years']} years")
    status = _attr(c, "company_status")
    if status and str(status).strip().lower() not in ("active", "active compliant"):
        out.append(f"registry status is {status}")
    return out


def assess(c: dict, as_of: date, cfg: dict, deadline_rules: dict, scheme_rules: dict, client=None) -> dict:
    """Everything the need engine says about one company."""
    inc_s = _attr(c, "incorporation_date")
    inc = date.fromisoformat(inc_s) if inc_s else None
    tc = type_code(c)
    cl = classify.classify(c["name"], brand=_attr(c, "brand", "") or "", nic=_attr(c, "nic_code", "") or _attr(c, "nic_division", "") or "",
                           sector_label=_attr(c, "portal_sector", "") or "", industry=_attr(c, "portal_industry", "") or "",
                           website=_attr(c, "website", "") or "", incorporated_year=inc.year if inc else None,
                           section8=tc == "NPL")
    cal = deadlines.calendar_for(c.get("kind", "company"), None if tc == "LLP" else tc, inc, as_of, deadline_rules) if inc else []
    near, passed = deadlines.timing(cal, cfg["deadline_window_days"], cfg.get("passed_deadline_window_days", 0))
    facts = schemes.Facts(kind=c.get("kind", "company"), type_code=tc, incorporated=inc, as_of=as_of,
                          district=_attr(c, "district"), sector=cl.theme, stage=_attr(c, "stage"),
                          startinup_listed=_known(_attr(c, "startinup_listed")),
                          incubated=_known(_attr(c, "incubators")), women_led=_known(_attr(c, "women_led")))
    verdicts, verdict_source = schemes.verdicts_for(facts, client=client, rules=scheme_rules)
    points, parts = fit.score(fit.FitInput(
        type_code=tc, age_days=(as_of - inc).days if inc else None, innovation=cl.innovation, theme_id=cl.theme_id,
        near_deadlines=near, startup_portal=bool(_attr(c, "startinup_listed") or _attr(c, "upsm_listed")),
        incubated=bool(facts.incubated), has_domain=bool((c.get("ids") or {}).get("domain")),
        passed_deadlines=passed), cfg)
    confirmed = bool(deadline_rules.get("confirmed_by")) and (
        verdict_source == "platform_rules_engine" or bool(scheme_rules.get("confirmed_by")))
    nxt = deadlines.next_deadline(cal)
    return {
        "inc": inc, "reasons": eligibility(c, inc, as_of, cfg),
        "score": {"fit": points, "components": parts, "version": cfg["version"],
                  "theme": {"id": cl.theme_id, "name": cl.theme, "sub_sector": cl.sub_sector,
                            "confidence": cl.confidence, "innovation": cl.innovation, "evidence": cl.evidence}},
        "needs": {"deadlines": [d.to_doc() for d in cal], "schemes": verdicts,
                  "next_deadline": nxt.to_doc() if nxt else None,
                  "rules_version": f"{deadline_rules['version']}+{verdicts[0]['rules_version'] if verdicts else ''}",
                  "verdicts_by": verdict_source, "rules_confirmed": confirmed},
    }


def previous_month(month: str) -> str:
    y, m = map(int, month.split("-"))
    return f"{y - 1}-12" if m == 1 else f"{y}-{m - 1:02d}"


def mca_file_loaded(db, cohort: str) -> bool:
    """True once the MCA monthly file covering `cohort` has been loaded (its run notes give the period)."""
    return db.ingest_runs.find_one({"source": "mca_monthly", "status": {"$in": ["ok", "partial"]},
                                    "notes": {"$regex": f"period {cohort}\\b"}}, {"_id": 1}) is not None


def run(db, *, month: str, cohorts: list[str] | None = None, as_of: date | None = None, shortlist_size: int = 200,
        holdout_pct: float = 10, cfg: dict | None = None, client=None, env=None, require_mca_file: bool = False,
        log=print) -> dict:
    """Rebuilds every lead and makes (or tops up) the shortlist for `month` ("2026-11").

    With require_mca_file, a cohort is shortlisted only once its MCA file is loaded. Otherwise, in the
    first days of a month (before the file is out), the few companies already known for that cohort
    would take shortlist places that belong to the month's best-fit companies."""
    salt, salt_id, dev_salt = holdout_salt(env)          # first: refuses to run without a salt
    as_of = as_of or datetime.now(IST).date()             # the IST day, whatever the server's time zone
    cohorts = cohorts or [previous_month(month)]
    waiting = [c for c in cohorts if require_mca_file and not mca_file_loaded(db, c)]
    cohorts = [c for c in cohorts if c not in waiting]
    cfg = cfg or fit.load_config()
    deadline_rules, scheme_rules = deadlines.load_rules(), schemes.load_rules()
    now = datetime.now(timezone.utc)
    existing = {d["company_id"]: d for d in db.leads.find({}, {"company_id": 1, "stage": 1, "holdout": 1,
                                                               "holdout_draw": 1, "shortlist": 1,
                                                               "eligibility_reasons": 1})}
    stats = Counter()
    plans = {}
    for c in db.companies.find({}):
        a = assess(c, as_of, cfg, deadline_rules, scheme_rules, client)
        prev = existing.get(c["_id"], {})
        draw = prev.get("holdout_draw")
        if draw is None:
            u = holdout_u(c["_id"], salt)
            draw = {"method": f"{HOLDOUT_METHOD}:{salt_id}:{holdout_pct:g}%", "u": u, "drawn_at": now}
            holdout = u < holdout_pct / 100
        else:
            holdout = prev["holdout"]
        plans[c["_id"]] = {"c": c, "a": a, "prev": prev, "draw": draw, "holdout": holdout,
                           "cohort": c.get("cohort") or (a["inc"].strftime("%Y-%m") if a["inc"] else None)}
        stats["holdout" if holdout else "not_holdout"] += 1
        stats["eligible" if not a["reasons"] else "not_eligible"] += 1

    # ---- the month's shortlist ---------------------------------------------------------------
    pool = [cid for cid, p in plans.items() if not p["a"]["reasons"] and p["cohort"] in cohorts]
    pool.sort(key=lambda cid: (-plans[cid]["a"]["score"]["fit"], tiebreak_u(cid, salt), cid))
    kept = {cid for cid, p in plans.items() if (p["prev"].get("shortlist") or {}).get("month") == month}
    taken = sum(1 for cid in kept if not plans[cid]["holdout"])
    ranks = {cid: plans[cid]["prev"]["shortlist"]["rank"] for cid in kept}
    rank = max(ranks.values(), default=0)
    # No sector theme may take more than its cap of the places to contact. Whether a company enters
    # never depends on its own holdout flag, so the holdout stays a fair comparison group.
    cap_pct = cfg.get("shortlist_theme_cap_pct")
    cap = math.ceil(cap_pct / 100 * shortlist_size) if cap_pct else None
    per_theme = Counter(_theme(plans[cid]) for cid in kept if not plans[cid]["holdout"])
    for cid in pool:
        if taken >= shortlist_size:
            break
        if cid in kept:
            continue
        theme = _theme(plans[cid])
        if cap and per_theme[theme] >= cap:
            stats["skipped_theme_cap"] += 1
            continue
        rank += 1
        ranks[cid] = rank
        if not plans[cid]["holdout"]:
            taken += 1
            per_theme[theme] += 1
    stats["shortlisted"] = taken
    stats["holdout_in_shortlist_range"] = sum(1 for cid in ranks if plans[cid]["holdout"])
    stats["pool"] = len(pool)

    # ---- write ---------------------------------------------------------------------------------
    ops = []
    for cid, p in plans.items():
        a, prev = p["a"], p["prev"]
        cur = prev.get("stage", "discovered")
        want = "shortlisted" if cid in ranks and not p["holdout"] and not a["reasons"] else "discovered"
        stage = max(cur, want, key=STAGES.index)
        sets = {
            "stage": stage, "holdout": p["holdout"], "holdout_draw": p["draw"], "eligible": not a["reasons"],
            "eligibility_reasons": a["reasons"], "score": {**a["score"], "computed_at": now},
            "needs": {**a["needs"], "computed_at": now}, "next_action": _next_action(p, cid in ranks, stage),
            "updated_at": now,
        }
        if p["cohort"]:
            sets["cohort"] = p["cohort"]
        if cid in ranks and cid not in kept:      # a kept entry keeps its rank, day and fit as first written
            sets["shortlist"] = {"month": month, "rank": ranks[cid], "as_of": as_of.isoformat(),
                                 "fit": a["score"]["fit"], "theme_cap_pct": cap_pct}
        if not p["cohort"]:
            stats["skipped_no_cohort"] += 1
            continue
        ops.append(UpdateOne({"company_id": cid}, {"$set": sets, "$setOnInsert": {"company_id": cid, "created_at": now}},
                             upsert=True))
    stats["leads_written"] = len(ops)
    # A lead whose company record is gone (a portal LLP whose link the knowledge base dropped) is kept,
    # with its history, but can never be shortlisted or contacted again.
    gone = [cid for cid, prev in existing.items() if cid not in plans and prev.get("eligibility_reasons") != [NO_COMPANY]]
    for cid in gone:
        ops.append(UpdateOne({"company_id": cid}, {"$set": {
            "eligible": False, "eligibility_reasons": [NO_COMPANY], "updated_at": now,
            "next_action": {"type": "none", "why": NO_COMPANY}}}))
    stats["company_gone"] = sum(1 for cid in existing if cid not in plans)
    for i in range(0, len(ops), 1000):
        db.leads.bulk_write(ops[i:i + 1000], ordered=False)
    out = dict(stats) | {"month": month, "cohorts": cohorts, "as_of": as_of.isoformat(), "holdout_salt_id": salt_id}
    if waiting:
        out["cohorts_waiting_for_mca_file"] = waiting
    if dev_salt:
        out["warning"] = "HOLDOUT_SALT is not set: the development salt was used. Set it once in production before the first real draw."
    log(f"leads: {stats['leads_written']} written, {taken} shortlisted for {month} from cohorts {cohorts}")
    return out


def _theme(plan: dict) -> str | None:
    return ((plan["a"]["score"].get("theme") or {}).get("id"))


def _next_action(p: dict, in_range: bool, stage: str) -> dict:
    a = p["a"]
    if a["reasons"]:
        return {"type": "none", "why": "; ".join(a["reasons"])}
    if p["holdout"]:
        return {"type": "none", "why": "holdout group: never contacted, so the engine's effect can be measured"}
    if stage != "shortlisted":
        return {"type": "none", "why": "contact already under way" if STAGES.index(stage) > 1 else
                "not in this month's shortlist"}
    if not in_range:
        earlier = (p["prev"].get("shortlist") or {}).get("month")
        return {"type": "none", "why": f"shortlisted for {earlier or 'an earlier month'} and not contacted; "
                                       "not in this month's shortlist"}
    if not a["needs"]["rules_confirmed"]:
        return {"type": "confirm_rules", "why": "deadline and scheme rules await a CA's confirmation before any message uses them"}
    return {"type": "enrich_full_profile", "why": "shortlisted: buy the full profile (address, directors, registered email)"}

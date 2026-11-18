"""Measuring the matcher (design 7.2 "Quality check" and 7.10).

Three measures, reported side by side and never mixed up:

  labelled       pairs a person decided (match_reviews), scored against the matcher's OWN decision
                 (entity_links.matcher, made without any reviewer's input). A reviewer's "same" turns
                 the written link into a manual one, so scoring the written link would leave nothing
                 to measure after the next rebuild. One labelled startup in five (match.holdout) is
                 never used to train the model; precision on that fold is the honest number for the
                 design's 95% target. Precision is reported for exact-name and Splink links apart,
                 with a 95% Wilson interval, because 150 exact links would hide a weak Splink path.
  misspelling    a self-test that needs no labels: names of startups the matcher linked exactly are
                 misspelt the ways founders misspell them, and the matcher must find the same company
                 again, or send the pair to a person, and never link a different company. Most of these
                 misspellings are undone by the name cleaner alone and never reach Splink; those cases
                 are counted apart ("solved_by_normaliser"), so the fuzzy rate is the fuzzy matcher's.
                 A changed generic word ("Solutions" for "Technologies") names a different company, so
                 there a link is a wrong link. The test runs at the production prior.
  leave-one-out  the "absent company" test over the whole company universe: a startup carrying a
                 real company's exact name, year and a listing a month after incorporation is matched
                 against every other company. Its own company is absent, so every link is wrong. It is
                 the test that found 18 sibling links in 4,000 UP names in the first version.
"""
import csv
import math
import random
from collections import Counter, defaultdict
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from . import match
from .entities import Startup

LABEL_FIELDS = ["entity_key", "startup_names", "entity_type", "year", "on_portal_since", "district",
                "company_id", "company_name", "incorporated", "matcher_status", "matcher_method", "probability",
                "label", "note"]
_FORM_TYPE = {"pvt ltd": "Private Limited", "opc pvt ltd": "OPC", "llp": "LLP"}


def _own(d: dict) -> dict:
    """The matcher's own decision on an entity_links doc (older docs carry only the written one)."""
    return d.get("matcher") or {k: d.get(k) for k in ("status", "company_id", "method", "probability")}


def export_candidates(db, startups: dict[str, Startup], path: Path, *, extra_random: int = 100, seed: int = 7) -> int:
    """A CSV of pairs for a person to label: every link and review pair, plus random near-misses.
    The 'label' column takes same / different / unsure."""
    index = match.CompanyIndex.load(db)
    rows, seen = [], set()

    def add(s, cid, link):
        if (s.key, cid) in seen or cid not in index.by_id:
            return
        seen.add((s.key, cid))
        c = index.by_id[cid]
        rows.append({"entity_key": s.key, "startup_names": " | ".join(s.names), "entity_type": s.entity_type,
                     "year": s.year or "", "on_portal_since": s.since or "", "district": s.district,
                     "company_id": cid, "company_name": c.name, "incorporated": c.inc_date or "",
                     "matcher_status": link.get("status", ""), "matcher_method": link.get("method") or "",
                     "probability": link.get("probability") or "", "label": "", "note": ""})

    links = {d["entity_key"]: d for d in db.entity_links.find({"entity_type": "startup"})}
    near = []
    for k, d in sorted(links.items()):
        s = startups.get(k)
        if not s:
            continue
        own = _own(d)
        if own.get("status") == "linked":
            add(s, own["company_id"], own)
        if d["status"] == "linked" and d.get("company_id"):
            add(s, d["company_id"], own)
        for cand in d.get("candidates", []):
            if d["status"] == "review":
                add(s, cand["company_id"], own)
            else:
                near.append((s, cand["company_id"], own))
    random.Random(seed).shuffle(near)
    for s, cid, d in near[:extra_random]:
        add(s, cid, d)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, LABEL_FIELDS)
        w.writeheader()
        w.writerows(rows)
    return len(rows)


def import_labels(db, path: Path, *, decided_by: str) -> Counter:
    """Reads a labelled CSV into match_reviews (source "label_set"). Rows without a label are skipped.
    A decision a reviewer made in the Admin pages (source "admin") is never overwritten by a file: the
    row is counted as a conflict and left out. Every import is written to audit_log."""
    from pymongo import ReplaceOne
    now = datetime.now(timezone.utc)
    rows, stats = [], Counter()
    with open(path, newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            label = (r.get("label") or "").strip().lower()
            if label not in ("same", "different", "unsure"):
                stats["skipped"] += 1
                continue
            rows.append((f"startup:{r['entity_key']}|{r['company_id']}", r, label))
    admin = {d["_id"] for d in db.match_reviews.find({"_id": {"$in": [i for i, _, _ in rows]}, "source": "admin"}, {"_id": 1})}
    ops, conflicts = [], []
    for _id, r, label in rows:
        if _id in admin:
            stats["conflicts_with_admin"] += 1
            conflicts.append(_id)
            continue
        ops.append(ReplaceOne({"_id": _id}, {
            "_id": _id, "entity_type": "startup", "entity_key": r["entity_key"], "company_id": r["company_id"],
            "decision": label, "decided_by": decided_by, "decided_at": now, "note": (r.get("note") or None),
            "source": "label_set"}, upsert=True))
        stats[label] += 1
    if ops:
        db.match_reviews.bulk_write(ops, ordered=False)
    db.audit_log.insert_one({"at": now, "actor": decided_by, "role": None, "action": "label_import",
                             "target": {"collection": "match_reviews", "file": Path(path).name}, "fields": None,
                             "detail": {"file": Path(path).name, "counts": dict(stats), "conflicts": conflicts[:50]}})
    return stats


def wilson(k: int, n: int, z: float = 1.96) -> list | None:
    """95% Wilson score interval for k successes in n trials."""
    if not n:
        return None
    p = k / n
    centre = (p + z * z / (2 * n)) / (1 + z * z / n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return [round(max(0.0, centre - half), 4), round(min(1.0, centre + half), 4)]


def evaluate_labels(db) -> dict:
    """Precision and recall of the matcher's own decisions against the pairs a person decided."""
    labels = {(r["entity_key"], r["company_id"]): r["decision"]
              for r in db.match_reviews.find({"entity_type": "startup", "decision": {"$in": ["same", "different"]}})}
    own_links, in_review = {}, set()
    for d in db.entity_links.find({"entity_type": "startup"}):
        own = _own(d)
        if own.get("status") == "linked" and own.get("company_id"):
            own_links[(d["entity_key"], own["company_id"])] = own.get("method")
        if d["status"] == "review" or own.get("status") == "review":
            in_review |= {(d["entity_key"], c["company_id"]) for c in d.get("candidates", [])}

    def score(pairs: dict) -> dict:
        by_method = defaultdict(Counter)
        for p, lab in pairs.items():
            if p in own_links:
                by_method[own_links[p]][lab] += 1
        out = {}
        for method in ("exact_name", "splink", "all"):
            c = sum(by_method.values(), Counter()) if method == "all" else by_method.get(method, Counter())
            n = c["same"] + c["different"]
            out[method] = {"links_judged": n, "precision": round(c["same"] / n, 4) if n else None,
                           "wilson_95": wilson(c["same"], n)}
        same = [p for p, lab in pairs.items() if lab == "same"]
        found = sum(1 for p in same if p in own_links)
        return {"labelled_pairs": len(pairs), "labelled_same": len(same), "precision": out,
                "recall": round(found / len(same), 4) if same else None,
                "same_pairs_waiting_in_review": sum(1 for p in same if p not in own_links and p in in_review)}

    held = {p: lab for p, lab in labels.items() if match.holdout(p[0])}
    return {
        "scored_on": "the matcher's own decision (entity_links.matcher), made without any reviewer's input",
        "held_out": score(held) | {"note": "never used to train the model: the honest precision"},
        "all_labels": score(labels) | {"note": "includes labels the model's m values were trained on; optimistic"},
        "labels_used_for_training": sum(1 for (k, _), lab in labels.items() if lab == "same" and not match.holdout(k)),
        "by_labeller": dict(Counter(r["decided_by"] for r in db.match_reviews.find({}, {"decided_by": 1}))),
    }


# ---- misspelling self-test ------------------------------------------------------------------------

_SWAP = {"technologies": "Solutions", "technology": "Solutions", "tech": "Solutions", "solutions": "Technologies",
         "solution": "Technologies", "services": "Solutions", "service": "Solutions", "enterprises": "Ventures",
         "enterprise": "Ventures", "ventures": "Enterprises", "venture": "Enterprises", "infra": "Projects",
         "industries": "Exports", "india": "Global", "global": "India", "innovations": "Labs", "labs": "Innovations",
         "digital": "Systems", "software": "Systems", "consultancy": "Services", "foods": "Industries"}


def _perturbations(name: str) -> list[tuple[str, str]]:
    base = name.strip()
    low = base.lower()
    out = []
    for form in (" private limited", " pvt ltd", " pvt. ltd.", " llp"):
        if low.endswith(form):
            stem = base[: -len(form)]
            out.append(("no legal form", stem))
            out.append(("typo in the form", stem + (" Private Limeted" if "llp" not in form else " L.L.P.")))
            out.append(("extra word", stem + " India" + base[len(stem):]))
            words = stem.split()
            swapped = next(((i, _SWAP[w.lower()]) for i, w in enumerate(words) if w.lower() in _SWAP), None)
            if swapped:
                words[swapped[0]] = swapped[1]
            else:
                words.append("Solutions")
            out.append(("generic word changed", " ".join(words) + base[len(stem):]))
            break
    if " and " in low:
        i = low.index(" and ")
        out.append(("& for and", base[:i] + " & " + base[i + 5:]))
    out.append(("trailing dot", base + "."))
    if len(base) > 8:
        j = len(base) // 3
        out.append(("one letter dropped", base[:j] + base[j + 1:]))
    return out


# kinds whose perturbed name is a different registered name: a link to the original is a wrong link
CHANGED_NAME_KINDS = {"generic word changed", "extra word"}


def perturbation_eval(db, startups: dict[str, Startup], *, sample: int = 120, seed: int = 11, params: dict | None = None,
                      log=print) -> dict:
    """Misspells the names of exactly-linked startups and checks what the matcher does with them,
    scored with the parameters the nightly run fits on the real startups (`params`)."""
    index = match.CompanyIndex.load(db)
    truth = {d["entity_key"]: d["company_id"] for d in db.entity_links.find({"status": "linked", "method": "exact_name"})}
    params = params or production_params(db, startups, index)
    keys = sorted(k for k in truth if k in startups and truth[k] in index.by_id)
    random.Random(seed).shuffle(keys)
    fakes, expected, kinds = [], {}, {}
    for k in keys[:sample]:
        s = startups[k]
        for kind, name in _perturbations(s.names[0]):
            fk = f"PERTURBED_{len(fakes):05d}"
            fakes.append(replace(s, key=fk, names=[name], brand=""))
            expected[fk], kinds[fk] = truth[k], kind
    exact = {f.key: match.exact_candidates(f, index) for f in fakes}
    by_normaliser = {f.key for f in fakes if kinds[f.key] not in CHANGED_NAME_KINDS
                     and any(c.method == "exact_name" and c.company_id == expected[f.key] for c in exact[f.key])}
    fuzzy, _ = match.splink_candidates([f for f in fakes if not exact[f.key]], index, params=params, log=log)
    by_kind = defaultdict(Counter)
    totals = Counter()
    for f in fakes:
        d = match.decide(f, index, exact[f.key], fuzzy.get(f.key, []), {})
        kind = kinds[f.key]
        right_in_review = d.status == "review" and any(c["company_id"] == expected[f.key] for c in d.candidates)
        if kind in CHANGED_NAME_KINDS:
            outcome = "wrong_link" if d.status == "linked" else "sent_to_review" if d.status == "review" else "not_linked"
        else:
            outcome = ("found" if d.status == "linked" and d.company_id == expected[f.key] else
                       "wrong_link" if d.status == "linked" else
                       "sent_to_review" if right_in_review else "missed")
        if f.key in by_normaliser:
            by_kind[kind]["solved_by_normaliser"] += 1
            totals["solved_by_normaliser"] += 1
            if outcome == "wrong_link":
                totals["wrong_link"] += 1
            continue
        by_kind[kind][outcome] += 1
        totals[f"fuzzy_{outcome}"] += 1
        if outcome == "wrong_link":
            totals["wrong_link"] += 1
    # rates over the misspellings that reached the fuzzy matcher (changed names are reported per kind)
    m_out = Counter()
    for kind, c in by_kind.items():
        if kind in CHANGED_NAME_KINDS:
            continue
        for o in ("found", "sent_to_review", "missed", "wrong_link"):
            m_out[o] += c[o]
    n_m = sum(m_out.values())
    absent = _absent_test(index, fakes, expected, params, log)
    return {"cases": len(fakes), "prior": params["prior"], "solved_by_normaliser": totals["solved_by_normaliser"],
            "misspellings_reaching_fuzzy_matcher": n_m, **{f"fuzzy_{k}": v for k, v in m_out.items()},
            "fuzzy_found_rate": round(m_out["found"] / n_m, 4) if n_m else None,
            "fuzzy_found_or_review_rate": round((m_out["found"] + m_out["sent_to_review"]) / n_m, 4) if n_m else None,
            "wrong_links": totals["wrong_link"], "wrong_link_rate": round(totals["wrong_link"] / len(fakes), 4) if fakes else None,
            "by_kind": {k: dict(v) for k, v in sorted(by_kind.items())}, "absent_company": absent}


def _absent_test(index, fakes, expected, params, log) -> dict:
    """The same misspelt names with their true companies taken out: every link is a wrong one."""
    absent = index.without(set(expected.values()))
    ex = {f.key: match.exact_candidates(f, absent) for f in fakes}
    fz, _ = match.splink_candidates([f for f in fakes if not ex[f.key]], absent, params=params, log=log)
    out = Counter(match.decide(f, absent, ex[f.key], fz.get(f.key, []), {}).status for f in fakes)
    return {"cases": len(fakes), "wrong_links": out["linked"], "sent_to_review": out["review"],
            "wilson_95_wrong_link_rate": wilson(out["linked"], len(fakes))}


# ---- leave-one-out over the company universe ------------------------------------------------------

def leave_one_out_eval(index: match.CompanyIndex, *, params: dict, sample: int = 4000, folds: int = 4,
                       seed: int = 5, log=print) -> dict:
    """Each sampled company becomes a startup with its exact registered name, its year, and a portal
    listing a month after incorporation, and is matched against all companies but itself. Its own
    company is absent, so every link is a wrong link. Cases whose company has a sibling in the
    universe (another company with the same distinctive words) are reported apart: they are the hard
    ones, and the ones the first version got wrong."""
    comps = sorted(index.by_id.values(), key=lambda c: c.id)
    random.Random(seed).shuffle(comps)
    comps = comps[:sample]
    wrong, review, sib_cases, sib_wrong = [], 0, 0, 0
    for f in range(folds):
        fold = comps[f * len(comps) // folds:(f + 1) * len(comps) // folds]
        if not fold:
            continue
        idx = index.without(c.id for c in fold)
        fakes = []
        for c in fold:
            since = (date.fromisoformat(c.inc_date[:10]) + timedelta(days=30)).isoformat() if c.inc_date else None
            fakes.append(Startup(key=f"LOO_{c.id}", names=[c.name], entity_type=_FORM_TYPE.get(c.form, "Private Limited"),
                                 year=c.inc_year, since=since))
        ex = {s.key: match.exact_candidates(s, idx) for s in fakes}
        fz, _ = match.splink_candidates([s for s in fakes if not ex[s.key]], idx, params=params, log=log)
        for c, s in zip(fold, fakes):
            d = match.decide(s, idx, ex[s.key], fz.get(s.key, []), {})
            sibling = bool(idx.by_key.get(c.key))
            sib_cases += sibling
            if d.status == "linked":
                wrong.append({"name": c.name, "linked_to": idx.by_id[d.company_id].name, "method": d.method,
                              "probability": d.probability})
                sib_wrong += sibling
            elif d.status == "review":
                review += 1
    n = len(comps)
    return {"companies": len(index.by_id), "cases": n, "prior": params["prior"], "wrong_links": len(wrong),
            "wrong_link_rate": round(len(wrong) / n, 4) if n else None, "wilson_95": wilson(len(wrong), n),
            "sent_to_review": review, "cases_with_sibling": sib_cases, "wrong_links_with_sibling": sib_wrong,
            "examples": wrong[:10]}


def production_params(db, startups: dict[str, Startup], index: match.CompanyIndex | None = None) -> dict:
    """The prior, u and m the nightly run fits on the real startups (labels included)."""
    index = index or match.CompanyIndex.load(db)
    return match.production_params(startups, index, labels=match.training_labels(db))

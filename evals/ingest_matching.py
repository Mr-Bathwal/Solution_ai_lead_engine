"""Eval 5: matching on hard name pairs, website confirmation, and what the web search sends out.

Run from the repository root:

    ingest/.venv/Scripts/python evals/ingest_matching.py            (Windows)
    ingest/.venv/bin/python evals/ingest_matching.py                (the server)
    ... --json evals/.matching.json                                 (also write the results as JSON)

1. Matching. evals/fixtures/name_pairs.json holds hand-written, labelled pairs of a portal startup
   and an MCA company (legal-form spellings, (OPC), & and "and", spacing, slips, Hindi/English
   transliteration, LLP against company, different companies with near-identical names, the same
   name in another district). The knowledge base's own matcher (kb/match.py: exact names, then
   Splink, then its link rules at the configured thresholds) decides every startup against a small
   company universe (the pairs' companies plus invented distractors). Precision and recall are of
   its automatic links; a pair sent to a person's review queue is neither a link nor a wrong link.
   The name level alone (names.py normalisation, match.name_agreement) is scored as well.
2. Website confirmation. evals/fixtures/website_cases.json: search results that are the company's
   own site, or a directory, marketplace, social network, shared site builder or someone else's
   site. Each runs through enrich/websites.py's own search step with a fake search API and fetcher.
3. Web search egress. A company record carrying canary personal data (fixtures/canaries.json) goes
   through the same step; the search query and every fetched URL are checked for the canaries.

No network: sockets to anything but this machine are refused for the whole run.
"""
import argparse
import json
import socket
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "evals" / "fixtures"
sys.path.insert(0, str(ROOT / "ingest" / "src"))

# ---- the network guard: nothing leaves this machine ----------------------------------------------------
BLOCKED = []
_real_connect = socket.socket.connect
_real_getaddrinfo = socket.getaddrinfo
LOCAL = {"127.0.0.1", "localhost", "::1"}


def _guarded_connect(self, address):
    host = address[0] if isinstance(address, tuple) else str(address)
    if host not in LOCAL:
        BLOCKED.append(f"connect {host}")
        raise OSError(f"network blocked by the eval guard: {host}")
    return _real_connect(self, address)


def _guarded_getaddrinfo(host, *a, **k):
    if host not in LOCAL and host is not None:
        BLOCKED.append(f"lookup {host}")
        raise socket.gaierror(f"DNS blocked by the eval guard: {host}")
    return _real_getaddrinfo(host, *a, **k)


socket.socket.connect = _guarded_connect
socket.getaddrinfo = _guarded_getaddrinfo

from leadengine.kb import match  # noqa: E402  (after the guard, on purpose)
from leadengine.kb.entities import Startup  # noqa: E402
from leadengine.names import normalize_name  # noqa: E402
from leadengine.enrich import websites  # noqa: E402

NOW = datetime(2026, 11, 20, 6, 0, tzinfo=timezone.utc)


def load(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


# ---- 1. matching -----------------------------------------------------------------------------------------
def matching():
    fx = load("name_pairs.json")
    pairs = fx["pairs"]
    startups, companies = {}, {}
    for p in pairs:
        s = p["startup"]
        if "ref" not in s and s["key"] not in startups:
            startups[s["key"]] = Startup(key=s["key"], names=list(s["names"]), entity_type=s.get("entity_type", ""), year=s.get("year"),
                                         since=s.get("since"), district=s.get("district", ""), sector=s.get("sector", ""), website=s.get("website", ""))
        c = p["company"]
        companies[c["cin"]] = match.company_from(c["cin"], c["name"], c.get("kind", "company"), c["inc"])
    for cin, name, inc in fx["distractors"]:
        companies.setdefault(cin, match.company_from(cin, name, "company", inc))
    index = match.CompanyIndex(list(companies.values()))
    key_of = lambda p: p["startup"].get("ref") or p["startup"]["key"]  # noqa: E731

    runs = {}
    notes = []
    for label, use_splink in (("exact_and_splink", True), ("exact_only", False)):
        try:
            t = time.time()
            _, own, model = match.match_all(startups, index, use_splink=use_splink, log=lambda *a, **k: None)
            runs[label] = {"own": own, "seconds": round(time.time() - t, 1), "pairs_scored": model.get("pairs_scored")}
        except Exception as exc:  # the eval reports a matcher that cannot run rather than crashing
            notes.append(f"{label} could not run: {type(exc).__name__}: {exc}")
    if not runs:
        return {"error": "; ".join(notes)}
    main = "exact_and_splink" if "exact_and_splink" in runs else "exact_only"
    if main != "exact_and_splink":
        notes.append("Splink did not run, so the scores are for exact matching only")
    same_set = {(key_of(p), p["company"]["cin"]) for p in pairs if p["label"] == "same"}

    def score(own):
        rows = []
        for p in pairs:
            d = own[key_of(p)]
            cid = p["company"]["cin"]
            shown = [c["company_id"] for c in (d.candidates or [])]
            if d.status == "linked" and d.company_id == cid:
                outcome = "linked"
            elif d.status == "linked":
                outcome = f"linked to {d.company_id}"
            elif d.status == "review" and cid in shown:
                outcome = "review"
            elif d.status == "review":
                outcome = "review (not shown)"
            else:
                outcome = "not linked"
            rows.append({"id": p["id"], "category": p["category"], "label": p["label"], "outcome": outcome,
                         "why": (d.evidence or {}).get("why_review") or (d.evidence or {}).get("reason"),
                         "name_agreement": match.name_agreement(startups[key_of(p)], companies[cid])})
        # every automatic link a startup got, right or wrong (a link to a distractor is wrong too)
        links = {(k, d.company_id) for k, d in own.items() if d.status == "linked"}
        tp = len(links & same_set)
        fp = len(links - same_set)
        n_same = len(same_set)
        reached = sum(1 for r in rows if r["label"] == "same" and r["outcome"] in ("linked", "review"))
        misses = [r for r in rows if (r["label"] == "same" and r["outcome"] != "linked") or (r["label"] == "different" and r["outcome"] == "linked")]
        return {
            "links": len(links), "correct_links": tp, "wrong_links": fp,
            "precision": round(tp / len(links), 4) if links else None,
            "recall": round(tp / n_same, 4) if n_same else None,
            "same_pairs_linked_or_sent_to_review": f"{reached}/{n_same}",
            "wrong_links_list": sorted(f"{k} -> {c}" for k, c in links - same_set),
            "misses": misses, "rows": rows,
        }

    scored = {k: score(v["own"]) for k, v in runs.items()}
    # the name level alone (names.py and match.name_agreement): "same" or "typo" to MCA counts as
    # predicting the same company. Only pairs where the question IS the name count here; where the
    # names are the same and other facts decide (LLP or company, partnership, another district,
    # the founder's year), the name level cannot be right or wrong, and the matcher's rules decide.
    by_name = [p for p in pairs if p["category"] not in ("LLP against company", "same brand, different districts", "same name, other facts disagree")]
    agrees = lambda p: match.name_agreement(startups[key_of(p)], companies[p["company"]["cin"]]) in ("same", "typo")  # noqa: E731
    tp = sum(1 for p in by_name if p["label"] == "same" and agrees(p))
    fp = sum(1 for p in by_name if p["label"] == "different" and agrees(p))
    n_same_names = sum(1 for p in by_name if p["label"] == "same")
    name_level = {"pairs": len(by_name), "predicted_same": tp + fp, "correct": tp, "wrong": fp, "precision": round(tp / (tp + fp), 4) if tp + fp else None,
                  "recall": round(tp / n_same_names, 4) if n_same_names else None,
                  "wrong_list": [p["id"] for p in by_name if p["label"] == "different" and agrees(p)],
                  "missed_list": [p["id"] for p in by_name if p["label"] == "same" and not agrees(p)]}
    n_same = sum(1 for p in pairs if p["label"] == "same")
    return {
        "pairs": len(pairs), "same": n_same, "different": len(pairs) - n_same, "startups": len(startups), "companies": len(companies),
        "thresholds": {"LINK_P": match.LINK_P, "REVIEW_P": match.REVIEW_P, "MARGIN_BITS": match.MARGIN_BITS, "model": match.MODEL_VERSION},
        "main_run": main, "runs": {k: {**{x: y for x, y in v.items() if x not in ("rows",)}, "seconds": runs[k]["seconds"], "pairs_scored": runs[k]["pairs_scored"]} for k, v in scored.items()},
        "rows": scored[main]["rows"], "name_level": name_level, "notes": notes,
    }


# ---- 2 and 3. websites: confirmation and what the search sends out -------------------------------------------
class _Coll:
    def __init__(self):
        self.updates = []

    def update_one(self, flt, upd, **kw):
        self.updates.append((flt, upd))

    def replace_one(self, flt, doc, upsert=False):
        self.updates.append((flt, doc))

    def find_one(self, *a, **k):
        return None


class _Db:
    """Just enough of a database for the search step: it records writes and finds nothing."""

    def __init__(self):
        self._c = {}

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return self._c.setdefault(name, _Coll())


class _Search:
    provider = "brave"

    def __init__(self, results):
        self.results, self.queries = results, []

    def search(self, q):
        self.queries.append(q)
        return self.results


class _Resp:
    def __init__(self, html):
        self.ok, self.text, self.content, self.status_code = True, html, html.encode("utf-8"), 200


class _Fetcher:
    def __init__(self, html):
        self.html, self.urls = html, []

    def get(self, url):
        self.urls.append(url)
        return _Resp(self.html)


def _search_one(company, results, html):
    db, search, fetcher = _Db(), _Search(results), _Fetcher(html)
    w = websites.Websites(db, None, {"monthly": {"web_searches": 10}}, fetcher=fetcher, search=search, log=lambda *a: None, clock=lambda: NOW)
    w._search_one({**company, "attempts": []})
    found = [u for _, u in db.companies.updates if isinstance(u, dict) and "attrs.website" in u.get("$set", {})]
    return (found[0]["$set"]["attrs.website"]["value"] if found else None), search.queries, fetcher.urls


def website_confirmation():
    fx = load("website_cases.json")
    rows = []
    for c in fx["cases"]:
        co = fx["companies"][c["company"]]
        doc = {"_id": co["cin"], "name": co["name"], "attrs": {"registered_district": {"value": co["district"]}}}
        try:
            site, _, _ = _search_one(doc, [{"url": c["url"], "title": co["name"], "snippet": ""}], c["html"])
            got = "accept" if site else "reject"
        except Exception as exc:
            got = f"error: {type(exc).__name__}: {exc}"
        rows.append({"id": c["id"], "url": c["url"], "expect": c["expect"], "got": got, "ok": got == c["expect"], "why": c.get("why")})
    wrong_accepts = [r for r in rows if r["expect"] == "reject" and r["got"] == "accept"]
    wrong_rejects = [r for r in rows if r["expect"] == "accept" and r["got"] != "accept"]
    rejects = [r for r in rows if r["expect"] == "reject"]
    return {"cases": len(rows), "correct": sum(r["ok"] for r in rows),
            "directories_social_rejected": f"{sum(1 for r in rejects if r['got'] == 'reject')}/{len(rejects)}",
            "own_sites_accepted": f"{sum(1 for r in rows if r['expect'] == 'accept' and r['got'] == 'accept')}/{sum(1 for r in rows if r['expect'] == 'accept')}",
            "wrong_accepts": wrong_accepts, "wrong_rejects": wrong_rejects, "rows": rows}


def search_egress():
    cn = load("canaries.json")
    co = cn["company"]
    phone_digits = "".join(ch for ch in cn["phone"] if ch.isdigit())
    # the record as the database holds it, with every personal field the vendor and the portals give
    doc = {"_id": co["cin"], "name": co["name"], "attrs": {
        "registered_district": {"value": co["district"]}, "registered_email": {"value": cn["personal_email"]},
        "directors": {"value": [cn["director_name"]]}, "phone": {"value": cn["phone"]}}}
    html = f"<h1>Zephyra Herbals Pvt Ltd</h1><p>Director: {cn['director_name']}</p>"
    _, queries, urls = _search_one(doc, [{"url": "https://zephyraherbals.example/", "title": "Zephyra Herbals", "snippet": ""}], html)
    sent = queries + urls
    text = "\n".join(sent)
    digits = "".join(ch for ch in text if ch.isdigit())
    leaked = [n for n, hit in (("director name", cn["director_name"].lower() in text.lower()),
                               ("personal email", cn["personal_email"].lower() in text.lower()),
                               ("mobile", phone_digits in digits)) if hit]
    return {"queries": queries, "fetched": urls, "leaked": leaked}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", help="also write the results to this file")
    args = ap.parse_args()
    t = time.time()
    out = {"matching": matching(), "websites": website_confirmation(), "search_egress": search_egress()}
    out["seconds"] = round(time.time() - t, 1)
    out["network_blocked"] = BLOCKED
    if args.json:
        Path(args.json).write_text(json.dumps(out, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    m, w = out["matching"], out["websites"]
    if "error" in m:
        print(f"matching: {m['error']}")
    else:
        r = m["runs"][m["main_run"]]
        print(f"matching ({m['main_run']}): {m['pairs']} pairs; precision {r['precision']}, recall {r['recall']}, "
              f"{r['wrong_links']} wrong link(s); same pairs linked or sent to review {r['same_pairs_linked_or_sent_to_review']}")
        for x in r["misses"]:
            print(f"  miss: {x['id']} ({x['label']}): {x['outcome']}; {x['why'] or ''}")
        n = m["name_level"]
        print(f"name level: precision {n['precision']}, recall {n['recall']}; wrong {n['wrong_list']}")
    print(f"websites: {w['correct']}/{w['cases']} right; directories and social networks rejected {w['directories_social_rejected']}; "
          f"own sites accepted {w['own_sites_accepted']}")
    for x in w["wrong_accepts"] + w["wrong_rejects"]:
        print(f"  wrong: {x['id']} {x['url']} expected {x['expect']}, got {x['got']}")
    print(f"web search egress: leaked {out['search_egress']['leaked'] or 'nothing'}; query {out['search_egress']['queries']}")
    print(f"{out['seconds']} s; network blocked: {BLOCKED or 'none attempted'}")


if __name__ == "__main__":
    main()

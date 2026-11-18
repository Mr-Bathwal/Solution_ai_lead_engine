"""leadengine: the data side of the lead engine (ingestion, knowledge base, enrichment, need engine).

  leadengine schema                              create/update collections, validators and indexes
  leadengine state rebuild                       rebuild source_state from source_records (after the v2 schema)
  leadengine ingest mca FILE [FILE ...]          load MCA monthly incorporation reports (UP companies)
  leadengine ingest inbox                        load what waits in the MCA inbox (MCA_INBOX; the Admin upload
                                                 page puts files there); the nightly does this first
  leadengine ingest startinup [--details new|all|none] [--max-pages N]
  leadengine ingest upsm [--max-districts N]
  leadengine ingest dpiit [--counters-only]      not scheduled: the API's robots.txt forbids automated access
  leadengine ingest incubators [--no-portfolios] [--no-sisfs]
  leadengine ingest news [--dry-run]             funding news from the feeds in config/news.json and GDELT; a
                                                 headline naming exactly one UP company becomes a proposed signal
                                                 for a person to confirm (--dry-run prints matches, writes nothing)
  leadengine backfill atlas [--root PATH]        first load from the UP Startup Atlas caches (no network)

  leadengine kb build [--no-splink]              UP LLPs, matching, portal facts onto companies
  leadengine kb eval [--loo-sample N]            precision against labelled pairs (the matcher's own decisions,
                                                 with a held-out fifth), the misspelling self-test and leave-one-out
  leadengine kb export-labels FILE               pairs for a person to label (same / different / unsure)
  leadengine kb import-labels FILE --by EMAIL    labelled pairs into match_reviews

  leadengine enrich plan [--month YYYY-MM]       what the waterfall would do, and the caps left
  leadengine enrich run [--month YYYY-MM] [--steps basic,resolve,profile] [--limit N]
  leadengine enrich probe CIN [--op lookup|search|profile]   one vendor call, printing the response shape
  leadengine enrich websites [--month YYYY-MM]   websites of shortlisted companies (a search API, WEB_SEARCH_*) and the
                                                 role address or contact form each publishes; nightly after enrichment
  leadengine enrich search-probe "QUERY"         one search through the configured search API

  leadengine need run --month YYYY-MM [--cohorts YYYY-MM,...] [--as-of YYYY-MM-DD]
  leadengine nightly [--month YYYY-MM]           MCA inbox, kb build, enrichment, need run: the nightly batch

  leadengine privacy redact-raw [--apply]        remove emails and phone numbers from raw pages stored
                                                 before redaction existed (a dry run unless --apply)
  leadengine privacy retention [--months 12] [--apply]
                                                 delete bought data on companies never contacted, after the
                                                 period (design 7.7; a dry run unless --apply)
  leadengine privacy erase-raw CIN [CIN ...]     delete the vendor's raw answers about these companies (after
                                                 an erasure request that blanked a registered email)

  leadengine eval extraction [--build]           the portal parsers against the 200-page golden set
                                                 (--build chooses the pages and records their output)
  leadengine export parquet [--out DIR]          the nightly Parquet exports for DuckDB, no personal data
  leadengine status                              what is stored, by source and cohort, and the latest runs

Secrets (INFYNER_API_KEY, HOLDOUT_SALT, RULES_ENGINE_URL/KEY) are read from the repository's .env as
well as from the environment, so a cron line needs nothing extra. Months are IST months.
"""
import argparse
import json
import sys
import traceback
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from pymongo import MongoClient
from pymongo.errors import DuplicateKeyError

from . import schema
from .config import load_settings
from .pipeline import make_fetcher, run_source
from .rawstore import open_rawstore
from .sink import MongoSink, new_run_id
from .util import ist_month
from .sources.dpiit import DpiitSource
from .sources.incubators import IncubatorCacheSource, IncubatorSource
from .sources.mca import McaMonthlySource
from .sources.startinup import StartinupCacheSource, StartinupSource
from .sources.upsm import UpsmCacheSource, UpsmSource

ATLAS_DEFAULT = Path.home() / "Downloads" / "up-startup-intel"
MCA_DEFAULT = Path.home() / "Downloads" / "solutionai-prospect-playbook" / "data" / "mca"


def _print_summary(s):
    print(f"\n{s.source}  {s.status.upper()}  run {s.run_id}")
    for k in sorted(s.stats):
        print(f"  {k:<32} {s.stats[k]}")
    for n in s.notes:
        print(f"  note: {n}")


def _json(obj):
    print(json.dumps(obj, indent=1, default=str, ensure_ascii=False))


def this_month() -> str:
    """The IST month: the 05:00 IST nightly on the 1st is still the last day of the old month in UTC."""
    return ist_month()


def main(argv=None):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(prog="leadengine", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("schema")
    sub.add_parser("status")
    st_p = sub.add_parser("state")
    st_p.add_argument("what", choices=["rebuild"])
    ing = sub.add_parser("ingest")
    isub = ing.add_subparsers(dest="source", required=True)
    m = isub.add_parser("mca")
    m.add_argument("files", nargs="+", type=Path)
    isub.add_parser("inbox")
    s = isub.add_parser("startinup")
    s.add_argument("--details", choices=["new", "all", "none"], default="new")
    s.add_argument("--max-pages", type=int)
    u = isub.add_parser("upsm")
    u.add_argument("--max-districts", type=int)
    d = isub.add_parser("dpiit")
    d.add_argument("--counters-only", action="store_true")
    i = isub.add_parser("incubators")
    i.add_argument("--no-portfolios", action="store_true")
    i.add_argument("--no-sisfs", action="store_true")
    nw = isub.add_parser("news")
    nw.add_argument("--dry-run", action="store_true", help="print the matches; write no signal and no run record")
    b = sub.add_parser("backfill")
    b.add_argument("what", choices=["atlas"])
    b.add_argument("--root", type=Path, default=ATLAS_DEFAULT)
    b.add_argument("--mca-dir", type=Path, default=MCA_DEFAULT)

    kb = sub.add_parser("kb")
    kbs = kb.add_subparsers(dest="action", required=True)
    kb_build = kbs.add_parser("build")
    kb_build.add_argument("--no-splink", action="store_true")
    kb_eval = kbs.add_parser("eval")
    kb_eval.add_argument("--loo-sample", type=int, default=4000,
                         help="companies in the leave-one-out test (0 skips it)")
    kb_exp = kbs.add_parser("export-labels")
    kb_exp.add_argument("file", type=Path)
    kb_imp = kbs.add_parser("import-labels")
    kb_imp.add_argument("file", type=Path)
    kb_imp.add_argument("--by", required=True, help="who labelled the file (an email address)")

    en = sub.add_parser("enrich")
    ens = en.add_subparsers(dest="action", required=True)
    en_plan = ens.add_parser("plan")
    en_plan.add_argument("--month", default=None)
    en_run = ens.add_parser("run")
    en_run.add_argument("--month", default=None)
    en_run.add_argument("--steps", default="basic,resolve,profile")
    en_run.add_argument("--limit", type=int)
    en_web = ens.add_parser("websites")
    en_web.add_argument("--month", default=None)
    en_web.add_argument("--limit", type=int)
    en_ws = ens.add_parser("search-probe")
    en_ws.add_argument("query")
    en_probe = ens.add_parser("probe")
    en_probe.add_argument("cin")
    en_probe.add_argument("--op", choices=["lookup", "search", "profile"], default="lookup",
                          help="search takes the company name in place of the CIN")

    pv = sub.add_parser("privacy")
    pvs = pv.add_subparsers(dest="action", required=True)
    pv_red = pvs.add_parser("redact-raw")
    pv_red.add_argument("--apply", action="store_true", help="rewrite the stored pages (otherwise only count)")
    pv_ret = pvs.add_parser("retention")
    pv_ret.add_argument("--months", type=int, default=12)
    pv_ret.add_argument("--apply", action="store_true", help="delete (otherwise only count)")
    pv_er = pvs.add_parser("erase-raw")
    pv_er.add_argument("cins", nargs="+")

    nd = sub.add_parser("need")
    nds = nd.add_subparsers(dest="action", required=True)
    nd_run = nds.add_parser("run")
    nd_run.add_argument("--month", required=True)
    nd_run.add_argument("--cohorts")
    nd_run.add_argument("--as-of", type=date.fromisoformat)

    ev = sub.add_parser("eval")
    evs = ev.add_subparsers(dest="action", required=True)
    ev_ex = evs.add_parser("extraction")
    ev_ex.add_argument("--build", action="store_true", help="choose the 200 pages and record their parsed output")

    ex = sub.add_parser("export")
    exs = ex.add_subparsers(dest="action", required=True)
    ex_pq = exs.add_parser("parquet")
    ex_pq.add_argument("--out", type=Path, default=None)

    ni = sub.add_parser("nightly")
    ni.add_argument("--month", default=None)
    ni.add_argument("--no-enrich", action="store_true")
    a = ap.parse_args(argv)

    st = load_settings()
    client = MongoClient(st.mongo_uri, appname="solutionai-lead-engine-ingest", serverSelectionTimeoutMS=10_000)
    db = client[st.db_name]
    try:
        if a.cmd == "schema":
            r = schema.apply(db)
            print(f"database {st.db_name}: created {r['created']} updated {r['updated']}")
            return 0
        if a.cmd == "status":
            return status(db)
        if a.cmd == "state":
            print(f"source_state: {MongoSink(db).rebuild_state()} keys")
            return 0
        if a.cmd == "kb":
            return _kb(a, db, st)
        if a.cmd == "enrich":
            return _enrich(a, db, st)
        if a.cmd == "need":
            return _need(a, db, st)
        if a.cmd == "nightly":
            return nightly(db, st, month=a.month or this_month(), enrich=not a.no_enrich)
        if a.cmd == "privacy" and a.action in ("retention", "erase-raw"):
            from .retention import erase_vendor_raw, run_retention
            raw = open_rawstore(st.raw_store)
            if a.action == "retention":
                if a.months < 1:
                    print("--months must be at least 1")
                    return 2
                print(json.dumps(run_retention(db, raw, months=a.months, apply=a.apply)))
                return 0
            print(json.dumps({cin.upper(): erase_vendor_raw(raw, cin.upper()) for cin in a.cins}))
            return 0
        if a.cmd == "privacy":
            return _privacy(a, st)
        if a.cmd == "eval":
            return _eval(a, st)
        if a.cmd == "export":
            from .export import export_parquet
            print(json.dumps(export_parquet(db, a.out)))
            return 0
        if a.cmd == "ingest" and a.source == "news":
            from .news import run as read_news
            r = read_news(db, make_fetcher(st, "news"), dry_run=a.dry_run)
            _json(r)
            return 1 if r["status"] == "failed" else 0      # every source failed: worth a look in the log
        sink, raw = MongoSink(db), open_rawstore(st.raw_store)
        summaries = []
        if a.cmd == "ingest" and a.source == "inbox":
            from .mca_inbox import inbox_path, load_inbox
            r = load_inbox(db, sink=sink, rawstore=raw, inbox=inbox_path(st.env))
            _json(r)
            return 1 if r["failed"] else 0
        if a.cmd == "ingest":
            fetcher = None if a.source == "mca" else make_fetcher(st, a.source)
            if a.source == "mca":
                for f in sorted(a.files):
                    summaries.append(run_source(McaMonthlySource(f), sink=sink, rawstore=raw, params={"file": f.name}))
            else:
                src = {
                    "startinup": lambda: StartinupSource(a.details, a.max_pages),
                    "upsm": lambda: UpsmSource(max_districts=a.max_districts),
                    "dpiit": lambda: DpiitSource(search=not a.counters_only),
                    "incubators": lambda: IncubatorSource(portfolios=not a.no_portfolios, sisfs=not a.no_sisfs),
                }[a.source]()
                summaries.append(run_source(src, sink=sink, rawstore=raw, fetcher=fetcher, params=vars(a) | {"files": None}))
        elif a.cmd == "backfill":
            root = a.root
            for f in sorted(a.mca_dir.glob("Incorporation-Report-*.xlsx")):
                summaries.append(run_source(McaMonthlySource(f), sink=sink, rawstore=raw, params={"file": f.name, "backfill": True}))
            summaries.append(run_source(StartinupCacheSource([root / "raw/L3_startinup/_cache", root / "v2/official/_cache/sui"]),
                                        sink=sink, rawstore=raw, params={"backfill": "atlas"}))
            summaries.append(run_source(UpsmCacheSource(root / "v2/official/_cache/usm"), sink=sink, rawstore=raw,
                                        params={"backfill": "atlas"}))
            summaries.append(run_source(IncubatorCacheSource(root / "raw/L3_startinup/_cache",
                                                             root / "v2/official/_cache/sisfs/portfoliofilter_empty.json"),
                                        sink=sink, rawstore=raw, params={"backfill": "atlas"}))
        for s in summaries:
            _print_summary(s)
        return 0 if all(s.status != "failed" for s in summaries) else 1
    finally:
        client.close()


def _kb(a, db, st):
    from .kb import labels
    from .kb.build import build
    from .kb.entities import load_startups
    if a.action == "build":
        _json(build(db, open_rawstore(st.raw_store), use_splink=not a.no_splink))
    elif a.action == "eval":
        from .kb.match import CompanyIndex
        startups = load_startups(MongoSink(db))
        index = CompanyIndex.load(db)
        params = labels.production_params(db, startups, index)      # the self-tests score with the nightly model
        out = {"labelled": labels.evaluate_labels(db),
               "misspelling_self_test": labels.perturbation_eval(db, startups, params=params)}
        if a.loo_sample:
            out["leave_one_out"] = labels.leave_one_out_eval(index, params=params, sample=a.loo_sample)
        _json(out)
    elif a.action == "export-labels":
        n = labels.export_candidates(db, load_startups(MongoSink(db)), a.file)
        print(f"{n} pairs written to {a.file}; fill the 'label' column with same / different / unsure")
    elif a.action == "import-labels":
        _json(dict(labels.import_labels(db, a.file, decided_by=a.by)))
    return 0


def _enrich(a, db, st):
    from .enrich.waterfall import Waterfall, client_from_env
    if a.action in ("websites", "search-probe"):
        from .enrich.websites import Websites, search_client_from_env
        search = search_client_from_env(st.env)
        if a.action == "search-probe":
            if search is None:
                print("set WEB_SEARCH_PROVIDER (google_cse or brave) and WEB_SEARCH_KEY (and WEB_SEARCH_CX for google_cse) first")
                return 2
            _json(search.search(a.query))           # one search, counted by the provider, not by the engine's cap
            return 0
        _json(Websites(db, open_rawstore(st.raw_store), st.caps, fetcher=make_fetcher(st, "websites"), search=search)
              .run(a.month or this_month(), limit=a.limit))
        return 0
    vendor = client_from_env(st.env)
    if a.action == "probe":
        if vendor is None:
            print("set INFYNER_API_KEY first, in .env or the environment (a pk_test_ sandbox key is free)")
            return 2
        path, params = {"lookup": (f"/v1/companies/{a.cin}", None), "profile": (f"/v1/companies/{a.cin}/profile", None),
                        "search": ("/v1/companies/search", {"q": a.cin})}[a.op]
        r = vendor.session.get(f"{vendor.base}{path}", params=params, timeout=vendor.timeout)
        print(f"{a.op}: HTTP {r.status_code}  sandbox={vendor.sandbox}")
        try:
            _json(r.json())
        except ValueError:
            print(r.text[:2000])
        return 0
    w = Waterfall(db, open_rawstore(st.raw_store), st.caps, client=vendor)
    if a.action == "plan":
        _json(w.plan(a.month))
    else:
        _json(w.run(a.month, steps=tuple(x.strip() for x in a.steps.split(",") if x.strip()), limit=a.limit))
    return 0


def _need(a, db, st):
    from .need import leads
    from .need.schemes import PlatformRulesClient
    cohorts = [c.strip() for c in a.cohorts.split(",")] if a.cohorts else None
    _json(leads.run(db, month=a.month, cohorts=cohorts, as_of=a.as_of, shortlist_size=st.caps["shortlist_per_month"],
                    holdout_pct=st.caps["holdout_pct"], client=PlatformRulesClient.from_env(st.env), env=st.env,
                    require_mca_file=True))
    return 0


def _eval(a, st):
    from .evalsets import GOLDEN, build_golden, eval_extraction
    raw = open_rawstore(st.raw_store)
    if a.build:
        if not hasattr(raw, "root"):
            print("the golden set is built from the local raw store")
            return 2
        print(json.dumps({"built": build_golden(raw, raw.root), "file": str(GOLDEN)}))
        return 0
    if not GOLDEN.exists():
        print(f"no golden set yet: run `leadengine eval extraction --build` first ({GOLDEN})")
        return 2
    r = eval_extraction(raw)
    print(json.dumps(r, indent=1))
    return 0 if r["same"] + sum(k.get("missing", 0) for k in r["kinds"].values()) == r["pages"] else 1


def _privacy(a, st):
    from .privacy import redact_bytes
    raw = open_rawstore(st.raw_store)
    if not hasattr(raw, "keys"):
        print("redact-raw works on the local raw store; on S3, run it from a machine with the bucket mounted")
        return 2
    seen = changed = removed = 0
    for key in raw.keys():
        if key.split("/", 1)[0] in ("mca_monthly",) or key.startswith("vendor_"):
            continue            # registers published under law, and vendor answers, are kept exactly
        data = raw.get({"key": key})
        out, n = redact_bytes(data)
        seen += 1
        if n and out != data:
            changed += 1
            removed += n
            if a.apply:
                raw.rewrite(key, out)
    print(f"{seen} raw pages checked; {changed} hold emails or phone numbers ({removed} in all)"
          + ("; rewritten without them" if a.apply else "; run with --apply to rewrite them"))
    return 0


NIGHTLY_STALE = timedelta(hours=6)


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _nightly_lock(db, run_id: str, month: str) -> bool:
    """Records this nightly run as 'running'. The unique one_running_nightly index refuses a second
    one; a 'running' run older than six hours is a dead process, so it is closed and the lock taken."""
    now = datetime.now(timezone.utc)
    doc = {"_id": run_id, "source": "nightly", "status": "running", "params": {"month": month}, "stats": {},
           "notes": [], "started_at": now, "finished_at": None}
    for _ in range(2):
        try:
            db.ingest_runs.insert_one(doc)
            return True
        except DuplicateKeyError:
            other = db.ingest_runs.find_one({"source": "nightly", "status": "running"})
            if other and _aware(other["started_at"]) < now - NIGHTLY_STALE:
                db.ingest_runs.update_one({"_id": other["_id"], "status": "running"}, {
                    "$set": {"status": "failed", "finished_at": now},
                    "$push": {"notes": f"still 'running' after {NIGHTLY_STALE}: the process died; closed by {run_id}"}})
                continue
            print(f"nightly: another nightly run is in progress ({other['_id'] if other else 'unknown'}); not starting")
            return False
    return False


def nightly(db, st, *, month: str, enrich: bool = True) -> int:
    """The nightly batch: knowledge base, then enrichment inside the caps, then the need engine.
    The knowledge base runs again after enrichment only if enrichment created companies.

    Each step stands alone: a step that fails is recorded and the next still runs, and the need engine
    always runs, so deadlines and the shortlist stay current on a day the vendor or the matcher fails.
    The run is recorded in ingest_runs (source "nightly"), which also stops two nightlies overlapping.
    Exit code 1 if any step failed, 2 if another nightly was already running."""
    from .enrich.waterfall import Waterfall, client_from_env
    from .kb.build import build
    from .enrich.websites import Websites, search_client_from_env
    from .mca_inbox import inbox_path, load_inbox
    from .need import leads
    from .need.schemes import PlatformRulesClient
    run_id = new_run_id("nightly")
    if not _nightly_lock(db, run_id, month):
        return 2
    raw = open_rawstore(st.raw_store)
    out, steps, notes = {"month": month}, {}, []

    def step(name, fn):
        try:
            out[name] = fn()
            steps[name] = "ok"
        except Exception as exc:          # recorded, and the batch goes on
            steps[name] = "failed"
            notes.append(f"{name} failed: {type(exc).__name__}: {exc}"[:500])
            traceback.print_exc()

    try:
        # the month's MCA file, if someone uploaded it since yesterday: loaded first, so tonight's run uses it
        step("mca_inbox", lambda: load_inbox(db, sink=MongoSink(db), rawstore=raw, inbox=inbox_path(st.env)))
        if (out.get("mca_inbox") or {}).get("failed"):          # a person must look: the run ends "partial" and alerts
            steps["mca_inbox"] = "failed"
            notes.append(("MCA inbox: " + "; ".join(f"{f['file']}: {f['why']}" for f in out["mca_inbox"]["failed"]))[:400])
        step("kb", lambda: build(db, raw, log=print))
        if enrich:
            step("enrich", lambda: Waterfall(db, raw, st.caps, client=client_from_env(st.env)).run(month))
            if (out.get("enrich") or {}).get("resolve_companies_created"):
                step("kb_again", lambda: build(db, raw, log=print)["match"])
            step("websites", lambda: Websites(db, raw, st.caps, fetcher=make_fetcher(st, "websites"),
                                              search=search_client_from_env(st.env), log=print).run(month))
        step("need", lambda: leads.run(db, month=month, shortlist_size=st.caps["shortlist_per_month"],
                                       holdout_pct=st.caps["holdout_pct"], client=PlatformRulesClient.from_env(st.env),
                                       env=st.env, require_mca_file=True))
    except BaseException as exc:          # Ctrl+C: never leave the lock 'running'
        notes.append(f"interrupted: {type(exc).__name__}")
        db.ingest_runs.update_one({"_id": run_id}, {"$set": {"status": "failed", "stats": {"steps": steps},
                                                             "notes": notes, "finished_at": datetime.now(timezone.utc)}})
        raise
    failed = [k for k, v in steps.items() if v == "failed"]
    status = "ok" if not failed else "failed" if "need" in failed else "partial"
    if "warning" in (out.get("need") or {}):
        notes.append(out["need"]["warning"])
    db.ingest_runs.update_one({"_id": run_id}, {"$set": {
        "status": status, "stats": {"steps": steps, **{f"enrich_{k}": v for k, v in (out.get("enrich") or {}).items()
                                                       if isinstance(v, (int, float, bool, str))}},
        "notes": notes, "finished_at": datetime.now(timezone.utc)}})
    kb = out.get("kb") or {}
    _json({k: v for k, v in out.items() if k != "kb"} | {"kb": kb.get("match") if isinstance(kb, dict) else None,
                                                         "steps": steps, "run": run_id, "status": status})
    return 1 if failed else 0


def status(db):
    print(f"database {db.name}")
    for name in ("companies", "source_records", "source_state", "ingest_runs", "entity_links", "leads", "consents",
                 "suppressions", "jobs", "enrichment_cache"):
        print(f"  {name:<18} {db[name].estimated_document_count():>8}")
    print("\nsource records by source (distinct keys / versions)")
    for row in db.source_records.aggregate([
        {"$group": {"_id": {"s": "$source", "k": "$natural_key"}, "v": {"$sum": 1}}},
        {"$group": {"_id": "$_id.s", "keys": {"$sum": 1}, "versions": {"$sum": "$v"}}},
        {"$sort": {"_id": 1}},
    ]):
        print(f"  {row['_id']:<22} {row['keys']:>7} / {row['versions']}")
    print("\nUP companies by incorporation month (companies / LLPs)")
    for row in db.companies.aggregate([{"$group": {"_id": "$cohort", "n": {"$sum": {"$cond": [{"$eq": ["$kind", "llp"]}, 0, 1]}},
                                                   "llp": {"$sum": {"$cond": [{"$eq": ["$kind", "llp"]}, 1, 0]}}}},
                                       {"$sort": {"_id": 1}}]):
        print(f"  {row['_id']}  {row['n']:>6} / {row['llp']}")
    print("\nportal startups linked to a company")
    for row in db.entity_links.aggregate([{"$group": {"_id": "$status", "n": {"$sum": 1}}}, {"$sort": {"_id": 1}}]):
        print(f"  {row['_id']:<10} {row['n']:>6}")
    print("\nleads by stage")
    for row in db.leads.aggregate([{"$group": {"_id": {"s": "$stage", "h": "$holdout"}, "n": {"$sum": 1}}},
                                   {"$sort": {"_id.s": 1}}]):
        print(f"  {row['_id']['s']:<12} {'holdout' if row['_id'].get('h') else '':<8} {row['n']:>6}")
    print("\nlatest runs")
    stale = datetime.now(timezone.utc) - timedelta(hours=6)
    for r in db.ingest_runs.find().sort("started_at", -1).limit(12):
        started = r["started_at"].replace(tzinfo=timezone.utc) if r["started_at"].tzinfo is None else r["started_at"]
        flag = "  <- still 'running' after 6 hours: the process probably died" if r["status"] == "running" and started < stale else ""
        print(f"  {r['started_at']:%Y-%m-%d %H:%M}  {r['source']:<14} {r['status']:<8} {r['_id']}{flag}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

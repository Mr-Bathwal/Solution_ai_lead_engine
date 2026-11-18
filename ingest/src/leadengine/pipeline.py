"""Runs one source end to end and records the run."""
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone

from .net.fetcher import BudgetExhausted, PoliteFetcher
from .records import RunContext
from .sink import MongoSink, new_run_id

# A run with any of these read less than it should have: it is "partial", not "ok".
PARTIAL_MARKERS = ("unavailable", "api_pages_failed", "directory_pages_failed", "profiles_failed")


@dataclass
class RunSummary:
    run_id: str
    source: str
    status: str
    stats: dict
    notes: list


def make_fetcher(settings, source: str | None = None) -> PoliteFetcher:
    """A fetcher with the crawl settings from caps.json. A source may have its own request budget
    (crawl.max_requests_by_source), because a full monthly re-read of every profile is far larger
    than a weekly run."""
    c = settings.crawl
    budget = (c.get("max_requests_by_source") or {}).get(source) or c.get("max_requests_per_run", 3000)
    return PoliteFetcher(settings.user_agent, min_gap=c.get("min_gap_seconds_per_host", 2.0),
                         timeout=c.get("timeout_seconds", 40), max_requests=budget,
                         robots_ttl=c.get("robots_cache_hours", 24) * 3600, insecure_hosts=settings.insecure_hosts,
                         blocked_hosts=frozenset(c.get("blocked_hosts", [])),
                         max_bytes=int(c.get("max_response_mb", 25) * 1024 * 1024))


def run_source(source, *, sink: MongoSink, rawstore, fetcher=None, params: dict | None = None, log=print) -> RunSummary:
    run_id = new_run_id(source.name)
    ctx = RunContext(run_id=run_id, fetcher=fetcher, rawstore=rawstore, known_keys=sink.known_keys, log=log)
    sink.start_run(run_id, source.name, params or {})
    started = datetime.now(timezone.utc)
    status = "ok"
    written = Counter()      # filled as batches are written, so it survives a run that stops early
    try:
        sink.write(source.collect(ctx), run_id, stats=written)
    except BudgetExhausted as exc:
        ctx.note(f"stopped early: {exc}")
        status = "partial"
    except BaseException as exc:   # including Ctrl+C, so no run is left "running" for ever
        what = "interrupted" if isinstance(exc, KeyboardInterrupt) else f"failed: {type(exc).__name__}: {exc}"
        ctx.note(what)
        sink.finish_run(run_id, "failed", {**ctx.stats, **written, **_fetch_stats(fetcher)}, ctx.notes)
        raise
    by_source = {}
    for src, key in ctx.seen:
        by_source.setdefault(src, []).append(key)
    for src, keys in by_source.items():
        written["listed_not_reread"] += sink.touch(src, keys, started, run_id)
    if any(ctx.stats.get(m) for m in PARTIAL_MARKERS):
        status = "partial"
    stats = {**ctx.stats, **written, **_fetch_stats(fetcher)}
    sink.finish_run(run_id, status, stats, ctx.notes)
    return RunSummary(run_id, source.name, status, stats, ctx.notes)


def _fetch_stats(fetcher) -> dict:
    if fetcher is None:
        return {}
    s = fetcher.stats
    out = {"http_requests": s.requests, "http_retries": s.retries, "http_redirects": s.redirects,
           "http_disallowed": s.disallowed, "http_errors": s.errors}
    out.update({f"http_{k}": v for k, v in s.by_status.items()})
    return out

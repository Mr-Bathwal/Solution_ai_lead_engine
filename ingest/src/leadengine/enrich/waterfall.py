"""The enrichment waterfall (design 7.3): free sources first, paid only for the best-fit companies.

  step 0  free     portal facts (website, district, stage, incubators) are already on the company,
                   written by the knowledge base from the startup portals
  step 1  basic    vendor company lookup, inside the free 500-a-day quota: registry status, registered
                   office (and from it the district and PIN code), ROC; shortlisted companies first,
                   then the newest cohorts
  step 2  resolve  vendor name search, inside its own free quota, for portal startups with no CIN
                   yet: an exact registered-name match with a UP CIN (or an LLPIN, for a portal LLP)
                   becomes a company record, and the knowledge base links it on its next run
  step 3  profile  the full profile (about Rs 5) for the month's shortlisted, non-holdout companies
                   only, never past the monthly cap: capital, directors (name and DIN, as filed with
                   MCA) and the registered email

A run buys the month's profiles first (they are the scarcest and matter most), then spends the free
daily quotas on lookups and searches.

Every answer, "not found" included, goes to the cache first, so nothing is bought twice. A fact
taken from the cache carries the date the vendor gave it, not the date it was re-read.
Without a vendor key the paid and quota steps are skipped and the run says so; nothing is faked.
With a sandbox key (pk_test_...) the calls are made and cached under their own provider name, but
nothing is written to companies or people: sandbox answers are test data. If the vendor refuses the
key or stays overloaded, the step stops (VendorUnavailable) instead of burning the quota.
"""
from collections import Counter
from datetime import datetime, timedelta, timezone

from pymongo import UpdateOne

from .. import SCHEMA_VERSION
from ..ids import parse_cin, is_llpin
from ..names import normalize_name
from ..privacy import email_is_personal
from ..util import parse_date
from . import cache, places
from .caps import meters
from .infyner import PROVIDER, COST_INR, NotConfigured, VendorUnavailable

FACTS_TTL = timedelta(days=90)


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _attr(source_op, value, raw_ref, now, confidence="high"):
    return {"value": value, "source": PROVIDER, "confidence": confidence, "seen_at": now,
            "ref": {"op": source_op, "raw": raw_ref, "legal_basis": "published_under_law"}}


def _keep_raw(rawstore, answer, op, key, provider=PROVIDER):
    """The vendor's answer, kept exactly (not redacted: the registered email is re-parsed from it),
    and marked as holding personal data (directors' names)."""
    if rawstore is None or not answer.raw:
        return None
    return rawstore.put(answer.raw, source=f"vendor_{provider}", url=f"{provider}://{op}/{key}",
                        content_type="application/json", redact=False, personal=True).key


def _in_up(fields: dict, item: dict) -> bool:
    """Whether a vendor answer places the registered office in Uttar Pradesh (an LLPIN carries no state)."""
    addr = fields.get("address") or item.get("address") or ""
    addr = ", ".join(str(v) for v in addr.values() if v) if isinstance(addr, dict) else str(addr)
    roc = str(fields.get("roc") or item.get("roc") or "").lower()
    return bool(places.district(addr)) or "uttar pradesh" in addr.lower() or "kanpur" in roc or "uttar pradesh" in roc


def _company_sets(fields: dict, op: str, raw_key, now) -> dict:
    sets = {}
    if fields.get("status"):
        sets["attrs.company_status"] = _attr(op, str(fields["status"]), raw_key, now)
    if fields.get("address"):
        addr = fields["address"]
        if isinstance(addr, dict):          # some APIs split the address into parts
            addr = ", ".join(str(v) for v in addr.values() if v)
        addr = str(addr)
        sets["attrs.registered_office"] = _attr(op, addr, raw_key, now)
        if d := places.district(addr):
            sets["attrs.registered_district"] = _attr(op, d, raw_key, now)
        if p := places.pincode(addr):
            sets["attrs.registered_pincode"] = _attr(op, p, raw_key, now)
    if fields.get("roc"):
        sets["attrs.roc"] = _attr(op, str(fields["roc"]), raw_key, now)
    if fields.get("email"):
        # The company's registered email, filed with MCA. Often a founder's own address (x@gmail.com,
        # firstname@company.in), so it is flagged as personal unless it is a role address (info@,
        # accounts@ ...) at the company's own domain; the Admin pages mask flagged ones.
        email = str(fields["email"]).strip().lower()
        sets["attrs.registered_email"] = {**_attr(op, email, raw_key, now), "personal": email_is_personal(email)}
    for k in ("authorised_capital", "paid_up_capital"):
        if fields.get(k) not in (None, ""):
            sets[f"attrs.{k}"] = _attr(op, fields[k], raw_key, now)
    return sets


class Waterfall:
    def __init__(self, db, rawstore, caps: dict, *, client=None, log=print, clock=lambda: datetime.now(timezone.utc)):
        self.db, self.rawstore, self.caps, self.client, self.log, self.clock = db, rawstore, caps, client, log, clock
        self.meters = meters(db, caps, clock=clock)
        self.stats = Counter()
        self.sandbox = bool(getattr(client, "sandbox", False))
        self.provider = f"{PROVIDER}_sandbox" if self.sandbox else PROVIDER   # sandbox answers never mix with live ones

    # ---- planning (what each step would do; shown in the Admin pages) ------------------------
    def basic_targets(self, month: str | None) -> list[str]:
        fresh_after = self.clock() - FACTS_TTL
        stale = {"$or": [{"attrs.company_status": {"$exists": False}}, {"attrs.company_status.seen_at": {"$lt": fresh_after}}]}
        shortlisted = [l["company_id"] for l in self.db.leads.find({"shortlist.month": month, "eligible": True},
                                                                  {"company_id": 1}).sort("shortlist.rank", 1)] if month else []
        first = [d["_id"] for d in self.db.companies.find({"_id": {"$in": shortlisted}, **stale}, {"_id": 1})]
        order = {cid: i for i, cid in enumerate(shortlisted)}
        first.sort(key=lambda cid: order[cid])
        rest = [d["_id"] for d in self.db.companies.find({"_id": {"$nin": first}, "kind": "company", **stale}, {"_id": 1})
                .sort([("cohort", -1), ("_id", 1)])]
        return first + rest

    def resolve_targets(self) -> list[dict]:
        out = []
        for d in self.db.entity_links.find({"entity_type": "startup", "status": "unlinked"}).sort("updated_at", -1):
            reason = (d.get("evidence") or {}).get("reason", "")
            if "has no CIN" in reason:
                continue                  # partnerships and proprietorships
            out.append(d)
        return out

    def profile_targets(self, month: str) -> list[str]:
        fresh_after = self.clock() - FACTS_TTL
        ids = [l["company_id"] for l in self.db.leads.find({"shortlist.month": month, "holdout": False, "eligible": True},
                                                          {"company_id": 1}).sort("shortlist.rank", 1)]
        have = {d["_id"] for d in self.db.companies.find({"_id": {"$in": ids}, "attrs.full_profile_at.seen_at": {"$gte": fresh_after}}, {"_id": 1})}
        return [cid for cid in ids if cid not in have]

    def plan(self, month: str | None) -> dict:
        return {"basic_lookups_wanted": len(self.basic_targets(month)),
                "basic_lookups_left_today": self.meters["basic_lookup"].left(),
                "cin_searches_wanted": len(self.resolve_targets()),
                "cin_searches_left_today": self.meters["name_search"].left(),
                "full_profiles_wanted": len(self.profile_targets(month)) if month else 0,
                "full_profiles_left_this_month": self.meters["full_profile"].left(),
                "vendor_configured": self.client is not None}

    # ---- running ------------------------------------------------------------------------------
    def run(self, month: str | None, steps=("basic", "resolve", "profile"), limit: int | None = None) -> dict:
        if self.client is None:
            out = {"vendor": "not configured: set INFYNER_API_KEY; no vendor call was made", **self.plan(month)}
            self.log(f"enrich: {out['vendor']}")
            return out
        if self.sandbox:
            self.log("enrich: sandbox key: answers are cached under infyner_sandbox and not written to companies")
        jobs = [("profile", lambda: self._profiles(month, limit)) if month else None,
                ("basic", lambda: self._basic(month, limit)), ("resolve", lambda: self._resolve(limit))]
        for step, job in filter(None, jobs):
            if step not in steps:
                continue
            try:
                job()
            except VendorUnavailable as exc:
                self.stats["stopped_vendor_unavailable"] += 1
                self.stats["stopped_at_step"] = step
                self.log(f"enrich: stopped at the {step} step: {exc}")
                break
        return dict(self.stats) | self.plan(month) | {"sandbox": self.sandbox}

    def _cached_call(self, op: str, key: str, meter: str, call, kind="company"):
        hit = cache.get(self.db, self.provider, op, key, self.clock())
        if hit:
            self.stats[f"{op}_cache_hits"] += 1
            return hit, False
        if not self.meters[meter].take():
            self.stats[f"{op}_cap_reached"] += 1
            return None, True
        a = call()
        raw_key = _keep_raw(self.rawstore, a, op, key, self.provider)
        doc = cache.put(self.db, self.provider, op, key, status=a.status,
                        result={"fields": a.fields, "items": a.items, "error": a.error} if a.status != "not_found" else None,
                        kind=kind, raw_ref={"key": raw_key} if raw_key else None,
                        cost_inr=COST_INR.get(op, 0.0) if a.status != "error" else 0.0, now=self.clock())
        self.stats[f"{op}_{a.status}"] += 1
        return doc, False

    def _write(self, cid: str, sets: dict, now) -> bool:
        if self.sandbox:
            self.stats["sandbox_answers_not_applied"] += 1
            return False
        self.db.companies.update_one({"_id": cid}, {"$set": {**sets, "updated_at": now}, "$addToSet": {"sources": PROVIDER}})
        return True

    def _basic(self, month, limit):
        for cid in self.basic_targets(month)[: limit or None]:
            doc, capped = self._cached_call("lookup", cid, "basic_lookup", lambda: self.client.lookup(cid))
            if capped:
                break
            if doc and doc["status"] == "found":
                seen = _aware(doc["fetched_at"])      # when the vendor said it, not when we re-read the cache
                sets = _company_sets(doc["result"]["fields"], "lookup", (doc.get("raw_ref") or {}).get("key"), seen)
                if sets and self._write(cid, sets, self.clock()):
                    self.stats["basic_companies_updated"] += 1

    def _profiles(self, month, limit):
        for cid in self.profile_targets(month)[: limit or None]:
            doc, capped = self._cached_call("profile", cid, "full_profile", lambda: self.client.profile(cid))
            if capped:
                self.log("enrich: the monthly cap on full profiles is reached; the rest wait for next month")
                break
            if not doc or doc["status"] != "found":
                continue
            seen = _aware(doc["fetched_at"])
            fields = doc["result"]["fields"]
            raw_key = (doc.get("raw_ref") or {}).get("key")
            sets = _company_sets(fields, "profile", raw_key, seen)
            sets["attrs.full_profile_at"] = _attr("profile", seen.date().isoformat(), raw_key, seen)
            directors = [d for d in fields.get("directors", []) if d.get("name")]
            if directors:
                sets["attrs.directors_count"] = _attr("profile", len(directors), raw_key, seen)
            if self._write(cid, sets, self.clock()):
                self._people(cid, directors, self.clock())
                self.stats["profiles_applied"] += 1

    def _people(self, cid, directors, now):
        """Directors as filed with MCA: name and DIN, keyed on the DIN. No personal contact details
        are bought; a director without a valid DIN is counted on the company but not stored."""
        ops = []
        for d in directors:
            din = str(d.get("din") or "").strip()
            if not (din.isdigit() and len(din) == 8):
                continue
            ops.append(UpdateOne({"din": din}, {"$set": {"name": str(d["name"]).strip(), "updated_at": now},
                                                "$addToSet": {"company_ids": cid},
                                                "$setOnInsert": {"contacts": [], "created_at": now}}, upsert=True))
        if ops:
            self.db.people.bulk_write(ops, ordered=False)

    def _resolve(self, limit):
        from ..kb.entities import load_startups
        from ..sink import MongoSink
        startups = load_startups(MongoSink(self.db))
        for link in self.resolve_targets()[: limit or None]:
            s = startups.get(link["entity_key"])
            if not s or not s.names:
                continue
            k = normalize_name(s.names[0])
            form = k.legal_form or s.legal_form
            if not k.clean or not form:
                continue
            doc, capped = self._cached_call("search", f"{k.clean}|{form}", "name_search",
                                            lambda: self.client.search(s.names[0]))
            if capped:
                break
            if not doc or doc["status"] != "found":
                continue
            exact = []
            for it in doc["result"]["items"]:
                ik = normalize_name(it.get("name", ""))
                cin = str(it["cin"]).strip().upper()
                pc = parse_cin(cin)
                up_cin = bool(pc and pc.is_up)
                if ik.clean == k.clean and ik.legal_form == form and (up_cin or (form == "llp" and is_llpin(cin))):
                    exact.append((cin, it))
            if len(exact) != 1:
                self.stats["resolve_no_single_exact_match"] += 1
                continue
            cin, it = exact[0]
            if self.db.companies.find_one({"_id": cin}, {"_id": 1}):
                self.stats["resolve_already_known"] += 1
                continue
            look, capped = self._cached_call("lookup", cin, "basic_lookup", lambda: self.client.lookup(cin))
            if capped:
                break
            fields = (look or {}).get("result", {}).get("fields", {}) if look and look["status"] == "found" else {}
            if is_llpin(cin) and not _in_up(fields, it):
                # an LLPIN carries no state, and the engine is UP only: no UP registered office, no record
                self.stats["resolve_llp_not_shown_in_up"] += 1
                continue
            if self.sandbox:
                self.stats["sandbox_answers_not_applied"] += 1
                continue
            self._create_company(cin, it, fields, s, (look or {}).get("raw_ref"))

    def _create_company(self, cin, item, fields, s, raw_ref):
        now = self.clock()
        name = (fields.get("name") or item.get("name") or "").strip()
        inc = parse_date(fields.get("incorporated") or item.get("incorporated"))
        if not name or not inc:
            self.stats["resolve_missing_name_or_date"] += 1
            return
        llp = is_llpin(cin)
        raw_key = (raw_ref or {}).get("key")
        sets = _company_sets(fields, "lookup", raw_key, now)
        sets |= {"name": name, "name_norm": normalize_name(name).key, "updated_at": now,
                 "attrs.legal_name": _attr("lookup", name, raw_key, now),
                 "attrs.incorporation_date": _attr("lookup", inc.isoformat(), raw_key, now)}
        if llp:   # _resolve has checked that the vendor places the registered office in UP
            sets["attrs.state_evidence"] = _attr("lookup", "UP", raw_key, now)
        else:
            c = parse_cin(cin)
            sets |= {"attrs.registrar_code": _attr("lookup", c.state, raw_key, now),
                     "attrs.nic_code": _attr("lookup", c.nic5, raw_key, now),
                     "attrs.nic_division": _attr("lookup", c.nic_division, raw_key, now),
                     "attrs.company_type": _attr("lookup", c.company_type, raw_key, now),
                     "attrs.listing": _attr("lookup", "listed" if c.listing == "L" else "unlisted", raw_key, now)}
            if c.sector:
                sets["attrs.sector"] = _attr("lookup", c.sector, raw_key, now)
        self.db.companies.update_one({"_id": cin}, {
            "$setOnInsert": {"kind": "llp" if llp else "company", "state": "UP",
                             "ids": {"llpin": cin} if llp else {"cin": cin}, "former_names": [],
                             "cohort": inc.strftime("%Y-%m"), "first_seen_at": now, "schema_version": SCHEMA_VERSION},
            "$set": sets, "$addToSet": {"sources": PROVIDER}}, upsert=True)
        self.stats["resolve_companies_created"] += 1


def client_from_env(env=None):
    """The vendor client from settings.env (.env merged with the process environment), or None."""
    import os
    from .infyner import InfynerClient
    env = env if env is not None else os.environ
    try:
        return InfynerClient(env.get("INFYNER_API_KEY"))
    except NotConfigured:
        return None

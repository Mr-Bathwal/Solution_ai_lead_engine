"""Hard caps (config/caps.json; design 10 "Hard caps").

A unit is taken before the call it pays for, in one atomic database operation, so two workers can
never overrun a cap between them. A failed call keeps its unit: the vendor may have counted it too,
and erring towards spending less is the point of a cap.

Days and months are Indian (IST) days and months, whatever the server's time zone: the 05:00 IST
nightly is 23:30 UTC the day before, and must count against the same day as a 10:00 IST manual run.
"""
from datetime import datetime, timezone

from pymongo.errors import DuplicateKeyError

from ..util import IST


def period(kind: str, now: datetime | None = None) -> str:
    now = (now or datetime.now(timezone.utc))
    now = (now if now.tzinfo else now.replace(tzinfo=timezone.utc)).astimezone(IST)
    return now.strftime("%Y-%m-%d") if kind == "daily" else now.strftime("%Y-%m")


class Meter:
    def __init__(self, db, meter: str, cap: int, kind: str = "monthly", clock=lambda: datetime.now(timezone.utc)):
        if kind not in ("daily", "monthly"):
            raise ValueError(kind)
        self.db, self.meter, self.cap, self.kind, self.clock = db, meter, int(cap), kind, clock

    @property
    def _id(self) -> str:
        return f"{self.meter}:{period(self.kind, self.clock())}"

    def take(self, n: int = 1) -> bool:
        """True if n units were taken; False if that would pass the cap (nothing is taken then)."""
        now = self.clock()
        _id = f"{self.meter}:{period(self.kind, now)}"
        try:
            self.db.usage.update_one({"_id": _id}, {"$setOnInsert": {"meter": self.meter, "period": period(self.kind, now),
                                                                    "count": 0, "cap": self.cap, "updated_at": now}},
                                     upsert=True)
        except DuplicateKeyError:
            pass        # another worker created it first
        r = self.db.usage.update_one({"_id": _id, "count": {"$lte": self.cap - n}},
                                     {"$inc": {"count": n}, "$set": {"updated_at": now, "cap": self.cap}})
        return r.modified_count == 1

    def used(self) -> int:
        d = self.db.usage.find_one({"_id": self._id})
        return d["count"] if d else 0

    def left(self) -> int:
        return max(0, self.cap - self.used())


def meters(db, caps: dict, clock=None) -> dict:
    """The meters the enrichment waterfall uses, with their caps from caps.json."""
    kw = {"clock": clock} if clock else {}
    return {
        "basic_lookup": Meter(db, "vendor.basic_lookup", caps["daily"]["free_basic_lookups"], "daily", **kw),
        "name_search": Meter(db, "vendor.name_search", caps["daily"].get("free_name_searches", 500), "daily", **kw),
        "full_profile": Meter(db, "vendor.full_profile", caps["monthly"]["paid_profile_lookups"], "monthly", **kw),
    }

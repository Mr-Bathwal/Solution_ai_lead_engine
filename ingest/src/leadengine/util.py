"""Small shared helpers: stable hashing and time."""
import hashlib
import json
from datetime import date, datetime, timedelta, timezone

# India has one time zone and no daylight saving, so a fixed offset is exact (and needs no tz database,
# which Windows does not ship). Days and months for caps, shortlists and schedules are IST days and months.
IST = timezone(timedelta(hours=5, minutes=30), "IST")


def _default(o):
    if isinstance(o, datetime):
        return o.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    if isinstance(o, date):
        return o.isoformat()
    if isinstance(o, (set, frozenset)):
        return sorted(o)
    raise TypeError(f"not JSON-serialisable: {type(o).__name__}")


def canonical_json(value) -> str:
    """Deterministic JSON (sorted keys, no spaces). The same idea as services/src/util/canonical.js,
    but the two are not byte-identical (dates and floats are written differently), so a hash is only
    ever compared with another hash made by the same language."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=_default)


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def ist_month(at: datetime | None = None) -> str:
    """The IST calendar month of an instant ("2026-11"), whatever the server's own time zone is."""
    return (at or utcnow()).astimezone(IST).strftime("%Y-%m")


def ist_naive_to_utc(s: str) -> datetime:
    """A timestamp written in Indian local time without an offset (the Atlas caches' retrieved_at), as UTC."""
    dt = datetime.fromisoformat(s)
    return (dt if dt.tzinfo else dt.replace(tzinfo=IST)).astimezone(timezone.utc)


def parse_date(value) -> date | None:
    """Dates as the Indian sources write them: 05-10-2026, 05/10/2026, 2026-10-05, 05 Oct 2026, 05.10.2026."""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    s = str(value).strip()
    for fmt in ("%d-%m-%Y", "%Y-%m-%d", "%d/%m/%Y", "%d.%m.%Y", "%d %b %Y", "%d %B %Y", "%d-%b-%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(s).date()   # "2026-09-29T00:00:00", "2026-09-29 00:00:00"
    except ValueError:
        return None

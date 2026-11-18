"""What every source produces, and what every source is given."""
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime
from typing import Callable

from .rawstore import RawRef
from .util import canonical_json, sha256_text, utcnow

LEGAL_BASES = ("published_under_law", "published_by_company", "public_statistics")


@dataclass
class Record:
    """One fact-bearing row from one source, exactly as the source gave it (after removing anything
    personal we must not keep). Stored in source_records and never edited afterwards."""
    source: str
    natural_key: str
    payload: dict
    legal_basis: str
    url: str | None = None
    company_id: str | None = None         # CIN or LLPIN when the source itself states it
    raw_ref: RawRef | None = None
    fetched_at: datetime = field(default_factory=utcnow)
    personal_fields: tuple = ()           # payload keys that hold personal data, for retention and erasure

    def __post_init__(self):
        if self.legal_basis not in LEGAL_BASES:
            raise ValueError(f"unknown legal basis: {self.legal_basis}")
        if not self.natural_key:
            raise ValueError("natural_key is required")

    @property
    def content_hash(self) -> str:
        return sha256_text(canonical_json(self.payload))


@dataclass
class RunContext:
    run_id: str
    fetcher: object            # PoliteFetcher, or None for offline sources
    rawstore: object           # FileRawStore / S3RawStore
    known_keys: Callable[..., set] = lambda source, where=None: set()   # natural keys already stored
    log: Callable[[str], None] = print
    stats: Counter = field(default_factory=Counter)
    notes: list = field(default_factory=list)
    seen: set = field(default_factory=set)   # keys a run saw listed but did not re-read, as (source, key)

    def saw(self, source: str, key: str):
        self.seen.add((source, key))

    def note(self, msg: str):
        self.notes.append(msg)
        self.log(msg)

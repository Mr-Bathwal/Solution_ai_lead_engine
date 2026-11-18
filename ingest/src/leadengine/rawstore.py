"""Raw page and file store, keyed by where a page came from and its content hash.

Key: <source>/<sha256(locator)[:16]>/<sha256(content as fetched)>.gz

The locator is the URL, or a stable key when the URL is not stable (Startup in UP re-encrypts its
profile URLs on every page load, so profiles are filed under their UPLC number). Re-fetching an
unchanged page writes nothing new; a changed page gets a new key beside the old one, so every
version a source showed us is kept and parsing can be re-run at any time. Pages whose markup changes
on every load (the Startup in UP directory embeds fresh encrypted links) are stored again each run;
at about 50 KB a page that is a few MB a week.

Before a page is written, email addresses and phone numbers are removed from it (redact=True, the
default; see privacy.py). The key and `sha256` still name the bytes as fetched, so a re-fetch of the
same page is recognised; the stored copy is the redacted one. A page that still holds people's names
(a startup's published team) is marked `personal`, in the index and on its RawRef, so retention and
erasure can find it. A local folder in development, S3 in production (RAW_STORE=s3://bucket/prefix).
"""
import gzip
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from urllib.parse import quote

from .privacy import redact_bytes
from .util import sha256_bytes, sha256_text


@dataclass(frozen=True)
class RawRef:
    store: str
    key: str
    sha256: str          # of the bytes as fetched
    size: int
    url: str
    content_type: str
    redacted: bool = False     # contact details were removed before storing
    personal: bool = False     # the stored bytes still hold people's names

    def to_doc(self) -> dict:
        return asdict(self)


def raw_key(source: str, url: str, content_sha: str) -> str:
    return f"{source}/{sha256_text(url)[:16]}/{content_sha}.gz"


def _prepare(data: bytes, source: str, url: str, content_type: str, redact: bool, locator: str | None):
    sha = sha256_bytes(data)
    key = raw_key(source, locator or url, sha)
    stored, removed = redact_bytes(data, content_type) if redact else (data, 0)
    return sha, key, stored, removed > 0


class FileRawStore:
    kind = "file"

    def __init__(self, root: str | Path):
        self.root = Path(root)

    def put(self, data: bytes, *, source: str, url: str, content_type: str = "", redact: bool = True,
            personal: bool = False, locator: str | None = None) -> RawRef:
        sha, key, stored, redacted = _prepare(data, source, url, content_type, redact, locator)
        path = self.root / key
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_bytes(gzip.compress(stored, mtime=0))
            tmp.replace(path)
            meta = {"url": url, "sha256": sha, "size": len(data), "content_type": content_type, "key": key,
                    "redacted": redacted, "personal": personal}
            with open(self.root / source / "_index.jsonl", "a", encoding="utf-8") as fh:
                fh.write(json.dumps(meta, ensure_ascii=False) + "\n")
        return RawRef(self.kind, key, sha, len(data), url, content_type, redacted, personal)

    def get(self, ref: RawRef | dict) -> bytes:
        key = ref["key"] if isinstance(ref, dict) else ref.key
        return gzip.decompress((self.root / key).read_bytes())

    def delete(self, key: str) -> bool:
        """Erasure: removes one stored object. The index line stays, as the record that it existed."""
        path = self.root / key
        if path.exists():
            path.unlink()
            return True
        return False

    def rewrite(self, key: str, data: bytes):
        """Replaces a stored object's bytes under the same key (used to redact pages stored before
        redaction existed; the key still names the bytes as fetched)."""
        path = self.root / key
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(gzip.compress(data, mtime=0))
        tmp.replace(path)

    def keys(self, source: str | None = None):
        base = self.root / source if source else self.root
        for p in sorted(base.rglob("*.gz")):
            yield p.relative_to(self.root).as_posix()

    def keys_under(self, prefix: str):
        """Every stored key that starts with `prefix` (a folder such as vendor_infyner/<hash>/)."""
        base = self.root / prefix
        if base.is_dir():
            for p in sorted(base.rglob("*.gz")):
                yield p.relative_to(self.root).as_posix()


class S3RawStore:
    kind = "s3"

    def __init__(self, bucket: str, prefix: str = ""):
        import boto3  # optional dependency: pip install leadengine-ingest[s3]

        self.s3 = boto3.client("s3")
        self.bucket = bucket
        self.prefix = prefix.strip("/")

    def _full(self, key: str) -> str:
        return f"{self.prefix}/{key}" if self.prefix else key

    def put(self, data: bytes, *, source: str, url: str, content_type: str = "", redact: bool = True,
            personal: bool = False, locator: str | None = None) -> RawRef:
        from botocore.exceptions import ClientError

        sha, key, stored, redacted = _prepare(data, source, url, content_type, redact, locator)
        try:
            self.s3.head_object(Bucket=self.bucket, Key=self._full(key))
        except ClientError:
            # S3 metadata must be ASCII: a search URL can carry Devanagari, so it is percent-encoded.
            self.s3.put_object(Bucket=self.bucket, Key=self._full(key), Body=gzip.compress(stored, mtime=0),
                               ContentEncoding="gzip", ContentType=content_type or "application/octet-stream",
                               ServerSideEncryption="AES256",
                               Metadata={"source-url": quote(url, safe=":/?&=%#+,;@")[:1024],
                                         "redacted": str(redacted).lower(), "personal": str(personal).lower()},
                               Tagging=f"personal={str(personal).lower()}")
        return RawRef(self.kind, key, sha, len(data), url, content_type, redacted, personal)

    def get(self, ref: RawRef | dict) -> bytes:
        key = ref["key"] if isinstance(ref, dict) else ref.key
        body = self.s3.get_object(Bucket=self.bucket, Key=self._full(key))["Body"].read()
        return gzip.decompress(body)

    def keys_under(self, prefix: str):
        """Every stored key that starts with `prefix`, without the store's own prefix."""
        cut = len(self._full("")) if self.prefix else 0
        for page in self.s3.get_paginator("list_objects_v2").paginate(Bucket=self.bucket, Prefix=self._full(prefix)):
            for o in page.get("Contents", []):
                yield o["Key"][cut:]

    def delete(self, key: str) -> bool:
        """Erasure: removes every stored version of one object (the bucket keeps versions)."""
        full = self._full(key)
        found = False
        for page in self.s3.get_paginator("list_object_versions").paginate(Bucket=self.bucket, Prefix=full):
            for v in page.get("Versions", []) + page.get("DeleteMarkers", []):
                if v["Key"] == full:
                    self.s3.delete_object(Bucket=self.bucket, Key=full, VersionId=v["VersionId"])
                    found = True
        return found


def open_rawstore(uri: str):
    if uri.startswith("s3://"):
        bucket, _, prefix = uri[5:].partition("/")
        return S3RawStore(bucket, prefix)
    return FileRawStore(uri)

"""Personal data on the way into storage.

The engine keeps company-level facts. Portal pages and incubator tables also carry people's email
addresses and mobile numbers (a representative's contact, a founder's gmail). Those are removed
from the bytes before a page is kept in the raw store, so neither the database nor the raw store
holds them. People's names published on the portals (a startup's team) stay in the raw page and
are flagged instead: the raw object is marked `personal`, so retention and erasure jobs can find it.

The same rules as services/src/util/normalize.js decide when an email address is a person's.
"""
import json
import re

REDACTED_EMAIL = "[email removed]"
REDACTED_PHONE = "[phone removed]"

# Keep in step with SHARED_MAIL_DOMAINS in services/src/util/normalize.js (a test compares the two).
SHARED_MAIL_DOMAINS = frozenset({
    "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "yahoo.in", "ymail.com", "rocketmail.com",
    "outlook.com", "outlook.in", "hotmail.com", "hotmail.co.in", "live.com", "live.in", "msn.com",
    "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "zoho.com", "zohomail.in",
    "rediffmail.com", "rediff.com", "gmx.com", "mail.com", "yandex.com", "tutanota.com",
})
_ROLE_LOCAL = re.compile(
    r"^(info|contact|contactus|hello|hi|admin|accounts?|finance|billing|sales|support|help|hr|careers|jobs|office|team|mail|"
    r"enquir(y|ies)|inquir(y|ies)|compliance|legal|cs|secretarial|director|directors|ca|tax|gst|payments?|ops|operations|"
    r"marketing|business|corporate|company|connect|care|service|services|query|queries|feedback|noreply|no-reply)"
    r"([._-]?\d*)?$")

EMAIL_RX = re.compile(r"(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])")
# Indian mobiles in the forms the portals print them: 9876543210, 98765 43210, +91-9876543210, (+91) 98765-43210,
# 09876543210, 0091 9876543210. Not inside a longer token (UPLC_00012345, logo timestamps, encrypted URLs)
# and not the decimals of a number (1985858.8000000007).
MOBILE_RX = re.compile(r"(?<![\w/+.])(?:(?:\(\+?91\)|\+91|0091|91)[\s.-]*|0)?[6-9]\d{4}[\s.-]?\d{5}(?!\w|\.\d)")
# Landlines with an STD code and a separator: 0522-2345678, 0120 4567890, (0522) 2345678.
LANDLINE_RX = re.compile(r"(?<![\w/.])\(?0\d{2,4}\)?[\s-]\d{6,8}(?![\w])")


def is_role_address(email: str) -> bool:
    e = (email or "").strip().lower()
    local, at, domain = e.rpartition("@")
    return bool(at) and domain not in SHARED_MAIL_DOMAINS and bool(_ROLE_LOCAL.match(local))


def email_is_personal(email: str) -> bool:
    """Personal unless it is a role address (info@, accounts@ ...) at a non-shared domain. firstname@acme.in
    is a person's address as much as x@gmail.com is."""
    return bool((email or "").strip()) and not is_role_address(email)


def redact_text(text: str) -> tuple[str, int]:
    """Text with email addresses and phone numbers replaced; and how many were replaced."""
    n = 0

    def sub(rx, repl, s):
        nonlocal n
        out, k = rx.subn(repl, s)
        n += k
        return out

    text = sub(EMAIL_RX, REDACTED_EMAIL, text)
    text = sub(MOBILE_RX, REDACTED_PHONE, text)
    text = sub(LANDLINE_RX, REDACTED_PHONE, text)
    return text, n


def _redact_json(o):
    if isinstance(o, str):
        return redact_text(o)[0]
    if isinstance(o, bool) or o is None:
        return o
    if isinstance(o, int) and MOBILE_RX.fullmatch(str(o)):
        return REDACTED_PHONE
    if isinstance(o, dict):
        return {k: _redact_json(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_redact_json(v) for v in o]
    return o


TEXT_TYPES = {"application/json", "application/xml", "application/javascript", "application/xhtml+xml"}


def is_text(data: bytes, content_type: str = "") -> bool:
    """Text a person could have typed contact details into; never a binary file (an .xlsx is
    "...spreadsheetml.sheet", which merely contains the letters "xml")."""
    ct = (content_type or "").split(";")[0].strip().lower()
    if ct:
        return ct.startswith("text/") or ct in TEXT_TYPES or ct.endswith(("+json", "+xml"))
    return data[:512].lstrip()[:1] in (b"<", b"{", b"[")


def redact_bytes(data: bytes, content_type: str = "") -> tuple[bytes, int]:
    """A page's bytes with contact details removed, and the number removed. JSON is redacted value by
    value so it stays valid JSON; HTML and other text keep their markup. Binary files are left alone."""
    if not is_text(data, content_type):
        return data, 0
    text = data.decode("utf-8", errors="surrogateescape")
    if "json" in (content_type or "").lower() or text.lstrip()[:1] in ("{", "["):
        try:
            body = json.loads(text)
        except ValueError:
            body = None
        if body is not None:
            out = json.dumps(_redact_json(body), ensure_ascii=False, separators=(",", ":"))
            before = len(EMAIL_RX.findall(text)) + len(MOBILE_RX.findall(text)) + len(LANDLINE_RX.findall(text))
            return (out.encode("utf-8") if out != json.dumps(body, ensure_ascii=False, separators=(",", ":")) else data), before
    out, n = redact_text(text)
    return (out.encode("utf-8", errors="surrogateescape") if n else data), n


def keep_only(row: dict, allowed: set) -> dict:
    """An allow-list scrub: only the keys we have decided to keep, at the top level. Anything a source
    adds later (an applicant's name, a WhatsApp number) is dropped until someone decides otherwise."""
    return {k: v for k, v in row.items() if k in allowed}

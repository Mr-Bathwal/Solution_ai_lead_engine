"""Company websites and domains."""
import re
from urllib.parse import urlsplit

# Pages on shared platforms are not a company's own domain: suppressing, matching or emailing on
# "facebook.com" would touch every company that has a page there.
SHARED_HOSTS = (
    "facebook.com", "fb.com", "instagram.com", "linkedin.com", "twitter.com", "x.com", "youtube.com", "youtu.be",
    "wa.me", "whatsapp.com", "t.me", "telegram.me", "linktr.ee", "google.com", "goo.gl", "forms.gle", "sites.google.com",
    "blogspot.com", "wordpress.com", "wixsite.com", "medium.com", "github.com", "github.io", "notion.site",
    "startinup.up.gov.in", "startupmission.up.gov.in", "startupindia.gov.in", "indiamart.com", "justdial.com",
    "play.google.com", "apps.apple.com", "bit.ly", "tinyurl.com", "carrd.co", "godaddysites.com", "business.site",
)
DOMAIN_RX = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$")


def normalize_domain(value) -> str | None:
    """"https://www.Acme.in/about" -> "acme.in", the same rule as services/src/util/normalize.js."""
    if not isinstance(value, str) or not value.strip():
        return None
    s = value.strip().lower()
    if "@" in s:
        s = s.rsplit("@", 1)[1]
    if not re.match(r"^[a-z][a-z0-9+.-]*://", s):
        s = "http://" + s
    host = (urlsplit(s).hostname or "").rstrip(".")
    host = re.sub(r"^www\d?\.", "", host)
    return host if DOMAIN_RX.match(host) else None


def company_domain(url) -> str | None:
    """The company's own domain from a website it published, or None for a page on a shared platform."""
    d = normalize_domain(url)
    if not d:
        return None
    if any(d == h or d.endswith("." + h) for h in SHARED_HOSTS):
        return None
    return d

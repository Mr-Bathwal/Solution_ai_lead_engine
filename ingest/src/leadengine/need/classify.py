"""The UP Startup Atlas rules-based classifier, ported for company records (design 7.4: "name terms,
using the Atlas rules-based classifier, which costs nothing to run").

Two outputs, both deterministic and explained:
  theme       one of 20 sector themes (taxonomy in lexicon.THEMES), from the name, the NIC code and the
              portal's sector label, with the evidence that decided it
  innovation  0-100: how much the name and activity code look like a technology or innovation business
              rather than a traditional one (trading, construction, contracting ...)

Ported from up-startup-intel/engine/v2_classify_rules.py (classify_row and innovation). The company
records have no business description, so the description terms of the original do not apply here.
"""
import re
from collections import defaultdict
from dataclasses import dataclass, field

from .lexicon import (HORIZONTAL, INDUSTRY_MAP, KW, LABEL_MAP, NIC_GENERIC, NIC_MAP, TECH_EXCLUDE, TECH_MED,
                      TECH_NIC_10, TECH_NIC_20, TECH_NIC_30, TECH_STRONG, THEMES, TRAD_NIC, TRAD_TOKENS)


def _wrap(p):
    return re.compile(r"(?<![a-z0-9])(?:%s)(?![a-z0-9])" % p, re.I)


KWC = [(t, sub, st, sc, _wrap(p)) for (t, sub, st, sc, p) in KW]
RE_TSTRONG, RE_TMED, RE_TEXCL, RE_TRAD = _wrap(TECH_STRONG), _wrap(TECH_MED), _wrap(TECH_EXCLUDE), _wrap(TRAD_TOKENS)
RE_SUFFIX = re.compile(r"\(\s*o\.?p\.?c\.?\s*\)|\b(?:private|pvt\.?|limited|ltd\.?|llp|opc)(?![a-z])", re.I)
W_NAME_S, W_NAME_S_HORIZ, W_NAME_W = 4.0, 2.5, 1.5
W_NIC, W_NIC_GENERIC, W_LABEL, W_INDUSTRY = 3.0, 2.0, 2.0, 1.0


@dataclass
class Classification:
    theme_id: str
    theme: str
    sub_sector: str
    confidence: str
    innovation: int
    evidence: list = field(default_factory=list)


def clean_name(s: str) -> str:
    s = RE_SUFFIX.sub(" ", (s or "").lower())
    return re.sub(r"\s+", " ", s.replace("_", " ")).strip(" .,-")


def nic_lookup(nic: str):
    for n in (5, 4, 3, 2):
        p = nic[:n]
        if len(nic) >= n and p in NIC_MAP:
            t, sub = NIC_MAP[p]
            return p, t, sub
    return None, None, None


def classify(name: str, *, brand: str = "", nic: str = "", sector_label: str = "", industry: str = "",
             website: str = "", incorporated_year: int | None = None, section8: bool = False) -> Classification:
    name_t = clean_name(name)
    b = clean_name(brand)
    if b and b != name_t:
        name_t = f"{name_t} | {b}"
    nic = (nic or "").strip()
    nic_p, nic_theme, nic_sub = nic_lookup(nic) if nic else (None, None, None)
    domain_nic = (nic_theme is not None and nic_theme not in HORIZONTAL and nic_theme not in ("T19", "T09")
                  and not (nic_p and nic_p.startswith(NIC_GENERIC)))
    score, ev = defaultdict(float), defaultdict(list)

    hits = defaultdict(list)
    for t, sub, st, sc, rx in KWC:
        if sc == "d":
            continue
        m = rx.search(name_t)
        if m:
            w = W_NAME_W if st == "W" else (W_NAME_S_HORIZ if (t in HORIZONTAL and domain_nic) else W_NAME_S)
            hits[t].append((w, m.group(0), sub, st))
    for t, h in hits.items():
        h.sort(key=lambda x: -x[0])
        score[t] += h[0][0] + (0.5 if len(h) > 1 else 0)
        ev[t].append(("name" if h[0][3] == "S" else "name_weak", h[0][1], h[0][2]))
    if website.lower().rstrip("/").endswith(".ai"):
        score["T01"] += W_NAME_W
        ev["T01"].append(("name_weak", ".ai domain", "AI solutions"))
    if nic_theme:
        score[nic_theme] += W_NIC_GENERIC if nic_p.startswith(NIC_GENERIC) else W_NIC
        ev[nic_theme].append(("nic", nic_p, nic_sub))
    for part in [p.strip() for p in (sector_label or "").split(",") if p.strip()]:
        if part in LABEL_MAP:
            t, sub = LABEL_MAP[part]
            score[t] += 1.5 if t == "T01" else W_LABEL
            ev[t].append(("portal_sector", part, sub))
            break
    if industry.strip() in INDUSTRY_MAP:
        t = INDUSTRY_MAP[industry.strip()]
        score[t] += W_INDUSTRY
        ev[t].append(("portal_industry", industry.strip(), None))

    inno = innovation(name_t, nic, website, incorporated_year, section8)
    if not score:
        return Classification("T19", THEMES["T19"][0], "unspecified (no sector evidence)", "low", inno, [])
    ranked = sorted(score, key=lambda t: (score[t], any(e[0] == "nic" for e in ev[t]),
                                          any(e[0] == "name" for e in ev[t]), -int(t[1:])), reverse=True)
    theme = ranked[0]
    if section8 and theme != "T20" and not ((nic_p or "").startswith(("62", "63", "721", "21")) or theme in ("T01", "T13")):
        theme = "T20"
        ev["T20"].append(("section8", "Section 8", None))
    top = score[theme]
    second = max((score[t] for t in ranked if t != theme), default=0.0)
    subs = [e[2] for e in ev[theme] if e[2]]
    sub = subs[0] if subs else THEMES[theme][0]
    margin = top - second
    conf = "high" if top >= 6 and margin >= 2 else "med" if top >= 3 and margin >= 1 else "low"
    evidence = [{"from": src, "matched": det} for src, det, _ in ev[theme]]
    return Classification(theme, THEMES[theme][0], sub, conf, inno, evidence)


def innovation(name_t: str, nic: str, website: str, incorporated_year: int | None, section8: bool) -> int:
    """The Atlas innovation score, minus its description term (company records have no description)."""
    s = 10
    if nic.startswith(TECH_NIC_30):
        s += 30
    elif nic.startswith(TECH_NIC_20):
        s += 20
    elif nic.startswith(TECH_NIC_10):
        s += 10
    excl = {m.group(0).lower() for m in RE_TEXCL.finditer(name_t)}
    strong = {m.group(0).lower() for m in RE_TSTRONG.finditer(name_t)} - excl
    med = {m.group(0).lower() for m in RE_TMED.finditer(name_t)} - excl - strong
    if strong:
        s += 30 + min(10, 5 * (len(strong) - 1))
    elif med:
        s += 15
    if RE_TRAD.search(name_t):
        s -= 20
    if nic and nic.startswith(TRAD_NIC):
        s -= 10
    if website.strip():
        s += 10
    if incorporated_year and incorporated_year >= 2025:
        s += 5
    if section8:
        s -= 20
    return max(0, min(100, s))

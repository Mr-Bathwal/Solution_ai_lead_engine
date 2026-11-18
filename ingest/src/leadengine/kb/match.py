"""Which company is each portal startup? (design 7.2, "matching in three steps")

1. Exact. MCA does not register two companies (or two LLPs) under the same name, so a startup whose
   registered name, legal form included, equals exactly one company's name is that company, unless
   the facts contradict it: the founder says it is an LLP and the match is a company, or the startup
   was on the portal before the company existed.
2. Splink scores the rest. A link is made only when the probability is high, the two names are the
   same name to MCA (or differ by one slip of spelling in a distinctive word), the legal forms agree,
   the best candidate is far ahead of the next one, AND something beyond the name agrees, as the
   design requires; anything in between goes to a person.
3. A person decides the unsure pairs in the Admin review queue. Their decision (match_reviews)
   always wins over the matcher on every later run. (The design's third step, an AI yes/no on unsure
   pairs, plugs in here once the LLM gateway has a key for the engine.)

Generic words count. "Pravaron Holdings" and "Pravaron Technologies" share every distinctive word but
are two companies MCA registered a month apart; a startup with one name is never linked to the other
automatically. Of 4,000 real UP company names matched against the other UP companies (the
leave-one-out test in labels.py), the first version of this matcher linked 18 to such a sibling.

"Something beyond the name" is the founder's own year of establishment, within a year of
incorporation. The portal listing date is not evidence on its own (every startup listed this year
"agrees" with every company incorporated this year); it counts only as a window, together with a
sector that fits the company's NIC code or a website named like the company.

Every decision is written to entity_links with its method, probability, evidence and model version,
and next to it the matcher's own decision before any reviewer's (`matcher`), so precision can be
measured against labels the matcher never saw.
"""
import hashlib
import math
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

from ..ids import parse_cin
from ..names import IGNORABLE, canonical, is_generic, normalize_name, typo_of, variant_key
from ..web import company_domain
from .entities import Startup

MODEL_VERSION = "kb-match-v2"
LINK_P = 0.98          # Splink probability needed for an automatic link (with the other conditions)
REVIEW_P = 0.30        # below this a candidate is not worth a person's time
CANDIDATE_P = 0.05     # pairs scored below this are dropped at prediction time
MARGIN_BITS = 6.0      # the best candidate must be 2^6 = 64 times likelier than the next, rejected ones included
WINDOW_DAYS = 548      # listed on the portal within ~18 months of incorporation
LABEL_PSEUDO = 20      # labelled pairs are blended with the prior m values as if the prior were 20 pairs
MIN_LABELS = 30        # labelled "same" pairs needed before m is re-estimated from them
TYPE_FORMS = {"PTC": "pvt ltd", "OPC": "opc pvt ltd", "PLC": "ltd"}

# The NIC divisions a portal sector or industry plausibly registers under. Hand-built from the NIC
# 2008 divisions and the portal's own lists; it is only ever used as evidence FOR a link (a sector
# that fits), never against one, because founders file under whatever NIC code their CA picks.
SECTOR_DIVISIONS = {
    "Software Development": {"58", "62", "63"},
    "Artificial Intelligence & Machine Learning": {"58", "62", "63", "72"},
    "Cloud Computing Services": {"58", "62", "63"},
    "Data Analytics": {"62", "63", "70", "73"},
    "Health Information Technology": {"62", "63", "86"},
    "Educational Software": {"58", "62", "85"},
    "Online Learning Platforms": {"58", "62", "63", "85"},
    "Food Processing": {"10", "11", "46"},
    "AgTech": {"01", "10", "46", "62", "72"},
    "Precision Agriculture": {"01", "28", "62", "72"},
    "Sustainable Farming": {"01", "10", "46"},
    "Medical Devices": {"26", "32", "46", "86"},
    "Telemedicine": {"62", "86"},
    "Biotechnology": {"20", "21", "72"},
    "Construction": {"41", "42", "43", "71"},
    "Urban Development": {"41", "42", "43", "68", "71"},
    "Renewable Energy": {"27", "35", "42", "43"},
    "Environmental Technologies": {"37", "38", "39", "72"},
    "Logistics Services": {"49", "52", "53"},
    "Retail and E-commerce": {"46", "47", "63"},
    "Digital Banking": {"62", "64", "66"},
    "Cryptocurrency Services": {"62", "64", "66"},
    "Tourism and Hospitality": {"55", "56", "79"},
    "Creative Industries": {"58", "59", "73", "74", "90"},
    "Manufacturing Technologies": {f"{d:02d}" for d in range(10, 34)} | {"72"},
    "IT/ITeS, FinTech & Emerging Technologies": {"58", "61", "62", "63", "64", "66"},
    "Education, EdTech & Social Impact": {"58", "62", "85", "88", "94"},
    "Healthcare & Life-Sciences": {"21", "26", "32", "72", "86"},
    "Agriculture, Food & Beverages": {"01", "02", "03", "10", "11", "46", "47"},
    "Infrastructure": {"35", "36", "41", "42", "43", "49", "52", "68", "71"},
}


@dataclass
class Company:
    id: str
    name: str
    kind: str
    clean: str
    form: str | None
    key: str
    core: tuple
    inc_date: str | None
    inc_year: int | None
    nic_division: str | None = None


@dataclass
class Candidate:
    company_id: str
    probability: float
    method: str
    evidence: dict = field(default_factory=dict)
    weight: float = math.inf          # Splink match weight in bits; an exact name is infinitely sure


@dataclass
class Decision:
    entity_key: str
    status: str                      # linked | review | unlinked | rejected
    company_id: str | None = None
    method: str | None = None
    probability: float | None = None
    candidates: list = field(default_factory=list)
    evidence: dict = field(default_factory=dict)
    decided_by: str | None = "matcher"


def company_from(cid: str, name: str, kind: str, inc_date: str | None, nic_division: str | None = None) -> Company:
    """A Company as the matcher sees it. The legal form comes from the name; a CIN of type OPC says
    "one person company" even when the name lost its "(OPC)", and a name with no form at all takes the
    form its CIN type implies."""
    k = normalize_name(name)
    cin = parse_cin(cid)
    form = k.legal_form
    if cin and cin.type_code == "OPC":
        form = "opc pvt ltd"
    elif not form:
        form = TYPE_FORMS.get(cin.type_code) if cin else ("llp" if kind == "llp" else None)
    nic = nic_division or (cin.nic_division if cin else None)
    return Company(cid, name, kind, k.clean, form, k.key, k.core, inc_date, int(inc_date[:4]) if inc_date else None, nic)


class CompanyIndex:
    def __init__(self, companies: list[Company]):
        self.by_id = {c.id: c for c in companies}
        self.by_exact = defaultdict(list)
        self.by_clean = defaultdict(list)
        self.by_key = defaultdict(list)
        self.by_variant = defaultdict(list)
        for c in companies:
            self.by_exact[(c.clean, c.form)].append(c)
            self.by_clean[c.clean].append(c)
            self.by_key[c.key].append(c)
            self.by_variant[variant_key(c.clean)].append(c)

    @classmethod
    def load(cls, db, extra: list[Company] = ()) -> "CompanyIndex":
        """Every company in the database, plus `extra` ones not stored yet (UP LLPs found this run,
        stored only if a link to them survives)."""
        out = []
        for d in db.companies.find({}, {"name": 1, "kind": 1, "attrs.incorporation_date.value": 1,
                                        "attrs.nic_division.value": 1}):
            attrs = d.get("attrs") or {}
            out.append(company_from(d["_id"], d["name"], d.get("kind", "company"),
                                    (attrs.get("incorporation_date") or {}).get("value"),
                                    (attrs.get("nic_division") or {}).get("value")))
        have = {c.id for c in out}
        return cls(out + [c for c in extra if c.id not in have])

    def without(self, ids) -> "CompanyIndex":
        ids = set(ids)
        return CompanyIndex([c for c in self.by_id.values() if c.id not in ids])


# ---- the evidence ---------------------------------------------------------------------------------

def same_core_name(s: Startup, c: Company) -> bool:
    return any(clean == c.clean for clean, _, _ in s.name_keys())


def possible_conversion(s: Startup, c: Company) -> bool:
    """An LLP on the portal and a newly incorporated company with the same name: most likely the LLP
    converted into a company (a common step before raising money), which is the same business."""
    return "llp" in s.stated_forms and c.kind == "company" and same_core_name(s, c) and bool(
        s.since and c.inc_date and s.since < c.inc_date)


def contradictions(s: Startup, c: Company) -> list[str]:
    """Facts that say this startup is not that company, whatever the names say. The founder's legal
    form is the one written in the name if any name carries one, else the portal's dropdown."""
    out = []
    forms = s.stated_forms
    if forms == {"llp"} and c.kind != "llp":
        out.append("the founder says it is an LLP; this is a company")
    if forms and "llp" not in forms and c.kind == "llp":
        out.append("the founder says it is a company; this is an LLP")
    if s.since and c.inc_date and s.since < c.inc_date:
        out.append(f"on the portal since {s.since}, before this company was incorporated on {c.inc_date}")
    return out


def name_agreement(s: Startup, c: Company) -> str:
    """How the best of the startup's names compares with the company's, as MCA would see it:
    "same"            the same name to MCA (spacing, plural, "The", "Company", the legal form ignored)
    "typo"            the same but for one slip of spelling in one distinctive word
    "generic_differs" the distinctive words agree but a generic word differs ("Holdings" against
                      "Technologies"); MCA registers these as two companies, so a person decides
    "different"       anything else"""
    ck = normalize_name(c.name)
    best = "different"
    for _, _, k in s.name_keys():
        v = _agreement(k, ck)
        if _RANK[v] < _RANK[best]:
            best = v
    return best


_RANK = {"same": 0, "typo": 1, "generic_differs": 2, "different": 3}


def _words(k) -> list[tuple[str, str, bool]]:
    """(word as MCA compares it, word as written, generic?) for each word that counts."""
    kept = [t for t in k.tokens if t not in IGNORABLE] or list(k.tokens)
    return [(canonical(t), t, is_generic(t)) for t in kept]


def _slip(x, y) -> bool:
    """Two distinctive words one slip of spelling apart, before or after the plural is folded."""
    return not x[2] and not y[2] and (typo_of(x[1], y[1]) or typo_of(x[0], y[0]))


def _agreement(a, b) -> str:
    if a.ident and a.ident == b.ident:
        return "same"
    A, B = _words(a), _words(b)
    if not A or not B:
        return "different"
    if len(A) == len(B):
        slips = [(x, y) for x, y in zip(A, B) if x[0] != y[0]]
        if len(slips) == 1 and _slip(*slips[0]):
            return "typo"
    elif typo_of(a.ident, b.ident):
        return "typo"                     # spacing differs as well as one letter: "Vastusmaart" / "Vastu Smart"
    dA, dB = [w for w in A if not w[2]], [w for w in B if not w[2]]
    if dA and len(dA) == len(dB):
        slips = [(x, y) for x, y in zip(dA, dB) if x[0] != y[0]]
        if not slips or (len(slips) == 1 and _slip(*slips[0])):
            return "generic_differs"
    if dA and dB and "".join(w[0] for w in dA) == "".join(w[0] for w in dB):
        return "generic_differs"
    return "different"


def names_consistent(s: Startup, c: Company) -> bool:
    """True when the names are the same name to MCA, or the same but for one slip of spelling."""
    return name_agreement(s, c) in ("same", "typo")


def forms_agree(s: Startup, c: Company) -> bool:
    """A legal form the founder stated must be the company's; "Pvt Ltd" against a one person company
    or a public "Limited" is a different registered name."""
    return not s.stated_forms or c.form is None or c.form in s.stated_forms


def year_agrees(s: Startup, c: Company) -> bool | None:
    """The founder's own year of establishment against the year of incorporation. None when either
    is unknown. The founder's year can be the year the business began, a little before
    incorporation, so one year either way counts. The portal listing date is deliberately not used
    here: see listed_soon_after."""
    if not s.year or not c.inc_year:
        return None
    return abs(s.year - c.inc_year) <= 1


def listed_soon_after(s: Startup, c: Company) -> bool | None:
    """True when the startup was listed on the portal within ~18 months after incorporation: the
    listing dates the company. None otherwise (listing earlier is a contradiction; listing years
    later says nothing)."""
    if not s.since or not c.inc_date:
        return None
    try:
        inc = date.fromisoformat(c.inc_date[:10])
        since = date.fromisoformat(s.since[:10])
    except ValueError:
        return None
    return True if inc <= since <= inc + timedelta(days=WINDOW_DAYS) else None


def startup_divisions(s: Startup) -> set:
    out = set()
    for v in (s.sector, *str(s.industry or "").split(",")):
        out |= SECTOR_DIVISIONS.get(str(v or "").strip(), set())
    return out


def sector_agrees(s: Startup, c: Company) -> bool | None:
    divisions = startup_divisions(s)
    if not divisions or not c.nic_division:
        return None
    return c.nic_division in divisions


def domain_agrees(s: Startup, c: Company) -> bool | None:
    """True when the startup's own website is named like the company ("vezras.in" for VEZRAS
    TECHNOLOGIES PRIVATE LIMITED): a second, separately typed spelling of the registered name.
    None otherwise; a brand domain is no evidence against."""
    d = company_domain(s.website)
    if not d:
        return None
    label = d.split(".")[0].replace("-", "")
    ck = normalize_name(c.name)
    if len(label) >= 4 and (label in (ck.key, ck.ident) or (len(label) >= 5 and label in ck.core)):
        return True
    return None


def independent_evidence(s: Startup, c: Company) -> tuple[bool, dict]:
    """Agreement beyond the name. The founder's year decides when it is given; without it, a listing
    soon after incorporation counts only together with a sector or a website that fits."""
    ev = {"founder_year_agrees": year_agrees(s, c), "listed_soon_after_incorporation": listed_soon_after(s, c),
          "sector_fits_nic": sector_agrees(s, c), "website_fits_name": domain_agrees(s, c)}
    if ev["founder_year_agrees"] is not None:
        return ev["founder_year_agrees"], ev
    return bool(ev["listed_soon_after_incorporation"] and (ev["sector_fits_nic"] or ev["website_fits_name"])), ev


# ---- exact ----------------------------------------------------------------------------------------

def exact_candidates(s: Startup, index: CompanyIndex) -> list[Candidate]:
    """Exact registered-name matches, plus the same name under another legal form (an LLP or OPC
    that converted into a private limited company keeps its name but changes its form and CIN).
    The second kind is never linked automatically; it goes to a person."""
    out, seen = [], {}
    for clean, form, k in s.name_keys():
        if not form:
            continue      # a bare brand name with no entity type is not a registered name
        for c in index.by_exact.get((clean, form), []):
            if c.id in seen:
                seen[c.id].evidence["form_in_name"] |= bool(k.legal_form)
                continue
            seen[c.id] = Candidate(c.id, 1.0, "exact_name", {"name": c.name, "matched_on": "registered name and legal form",
                                                             "form_in_name": bool(k.legal_form)})
            out.append(seen[c.id])
    for clean, form, _ in s.name_keys():
        for c in index.by_clean.get(clean, []):
            if c.id not in seen and form and c.form and form != c.form:
                seen[c.id] = Candidate(c.id, 0.5, "same_name", {"name": c.name, "matched_on": "same name, different legal form"})
                out.append(seen[c.id])
    return out


def variant_candidates(s: Startup, index: CompanyIndex) -> list[Candidate]:
    """The same name in another spelling ("Shri Lakshmi Agro" and "Sree Laxmi Agro"), with the same legal form
    or none given. Never linked automatically: a person sees the two side by side."""
    out, seen = [], set()
    for clean, form, _ in s.name_keys():
        for c in index.by_variant.get(variant_key(clean), []):
            if c.id in seen or c.clean == clean or (form and c.form and form != c.form):
                continue
            seen.add(c.id)
            out.append(Candidate(c.id, 0.5, "variant_name", {"name": c.name, "matched_on": "the same name in another spelling"}))
    return out


# ---- Splink ---------------------------------------------------------------------------------------
#
# One comparison of the name, with ordered levels, so one fact is counted once (the first version
# compared the name twice and counted an equal set of distinctive words as 43 bits of evidence).
# Term frequency: "same distinctive words" is split by how many companies share those words, so a
# name shared by three companies counts for much less than a unique one. (Splink's own term-frequency
# adjustment estimates a value's chance as its share of the table, 1/12,700 for a name seen once,
# which would make even a unique name nearly worthless at this prior.)
#
# Nothing is trained by random sampling. u (how often two unrelated records land in a level) is
# counted exactly: for the close-name levels over every blocked pair (pairs outside the blocks are
# not that close), divided by all possible pairs, plus one pseudo-count; for legal form, year and
# sector from the values' frequencies on each side. The same input gives the same model on every run,
# and the model does not change character as the company universe grows. m (how often a true match
# lands in a level) starts from the priors below and, once enough people have labelled pairs, is
# re-estimated from the "same" labels blended with those priors.

NAME_LEVELS = [
    ("identical names", "name_clean_l = name_clean_r"),
    ("the same name to MCA", "ident_l = ident_r"),
    ("same distinctive words, no other company has them", "name_key_l = name_key_r AND coalesce(key_companies_l, key_companies_r) <= 1"),
    ("same distinctive words, shared by several companies", "name_key_l = name_key_r"),
    ("distinctive words nearly equal", "jaro_winkler_similarity(name_key_l, name_key_r) >= 0.96"),
    ("distinctive words similar", "jaro_winkler_similarity(name_key_l, name_key_r) >= 0.92"),
    ("same rarest word", "rare_token_l = rare_token_r"),
    ("rarest word of one name is in the other",
     "list_contains(core_tokens_r, rare_token_l) OR list_contains(core_tokens_l, rare_token_r)"),
    ("rarest words one edit apart", "levenshtein(rare_token_l, rare_token_r) <= 1"),
]
NAME_NULL = "name_key_l IS NULL OR name_key_r IS NULL OR name_key_l = '' OR name_key_r = ''"
NAME_M = [0.10, 0.35, 0.15, 0.02, 0.13, 0.08, 0.05, 0.04, 0.04, 0.04]           # the last is "all other"
FORM_M = [0.85, 0.15]
YEAR_M = [0.70, 0.25, 0.05]
NIC_M = [0.55, 0.45]
NIC_NULL = "coalesce(divisions_l, divisions_r) IS NULL OR coalesce(nic_division_l, nic_division_r) IS NULL"
NIC_AGREE = "list_contains(coalesce(divisions_l, divisions_r), coalesce(nic_division_l, nic_division_r))"
# When the startup was listed against when the company was incorporated: soon after is what a new
# company does; before is what a different company (or a conversion) looks like; years later says little.
LISTED_NULL = "coalesce(since_l, since_r) IS NULL OR coalesce(inc_date_l, inc_date_r) IS NULL"
LISTED_LEVELS = [
    f"date_diff('day', coalesce(inc_date_l, inc_date_r), coalesce(since_l, since_r)) BETWEEN 0 AND {WINDOW_DAYS}",
    "coalesce(since_l, since_r) < coalesce(inc_date_l, inc_date_r)",
]
LISTED_M = [0.60, 0.05, 0.35]


def _rare(tokens, df) -> str | None:
    """The name's most distinctive word: the one fewest names share (ties go to the longer word).
    "Book My Saarthi" -> "saarthi", so it is no longer close to "Book My Studio"."""
    return min(tokens, key=lambda t: (df.get(t, 0), -len(t))) if tokens else None


def _deletion_keys(token: str | None) -> list | None:
    """The word and every one-letter deletion of it: two words one edit apart share one of these, so
    a typo anywhere in the rarest word still lands the pair in a block."""
    if not token:
        return None
    if len(token) < 4:
        return [token]
    return sorted({token} | {token[:i] + token[i + 1:] for i in range(len(token))})


def _schema():
    import pyarrow as pa
    return pa.schema([
        ("uid", pa.string()), ("entity_key", pa.string()), ("name_clean", pa.string()), ("ident", pa.string()),
        ("name_key", pa.string()), ("rare_token", pa.string()), ("rare_dels", pa.list_(pa.string())),
        ("core_tokens", pa.list_(pa.string())), ("key_companies", pa.int64()), ("legal_form", pa.string()),
        ("inc_year", pa.int64()), ("divisions", pa.list_(pa.string())), ("nic_division", pa.string()),
        ("since", pa.date32()), ("inc_date", pa.date32()),
    ])


def _day(v) -> date | None:
    try:
        return date.fromisoformat(str(v)[:10]) if v else None
    except ValueError:
        return None


def _rows_left(startups, df):
    rows = []
    for s in startups:
        if not s.is_registered_entity:
            continue
        divisions = sorted(startup_divisions(s)) or None
        for i, (clean, form, k) in enumerate(s.name_keys()):
            core = list(k.core or k.tokens)
            rare = _rare(core, df)
            rows.append({"uid": f"{s.key}#{i}", "entity_key": s.key, "name_clean": clean, "ident": k.ident,
                         "name_key": k.key, "rare_token": rare, "rare_dels": _deletion_keys(rare), "core_tokens": core,
                         "key_companies": None, "legal_form": form, "inc_year": s.year,
                         "divisions": divisions, "nic_division": None, "since": _day(s.since), "inc_date": None})
    return rows


def _rows_right(index: CompanyIndex, df):
    rows = []
    for c in index.by_id.values():
        core = list(c.core or c.clean.split())
        rare = _rare(core, df)
        rows.append({"uid": c.id, "entity_key": c.id, "name_clean": c.clean, "ident": normalize_name(c.name).ident,
                     "name_key": c.key, "rare_token": rare, "rare_dels": _deletion_keys(rare), "core_tokens": core,
                     "key_companies": len(index.by_key.get(c.key, ())), "legal_form": c.form, "inc_year": c.inc_year,
                     "divisions": None, "nic_division": c.nic_division, "since": None, "inc_date": _day(c.inc_date)})
    return rows


def token_frequencies(index: CompanyIndex, startups) -> dict:
    df = defaultdict(int)
    for c in index.by_id.values():
        for t in set(c.core or c.clean.split()):
            df[t] += 1
    for s in startups:
        for _, _, k in s.name_keys():
            for t in set(k.core or k.tokens):
                df[t] += 1
    return df


_BLOCKS = [
    "l.name_key = r.name_key",
    "substr(l.name_key, 1, 4) = substr(r.name_key, 1, 4)",
]
_EXPLODED_BLOCKS = ["core_tokens", "rare_dels"]


def _blocked_pairs_sql() -> str:
    """Every (startup row, company row) pair the blocking rules below produce, as SQL over tables
    `l` and `r`. Used to count u exactly; it must stay in step with splink_settings."""
    parts = [f"select l.uid as uid_l, r.uid as uid_r from l join r on {cond} where l.name_key <> '' and r.name_key <> ''"
             for cond in _BLOCKS]
    for col in _EXPLODED_BLOCKS:
        parts.append(f"select a.uid as uid_l, b.uid as uid_r from (select uid, unnest({col}) as v from l) a "
                     f"join (select uid, unnest({col}) as v from r) b on a.v = b.v")
    return " union ".join(parts)


def _case(levels: list[str], null_sql: str) -> str:
    """The level number of a pair, as Splink orders them: -1 null, then the levels best first."""
    n = len(levels)
    whens = " ".join(f"when {cond} then {n - i}" for i, cond in enumerate(levels))
    return f"case when {null_sql} then -1 {whens} else 0 end"


def _pairs_with_columns(pairs_sql: str) -> str:
    cols = [f.name for f in _schema()]
    sel = ", ".join([f"l.{c} as {c}_l" for c in cols] + [f"r.{c} as {c}_r" for c in cols])
    return f"select {sel} from ({pairs_sql}) p join l on l.uid = p.uid_l join r on r.uid = p.uid_r"


def _counts(con, pairs_sql: str, levels: list[str], null_sql: str) -> dict[int, int]:
    q = f"select {_case(levels, null_sql)} as g, count(*) from ({_pairs_with_columns(pairs_sql)}) group by 1"
    return {int(g): int(n) for g, n in con.execute(q).fetchall()}


def _marginal_u(left: list, right: list, agree) -> float:
    """P(two unrelated records agree) from the frequency of each value on each side."""
    lv = defaultdict(int)
    for v in left:
        lv[v if not isinstance(v, list) else tuple(v)] += 1
    rv = defaultdict(int)
    for v in right:
        rv[v] += 1
    nl, nr = sum(lv.values()), sum(rv.values())
    if not nl or not nr:
        return 0.5
    hits = sum(a * b for x, a in lv.items() for y, b in rv.items() if agree(x, y))
    return min(max(hits / (nl * nr), 1e-6), 1 - 1e-6)


def estimate_u(left: list[dict], right: list[dict], con) -> dict:
    """The u values of every comparison, counted rather than sampled (see the note above)."""
    n_l = sum(1 for r in left if r["name_key"])
    n_r = sum(1 for r in right if r["name_key"])
    total = max(n_l * n_r, 1)
    counts = _counts(con, _blocked_pairs_sql(), [c for _, c in NAME_LEVELS], NAME_NULL)
    n = len(NAME_LEVELS)
    name_u = [(counts.get(n - i, 0) + 1) / total for i in range(n)]
    name_u.append(max(1 - sum(name_u), 1e-6))
    forms_l = [r["legal_form"] for r in left if r["legal_form"]]
    forms_r = [r["legal_form"] for r in right if r["legal_form"]]
    years_l = [r["inc_year"] for r in left if r["inc_year"]]
    years_r = [r["inc_year"] for r in right if r["inc_year"]]
    div_l = [r["divisions"] for r in left if r["divisions"]]
    div_r = [r["nic_division"] for r in right if r["nic_division"]]
    u_form = _marginal_u(forms_l, forms_r, lambda a, b: a == b)
    u_y0 = _marginal_u(years_l, years_r, lambda a, b: a == b)
    u_y1 = _marginal_u(years_l, years_r, lambda a, b: abs(a - b) == 1)
    u_nic = _marginal_u(div_l, div_r, lambda a, b: b in a)
    since_l = [r["since"] for r in left if r["since"]]
    inc_r = [r["inc_date"] for r in right if r["inc_date"]]
    u_soon = _marginal_u(since_l, inc_r, lambda a, b: 0 <= (a - b).days <= WINDOW_DAYS)
    u_before = _marginal_u(since_l, inc_r, lambda a, b: a < b)
    return {"name": name_u, "legal_form": [u_form, 1 - u_form], "inc_year": [u_y0, u_y1, max(1 - u_y0 - u_y1, 1e-6)],
            "nic": [u_nic, 1 - u_nic], "listed": [u_soon, u_before, max(1 - u_soon - u_before, 1e-6)],
            "blocked_pairs": sum(counts.values()), "total_pairs": total,
            "blocked_by_level": {NAME_LEVELS[n - g][0] if g > 0 else ("all other" if g == 0 else "null"): c
                                 for g, c in sorted(counts.items(), reverse=True)}}


def _blend(prior: list[float], counts: list[int]) -> list[float]:
    n = sum(counts)
    return [(c + LABEL_PSEUDO * p) / (n + LABEL_PSEUDO) for p, c in zip(prior, counts)]


def estimate_m(con, label_pairs_sql: str) -> dict:
    """m from the labelled "same" pairs that joined, blended with the priors."""
    def counts(levels, null_sql, prior):
        got = _counts(con, label_pairs_sql, levels, null_sql)
        n = len(levels)
        return _blend(prior, [got.get(n - i, 0) for i in range(n)] + [got.get(0, 0)])
    return {"name": counts([c for _, c in NAME_LEVELS], NAME_NULL, NAME_M),
            "legal_form": counts(["legal_form_l = legal_form_r"], "legal_form_l IS NULL OR legal_form_r IS NULL", FORM_M),
            "inc_year": counts(["inc_year_l = inc_year_r", "abs(inc_year_l - inc_year_r) <= 1"],
                               "inc_year_l IS NULL OR inc_year_r IS NULL", YEAR_M),
            "nic": counts([NIC_AGREE], NIC_NULL, NIC_M),
            "listed": counts(LISTED_LEVELS, LISTED_NULL, LISTED_M)}


PRIOR_M = {"name": NAME_M, "legal_form": FORM_M, "inc_year": YEAR_M, "nic": NIC_M, "listed": LISTED_M}


def splink_settings(prior: float, m: dict | None = None, u: dict | None = None):
    import splink.comparison_level_library as cll
    import splink.comparison_library as cl
    from splink import SettingsCreator, block_on

    m = m or PRIOR_M
    u = u or {"name": [1e-6] * len(NAME_LEVELS) + [1 - 1e-6 * len(NAME_LEVELS)], "legal_form": [0.8, 0.2],
              "inc_year": [0.2, 0.2, 0.6], "nic": [0.3, 0.7], "listed": [0.1, 0.6, 0.3]}
    name = cl.CustomComparison(output_column_name="name", comparison_levels=[
        cll.CustomLevel(NAME_NULL).configure(is_null_level=True),
        *[cll.CustomLevel(sql, label_for_charts=label) for label, sql in NAME_LEVELS],
        cll.ElseLevel()]).configure(m_probabilities=m["name"], u_probabilities=u["name"])
    form = cl.CustomComparison(output_column_name="legal_form", comparison_levels=[
        cll.NullLevel("legal_form"), cll.ExactMatchLevel("legal_form"), cll.ElseLevel()]).configure(
        m_probabilities=m["legal_form"], u_probabilities=u["legal_form"])
    year = cl.CustomComparison(output_column_name="inc_year", comparison_levels=[
        cll.NullLevel("inc_year"), cll.ExactMatchLevel("inc_year"), cll.AbsoluteDifferenceLevel("inc_year", 1),
        cll.ElseLevel()]).configure(m_probabilities=m["inc_year"], u_probabilities=u["inc_year"])
    nic = cl.CustomComparison(output_column_name="nic", comparison_levels=[
        cll.CustomLevel(NIC_NULL).configure(is_null_level=True),
        cll.CustomLevel(NIC_AGREE, label_for_charts="sector fits the NIC division"),
        cll.ElseLevel()]).configure(m_probabilities=m["nic"], u_probabilities=u["nic"])
    listed = cl.CustomComparison(output_column_name="listed", comparison_levels=[
        cll.CustomLevel(LISTED_NULL).configure(is_null_level=True),
        cll.CustomLevel(LISTED_LEVELS[0], label_for_charts="listed within 18 months after incorporation"),
        cll.CustomLevel(LISTED_LEVELS[1], label_for_charts="listed before incorporation"),
        cll.ElseLevel()]).configure(m_probabilities=m["listed"], u_probabilities=u["listed"])
    return SettingsCreator(
        link_type="link_only",
        unique_id_column_name="uid",
        probability_two_random_records_match=prior,
        comparisons=[name, form, year, nic, listed],
        # equal distinctive words; a shared distinctive word; a typo anywhere in the rarest word (its
        # deletion keys meet); the same first letters of the distinctive words. Generic words are never
        # blocked on: "...technologies" against every "...technologies" was 99% of all pairs.
        blocking_rules_to_generate_predictions=[
            block_on("name_key"), block_on("core_tokens", arrays_to_explode=["core_tokens"]),
            block_on("rare_dels", arrays_to_explode=["rare_dels"]), block_on("substr(name_key, 1, 4)")],
        retain_intermediate_calculation_columns=False,
        additional_columns_to_retain=["entity_key"],
    )


def production_prior(startups: dict[str, Startup], index: CompanyIndex, exact: dict[str, list]) -> float:
    """P(a startup name row and a company are the same), as the nightly run sets it: a quarter as many
    fuzzy links as exact ones are expected among the startups without an exact name. The self-tests
    use this same value, so they measure the matcher as it runs."""
    rest = [s for k, s in startups.items() if not exact.get(k) and s.is_registered_entity]
    rows = sum(len(s.name_keys()) for s in rest)
    expected = max(10, int(sum(1 for v in exact.values() if v) * 0.25))
    return min(0.5, expected / (max(rows, 1) * max(len(index.by_id), 1)))


def label_rows(startups: dict[str, Startup], index: CompanyIndex, labels: list[dict]) -> list[tuple[str, str]]:
    """(left uid, company id) for each labelled "same" pair: the left row is the startup name closest
    to the company's (the pair may have matched on the second name), not always the first."""
    from difflib import SequenceMatcher
    out = []
    for lab in labels:
        s, c = startups.get(lab["entity_key"]), index.by_id.get(lab["company_id"])
        if not s or not c or not s.is_registered_entity:
            continue
        keys = s.name_keys()
        if not keys:
            continue
        best = max(range(len(keys)), key=lambda i: (keys[i][0] == c.clean, SequenceMatcher(None, keys[i][0], c.clean).ratio(), -i))
        out.append((f"{s.key}#{best}", c.id))
    return out


def _tables(startups: list[Startup], index: CompanyIndex):
    import pyarrow as pa
    df = token_frequencies(index, startups)
    left, right = _rows_left(startups, df), _rows_right(index, df)
    return left, right, pa.Table.from_pylist(left, schema=_schema()), pa.Table.from_pylist(right, schema=_schema())


def fit(startups: list[Startup], index: CompanyIndex, *, prior: float, labels: list[dict] | None = None,
        label_startups: dict[str, Startup] | None = None, _tabled=None) -> dict:
    """The model's parameters (prior, u, m) for these startups against this company universe, without
    scoring anything. The self-tests score their invented startups with the parameters fitted on the
    real ones, so they measure the model as it runs (u counted over invented near-copies of real
    names would say close names are common, and nothing would ever match)."""
    import duckdb
    import pyarrow as pa
    left, right, tl, tr = _tabled or _tables(startups, index)
    if not left or not right:
        return {"prior": prior, "u": None, "m": None, "labels_joined": 0, "blocked_pairs": 0}
    con = duckdb.connect()
    con.register("l", tl)
    con.register("r", tr)
    u = estimate_u(left, right, con)
    m, joined = None, 0
    if labels:
        by_key = {s.key: s for s in startups} | (label_startups or {})
        left_uids = {r["uid"] for r in left}
        pairs = [(lu, cid) for lu, cid in label_rows(by_key, index, labels) if lu in left_uids]
        joined = len(pairs)
        if joined >= MIN_LABELS:
            con.register("labelled", pa.Table.from_pylist([{"uid_l": a, "uid_r": b} for a, b in pairs]))
            m = estimate_m(con, "select uid_l, uid_r from labelled")
    con.close()
    return {"prior": prior, "u": {k: u[k] for k in PRIOR_M}, "m": m, "labels_given": len(labels or []),
            "labels_joined": joined, "blocked_pairs": u["blocked_pairs"]}


def splink_candidates(startups: list[Startup], index: CompanyIndex, *, prior: float | None = None,
                      expected_links: int | None = None, labels: list[dict] | None = None,
                      label_startups: dict[str, Startup] | None = None, params: dict | None = None,
                      log=print) -> tuple[dict, dict]:
    """Splink scores for every blocked (startup, company) pair. Returns
    ({entity_key: [Candidate, ...]}, model summary). The parameters are fitted on these startups
    unless `params` (from `fit`) is given. `labels` are labelled "same" pairs
    ({"entity_key", "company_id"}); only those whose startup row and company are in this run count."""
    from splink import Linker
    from splink.backends.duckdb import DuckDBAPI

    left, right, tl, tr = tabled = _tables(startups, index)
    if not left or not right:
        return {}, {"pairs_scored": 0}
    if params is None:
        if prior is None:
            prior = min(0.5, max(expected_links or 1, 1) / (len(left) * len(right)))
        params = fit(startups, index, prior=prior, labels=labels, label_startups=label_startups, _tabled=tabled)
    prior, u, m = params["prior"], params["u"], params["m"]
    joined = params.get("labels_joined", 0)
    db_api = DuckDBAPI()
    sl = db_api.register(tl, dataset_display_name="startups")
    sr = db_api.register(tr, dataset_display_name="companies")
    linker = Linker([sl, sr], splink_settings(prior, m, u), log_level=30)
    preds = linker.inference.predict(threshold_match_probability=CANDIDATE_P).as_record_list()
    best = defaultdict(dict)
    for p in preds:
        ek, cid = p["entity_key_l"], p["uid_r"]
        if p["source_dataset_l"] != "startups":     # Splink may put either table on the left
            ek, cid = p["entity_key_r"], p["uid_l"]
        prob = float(p["match_probability"])
        if prob > best[ek].get(cid, (0.0, None))[0]:
            best[ek][cid] = (prob, p)
    out = {}
    for ek, cands in best.items():
        out[ek] = sorted((Candidate(cid, prob, "splink", {"name": index.by_id[cid].name, "match_weight": round(float(p["match_weight"]), 2)},
                                    weight=float(p["match_weight"]))
                          for cid, (prob, p) in cands.items()), key=lambda c: (-c.probability, c.company_id))
    model = {"version": MODEL_VERSION, "prior": prior, "pairs_scored": len(preds), "blocked_pairs": params.get("blocked_pairs"),
             "labels_given": params.get("labels_given", 0), "labels_joined": joined, "m_from_labels": m is not None,
             "u": u, "m": m or PRIOR_M}
    return out, model


def production_params(startups: dict[str, Startup], index: CompanyIndex, *, labels: list[dict] | None = None) -> dict:
    """The parameters the nightly run would fit: on the startups without an exact name, at the
    production prior."""
    exact = {k: exact_candidates(s, index) for k, s in startups.items()}
    rest = [s for k, s in startups.items() if not exact[k]]
    return fit(rest, index, prior=production_prior(startups, index, exact), labels=labels, label_startups=startups)


# ---- decisions -----------------------------------------------------------------------------------

_METHOD_ORDER = {"exact_name": 0, "same_name": 1, "variant_name": 1}


def decide(s: Startup, index: CompanyIndex, exact: list[Candidate], fuzzy: list[Candidate],
           reviews: dict[str, dict]) -> Decision:
    """One startup's link. `reviews` maps company_id -> a person's decision on this pair."""
    if not s.is_registered_entity:
        return Decision(s.key, "unlinked", evidence={"reason": f"a {s.entity_type.lower()} has no CIN or LLPIN"})
    same = sorted({cid for cid, r in reviews.items() if r["decision"] == "same"})
    if same:
        held = [cid for cid in same if cid in index.by_id]
        if len(same) == 1 and held:
            cid = same[0]
            return Decision(s.key, "linked", cid, "manual", 1.0, evidence={"reviewed_by": reviews[cid]["decided_by"]},
                            decided_by=reviews[cid]["decided_by"])
        why = (f"reviewers linked this startup to several companies ({', '.join(same)})" if len(same) > 1 else
               f"a reviewer linked this startup to {same[0]}, which is no longer among the companies we hold")
        return Decision(s.key, "review", None, "review", None, [], {"why_review": why, "reviewed_same": same})
    rejected = {cid for cid, r in reviews.items() if r["decision"] == "different"}
    unsure = {cid for cid, r in reviews.items() if r["decision"] == "unsure"}

    pool = {}
    for c in exact + fuzzy:
        if c.company_id in index.by_id:
            pool.setdefault(c.company_id, c)     # exact first, so it wins over a Splink score for the same pair
    # ties are broken by CIN, so a rebuild on the same data writes the same document
    ranked = sorted(pool.values(), key=lambda c: (_METHOD_ORDER.get(c.method, 2), -c.probability, c.company_id))
    cands = [c for c in ranked if c.company_id not in rejected]
    shown = [_show(s, index.by_id[c.company_id], c) for c in cands[:3]]
    if not cands:
        why = "every candidate was rejected by a reviewer" if rejected else "no company with a similar name in the CIN universe we hold"
        return Decision(s.key, "unlinked", evidence={"reason": why})

    top = cands[0]
    c = index.by_id[top.company_id]
    against = contradictions(s, c)
    beyond, beyond_ev = independent_evidence(s, c)
    # the runner-up includes candidates a reviewer rejected: rejecting the closest name says nothing
    # in favour of the next one, which must still be far ahead of it
    others = [x for x in ranked if x.company_id != top.company_id]
    runner_up = max((x.probability for x in others), default=0.0)
    runner_w = max((x.weight for x in others), default=-math.inf)
    ev = {"name": c.name, "contradictions": against, "year_agrees": beyond_ev["founder_year_agrees"], **beyond_ev,
          "runner_up_p": round(runner_up, 4)}
    if rejected:
        ev["rejected_by_reviewer"] = sorted(rejected)

    if possible_conversion(s, c):
        ev["why_review"] = "same name: probably an LLP that converted into a company; confirm before linking"
        ev["possible_conversion"] = True
        return Decision(s.key, "review", None, "review", round(top.probability, 6), shown, ev)

    if top.method == "same_name":
        ev["why_review"] = "same name under another legal form; confirm it is the same business"
        return Decision(s.key, "review", None, "review", None, shown, ev)

    if top.method == "variant_name":
        ev["why_review"] = "the same name in another spelling (Shri and Shree, Lakshmi and Laxmi); confirm it is the same business"
        return Decision(s.key, "review", None, "review", None, shown, ev)

    if top.company_id in unsure:
        ev["why_review"] = "a reviewer was unsure about this pair; it is never linked automatically"
        return Decision(s.key, "review", None, "review", round(top.probability, 6), shown, ev)

    if top.method == "exact_name":
        exact_ids = [x for x in cands if x.method == "exact_name"]
        written = top.evidence.get("form_in_name", True)
        dated = beyond_ev["founder_year_agrees"] is True or beyond_ev["listed_soon_after_incorporation"] is True
        if len(exact_ids) == 1 and not against and beyond_ev["founder_year_agrees"] is not False and (written or dated):
            return Decision(s.key, "linked", c.id, "exact_name", 1.0, shown, ev)
        ev["why_review"] = ("; ".join(against) or
                            ("the founder's year of establishment is more than a year from incorporation"
                             if beyond_ev["founder_year_agrees"] is False else
                             "several exact names" if len(exact_ids) > 1 else
                             "the name carries no legal form, so it may be a brand; nothing dates it to this company"))
        return Decision(s.key, "review", None, "review", 1.0, shown, ev)

    agreement = name_agreement(s, c)
    margin = top.weight - runner_w
    ev |= {"names_consistent": agreement in ("same", "typo"), "name_agreement": agreement,
           "forms_agree": forms_agree(s, c), "margin_bits": None if math.isinf(margin) else round(margin, 2)}
    if (top.probability >= LINK_P and agreement in ("same", "typo") and ev["forms_agree"] and not against
            and beyond and margin >= MARGIN_BITS):
        return Decision(s.key, "linked", c.id, "splink", round(top.probability, 6), shown, ev)
    if (top.probability >= REVIEW_P and not against) or (same_core_name(s, c) and top.probability >= CANDIDATE_P) \
            or (agreement in ("same", "typo") and not against):
        ev["why_review"] = "; ".join(against) or _why_not_linked(top, agreement, ev, beyond_ev, margin, bool(rejected))
        return Decision(s.key, "review", None, "review", round(top.probability, 6), shown, ev)
    return Decision(s.key, "unlinked", None, None, round(top.probability, 6), shown,
                    {"reason": "best candidate too weak or contradicted", **ev})


def _why_not_linked(top, agreement, ev, beyond_ev, margin, rejected) -> str:
    if agreement == "generic_differs":
        return "the distinctive words agree but a generic word differs; MCA registers those as two companies"
    if agreement == "different":
        return "a distinctive word in one name is missing from the other"
    if not ev["forms_agree"]:
        return "the legal form in the name differs from the company's"
    if beyond_ev["founder_year_agrees"] is False:
        return "the founder's year of establishment is more than a year from incorporation"
    if beyond_ev["founder_year_agrees"] is None and not (beyond_ev["listed_soon_after_incorporation"]
                                                          and (beyond_ev["sector_fits_nic"] or beyond_ev["website_fits_name"])):
        return "nothing beyond the name agrees: no founder year, and no sector or website that fits a recent listing"
    if top.probability < LINK_P:
        return "probability below the automatic threshold"
    if rejected and margin < MARGIN_BITS:
        return "a reviewer rejected a close candidate; this one is not far enough ahead of it"
    return "a second candidate is close"


def _show(s: Startup, c: Company, cand: Candidate) -> dict:
    out = {"company_id": c.id, "name": c.name, "incorporated": c.inc_date, "probability": round(cand.probability, 6),
           "method": cand.method, "contradictions": contradictions(s, c), "year_agrees": year_agrees(s, c)}
    if not math.isinf(cand.weight):
        out["match_weight"] = round(cand.weight, 2)
    return out


def one_to_one(decisions: dict[str, Decision], index: CompanyIndex) -> int:
    """A company is one startup. Two portal entries with the same registered name (an exact or a
    manual link) are one startup listed twice and both keep the link; a Splink link to a company that
    another startup also claims goes to a person. Returns the number of links sent to review."""
    claims = defaultdict(list)
    for k, d in decisions.items():
        if d.status == "linked":
            claims[d.company_id].append(k)
    n = 0
    for cid, keys in claims.items():
        if len(keys) < 2:
            continue
        for k in keys:
            d = decisions[k]
            if d.method != "splink":
                continue
            others = sorted(x for x in keys if x != k)
            d.evidence["why_review"] = (f"{index.by_id[cid].name} is also linked to {', '.join(others)}; "
                                        "one company is one startup unless a person says otherwise")
            d.evidence["also_claimed_by"] = others
            d.status, d.company_id, d.method = "review", None, "review"
            n += 1
    return n


# ---- the nightly run -------------------------------------------------------------------------------

def holdout(entity_key: str) -> bool:
    """One labelled startup in five is held out: never used to train m, so precision measured on it
    is honest. Fixed by the key, so the split never moves."""
    return int(hashlib.sha1(entity_key.encode()).hexdigest(), 16) % 5 == 0


def training_labels(db) -> list[dict]:
    """Labelled "same" pairs for re-estimating m. Only "same": Splink 5's estimate_m_from_pairwise_labels
    treats every row it is given as a match, so the first version taught the model that unrelated
    names were matches. The held-out fold is left out."""
    return [{"entity_key": r["entity_key"], "company_id": r["company_id"]}
            for r in db.match_reviews.find({"entity_type": "startup", "decision": "same"},
                                           {"entity_key": 1, "company_id": 1})
            if not holdout(r["entity_key"])]


def match_all(startups: dict[str, Startup], index: CompanyIndex, *, reviews: dict | None = None,
              labels: list[dict] | None = None, use_splink: bool = True, prior: float | None = None,
              log=print) -> tuple[dict, dict, dict]:
    """Decides every startup twice: with the reviewers' decisions (what is written) and without them
    (the matcher's own decision, which precision is measured on). Returns (decisions, own, model)."""
    reviews = reviews or {}
    exact = {k: exact_candidates(s, index) for k, s in startups.items()}
    fuzzy, model = {}, {"pairs_scored": 0}
    if use_splink:
        rest = [s for k, s in startups.items() if not exact[k]]
        fuzzy, model = splink_candidates(rest, index, prior=prior if prior is not None else production_prior(startups, index, exact),
                                         labels=labels, label_startups=startups, log=log)
    # spelling variants only feed the review queue; a startup with an exact name does not need them
    variants = {k: [] if exact[k] else variant_candidates(s, index) for k, s in startups.items()}
    # (ahead of Splink's score for the same pair, so a weak score cannot hide the spelling from a person)
    decisions = {k: decide(s, index, exact[k], variants[k] + fuzzy.get(k, []), reviews.get(k, {})) for k, s in startups.items()}
    own = {k: decide(s, index, exact[k], variants[k] + fuzzy.get(k, []), {}) for k, s in startups.items()}
    model["one_to_one_sent_to_review"] = one_to_one(decisions, index)
    one_to_one(own, index)
    return decisions, own, model


def run(db, startups: dict[str, Startup], *, log=print, use_splink: bool = True, extra_companies=()) -> dict:
    """Matches every startup and writes entity_links. Returns run statistics."""
    index = CompanyIndex.load(db, extra=list(extra_companies))
    reviews = defaultdict(dict)
    for r in db.match_reviews.find({"entity_type": "startup"}):
        reviews[r["entity_key"]][r["company_id"]] = r
    decisions, own, model = match_all(startups, index, reviews=reviews, labels=training_labels(db) if use_splink else None,
                                      use_splink=use_splink, log=log)
    now = datetime.now(timezone.utc)
    stats = defaultdict(int)
    ops = []
    from pymongo import ReplaceOne
    existing = {d["_id"]: d for d in db.entity_links.find({"entity_type": "startup"})}
    for k, d in decisions.items():
        stats[f"{d.status}"] += 1
        if d.method:
            stats[f"{d.status}_{d.method}"] += 1
        m = own[k]
        doc = {"_id": f"startup:{k}", "entity_type": "startup", "entity_key": k, "company_id": d.company_id,
               "status": d.status, "method": d.method, "probability": _f(d.probability), "candidates": d.candidates,
               "evidence": d.evidence, "model_version": MODEL_VERSION, "decided_by": d.decided_by,
               "matcher": {"status": m.status, "company_id": m.company_id, "method": m.method, "probability": _f(m.probability)}}
        old = existing.get(doc["_id"])
        if old and all(old.get(f) == v for f, v in doc.items()):
            continue      # unchanged: keep its date, so "linked on" stays the day the link was made
        stats["links_changed"] += 1
        ops.append(ReplaceOne({"_id": doc["_id"]}, doc | {"updated_at": now}, upsert=True))
    for i in range(0, len(ops), 1000):
        db.entity_links.bulk_write(ops[i:i + 1000], ordered=False)
    # a startup no longer on the portals (or a stale duplicate of one) keeps no link
    stale = [d["_id"] for d in existing.values() if d.get("entity_key") not in startups]
    if stale:
        stats["stale_links_deleted"] = db.entity_links.delete_many({"_id": {"$in": stale}}).deleted_count
    stats["startups"] = len(startups)
    stats["splink_pairs_scored"] = model.get("pairs_scored", 0)
    return dict(stats) | {"model": {k: v for k, v in model.items() if k not in ("u", "m")}}


def _f(x):
    return None if x is None or (isinstance(x, float) and math.isnan(x)) else float(x)

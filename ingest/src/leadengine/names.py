"""Indian company name cleaning.

"M/s ABC Technologies (P) Ltd.", "ABC TECHNOLOGIES PVT LTD" and "Abc Technologies Private Limited" must
come out the same. Words such as "Technologies", "Solutions" and "India" appear in thousands of names,
so they are kept apart as generic tokens and given low weight when matching; otherwise every
"<X> Technologies" would look like every other.

Generic words still count when deciding whether two names are the same name. MCA registers
"Pravaron Holdings" and "Pravaron Technologies" as two different companies, so two names may differ
only in the ways MCA's name rules treat as no difference at all: the legal form, "The", "Company",
plural or singular, spacing and punctuation, and a slip of spelling. `NameKey.ident` is the name with
exactly those differences folded away. (The list follows rule 8 of the Companies (Incorporation)
Rules, 2014, as summarised here; check the rule's current text before relying on a borderline word.
"India" is deliberately not on it: MCA registered both FLIPTOSOLAR and FLIPTOSOLAR INDIA in 2026.)
"""
import re
import unicodedata
from dataclasses import dataclass

GENERIC = frozenset("""
technologies technology tech technocrats techno solutions solution services service india indian global international
ventures venture enterprises enterprise industries industry infotech infosystems systems system innovations innovation
labs lab group consultancy consultants consulting digital software softwares private limited pvt ltd the and of
corporation corp corpn company co inc associates trading traders exports export imports import infra infrastructure
projects works world worldwide network networks marketing management resources holdings developers development
""".split())

# Words whose presence or absence never makes two names different (see the module docstring).
IGNORABLE = frozenset("the and of company co corporation corp corpn inc".split())


def _deletes(word: str) -> set:
    return {word[:i] + word[i + 1:] for i in range(len(word))}


def one_edit(a: str, b: str) -> bool:
    """True if a and b differ by exactly one insertion, deletion, substitution or swap of two
    neighbouring letters."""
    if a == b or abs(len(a) - len(b)) > 1:
        return False
    if len(a) == len(b):
        diff = [i for i in range(len(a)) if a[i] != b[i]]
        return len(diff) == 1 or (len(diff) == 2 and diff[1] == diff[0] + 1
                                   and a[diff[0]] == b[diff[1]] and a[diff[1]] == b[diff[0]])
    if len(a) > len(b):
        a, b = b, a
    i = 0
    while i < len(a) and a[i] == b[i]:
        i += 1
    return a[i:] == b[i + 1:]


# Indian names written in Roman script several ways: Shri, Shree, Sri and Sree; Lakshmi and Laxmi; Deepak and
# Dipak; Pooja and Puja; Vinod and Winod. One spelling for each, so such names can be put to a reviewer.
_HONORIFIC = {"shri", "shree", "sri", "sree", "shrii", "shre"}
_SPELLING = (("ksh", "x"), ("aa", "a"), ("ee", "i"), ("ii", "i"), ("oo", "u"), ("uu", "u"), ("w", "v"), ("ph", "f"), ("q", "k"))


def variant_key(clean: str) -> str:
    """The name with each word in one spelling: "shree lakshmi agro" and "sri laxmi agro" -> "shri laxmi agro".
    Used only to find names a reviewer should see side by side, never to link them."""
    out = []
    for tok in (clean or "").split():
        if tok in _HONORIFIC:
            out.append("shri")
            continue
        for a, b in _SPELLING:
            tok = tok.replace(a, b)
        out.append(tok)
    return " ".join(out)


def typo_of(a: str, b: str) -> bool:
    """True if one distinctive word is a plausible slip of the other: one edit apart, at least five
    letters, the same first letter, and a letter added at the very end only if it doubles the one
    before it or makes a plural. "Moors"/"Motors" and "Yagnawealthh"/"Yagnawealth" pass; "FGEV"/"FIEV"
    (too short), "Matrix"/"Datrix" (first letter) and "KavachX"/"Kavach" (a letter added as a suffix,
    which is how brands are made) do not."""
    if a == b or min(len(a), len(b)) < 5 or a[0] != b[0] or not one_edit(a, b):
        return False
    # "Hiranya" and "Hiranyo": brands are made by changing the last vowel, so that is not a slip
    if len(a) == len(b) and a[:-1] == b[:-1] and a[-1] in "aeiouy" and b[-1] in "aeiouy":
        return False
    short, long_ = (a, b) if len(a) < len(b) else (b, a)
    if len(short) != len(long_) and long_.startswith(short):          # a letter added at the end
        extra = long_[-1]
        return extra == short[-1] or extra == "s"
    return True


# A founder who types "Techologies" or "Inovations" still means a generic word. Long generic words
# (7+ letters, where a one-letter slip rarely makes a different real word) are recognised within one
# edit. The first letter must agree, so "Centure" is not read as "Venture".
_LONG_GENERIC = frozenset(g for g in GENERIC if len(g) >= 7)
_GENERIC_BY_DELETE: dict[str, list] = {}
for _g in _LONG_GENERIC:
    for _i in range(len(_g)):
        _GENERIC_BY_DELETE.setdefault(_g[:_i] + _g[_i + 1:], []).append((_g, _i))


def near_generic(token: str) -> str | None:
    """The generic word `token` is, or is a one-edit slip of; None for a distinctive word."""
    if token in GENERIC:
        return token
    if len(token) < 6:
        return None
    for g, _ in _GENERIC_BY_DELETE.get(token, ()):                     # a letter missing
        if g[0] == token[0]:
            return g
    for j in range(len(token)):
        d = token[:j] + token[j + 1:]
        if d in _LONG_GENERIC and d[0] == token[0]:                    # a letter too many
            return d
        if j > 0:
            for g, i in _GENERIC_BY_DELETE.get(d, ()):
                if i == j:                                             # one letter changed
                    return g
        if j + 1 < len(token):
            swapped = token[:j] + token[j + 1] + token[j] + token[j + 2:]
            if swapped in _LONG_GENERIC and swapped[0] == token[0]:   # two letters swapped
                return swapped
    return None


def is_generic(token: str) -> bool:
    return near_generic(token) is not None


def _singular(word: str) -> str:
    """MCA treats the plural and the singular as the same word."""
    if len(word) > 4 and word.endswith("ies"):
        return word[:-3] + "y"
    if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
        return word[:-1]
    return word


def canonical(token: str) -> str:
    """The word as compared for MCA identity: a generic word, misspelt or not, becomes its singular
    ("Techologies" -> "technology"). A distinctive word is left alone: the "s" of "Kairos" or "Sivas"
    is not a plural, and folding it would split "Kairos AI" from "KairosAI"."""
    g = near_generic(token)
    return _singular(g) if g else token


# ---- legal forms -----------------------------------------------------------------------------------
# Forms are read from the end of the folded token list, so punctuation and spacing never matter:
# "Pvt-Ltd", "(Pvt) Ltd", "P. Ltd.", "Pvt.Ltd.,", "PRIVATELIMITED" and "X(OPC) PRIVATE LIMITED" all fold.
_PVT_WORDS = {"private", "pvt", "prvt", "privet", "प्राइवेट"}
_LTD_WORDS = {"limited", "ltd", "लिमिटेड"}
_LTD_SHORT = {"lt", "td", "tld", "ltd"}          # only after a "private" word: "Pvt. Lt.", "PVT.TD", "pvt tld"


def _is_pvt(t: str) -> bool:
    return t in _PVT_WORDS or (len(t) >= 6 and t[0] == "p" and one_edit(t, "private"))


def _is_ltd(t: str) -> bool:
    return t in _LTD_WORDS or (len(t) >= 6 and t[0] == "l" and (one_edit(t, "limited") or t in ("limitted", "limeted")))


def _form_at_end(t: list) -> tuple[int, str | None]:
    """(number of tokens the legal form takes at the end of t, canonical form)."""
    n = len(t)
    if n >= 1 and t[-1] in ("llp", "एलएलपी"):
        return 1, "llp"
    if t[-3:] == ["l", "l", "p"]:
        return 3, "llp"
    if t[-3:] == ["limited", "liability", "partnership"]:
        return 3, "llp"
    k, form = 0, None
    if n >= 3 and t[-1] == "opc" and _is_pvt(t[-3]) and (_is_ltd(t[-2]) or t[-2] in _LTD_SHORT):
        k, form = 3, "opc pvt ltd"                                       # "X Private Limited OPC"
    elif n >= 3 and t[-1] == "company" and _is_pvt(t[-3]) and _is_ltd(t[-2]):
        k, form = 3, "pvt ltd"                                           # "X Private Limited Company"
    elif n >= 2 and (_is_pvt(t[-2]) or t[-2] == "p") and (_is_ltd(t[-1]) or (_is_pvt(t[-2]) and t[-1] in _LTD_SHORT)):
        k, form = 2, "pvt ltd"                                           # "(P) Ltd", "Pvt. Lt."
    elif n >= 1 and t[-1] == "pvt":
        k, form = 1, "pvt ltd"                                           # "X Technologies Pvt"
    elif n >= 1 and _is_ltd(t[-1]):
        k, form = 1, "ltd"
        if n >= 2 and t[-2] == "public":
            k = 2
        return k, form
    if form == "pvt ltd":
        if n - k >= 1 and t[n - k - 1] == "opc":
            k, form = k + 1, "opc pvt ltd"
        elif t[max(0, n - k - 3):n - k] == ["one", "person", "company"]:
            k, form = k + 3, "opc pvt ltd"
        return k, form
    if form:
        return k, form
    if t[-3:] == ["one", "person", "company"]:
        return 3, "opc pvt ltd"
    return 0, None


def _junk(t: str) -> bool:
    """A stray token typed after the legal form: "PRIVATE LIMITED i", "Pvt Ltd-1464"."""
    return t.isdigit() or (len(t) <= 2 and t not in ("p", "co"))


def _fold(s: str) -> list:
    s = re.sub(r"(private|pvt)(limited|ltd)\b", r"\1 \2", s)
    s = re.sub(r"([a-z0-9])(private|pvt)(\s+(?:limited|ltd)\b)", r"\1 \2\3", s)   # "SafepikPrivate Limited"
    s = re.sub(r"[^a-z0-9ऀ-ॿ]+", " ", s)                    # keep Devanagari, fold punctuation
    return s.split()


def _split_form(tokens: list) -> tuple[list, str | None]:
    k, form = _form_at_end(tokens)
    if form:
        return tokens[:len(tokens) - k], form
    if len(tokens) >= 2 and _junk(tokens[-1]):
        k, form = _form_at_end(tokens[:-1])
        if form:
            return tokens[:len(tokens) - 1 - k], form
    return tokens, None


@dataclass(frozen=True)
class NameKey:
    clean: str               # lower case, legal form removed, punctuation folded
    legal_form: str | None   # "pvt ltd", "opc pvt ltd", "llp", "ltd" or None
    tokens: tuple            # all tokens of `clean`
    core: tuple              # tokens that are not generic

    @property
    def key(self) -> str:
        """Compact blocking key: the distinctive tokens, or every token if all are generic."""
        return "".join(self.core or self.tokens)

    @property
    def words(self) -> tuple:
        """The name's words as MCA compares them: ignorable words dropped, generic words corrected
        and singular."""
        return tuple(canonical(t) for t in self.tokens if t not in IGNORABLE) or tuple(canonical(t) for t in self.tokens)

    @property
    def ident(self) -> str:
        """The name with every difference MCA ignores folded away; two names with the same `ident`
        cannot both be registered."""
        return "".join(self.words)


def normalize_name(name: str) -> NameKey:
    s = unicodedata.normalize("NFKC", str(name or "")).lower().strip()
    s = re.sub(r"^\s*(?:m\s*/\s*s|messrs|messers)\b\.?\s*", "", s)    # M/s, M/s., Messrs
    s = re.sub(r"^\s*\d+\s*\.\s*(?=[a-z])", "", s)                    # "1.RHINO DIGITAL HUB" as printed in MCA files
    s = s.replace("&", " and ").replace("+", " and ")
    s = re.sub(r"[‘’'`\"]", "", s)                          # apostrophes vanish: "Ram's" -> "rams"
    # A trailing bracket is either part of the form ("(OPC)"), the registered name after a brand
    # ("CULTRE (CULTECH WAVE PRIVATE LIMITED)"), or a note to drop ("(KimUp)", "(formerly X LLP)").
    m = re.search(r"\(([^()]*)\)[\s.,;:\-]*$", s)
    if m:
        inner, outer = _fold(m[1]), _fold(s[: m.start()])
        if inner and inner != ["opc"] and inner != ["p"]:
            if _split_form(inner)[1] and not _split_form(outer)[1] and not inner[0] in ("formerly", "earlier", "old"):
                s = m[1]
            elif outer:
                s = s[: m.start()]
    tokens, form = _split_form(_fold(s))
    if tokens and tokens[0] == "the" and len(tokens) > 1:
        tokens = tokens[1:]                                            # MCA: "The X" is "X"
    tokens = tuple(tokens)
    core = tuple(t for t in tokens if not is_generic(t))
    return NameKey(" ".join(tokens), form, tokens, core)

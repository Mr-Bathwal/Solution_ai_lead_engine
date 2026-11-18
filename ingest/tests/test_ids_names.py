from leadengine.ids import is_llpin, parse_cin, uplc_key
from leadengine.names import normalize_name


def test_up_cins_from_both_registrars():
    a = parse_cin("U62099UW2026PTC259408")
    assert a.is_up and a.registrar == "ROC Uttar Pradesh-II"
    assert a.nic5 == "62099" and a.sector == "Software & IT services" and a.company_type == "Private Limited"
    b = parse_cin(" u72900up2025opc123456 ")
    assert b.is_up and b.year == 2025 and b.company_type == "One Person Company"


def test_non_up_and_invalid():
    assert not parse_cin("U73100TS2026PTC222023").is_up
    assert parse_cin("U7310TS2026PTC222023") is None
    assert parse_cin("") is None
    assert is_llpin("ADB-7622") and not is_llpin("ADB7622")


def test_uplc_spellings():
    for s in ["A_STARTUP_UP_UPLC_00004164", "A/STARTUP/UP/UPLC/00004164", "UPLC_4164",
              "https://x/Documents/Startup/A_STARTUP_UP_UPLC_00004164/startup_logo/1.png"]:
        assert uplc_key(s) == "UPLC_00004164", s
    assert uplc_key("nothing") is None
    assert uplc_key("sui_sd_UPLC_000010082") == "UPLC_00010082", "9-digit padding is read whole"
    assert uplc_key("UPLC_000010082") != uplc_key("UPLC_000010083")


def test_legal_forms_fold_together():
    keys = {normalize_name(n).key for n in [
        "ABC Technologies Pvt. Ltd.", "ABC TECHNOLOGIES PRIVATE LIMITED", "M/s ABC Technologies (P) Ltd",
        "Abc Technologies Pvt Ltd",
    ]}
    assert keys == {"abc"}
    assert normalize_name("ABC Technologies Pvt. Ltd.").legal_form == "pvt ltd"


def test_other_forms_and_symbols():
    assert normalize_name("Green Leaf Farms LLP").legal_form == "llp"
    assert normalize_name("Kumar OPC Private Limited").legal_form == "opc pvt ltd"
    assert normalize_name("R & D Labs").clean == normalize_name("R and D Labs").clean
    assert normalize_name("1.RHINO DIGITAL HUB PRIVATE LIMITED").clean == "rhino digital hub"


def test_generic_words_do_not_make_names_match():
    a, b = normalize_name("Zeta Solutions India Pvt Ltd"), normalize_name("Omega Solutions India Pvt Ltd")
    assert a.key != b.key
    assert normalize_name("Digital Solutions Pvt Ltd").key == "digitalsolutions", "all-generic names keep every token"


def test_portal_spellings_of_the_legal_form():
    """As typed on the startup portals: a trailing dot, (OPC) after the form, no space, P. Ltd."""
    want = normalize_name("Prodes Projects Private Limited")
    for s in ("PRODES PROJECTS PRIVATELIMITED", "Prodes Projects Private Limited.", "PRODES PROJECTS PVT. LTD,",
              "Prodes Projects P. Ltd."):
        k = normalize_name(s)
        assert (k.clean, k.legal_form) == (want.clean, want.legal_form), s
    assert normalize_name("Arcane Infotech Private Limited (OPC)").legal_form == "opc pvt ltd"

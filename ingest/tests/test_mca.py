import csv
import io
from datetime import datetime

import openpyxl
import pytest

from conftest import ATLAS, MCA_DIR
from leadengine.records import RunContext
from leadengine.sources.mca import McaMonthlySource, parse_report, to_company


def make_report(companies, llps=(), foreign=()):
    """A workbook laid out like MCA's: title row, blank rows, then a header with stray spaces."""
    wb = openpyxl.Workbook()
    layouts = [
        ("Indian Companies", [" CIN", " Class", " Company Name", " Date Of Registration", " Company Type", " Activity Code"], companies),
        ("LLP Companies", [" LLPIN", " LLP Name", " Date of registration", " Activity"], llps),
        ("Foreign Companies", [" FCIN", " Company Name", " Date of Registration", " Activity"], foreign),
    ]
    wb.remove(wb.active)
    for title, header, rows in layouts:
        ws = wb.create_sheet(title)
        ws.append(["   Monthly Company (Indian and Foreign) and LLP's incorporation FO portal report      Date: 05-Oct-2026 00:20:04"])
        for _ in range(7):
            ws.append([])
        ws.append(header)
        for r in rows:
            ws.append(list(r))
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


ROWS = [
    ("U62099UW2026PTC259408", "Private", "ADOZMART ECOM PRIVATE LIMITED", "30-09-2026", "Non-government company", "62"),
    ("U01500UP2026PTC259415", "Private", "ABHAM GLOBAL SKYSTEPS PRIVATE LIMITED", datetime(2026, 9, 29), "Non-government company", "01"),
    ("U73100TS2026PTC222023", "Private", "1.RHINO DIGITAL HUB PRIVATE LIMITED", "01-09-2026", "Non-government company", "73"),
    ("BADCIN", "Private", "BROKEN ROW", "01-09-2026", "", ""),
]


def test_parse_layout():
    rep = parse_report(make_report(ROWS, llps=[("ADB-7622", "RA KESHAV ESTATES LLP", "01-09-2026", "68")]))
    assert len(rep.companies) == 4 and len(rep.llps) == 1
    assert rep.companies[0]["name"] == "ADOZMART ECOM PRIVATE LIMITED"
    assert rep.companies[1]["registered_on"] == "2026-09-29", "Excel datetime cells are handled"
    assert rep.period == "2026-09"
    assert rep.generated_at == datetime(2026, 10, 5, 0, 20, 4)


def test_source_keeps_only_up(tmp_path, raw):
    f = tmp_path / "Incorporation-Report-20261005.xlsx"
    f.write_bytes(make_report(ROWS, llps=[("ADB-7622", "X LLP", "01-09-2026", "68")]))
    ctx = RunContext(run_id="t", fetcher=None, rawstore=raw, log=lambda m: None)
    recs = list(McaMonthlySource(f).collect(ctx))
    assert [r.natural_key for r in recs] == ["U62099UW2026PTC259408", "U01500UP2026PTC259415"]
    assert ctx.stats["companies_up"] == 2 and ctx.stats["companies_india"] == 3
    assert ctx.stats["rows_with_bad_cin"] == 1 and ctx.stats["llps_india_state_unknown"] == 1
    assert all(r.legal_basis == "published_under_law" and r.raw_ref.key.startswith("mca_monthly/") for r in recs)
    c = to_company(recs[0])
    assert c["cohort"] == "2026-09" and c["attrs"]["registrar"] == "ROC Uttar Pradesh-II"
    assert c["attrs"]["sector"] == "Software & IT services" and c["name_norm"] == "adozmartecom"


@pytest.mark.skipif(not (MCA_DIR / "Incorporation-Report-20261005.xlsx").exists(), reason="real MCA file not on this machine")
def test_real_september_report_matches_atlas(raw):
    """The engine must find exactly the UP companies the Atlas pipeline found in the same file."""
    f = MCA_DIR / "Incorporation-Report-20261005.xlsx"
    ctx = RunContext(run_id="t", fetcher=None, rawstore=raw, log=lambda m: None)
    ours = {r.natural_key for r in McaMonthlySource(f).collect(ctx)}
    atlas_csv = ATLAS / "raw" / "L1_registry" / "up_incorporations.csv"
    if not atlas_csv.exists():
        pytest.skip("Atlas output not on this machine")
    theirs = {r["cin_llpin"] for r in csv.DictReader(open(atlas_csv, encoding="utf-8")) if f.name in r["source_name"]}
    assert ours == theirs
    assert 2000 < len(ours) < 3500

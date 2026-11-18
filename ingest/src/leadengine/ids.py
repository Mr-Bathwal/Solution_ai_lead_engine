"""Indian company identifiers. Most of what we know about a brand-new company is decoded from its CIN.

    U 62013 UP 2026 PTC 123456
    | |     |  |    |   +-- serial
    | |     |  |    +------ type: PTC private, OPC one-person, NPL section 8, PLC public, FTC foreign subsidiary
    | |     |  +----------- year of incorporation
    | |     +-------------- state of the registrar: UP (ROC Uttar Pradesh-I, formerly Kanpur) and
    | |                     UW (ROC Uttar Pradesh-II, created when ROC Kanpur was split on 16 Feb 2026)
    | +-------------------- five-digit NIC 2008 activity code
    +---------------------- U unlisted, L listed

An LLPIN (for example ADB-7622) carries no state, so an LLP's state has to come from a lookup.
"""
import re
from dataclasses import dataclass

CIN_RX = re.compile(r"^([UL])(\d{5})([A-Z]{2})(\d{4})([A-Z]{3})(\d{6})$")
LLPIN_RX = re.compile(r"^[A-Z]{3}-\d{4}$")
UPLC_RX = re.compile(r"UPLC[_/](\d+)", re.I)  # padding varies: 8 digits on UPSM, 9 on newer portal profiles

UP_REGISTRARS = {"UP": "ROC Uttar Pradesh-I (formerly ROC Kanpur)", "UW": "ROC Uttar Pradesh-II"}

COMPANY_TYPES = {
    "PTC": "Private Limited", "OPC": "One Person Company", "NPL": "Section 8 (not for profit)",
    "PLC": "Public Limited", "FTC": "Subsidiary of foreign company", "GOI": "Central Government company",
    "SGC": "State Government company", "GAP": "Guarantee and association", "ULL": "Unlimited", "ULT": "Unlimited",
}

NIC_DIVISIONS = {
    "01": "Agriculture & allied", "02": "Forestry", "03": "Fishing & aquaculture", "05": "Mining", "06": "Oil & gas",
    "07": "Mining", "08": "Quarrying", "09": "Mining support", "10": "Food processing", "11": "Beverages",
    "12": "Tobacco", "13": "Textiles", "14": "Apparel", "15": "Leather & footwear", "16": "Wood products",
    "17": "Paper", "18": "Printing", "19": "Petroleum products", "20": "Chemicals", "21": "Pharmaceuticals",
    "22": "Rubber & plastics", "23": "Non-metallic minerals", "24": "Basic metals", "25": "Fabricated metal",
    "26": "Electronics & optical", "27": "Electrical equipment", "28": "Machinery", "29": "Motor vehicles & EV",
    "30": "Other transport equipment", "31": "Furniture", "32": "Other manufacturing",
    "33": "Machinery repair & installation", "35": "Power & gas", "36": "Water supply", "37": "Sewerage",
    "38": "Waste & recycling", "39": "Remediation", "41": "Building construction", "42": "Civil engineering",
    "43": "Specialised construction", "45": "Vehicle trade & repair", "46": "Wholesale trade", "47": "Retail trade",
    "49": "Land transport", "50": "Water transport", "51": "Air transport", "52": "Warehousing & logistics",
    "53": "Courier", "55": "Accommodation", "56": "Restaurants & food service", "58": "Publishing",
    "59": "Film, video & music", "60": "Broadcasting", "61": "Telecom", "62": "Software & IT services",
    "63": "Information services & data", "64": "Financial services", "65": "Insurance",
    "66": "Financial auxiliaries", "68": "Real estate", "69": "Legal & accounting", "70": "Management consultancy",
    "71": "Architecture & engineering", "72": "Scientific R&D", "73": "Advertising & market research",
    "74": "Other professional & technical", "75": "Veterinary", "77": "Rental & leasing",
    "78": "Staffing & recruitment", "79": "Travel & tourism", "80": "Security services", "81": "Facility services",
    "82": "Business support", "84": "Public administration", "85": "Education", "86": "Healthcare",
    "87": "Residential care", "88": "Social work", "90": "Creative arts", "91": "Libraries & culture",
    "92": "Gaming & lotteries", "93": "Sports & recreation", "94": "Membership organisations",
    "95": "Repair of goods", "96": "Personal services", "97": "Households", "98": "Households",
    "99": "Extraterritorial",
}


@dataclass(frozen=True)
class Cin:
    value: str
    listing: str      # "U" unlisted or "L" listed
    nic5: str
    state: str        # registrar state code, e.g. "UP", "UW", "DL"
    year: int
    type_code: str
    serial: str

    @property
    def is_up(self) -> bool:
        return self.state in UP_REGISTRARS

    @property
    def registrar(self) -> str:
        return UP_REGISTRARS.get(self.state, self.state)

    @property
    def company_type(self) -> str:
        return COMPANY_TYPES.get(self.type_code, self.type_code)

    @property
    def nic_division(self) -> str:
        return self.nic5[:2]

    @property
    def sector(self) -> str:
        return NIC_DIVISIONS.get(self.nic_division, "")


def clean_id(value) -> str:
    return re.sub(r"\s+", "", str(value or "")).upper()


def parse_cin(value) -> Cin | None:
    s = clean_id(value)
    m = CIN_RX.match(s)
    if not m:
        return None
    return Cin(s, m[1], m[2], m[3], int(m[4]), m[5], m[6])


def is_llpin(value) -> bool:
    return bool(LLPIN_RX.match(clean_id(value)))


def uplc_key(value) -> str | None:
    """Startup in UP / UP Startup Mission application number, from any of its spellings:
    'A_STARTUP_UP_UPLC_00004164', 'A/STARTUP/UP/UPLC/00004164', 'UPLC_4164' -> 'UPLC_00004164'.
    The number is compared by value, so 'UPLC_000010082' (9 digits) -> 'UPLC_00010082'."""
    m = UPLC_RX.search(str(value or ""))
    return f"UPLC_{int(m[1]):08d}" if m else None

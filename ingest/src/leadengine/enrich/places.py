"""Uttar Pradesh districts and PIN codes, read from a registered-office address."""
import re

# The 75 districts, each with the other names that appear in addresses (old names, city names).
DISTRICTS = {
    "Agra": [], "Aligarh": [], "Ambedkar Nagar": ["akbarpur"], "Amethi": ["chhatrapati shahuji maharaj nagar"],
    "Amroha": ["jyotiba phule nagar", "j p nagar"], "Auraiya": [], "Ayodhya": ["faizabad"], "Azamgarh": [],
    "Baghpat": ["bagpat"], "Bahraich": [], "Ballia": [], "Balrampur": [], "Banda": [], "Barabanki": ["bara banki"],
    "Bareilly": [], "Basti": [], "Bhadohi": ["sant ravidas nagar", "sant ravi das nagar"], "Bijnor": [],
    "Budaun": ["badaun"], "Bulandshahr": ["bulandshahar"], "Chandauli": [], "Chitrakoot": [], "Deoria": [],
    "Etah": [], "Etawah": [], "Farrukhabad": [], "Fatehpur": [], "Firozabad": ["ferozabad"],
    "Gautam Buddha Nagar": ["gautam budh nagar", "gautam buddh nagar", "gautambudh nagar", "g b nagar", "noida",
                            "greater noida"],
    "Ghaziabad": [], "Ghazipur": [], "Gonda": [], "Gorakhpur": [], "Hamirpur": [], "Hapur": ["panchsheel nagar"],
    "Hardoi": [], "Hathras": ["mahamaya nagar"], "Jalaun": ["orai"], "Jaunpur": [], "Jhansi": [], "Kannauj": [],
    "Kanpur Dehat": ["ramabai nagar"], "Kanpur Nagar": ["kanpur"], "Kasganj": ["kanshiram nagar", "kanshi ram nagar"],
    "Kaushambi": [], "Kushinagar": ["padrauna", "kushi nagar"], "Lakhimpur Kheri": ["kheri", "lakhimpur"],
    "Lalitpur": [], "Lucknow": [], "Maharajganj": ["mahrajganj"], "Mahoba": [], "Mainpuri": [], "Mathura": [],
    "Mau": [], "Meerut": [], "Mirzapur": [], "Moradabad": [], "Muzaffarnagar": ["muzaffar nagar"], "Pilibhit": [],
    "Pratapgarh": [], "Prayagraj": ["allahabad"], "Raebareli": ["rae bareli", "raibareli", "rai bareli"],
    "Rampur": [], "Saharanpur": [], "Sambhal": ["bhim nagar"], "Sant Kabir Nagar": ["santkabir nagar", "khalilabad"],
    "Shahjahanpur": [], "Shamli": ["prabuddh nagar"], "Shravasti": [], "Siddharthnagar": ["siddharth nagar"],
    "Sitapur": [], "Sonbhadra": ["sonebhadra", "robertsganj"], "Sultanpur": [], "Unnao": [],
    "Varanasi": ["banaras", "benaras", "benares"],
}
_NAMES = sorted(((alias or d.lower(), d) for d, aliases in DISTRICTS.items() for alias in [d.lower(), *aliases]),
                key=lambda x: -len(x[0]))          # "kanpur dehat" before "kanpur", "greater noida" before "noida"
_RX = [(re.compile(r"(?<![a-z])" + re.escape(n).replace(r"\ ", r"[\s.-]*") + r"(?![a-z])"), d) for n, d in _NAMES]
UP_PIN = re.compile(r"(?<!\d)(2[0-8]\d)\s?(\d{3})(?!\d)")


def pincode(address: str) -> str | None:
    """The last UP PIN code (201xxx-285xxx) in an address."""
    found = UP_PIN.findall(address or "")
    return "".join(found[-1]) if found else None


def district(address: str) -> str | None:
    """The district an address names. Addresses run from the street to the state, so the district
    named last wins ("Gomti Nagar, Lucknow" -> Lucknow, not a district called in a street name)."""
    s = (address or "").lower()
    best, pos = None, -1
    taken = []
    for rx, d in _RX:
        for m in rx.finditer(s):
            if any(a <= m.start() < b for a, b in taken):
                continue        # inside a longer name already matched ("kanpur" inside "kanpur dehat")
            taken.append((m.start(), m.end()))
            if m.start() > pos:
                best, pos = d, m.start()
    return best

"""Checks the outreach domain's email set-up before warm-up starts, and again before the first send.

    python ops/check_email_dns.py <outreach-domain> [--selector zmail] [--main-domain solutionai.in]

Checks MX (Zoho), SPF (one record, includes Zoho, ends in ~all or -all), DKIM (present, 2048-bit),
DMARC (present, has a reporting address) and that the outreach domain is not the main domain.
Uses public DNS-over-HTTPS (Google, then Cloudflare) and falls back to the system's own resolver
(nslookup) on networks that block DNS-over-HTTPS, so it needs no extra packages.
"""
import argparse
import json
import re
import subprocess
import sys
import urllib.parse
import urllib.request

RESOLVERS = ["https://dns.google/resolve?name={n}&type={t}", "https://cloudflare-dns.com/dns-query?name={n}&type={t}"]


def _doh(name: str, rtype: str) -> list[str] | None:
    for tpl in RESOLVERS:
        url = tpl.format(n=urllib.parse.quote(name), t=rtype)
        req = urllib.request.Request(url, headers={"Accept": "application/dns-json"})
        try:
            with urllib.request.urlopen(req, timeout=8) as r:
                data = json.load(r)
        except Exception:
            continue
        out = []
        for a in data.get("Answer", []):
            if a.get("type") == 15:   # MX: "10 mx.zoho.in."
                out.append(a["data"].split()[-1].rstrip("."))
            elif a.get("type") == 16:
                out.append("".join(re.findall(r'"([^"]*)"', a["data"])) or a["data"])
        return out
    return None


def _nslookup(name: str, rtype: str) -> list[str]:
    try:
        text = subprocess.run(["nslookup", f"-type={rtype}", name], capture_output=True, text=True, timeout=20).stdout
    except (OSError, subprocess.TimeoutExpired):
        raise SystemExit("no DNS resolver available (DNS-over-HTTPS blocked and nslookup missing)")
    if rtype == "MX":
        return [m.rstrip(".") for m in re.findall(r"mail exchanger = (?:\d+\s+)?(\S+)", text)]
    records, current = [], None
    for line in text.splitlines():
        if "text =" in line:                      # a new TXT record starts
            if current is not None:
                records.append(current)
            current = "".join(re.findall(r'"([^"]*)"', line))
        elif current is not None and line.strip().startswith('"'):
            current += "".join(re.findall(r'"([^"]*)"', line))
        elif current is not None and line.strip() and not line.strip().startswith('"'):
            records.append(current)
            current = None
    if current is not None:
        records.append(current)
    return records


_doh_blocked = False


def lookup(name: str, rtype: str) -> list[str]:
    global _doh_blocked
    found = None if _doh_blocked else _doh(name, rtype)
    if found is None:
        _doh_blocked = True   # do not wait for the timeout again on every lookup
        return _nslookup(name, rtype)
    return found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("domain")
    ap.add_argument("--selector", default="zmail", help="DKIM selector chosen in Zoho (default: zmail)")
    ap.add_argument("--main-domain", default="solutionai.in")
    a = ap.parse_args()
    d = a.domain.lower().strip(".")
    results = []

    def check(name, ok, detail):
        results.append(ok)
        print(f"  [{'OK ' if ok else 'FIX'}] {name}: {detail}")

    print(f"Email DNS for {d}")
    check("separate domain", d != a.main_domain.lower(), "outreach must never be sent from the main domain")

    mx = lookup(d, "MX")
    check("MX", any("zoho" in m.lower() for m in mx), ", ".join(mx) or "no MX records")

    spf = [t for t in lookup(d, "TXT") if t.lower().startswith("v=spf1")]
    if len(spf) != 1:
        check("SPF", False, f"{len(spf)} SPF records found; there must be exactly one")
    else:
        s = spf[0].lower()
        zoho = re.search(r"include:([\w-]+\.)*zoho\.(in|com|eu)\b", s)   # include:zoho.in, include:spf.zoho.in, ...
        check("SPF", bool(zoho) and (s.endswith("~all") or s.endswith("-all")), spf[0])

    dk = [t for t in lookup(f"{a.selector}._domainkey.{d}", "TXT") if "v=dkim1" in t.lower().replace(" ", "")]
    if not dk:
        check("DKIM", False, f"no key at {a.selector}._domainkey.{d} (use the selector you created in Zoho)")
    else:
        p = dk[0].replace(" ", "").split("p=")[-1].split(";")[0]
        check("DKIM", len(p) >= 300, f"public key {len(p)} base64 characters ({'2048-bit' if len(p) >= 300 else 'too short: generate a 2048-bit key'})")

    dm = [t for t in lookup(f"_dmarc.{d}", "TXT") if t.lower().startswith("v=dmarc1")]
    if not dm:
        check("DMARC", False, "no record at _dmarc")
    else:
        v = dm[0].lower()
        check("DMARC", "p=" in v and "rua=" in v, dm[0])

    print("\nAll good: warm-up can start." if all(results) else "\nFix the items marked FIX, wait for DNS to update (up to an hour), and run again.")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())

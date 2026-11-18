"""The platform rules engine: an outage costs a few timeouts, not one per company."""
from datetime import date

import requests

from leadengine.need import schemes


class Down:
    def __init__(self):
        self.calls = 0

    def post(self, *a, **kw):
        self.calls += 1
        raise requests.ConnectTimeout("rules engine down")


def test_after_five_failures_in_a_row_the_night_uses_the_provisional_rules():
    c = schemes.PlatformRulesClient("https://rules.example", "k")
    c.session = Down()
    f = schemes.Facts(kind="company", type_code="PTC", incorporated=date(2026, 9, 1), as_of=date(2026, 10, 27))
    sources = [schemes.verdicts_for(f, client=c)[1] for _ in range(100)]
    assert set(sources) == {"provisional_rules"}
    assert c.session.calls == schemes.PlatformRulesClient.MAX_CONSECUTIVE_FAILURES == 5

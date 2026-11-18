from leadengine.rawstore import FileRawStore, raw_key
from leadengine.util import sha256_bytes


def test_same_content_is_stored_once(tmp_path):
    st = FileRawStore(tmp_path)
    a = st.put(b"<html>v1</html>", source="startinup", url="https://x.in/p1")
    b = st.put(b"<html>v1</html>", source="startinup", url="https://x.in/p1")
    assert a == b
    assert len((tmp_path / "startinup" / "_index.jsonl").read_text().splitlines()) == 1
    assert st.get(a) == b"<html>v1</html>"


def test_changed_content_is_a_new_version_beside_the_old(tmp_path):
    st = FileRawStore(tmp_path)
    a = st.put(b"v1", source="s", url="https://x.in/p")
    b = st.put(b"v2", source="s", url="https://x.in/p")
    assert a.key != b.key and a.key.rsplit("/", 1)[0] == b.key.rsplit("/", 1)[0], "same URL folder"
    assert st.get(a) == b"v1" and st.get(b.to_doc()) == b"v2"


def test_key_is_url_and_content_hash():
    k = raw_key("upsm", "https://x.in/api?page=1", sha256_bytes(b"x"))
    src, url_part, content = k.split("/")
    assert src == "upsm" and len(url_part) == 16 and content == sha256_bytes(b"x") + ".gz"


PAGE = b"<p>Write to asha.v@gmail.com or info@acme.in, call +91-98765 43210 or 0522-2345678.</p>" \
       b"<img src='/A_STARTUP_UP_UPLC_00012345/startup_logo/1693820000.png'>"


def test_contacts_are_removed_before_storing_but_the_key_names_the_page_as_fetched(tmp_path):
    import json
    st = FileRawStore(tmp_path)
    ref = st.put(PAGE, source="incubator", url="https://x.in/p", content_type="text/html", personal=True)
    stored = st.get(ref)
    assert b"gmail" not in stored and b"info@acme.in" not in stored and b"98765" not in stored and b"2345678" not in stored
    assert b"UPLC_00012345" in stored and b"1693820000" in stored, "identifiers and timestamps are not phone numbers"
    assert ref.sha256 == sha256_bytes(PAGE) and ref.redacted and ref.personal
    assert st.put(PAGE, source="incubator", url="https://x.in/p", content_type="text/html", personal=True) == ref, \
        "a re-fetch of the same page is recognised"
    meta = json.loads((tmp_path / "incubator" / "_index.jsonl").read_text().splitlines()[0])
    assert meta["personal"] is True and meta["redacted"] is True


def test_json_stays_json_and_binary_files_are_left_alone(tmp_path):
    import json
    st = FileRawStore(tmp_path)
    body = json.dumps({"data": {"records": [{"note": "call 9876543210", "mobile": 9876543210, "id": 7}]}}).encode()
    ref = st.put(body, source="upsm", url="https://x.in/api", content_type="application/json")
    out = json.loads(st.get(ref))
    assert out["data"]["records"][0]["id"] == 7 and "9876543210" not in json.dumps(out)
    xlsx = b"PK\x03\x04 9876543210 binary"
    ref = st.put(xlsx, source="mca_monthly", url="upload://mca/x.xlsx",
                 content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    assert st.get(ref) == xlsx and not ref.redacted


def test_a_stable_locator_replaces_an_unstable_url(tmp_path):
    st = FileRawStore(tmp_path)
    a = st.put(b"<p>same</p>", source="startinup", url="https://x.in/details/enc1", locator="profile:UPLC_1")
    b = st.put(b"<p>same</p>", source="startinup", url="https://x.in/details/enc2", locator="profile:UPLC_1")
    assert a.key == b.key, "the same profile under a re-encrypted URL is stored once"


def test_erasure_and_rewrite(tmp_path):
    st = FileRawStore(tmp_path)
    ref = st.put(b"<p>x</p>", source="s", url="https://x.in/p")
    st.rewrite(ref.key, b"<p>y</p>")
    assert st.get(ref) == b"<p>y</p>" and list(st.keys("s")) == [ref.key]
    assert st.delete(ref.key) and not st.delete(ref.key) and list(st.keys("s")) == []


def test_role_and_personal_addresses():
    from leadengine.privacy import email_is_personal
    assert not email_is_personal("info@acme.in") and not email_is_personal("Accounts@Acme.in")
    assert email_is_personal("rahul.verma@acme.in") and email_is_personal("info@gmail.com") and email_is_personal("garbage")

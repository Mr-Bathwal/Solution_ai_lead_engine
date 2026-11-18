"""Test fixtures. Database tests run against a throwaway mongod on a free port (or TEST_MONGODB_URI)."""
import glob
import os
import shutil
import socket
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

import pytest
from pymongo import MongoClient

from leadengine import schema

ATLAS = Path.home() / "Downloads" / "up-startup-intel"
MCA_DIR = Path.home() / "Downloads" / "solutionai-prospect-playbook" / "data" / "mca"


def _mongod_path():
    if os.environ.get("MONGOD_PATH"):
        return os.environ["MONGOD_PATH"]
    found = sorted(glob.glob(r"C:\Program Files\MongoDB\Server\*\bin\mongod.exe"), reverse=True)
    return found[0] if found else shutil.which("mongod")


@pytest.fixture(scope="session")
def mongo_uri():
    if os.environ.get("TEST_MONGODB_URI"):
        yield os.environ["TEST_MONGODB_URI"]
        return
    exe = _mongod_path()
    if not exe:
        pytest.skip("no mongod available")
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    dbpath = tempfile.mkdtemp(prefix="lead-engine-pytest-")
    proc = subprocess.Popen([exe, "--dbpath", dbpath, "--port", str(port), "--bind_ip", "127.0.0.1", "--quiet"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    uri = f"mongodb://127.0.0.1:{port}"
    for _ in range(100):
        try:
            MongoClient(uri, serverSelectionTimeoutMS=300).admin.command("ping")
            break
        except Exception:
            if proc.poll() is not None:
                raise RuntimeError(f"mongod exited with {proc.returncode}")
            time.sleep(0.1)
    yield uri
    proc.terminate()
    proc.wait(timeout=20)
    shutil.rmtree(dbpath, ignore_errors=True)


@pytest.fixture
def db(mongo_uri):
    client = MongoClient(mongo_uri)
    database = client[f"t_{uuid.uuid4().hex[:10]}"]
    schema.apply(database)
    yield database
    client.drop_database(database.name)
    client.close()


class FakeRaw:
    """In-memory raw store with the same interface as FileRawStore."""

    def __init__(self):
        from leadengine.rawstore import FileRawStore
        self._dir = tempfile.mkdtemp(prefix="raw-")
        self._store = FileRawStore(self._dir)

    def put(self, data, **kw):
        return self._store.put(data, **kw)

    def get(self, ref):
        return self._store.get(ref)


@pytest.fixture
def raw():
    r = FakeRaw()
    yield r
    shutil.rmtree(r._dir, ignore_errors=True)

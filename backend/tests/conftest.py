import os
import sys
import tempfile
from pathlib import Path

import pytest

BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

_TMP = tempfile.mkdtemp(prefix="cahangir_test_")
os.environ["CAHANGIR_DATA_DIR"] = os.path.join(_TMP, "data")
os.environ["CAHANGIR_BACKUP_DIR"] = os.path.join(_TMP, "backups")
os.environ["CAHANGIR_DB_PATH"] = os.path.join(_TMP, "data", "test.db")
os.environ["CAHANGIR_ADMIN_TOKEN"] = "test_admin_secret_123"
os.environ["CAHANGIR_BACKUP_INTERVAL_HOURS"] = "0"
for k in list(os.environ):
    if k.startswith("CAHANGIR_AI_") or k.endswith("_API_KEY") or k == "GITHUB_MODELS_TOKEN":
        del os.environ[k]

from fastapi.testclient import TestClient  # noqa: E402

from app.auth import reset_throttle  # noqa: E402
from app.database import init_db  # noqa: E402
from app.main import app  # noqa: E402

ADMIN = "test_admin_secret_123"


@pytest.fixture(scope="session")
def client():
    init_db()
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _reset_throttle():
    reset_throttle()
    yield


_counter = [0]


@pytest.fixture
def make_device(client):
    def _make(name="dev"):
        _counter[0] += 1
        dev_id = f"{name}_{_counter[0]}"
        r = client.post("/api/auth/register-device", json={"admin_token": ADMIN, "device_id": dev_id, "device_name": name})
        assert r.status_code == 200, r.text
        tok = r.json()["api_token"]
        return dev_id, {"Authorization": f"Bearer {tok}"}
    return _make

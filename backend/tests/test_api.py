import os
import sys
import unittest
from pathlib import Path

# Add backend directory to sys.path
BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

# Use an in-memory or temp SQLite DB for testing
os.environ["CAHANGIR_DB_PATH"] = str(BASE_DIR / "data" / "test_cahangir.db")
os.environ["CAHANGIR_ADMIN_TOKEN"] = "test_admin_secret_123"

from fastapi.testclient import TestClient
from app.database import init_db
from app.main import app


class CahangirBackendTests(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        init_db()
        cls.client = TestClient(app)
        cls.admin_token = "test_admin_secret_123"

    def test_01_health_check(self):
        res = self.client.get("/api/health")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["status"], "healthy")
        self.assertIn("cpu_percent", data)
        self.assertIn("ram_used_mb", data)

    def test_02_register_device(self):
        payload = {
            "admin_token": self.admin_token,
            "device_id": "galaxy_s25_test",
            "device_name": "Samsung Galaxy S25",
        }
        res = self.client.post("/api/auth/register-device", json=payload)
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["device_id"], "galaxy_s25_test")
        self.assertTrue(data["api_token"].startswith("cg_"))
        CahangirBackendTests.device_token = data["api_token"]

    def test_03_create_memory(self):
        headers = {"Authorization": f"Bearer {self.device_token}"}
        payload = {
            "id": "mem_test_1",
            "category": "personal",
            "fact_text": "Anamın ad günü 15 maydır.",
        }
        res = self.client.post("/api/memories", json=payload, headers=headers)
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["fact_text"], "Anamın ad günü 15 maydır.")

        # Test search
        res_search = self.client.get("/api/memories?q=15+may", headers=headers)
        self.assertEqual(res_search.status_code, 200)
        self.assertEqual(len(res_search.json()), 1)

    def test_04_create_reminder(self):
        headers = {"Authorization": f"Bearer {self.device_token}"}
        payload = {
            "id": "rem_test_1",
            "text": "Dərman qəbul et",
            "due": 1730000000000,
            "done": 0,
        }
        res = self.client.post("/api/reminders", json=payload, headers=headers)
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["text"], "Dərman qəbul et")

    def test_05_bidirectional_sync(self):
        headers = {"Authorization": f"Bearer {self.device_token}"}
        payload = {
            "device_id": "galaxy_s25_test",
            "client_timestamp": 0,
            "reminders": [
                {
                    "id": "rem_sync_2",
                    "user_id": "default",
                    "text": "Toplantı hesabatı",
                    "due": 1730500000000,
                    "snooze": None,
                    "done": 0,
                    "timer": 0,
                    "repeat": None,
                    "created_at": 1730000000000,
                    "updated_at": 1730000000000,
                    "deleted": 0,
                }
            ],
            "memories": [],
            "projects": [],
        }
        res = self.client.post("/api/sync", json=payload, headers=headers)
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertTrue(data["success"])
        self.assertEqual(data["applied_reminders"], 1)
        # Should pull rem_test_1 back in delta
        delta_reminders = data["delta"]["reminders"]
        self.assertTrue(any(r["id"] == "rem_test_1" for r in delta_reminders))


if __name__ == "__main__":
    unittest.main()

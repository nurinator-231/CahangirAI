"""API, authentication, CRUD and security tests."""
from conftest import ADMIN


def test_health_public(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    d = r.json()
    assert d["status"] == "healthy"
    assert d["schema_version"] == 2
    assert "server_rev" in d


def test_register_and_auth_errors(client, make_device):
    dev, h = make_device("phone")
    assert client.get("/api/tasks", headers=h).status_code == 200
    assert client.get("/api/tasks").status_code == 401
    assert client.get("/api/tasks", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert client.get("/api/tasks", headers={"Authorization": "Token x"}).status_code == 401
    r = client.post("/api/auth/register-device", json={"admin_token": "wrong", "device_id": "x", "device_name": "x"})
    assert r.status_code == 403


def test_register_with_admin_header(client):
    r = client.post("/api/auth/register-device", headers={"X-Admin-Token": ADMIN}, json={"device_id": "hdr_dev", "device_name": "Header"})
    assert r.status_code == 200
    assert r.json()["api_token"].startswith("cg_")


def test_bruteforce_throttle(client):
    for _ in range(10):
        client.get("/api/tasks", headers={"Authorization": "Bearer bad"})
    r = client.get("/api/tasks", headers={"Authorization": "Bearer bad"})
    assert r.status_code == 429


def test_revoke_blocks_device_and_rotates_mesh_key(client, make_device):
    dev, h = make_device("laptop")
    other, h2 = make_device("phone")
    k1 = client.get("/api/p2p/credentials", headers=h2).json()
    r = client.post("/api/auth/revoke-device", headers={"X-Admin-Token": ADMIN}, json={"device_id": dev})
    assert r.status_code == 200
    assert client.get("/api/tasks", headers=h).status_code == 403
    assert client.get("/api/p2p/credentials", headers=h).status_code == 403
    k2 = client.get("/api/p2p/credentials", headers=h2).json()
    assert k1["mesh_key"] != k2["mesh_key"] and k2["key_id"] == k1["key_id"] + 1
    assert len(k2["mesh_key"]) == 64


def test_admin_device_list_header_and_legacy_query(client, make_device):
    make_device("x")
    assert client.get("/api/auth/devices", headers={"X-Admin-Token": ADMIN}).status_code == 200
    assert client.get(f"/api/auth/devices?admin_token={ADMIN}").status_code == 200
    assert client.get("/api/auth/devices", headers={"X-Admin-Token": "bad"}).status_code == 403


def test_devices_list_exposes_p2p_info_not_secrets(client, make_device):
    dev, h = make_device("win")
    client.post("/api/sync", headers=h, json={"device_id": dev, "since_rev": 0, "p2p": {"hosts": ["100.64.1.2", "192.168.1.5"], "port": 8767, "platform": "windows", "app_version": "1.0.0"}})
    devs = client.get("/api/devices", headers=h).json()
    me = next(d for d in devs if d["device_id"] == dev)
    assert me["p2p_hosts"] == ["100.64.1.2", "192.168.1.5"] and me["p2p_port"] == 8767 and me["platform"] == "windows"
    assert all("token" not in k for d in devs for k in d)


def test_memory_crud_and_search(client, make_device):
    _, h = make_device()
    r = client.post("/api/memories", headers=h, json={"id": "mem_test_1", "category": "personal", "fact_text": "Anamın ad günü 15 maydır."})
    assert r.status_code == 200 and r.json()["fact_text"] == "Anamın ad günü 15 maydır."
    res = client.get("/api/memories?q=15+may", headers=h).json()
    assert [m["id"] for m in res] == ["mem_test_1"]
    assert client.delete("/api/memories/mem_test_1", headers=h).status_code == 200
    assert client.get("/api/memories?q=15+may", headers=h).json() == []
    assert client.get("/api/memories?q=15+may&include_deleted=true", headers=h).json()[0]["deleted"] == 1


def test_reminder_crud_including_update(client, make_device):
    _, h = make_device()
    r = client.post("/api/reminders", headers=h, json={"id": "rem_u1", "text": "Dərman qəbul et", "due": 1730000000000, "repeat": {"type": "daily"}})
    assert r.status_code == 200
    assert r.json()["repeat"] == '{"type":"daily"}'
    r = client.put("/api/reminders/rem_u1", headers=h, json={"text": "Dərman (axşam)", "due": 1730000600000})
    assert r.status_code == 200 and r.json()["text"] == "Dərman (axşam)" and r.json()["due"] == 1730000600000
    assert client.put("/api/reminders/rem_u1/snooze?minutes=5", headers=h).status_code == 200
    assert client.put("/api/reminders/rem_u1/complete", headers=h).status_code == 200
    item = client.get("/api/reminders/rem_u1", headers=h).json()
    assert item["done"] == 1 and item["snooze"] is None
    assert client.put("/api/reminders/missing", headers=h, json={"text": "x"}).status_code == 404


def test_task_validation(client, make_device):
    _, h = make_device()
    assert client.post("/api/tasks", headers=h, json={"title": "x", "priority": "super"}).status_code == 422
    assert client.post("/api/tasks", headers=h, json={"title": "x", "deadline": "tomorrow"}).status_code == 422
    assert client.post("/api/events", headers=h, json={"title": "x", "recurrence": "{not json"}).status_code == 422
    r = client.post("/api/tasks", headers=h, json={"title": "Programming assignment", "priority": "high", "estimated_minutes": 120, "deadline": 1731100000000})
    assert r.status_code == 200
    t = r.json()
    assert t["id"].startswith("tsk_") and t["status"] == "todo" and t["server_rev"] > 0


def test_cors_disabled_by_default(client):
    r = client.options("/api/health", headers={"Origin": "http://evil.example", "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in {k.lower() for k in r.headers}


def test_backup_endpoint_requires_admin(client):
    assert client.post("/api/backup").status_code == 403
    r = client.post("/api/backup", headers={"X-Admin-Token": ADMIN})
    assert r.status_code == 200 and r.json()["success"]
    assert len(client.get("/api/backups", headers={"X-Admin-Token": ADMIN}).json()) >= 1

"""Synchronization: v2 revision protocol, conflicts, tombstones, legacy v1 clients."""


def sync(client, h, dev, since_rev=0, **items):
    body = {"device_id": dev, "since_rev": since_rev}
    body.update(items)
    r = client.post("/api/sync", headers=h, json=body)
    assert r.status_code == 200, r.text
    return r.json()


def task(i, title, updated_at, **kw):
    d = {"id": i, "title": title, "created_at": 1000, "updated_at": updated_at, "deleted": 0}
    d.update(kw)
    return d


def pull_all(client, h, dev, since_rev):
    """Follow has_more until fully synced."""
    out = {}
    while True:
        res = sync(client, h, dev, since_rev)
        for k, v in res["delta"].items():
            if isinstance(v, list):
                out.setdefault(k, []).extend(v)
        since_rev = res["server_rev"]
        if not res["has_more"]:
            return out, since_rev


def test_create_on_a_appears_on_b_then_edit_propagates(client, make_device):
    a, ha = make_device("android")
    b, hb = make_device("windows")
    _, cur_b = pull_all(client, hb, b, 0)
    r = sync(client, ha, a, 0, tasks=[task("t_ab", "Assignment", 5000, estimated_minutes=120)])
    rev = r["acks"]["tasks"]["t_ab"]
    assert r["applied"]["tasks"] == 1 and rev > 0
    # A's own push is acknowledged, not echoed back.
    assert all(t["id"] != "t_ab" for t in r["delta"]["tasks"])
    rb = sync(client, hb, b, cur_b)
    got = [t for t in rb["delta"]["tasks"] if t["id"] == "t_ab"]
    assert got and got[0]["title"] == "Assignment" and got[0]["server_rev"] == rev
    cur_b = rb["server_rev"]
    # B edits on top of the version it saw.
    rb2 = sync(client, hb, b, cur_b, tasks=[task("t_ab", "Assignment v2", 6000, base_rev=rev, estimated_minutes=90)])
    assert rb2["conflicts"] == []
    ra = sync(client, ha, a, r["server_rev"])
    got = [t for t in ra["delta"]["tasks"] if t["id"] == "t_ab"]
    assert got[0]["title"] == "Assignment v2" and got[0]["estimated_minutes"] == 90


def test_clock_skew_does_not_lose_changes(client, make_device):
    """A device whose clock is far behind must still have its edits delivered.
    (The v1 protocol filtered by device timestamps and missed these.)"""
    a, ha = make_device()
    b, hb = make_device()
    _, cur_b = pull_all(client, hb, b, 0)
    sync(client, ha, a, 0, tasks=[task("t_skew", "Skewed", 10)])  # updated_at in 1970
    rb = sync(client, hb, b, cur_b)
    assert any(t["id"] == "t_skew" for t in rb["delta"]["tasks"])


def test_concurrent_edit_conflict_newer_wins_and_is_logged(client, make_device):
    a, ha = make_device()
    b, hb = make_device()
    r = sync(client, ha, a, 0, tasks=[task("t_c", "Base", 1000)])
    base = r["acks"]["tasks"]["t_c"]
    # Both edit from the same base revision; B's edit is newer.
    sync(client, ha, a, r["server_rev"], tasks=[task("t_c", "Edit A", 2000, base_rev=base)])
    rb = sync(client, hb, b, 0, tasks=[task("t_c", "Edit B", 3000, base_rev=base)])
    assert rb["conflicts"] and rb["conflicts"][0]["winner"] == "client"
    # Now A pushes an OLDER concurrent edit: server keeps B's, sends it back to A.
    ra = sync(client, ha, a, 0, tasks=[task("t_c", "Late A", 2500, base_rev=base)])
    assert ra["conflicts"][0]["winner"] == "server"
    back = [t for t in ra["delta"]["tasks"] if t["id"] == "t_c"]
    assert back and back[0]["title"] == "Edit B"
    conflicts = client.get("/api/sync/conflicts", headers=ha).json()
    mine = [c for c in conflicts if c["entity_id"] == "t_c"]
    assert len(mine) == 2
    assert {c["discarded"]["title"] for c in mine} == {"Edit A", "Late A"}
    assert client.post(f"/api/sync/conflicts/{mine[0]['id']}/resolve", headers=ha).status_code == 200


def test_confirmed_commitment_not_overwritten_by_concurrent_unconfirmed_edit(client, make_device):
    a, ha = make_device()
    b, hb = make_device()
    ev = {"id": "e_conf", "title": "English lesson", "start_at": 1_800_000_000_000, "confirmed": 1, "created_at": 1, "updated_at": 1000}
    r = sync(client, ha, a, 0, events=[ev])
    base = r["acks"]["events"]["e_conf"]
    sync(client, ha, a, r["server_rev"], events=[dict(ev, title="English lesson (room 4)", updated_at=2000, base_rev=base)])
    # A concurrent, newer but UNconfirmed (e.g. AI-suggested) version must not win.
    rb = sync(client, hb, b, 0, events=[dict(ev, title="AI moved it", start_at=1_800_000_360_000, confirmed=0, updated_at=9000, base_rev=base)])
    assert rb["conflicts"][0]["winner"] == "server" and rb["conflicts"][0]["reason"] == "protected_confirmed"
    item = client.get("/api/events/e_conf", headers=ha).json()
    assert item["title"] == "English lesson (room 4)" and item["confirmed"] == 1


def test_tombstone_deletion_propagates(client, make_device):
    a, ha = make_device()
    b, hb = make_device()
    r = sync(client, ha, a, 0, tasks=[task("t_del", "Delete me", 1000)])
    rev = r["acks"]["tasks"]["t_del"]
    _, cur_b = pull_all(client, hb, b, 0)
    sync(client, ha, a, r["server_rev"], tasks=[task("t_del", "Delete me", 2000, deleted=1, base_rev=rev)])
    rb = sync(client, hb, b, cur_b)
    got = [t for t in rb["delta"]["tasks"] if t["id"] == "t_del"]
    assert got and got[0]["deleted"] == 1


def test_duplicate_push_is_noop(client, make_device):
    a, ha = make_device()
    t = task("t_dup", "Once", 1000)
    r1 = sync(client, ha, a, 0, tasks=[t])
    r2 = sync(client, ha, a, r1["server_rev"], tasks=[dict(t, base_rev=r1["acks"]["tasks"]["t_dup"])])
    assert r2["applied"]["tasks"] == 0
    assert r2["acks"]["tasks"]["t_dup"] == r1["acks"]["tasks"]["t_dup"]


def test_invalid_item_rejected_others_applied(client, make_device):
    a, ha = make_device()
    r = sync(client, ha, a, 0, tasks=[task("t_ok", "ok", 1), {"id": "t_bad", "title": "x", "priority": "nope", "updated_at": 1}])
    assert r["applied"]["tasks"] == 1
    assert r["rejected"][0]["id"] == "t_bad"


def test_paging_has_more(client, make_device, monkeypatch):
    import app.routers.sync_router as sr
    import app.sync_engine as se

    a, ha = make_device()
    sync(client, ha, a, 0, clipboard_items=[{"id": f"c{i}", "text": f"t{i}", "hash": str(i), "updated_at": i + 1, "created_at": i + 1} for i in range(7)])
    orig = se.delta_since_rev
    monkeypatch.setattr(sr, "delta_since_rev", lambda conn, since, ents: orig(conn, since, ents, limit=3))
    b, hb = make_device()
    rows, _ = pull_all(client, hb, b, 0)
    ids = [c["id"] for c in rows["clipboard_items"]]
    assert {f"c{i}" for i in range(7)} <= set(ids)
    assert len(ids) == len(set(ids))


def test_legacy_v1_client_compatible(client, make_device):
    """An already-installed v1 Android client keeps working unchanged."""
    a, ha = make_device("old_android")
    client.post("/api/reminders", headers=ha, json={"id": "rem_legacy_srv", "text": "Server side", "due": 1730000000000})
    payload = {
        "device_id": a,
        "client_timestamp": 0,
        "reminders": [{"id": "rem_sync_2", "user_id": "default", "text": "Toplantı hesabatı", "due": 1730500000000, "snooze": None,
                       "done": 0, "timer": 0, "repeat": None, "created_at": 1730000000000, "updated_at": 1730000000000, "deleted": 0}],
        "memories": [],
        "projects": [],
    }
    r = client.post("/api/sync", headers=ha, json=payload)
    assert r.status_code == 200
    d = r.json()
    assert d["success"] and d["applied_reminders"] == 1 and d["protocol"] == 1
    assert any(x["id"] == "rem_legacy_srv" for x in d["delta"]["reminders"])
    assert "tasks" not in d["delta"]
    # The v1 item is visible to v2 clients through the revision cursor.
    b, hb = make_device()
    rows, _ = pull_all(client, hb, b, 0)
    assert any(x["id"] == "rem_sync_2" for x in rows["reminders"])


def test_legacy_pull_endpoint(client, make_device):
    a, ha = make_device()
    r = client.get("/api/sync/pull?since=0", headers=ha)
    assert r.status_code == 200 and "reminders" in r.json()
    r = client.get("/api/sync/pull?since_rev=0", headers=ha)
    assert r.status_code == 200 and "tasks" in r.json()


def test_rest_write_visible_to_sync(client, make_device):
    a, ha = make_device()
    b, hb = make_device()
    _, cur = pull_all(client, hb, b, 0)
    client.post("/api/tasks", headers=ha, json={"id": "t_rest", "title": "From REST"})
    rb = sync(client, hb, b, cur)
    assert any(t["id"] == "t_rest" for t in rb["delta"]["tasks"])

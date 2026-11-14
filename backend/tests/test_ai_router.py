"""AI router: fallback, rate limits, quota exhaustion, free-tier policy, validation.
All HTTP traffic goes to an in-process mock transport; no real provider is called."""
import json

import httpx
import pytest

from app.ai import planner_parse
from app.ai.router import AIRouter, NoProviderAvailable, set_router
from app.database import get_db

KEYS = {"GROQ_API_KEY": "k1", "GEMINI_API_KEY": "k2", "OPENROUTER_API_KEY": "k3", "CEREBRAS_API_KEY": "k4"}


def ok_body(text="hello", model="m"):
    return {"model": model, "choices": [{"message": {"content": text}}], "usage": {"prompt_tokens": 3, "completion_tokens": 2}}


class Recorder:
    def __init__(self, behaviours):
        self.behaviours = behaviours  # host -> list of responses (callables or Response)
        self.calls = []

    def __call__(self, request: httpx.Request):
        host = request.url.host
        self.calls.append((host, json.loads(request.content)))
        queue = self.behaviours.get(host)
        if not queue:
            raise AssertionError(f"unexpected call to {host}")
        r = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(r, Exception):
            raise r
        return r


def make_router(env, behaviours):
    rec = Recorder(behaviours)
    client = httpx.Client(transport=httpx.MockTransport(rec))
    return AIRouter(env=env, client=client, sleep=lambda s: None), rec


@pytest.fixture(autouse=True)
def clean_ai_state(client):
    with get_db() as conn:
        conn.execute("DELETE FROM ai_usage;")
        conn.execute("DELETE FROM ai_provider_state;")
    yield
    set_router(None)


MSG = [{"role": "user", "content": "hi"}]


def test_no_providers_enabled_raises():
    r, _ = make_router({}, {})
    with pytest.raises(NoProviderAvailable):
        r.complete("chat", MSG)


def test_provider_with_key_but_not_enabled_is_never_called():
    r, rec = make_router(dict(KEYS), {})
    with pytest.raises(NoProviderAvailable):
        r.complete("chat", MSG)
    assert rec.calls == []


def test_fallback_on_rate_limit_then_cooldown():
    env = dict(KEYS, CAHANGIR_AI_PROVIDERS="groq,gemini")
    r, rec = make_router(env, {
        "api.groq.com": [httpx.Response(429, headers={"retry-after": "30"}, json={"error": {"message": "Rate limit reached for requests per minute"}})],
        "generativelanguage.googleapis.com": [httpx.Response(200, json=ok_body("from gemini"))],
    })
    res = r.complete("chat", MSG)
    assert res.provider == "gemini" and res.text == "from gemini"
    st = {p["name"]: p for p in r.status()}
    assert st["groq"]["status"] == "rate_limited" and not st["groq"]["available"]
    # Next call skips groq entirely while it cools down.
    rec.calls.clear()
    r.complete("chat", MSG)
    assert [h for h, _ in rec.calls] == ["generativelanguage.googleapis.com"]


def test_quota_exhaustion_disables_until_tomorrow_and_402_never_retried():
    env = dict(KEYS, CAHANGIR_AI_PROVIDERS="gemini,groq")
    r, rec = make_router(env, {
        "generativelanguage.googleapis.com": [httpx.Response(429, json={"error": {"status": "RESOURCE_EXHAUSTED", "message": "Quota exceeded for metric: requests per day"}})],
        "api.groq.com": [httpx.Response(402, json={"error": {"message": "payment required"}})],
    })
    with pytest.raises(NoProviderAvailable) as ei:
        r.complete("parse", MSG)
    assert len(rec.calls) == 2  # exactly one call each, no retries
    st = {p["name"]: p for p in r.status()}
    assert st["gemini"]["status"] == "quota_exhausted"
    assert st["groq"]["status"] == "quota_exhausted"
    assert any("quota" in a.get("error", "") for a in ei.value.attempts)


def test_transient_error_retried_once_then_fallback():
    env = dict(KEYS, CAHANGIR_AI_PROVIDERS="groq,cerebras")
    r, rec = make_router(env, {
        "api.groq.com": [httpx.Response(503), httpx.Response(503)],
        "api.cerebras.ai": [httpx.Response(200, json=ok_body("ok"))],
    })
    res = r.complete("chat", MSG)
    assert res.provider == "cerebras"
    assert [h for h, _ in rec.calls] == ["api.groq.com", "api.groq.com", "api.cerebras.ai"]


def test_timeout_falls_back():
    env = dict(KEYS, CAHANGIR_AI_PROVIDERS="groq,gemini")
    r, _ = make_router(env, {
        "api.groq.com": [httpx.ReadTimeout("t"), httpx.ReadTimeout("t")],
        "generativelanguage.googleapis.com": [httpx.Response(200, json=ok_body())],
    })
    assert r.complete("chat", MSG).provider == "gemini"


def test_openrouter_paid_model_refused_without_any_call():
    env = dict(KEYS, CAHANGIR_AI_PROVIDERS="openrouter", CAHANGIR_AI_OPENROUTER_MODEL="openai/gpt-4o")
    r, rec = make_router(env, {})
    with pytest.raises(NoProviderAvailable) as ei:
        r.complete("chat", MSG)
    assert rec.calls == []
    assert "free" in ei.value.attempts[0]["skipped"]
    st = {p["name"]: p for p in r.status()}
    assert st["openrouter"]["policy_ok"] is False


def test_openrouter_free_model_used():
    env = dict(KEYS, CAHANGIR_AI_PROVIDERS="openrouter")
    r, rec = make_router(env, {"openrouter.ai": [httpx.Response(200, json=ok_body("free!"))]})
    assert r.complete("chat", MSG).text == "free!"
    assert rec.calls[0][1]["model"].endswith(":free")


def test_daily_budget_enforced_locally_and_cannot_be_raised():
    env = dict(KEYS, CAHANGIR_AI_PROVIDERS="groq", CAHANGIR_AI_GROQ_RPD="2")
    r, rec = make_router(env, {"api.groq.com": [httpx.Response(200, json=ok_body())]})
    r.complete("chat", MSG)
    r.complete("chat", MSG)
    with pytest.raises(NoProviderAvailable):
        r.complete("chat", MSG)
    assert len(rec.calls) == 2
    env2 = dict(KEYS, CAHANGIR_AI_PROVIDERS="groq", CAHANGIR_AI_GROQ_RPD="999999")
    r2, _ = make_router(env2, {})
    assert {p["name"]: p for p in r2.status()}["groq"]["limits"]["rpd"] == 900


def test_usage_tracked():
    env = dict(KEYS, CAHANGIR_AI_PROVIDERS="groq")
    r, _ = make_router(env, {"api.groq.com": [httpx.Response(200, json=ok_body())]})
    r.complete("chat", MSG)
    u = {p["name"]: p for p in r.status()}["groq"]["usage_today"]
    assert u["requests"] == 1 and u["prompt_tokens"] == 3 and u["completion_tokens"] == 2


def test_parse_validation_rejects_hallucinated_deadline():
    text = "I have a programming assignment due Friday. I need approximately two hours. I also have English lessons tomorrow at 10 AM."
    model_out = json.dumps({
        "tasks": [
            {"title": "Programming assignment", "category": "study", "priority": "medium", "deadline": "2026-11-20T23:59",
             "deadline_text": "due Friday", "estimated_minutes": 120, "estimate_text": "approximately two hours"},
            {"title": "Buy milk", "deadline": "2026-11-16T10:00", "deadline_text": "by Monday morning", "estimated_minutes": 15, "estimate_text": "15 minutes"},
        ],
        "events": [
            {"title": "English lessons", "start": "2026-11-15T10:00", "time_text": "tomorrow at 10 AM", "duration_minutes": None},
            {"title": "Dentist", "start": "2026-11-17T09:00", "time_text": "Tuesday 9am"},
        ],
        "questions": [],
    })
    out = planner_parse.validate(model_out, text, 240, 0)
    t1, t2 = out["tasks"]
    assert t1["deadline"] is not None and t1["estimated_minutes"] == 120
    assert t2["deadline"] is None and t2["estimated_minutes"] is None  # invented -> dropped
    assert [e["title"] for e in out["events"]] == ["English lessons"]  # invented commitment dropped
    assert out["events"][0]["end_at"] is None
    assert any("Buy milk" in q for q in out["questions"])
    assert any("Dentist" in q for q in out["questions"])
    assert any("English lessons" in q and "long" in q for q in out["questions"])


def test_parse_endpoint_503_without_providers(client, make_device):
    _, h = make_device()
    set_router(AIRouter(env={}))
    r = client.post("/api/ai/parse", headers=h, json={"text": "task", "now_local": "2026-11-14T10:00", "tz_offset_minutes": 240})
    assert r.status_code == 503
    assert r.json()["detail"]["error"] == "ai_unavailable"


def test_parse_endpoint_with_mock_provider(client, make_device):
    _, h = make_device()
    out = {"tasks": [{"title": "Report", "deadline": "2026-11-20T17:00", "deadline_text": "Friday 5pm", "estimated_minutes": 60, "estimate_text": "an hour"}], "events": [], "questions": []}
    env = dict(KEYS, CAHANGIR_AI_PROVIDERS="groq")
    r, rec = make_router(env, {"api.groq.com": [httpx.Response(200, json=ok_body(json.dumps(out)))]})
    set_router(r)
    res = client.post("/api/ai/parse", headers=h, json={"text": "Report by Friday 5pm, takes an hour", "now_local": "2026-11-14T10:00", "tz_offset_minutes": 240})
    assert res.status_code == 200, res.text
    d = res.json()
    assert d["provider"] == "groq" and d["tasks"][0]["deadline"] == 1795179600000  # 2026-11-20 17:00 +04:00
    assert rec.calls[0][1]["response_format"] == {"type": "json_object"}
    st = client.get("/api/ai/providers", headers=h).json()
    assert all("k1" not in json.dumps(p) for p in st["providers"])  # keys never exposed

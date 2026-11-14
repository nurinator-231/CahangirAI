"""AI Router: chooses a free-tier provider per task, enforces budgets, detects rate
limits/quota exhaustion, retries transient failures and falls back to the next
eligible provider. Core features never depend on it: callers handle
NoProviderAvailable by using the deterministic (non-AI) code path."""
import logging
import os
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from typing import Callable, Dict, List, Optional

from app.ai.providers import (
    DEFAULT_PROVIDERS,
    AuthFailed,
    ChatResult,
    PolicyViolation,
    ProviderError,
    QuotaExhausted,
    RateLimited,
    Transient,
    build_provider,
    load_provider_config,
)
from app.database import get_db

logger = logging.getLogger("cahangir.ai")

TASK_TYPES = ("parse", "chat", "plan")
# Default preference per task: fast/structured-output models first for parsing.
TASK_PREFERENCE = {
    "parse": ["groq", "cerebras", "gemini", "mistral", "github", "openrouter"],
    "plan": ["gemini", "groq", "cerebras", "mistral", "github", "openrouter"],
    "chat": ["gemini", "groq", "mistral", "cerebras", "github", "openrouter"],
}


class NoProviderAvailable(Exception):
    def __init__(self, message: str, attempts: List[dict]):
        super().__init__(message)
        self.attempts = attempts


def _utc_day() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _next_utc_midnight_ms() -> int:
    now = time.time()
    return int((now - now % 86400 + 86400) * 1000)


class AIRouter:
    def __init__(self, env=None, client=None, sleep: Callable[[float], None] = time.sleep):
        self.env = env if env is not None else os.environ
        self.client = client
        self.sleep = sleep
        self._minute = defaultdict(deque)
        self._lock = threading.Lock()

    # ---------- configuration ----------
    def enabled_names(self) -> List[str]:
        raw = self.env.get("CAHANGIR_AI_PROVIDERS", "")
        names = [n.strip().lower() for n in raw.split(",") if n.strip()]
        return [n for n in names if n in DEFAULT_PROVIDERS]

    def order_for(self, task: str) -> List[str]:
        enabled = self.enabled_names()
        override = self.env.get(f"CAHANGIR_AI_ORDER_{task.upper()}", "")
        if override:
            pref = [n.strip().lower() for n in override.split(",") if n.strip()]
        elif self.env.get("CAHANGIR_AI_PROVIDERS"):
            # Explicit global order given by the operator is respected as-is.
            return enabled
        else:
            pref = TASK_PREFERENCE.get(task, [])
        return [n for n in pref if n in enabled] + [n for n in enabled if n not in pref]

    # ---------- state ----------
    def _state(self, conn, name):
        row = conn.execute("SELECT * FROM ai_provider_state WHERE provider = ?;", (name,)).fetchone()
        return dict(row) if row else {"provider": name, "cooldown_until": 0, "status": "ok", "detail": ""}

    def _set_state(self, name, cooldown_until, status, detail):
        with get_db() as conn:
            conn.execute(
                """INSERT INTO ai_provider_state (provider, cooldown_until, status, detail) VALUES (?, ?, ?, ?)
                   ON CONFLICT(provider) DO UPDATE SET cooldown_until = excluded.cooldown_until,
                   status = excluded.status, detail = excluded.detail;""",
                (name, int(cooldown_until), status, detail[:300]),
            )

    def _usage_today(self, conn, name) -> dict:
        row = conn.execute("SELECT * FROM ai_usage WHERE provider = ? AND day = ?;", (name, _utc_day())).fetchone()
        return dict(row) if row else {"requests": 0, "failures": 0, "prompt_tokens": 0, "completion_tokens": 0, "last_error": ""}

    def _record(self, name, ok: bool, result: Optional[ChatResult] = None, error: str = ""):
        with get_db() as conn:
            conn.execute(
                """INSERT INTO ai_usage (provider, day, requests, failures, prompt_tokens, completion_tokens, last_error)
                   VALUES (?, ?, 1, ?, ?, ?, ?)
                   ON CONFLICT(provider, day) DO UPDATE SET requests = requests + 1,
                   failures = failures + excluded.failures,
                   prompt_tokens = prompt_tokens + excluded.prompt_tokens,
                   completion_tokens = completion_tokens + excluded.completion_tokens,
                   last_error = CASE WHEN excluded.last_error != '' THEN excluded.last_error ELSE last_error END;""",
                (name, _utc_day(), 0 if ok else 1, result.prompt_tokens if result else 0,
                 result.completion_tokens if result else 0, error[:300]),
            )

    def _budget_ok(self, name, cfg) -> Optional[str]:
        now = time.time()
        with self._lock:
            q = self._minute[name]
            while q and q[0] < now - 60:
                q.popleft()
            if len(q) >= cfg.rpm:
                return "per-minute free budget reached"
        with get_db() as conn:
            used = self._usage_today(conn, name)["requests"]
            st = self._state(conn, name)
        if used >= cfg.rpd:
            return "daily free budget reached"
        if st["cooldown_until"] > int(now * 1000):
            return f"cooling down ({st['status']})"
        return None

    def _take_slot(self, name):
        with self._lock:
            self._minute[name].append(time.time())

    # ---------- main entry ----------
    def complete(self, task: str, messages: List[Dict[str, str]], json_mode: bool = False, timeout: float = 30.0) -> ChatResult:
        if task not in TASK_TYPES:
            task = "chat"
        order = self.order_for(task)
        attempts: List[dict] = []
        if not order:
            raise NoProviderAvailable("No AI provider is enabled (set CAHANGIR_AI_PROVIDERS and an API key).", attempts)
        for name in order:
            try:
                provider = build_provider(name, self.env, client=self.client)
            except PolicyViolation as e:
                attempts.append({"provider": name, "skipped": str(e)})
                continue
            cfg = provider.cfg
            reason = self._budget_ok(name, cfg)
            if reason:
                attempts.append({"provider": name, "skipped": reason})
                continue
            for attempt in range(2):
                self._take_slot(name)
                try:
                    result = provider.chat(messages, json_mode=json_mode, timeout=timeout)
                except Transient as e:
                    self._record(name, False, error=str(e))
                    attempts.append({"provider": name, "error": str(e)})
                    if attempt == 0:
                        self.sleep(1.0)
                        continue
                    self._set_state(name, time.time() * 1000 + 60_000, "unavailable", str(e))
                    break
                except RateLimited as e:
                    self._record(name, False, error=str(e))
                    wait = e.retry_after_s if e.retry_after_s else 60
                    self._set_state(name, time.time() * 1000 + wait * 1000, "rate_limited", str(e))
                    attempts.append({"provider": name, "error": str(e)})
                    break
                except QuotaExhausted as e:
                    self._record(name, False, error=str(e))
                    self._set_state(name, _next_utc_midnight_ms(), "quota_exhausted", str(e))
                    attempts.append({"provider": name, "error": str(e)})
                    break
                except AuthFailed as e:
                    self._record(name, False, error=str(e))
                    self._set_state(name, time.time() * 1000 + 3600_000, "auth_failed", str(e))
                    attempts.append({"provider": name, "error": str(e)})
                    break
                except (PolicyViolation, ProviderError) as e:
                    self._record(name, False, error=str(e))
                    attempts.append({"provider": name, "error": str(e)})
                    break
                else:
                    self._record(name, True, result=result)
                    self._set_state(name, 0, "ok", "")
                    result.attempts = attempts  # type: ignore[attr-defined]
                    return result
        raise NoProviderAvailable("All enabled free AI providers are unavailable right now.", attempts)

    def status(self) -> List[dict]:
        enabled = self.enabled_names()
        out = []
        with get_db() as conn:
            for name, base in DEFAULT_PROVIDERS.items():
                cfg = load_provider_config(name, self.env)
                usage = self._usage_today(conn, name)
                st = self._state(conn, name)
                key_present = bool(self.env.get(cfg.key_env, "").strip())
                policy_ok = True
                policy_error = ""
                if name == "openrouter" and not cfg.model.endswith(":free"):
                    policy_ok, policy_error = False, "model is not a ':free' model"
                out.append({
                    "name": name,
                    "label": cfg.label,
                    "enabled": name in enabled,
                    "key_configured": key_present,
                    "key_env": cfg.key_env,
                    "model": cfg.model,
                    "policy_ok": policy_ok,
                    "policy_error": policy_error,
                    "limits": {"rpm": cfg.rpm, "rpd": cfg.rpd},
                    "usage_today": {k: usage[k] for k in ("requests", "failures", "prompt_tokens", "completion_tokens")},
                    "status": st["status"] if st["cooldown_until"] > time.time() * 1000 else "ok",
                    "cooldown_until": st["cooldown_until"] or None,
                    "last_error": usage.get("last_error", ""),
                    "free_tier_note": cfg.free_tier_note,
                    "signup_url": cfg.signup_url,
                    "available": name in enabled and key_present and policy_ok
                    and st["cooldown_until"] <= time.time() * 1000 and usage["requests"] < cfg.rpd,
                })
        return out


_router: Optional[AIRouter] = None


def get_router() -> AIRouter:
    global _router
    if _router is None:
        _router = AIRouter()
    return _router


def set_router(r: Optional[AIRouter]):
    global _router
    _router = r

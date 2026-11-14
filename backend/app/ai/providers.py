"""AI provider adapters.

Every adapter implements `chat(messages, json_mode, timeout) -> ChatResult` and maps
provider-specific failures onto a small set of error classes the router understands.

FREE-TIER POLICY (enforced in code, not just documented):
  * A provider is only used when it is explicitly listed in CAHANGIR_AI_PROVIDERS and
    its API key is configured. There is no implicit or paid fallback.
  * OpenRouter: only model ids ending in ":free" are accepted (free models never bill).
  * Per-provider request budgets (per minute / per day) default to values at or below
    the providers' published free-tier limits, so usage stays inside the free tier even
    if a key belongs to an account where billing was enabled elsewhere.
  * HTTP 402 / "insufficient_quota" / billing errors disable the provider for the rest
    of the day; they are never retried.
"""
import os
from dataclasses import dataclass, field
from typing import Dict, List, Optional

import httpx


class ProviderError(Exception):
    kind = "error"

    def __init__(self, message: str, retry_after_s: Optional[float] = None):
        super().__init__(message)
        self.retry_after_s = retry_after_s


class RateLimited(ProviderError):
    kind = "rate_limited"


class QuotaExhausted(ProviderError):
    kind = "quota_exhausted"


class AuthFailed(ProviderError):
    kind = "auth_failed"


class Transient(ProviderError):
    kind = "transient"


class BadResponse(ProviderError):
    kind = "bad_response"


class PolicyViolation(ProviderError):
    kind = "policy"


@dataclass
class ChatResult:
    text: str
    provider: str
    model: str
    prompt_tokens: int = 0
    completion_tokens: int = 0


@dataclass
class ProviderConfig:
    name: str
    label: str
    base_url: str
    model: str
    key_env: str
    rpm: int
    rpd: int
    free_tier_note: str
    signup_url: str
    json_mode: bool = True
    extra_headers: Dict[str, str] = field(default_factory=dict)


# Defaults are conservative (at or below published free-tier limits) and every value
# can be overridden through environment variables, because providers change their
# model line-ups over time:  CAHANGIR_AI_<NAME>_MODEL / _RPM / _RPD / _BASE_URL
DEFAULT_PROVIDERS: Dict[str, ProviderConfig] = {
    "gemini": ProviderConfig(
        name="gemini",
        label="Google Gemini (AI Studio free tier)",
        base_url="https://generativelanguage.googleapis.com/v1beta/openai",
        model="gemini-2.5-flash",
        key_env="GEMINI_API_KEY",
        rpm=8,
        rpd=200,
        free_tier_note="Create the key in Google AI Studio in a project WITHOUT Cloud Billing; free-tier keys cannot be charged.",
        signup_url="https://aistudio.google.com/apikey",
    ),
    "groq": ProviderConfig(
        name="groq",
        label="Groq (free plan)",
        base_url="https://api.groq.com/openai/v1",
        model="llama-3.3-70b-versatile",
        key_env="GROQ_API_KEY",
        rpm=25,
        rpd=900,
        free_tier_note="Free plan; do not upgrade the organization to Developer tier.",
        signup_url="https://console.groq.com/keys",
    ),
    "cerebras": ProviderConfig(
        name="cerebras",
        label="Cerebras Inference (free tier)",
        base_url="https://api.cerebras.ai/v1",
        model="llama-3.3-70b",
        key_env="CEREBRAS_API_KEY",
        rpm=25,
        rpd=1000,
        free_tier_note="Free tier; no payment method required.",
        signup_url="https://cloud.cerebras.ai",
    ),
    "mistral": ProviderConfig(
        name="mistral",
        label="Mistral La Plateforme (Experiment plan)",
        base_url="https://api.mistral.ai/v1",
        model="mistral-small-latest",
        key_env="MISTRAL_API_KEY",
        rpm=20,
        rpd=500,
        free_tier_note="Choose the free 'Experiment' plan; do not subscribe to Scale.",
        signup_url="https://console.mistral.ai/api-keys",
    ),
    "openrouter": ProviderConfig(
        name="openrouter",
        label="OpenRouter (':free' models only)",
        base_url="https://openrouter.ai/api/v1",
        model="meta-llama/llama-3.3-70b-instruct:free",
        key_env="OPENROUTER_API_KEY",
        rpm=15,
        rpd=45,
        free_tier_note="Only ':free' model variants are allowed by Cahangir; they are never billed.",
        signup_url="https://openrouter.ai/keys",
        json_mode=False,
        extra_headers={"X-Title": "Cahangir"},
    ),
    "github": ProviderConfig(
        name="github",
        label="GitHub Models (free, rate limited)",
        base_url="https://models.github.ai/inference",
        model="openai/gpt-4o-mini",
        key_env="GITHUB_MODELS_TOKEN",
        rpm=10,
        rpd=120,
        free_tier_note="Fine-grained PAT with 'models:read'. Leave paid usage for GitHub Models disabled.",
        signup_url="https://github.com/settings/tokens",
    ),
}


def load_provider_config(name: str, env=os.environ) -> ProviderConfig:
    base = DEFAULT_PROVIDERS[name]
    up = name.upper()
    cfg = ProviderConfig(**{**base.__dict__})
    cfg.model = env.get(f"CAHANGIR_AI_{up}_MODEL", cfg.model)
    cfg.base_url = env.get(f"CAHANGIR_AI_{up}_BASE_URL", cfg.base_url).rstrip("/")
    # Budgets can only be lowered below the free-tier defaults, never raised.
    for attr in ("rpm", "rpd"):
        v = env.get(f"CAHANGIR_AI_{up}_{attr.upper()}")
        if v and v.isdigit():
            setattr(cfg, attr, min(int(v), getattr(base, attr)))
    return cfg


class OpenAICompatibleProvider:
    """Adapter for OpenAI-compatible chat completion APIs (Groq, Cerebras, Mistral,
    OpenRouter, GitHub Models and Gemini's official OpenAI-compatible endpoint)."""

    def __init__(self, cfg: ProviderConfig, api_key: str, client: Optional[httpx.Client] = None):
        self.cfg = cfg
        self.name = cfg.name
        self._key = api_key
        self._client = client
        self.validate_policy()

    def validate_policy(self):
        if not self._key:
            raise PolicyViolation(f"{self.name}: no API key configured")

    def _headers(self):
        h = {"Authorization": f"Bearer {self._key}", "Content-Type": "application/json"}
        h.update(self.cfg.extra_headers)
        return h

    def chat(self, messages: List[Dict[str, str]], json_mode: bool = False, timeout: float = 30.0, max_tokens: int = 1200) -> ChatResult:
        body = {"model": self.cfg.model, "messages": messages, "temperature": 0.2, "max_tokens": max_tokens, "stream": False}
        if json_mode and self.cfg.json_mode:
            body["response_format"] = {"type": "json_object"}
        url = f"{self.cfg.base_url}/chat/completions"
        try:
            client = self._client or httpx.Client(timeout=timeout)
            try:
                resp = client.post(url, json=body, headers=self._headers(), timeout=timeout)
            finally:
                if self._client is None:
                    client.close()
        except httpx.TimeoutException:
            raise Transient(f"{self.name}: request timed out after {timeout:.0f}s")
        except httpx.HTTPError as e:
            raise Transient(f"{self.name}: network error: {type(e).__name__}")
        return self._parse(resp)

    def _parse(self, resp: httpx.Response) -> ChatResult:
        text = resp.text[:2000]
        low = text.lower()
        retry_after = None
        ra = resp.headers.get("retry-after")
        if ra:
            try:
                retry_after = float(ra)
            except ValueError:
                retry_after = None
        code = resp.status_code
        if code == 402 or (code >= 400 and ("insufficient_quota" in low or "billing" in low)):
            raise QuotaExhausted(f"{self.name}: free quota exhausted or billing required (HTTP {code})")
        if code == 429:
            daily = any(s in low for s in ("per day", "daily", "rpd", "resource_exhausted", "quota exceeded", "exceeded your current quota"))
            if daily:
                raise QuotaExhausted(f"{self.name}: daily free quota exhausted", retry_after)
            raise RateLimited(f"{self.name}: rate limited", retry_after)
        if code in (401, 403):
            raise AuthFailed(f"{self.name}: authentication failed (HTTP {code}) - check the API key")
        if code >= 500 or code == 408:
            raise Transient(f"{self.name}: server error HTTP {code}")
        if code >= 400:
            raise BadResponse(f"{self.name}: request rejected HTTP {code}: {text[:200]}")
        try:
            data = resp.json()
            content = data["choices"][0]["message"]["content"] or ""
        except (ValueError, KeyError, IndexError, TypeError):
            raise BadResponse(f"{self.name}: unexpected response format")
        usage = data.get("usage") or {}
        return ChatResult(
            text=content.strip(),
            provider=self.name,
            model=data.get("model") or self.cfg.model,
            prompt_tokens=int(usage.get("prompt_tokens") or 0),
            completion_tokens=int(usage.get("completion_tokens") or 0),
        )


class OpenRouterProvider(OpenAICompatibleProvider):
    def validate_policy(self):
        super().validate_policy()
        if not self.cfg.model.endswith(":free"):
            raise PolicyViolation(
                f"openrouter: model '{self.cfg.model}' is not a ':free' model; refusing to use a paid model"
            )

    def chat(self, messages, json_mode=False, timeout=30.0, max_tokens=1200):
        self.validate_policy()  # re-checked on every call (config could change at runtime)
        return super().chat(messages, json_mode=json_mode, timeout=timeout, max_tokens=max_tokens)


ADAPTERS = {"openrouter": OpenRouterProvider}


def build_provider(name: str, env=os.environ, client: Optional[httpx.Client] = None):
    cfg = load_provider_config(name, env)
    key = env.get(cfg.key_env, "").strip()
    cls = ADAPTERS.get(name, OpenAICompatibleProvider)
    return cls(cfg, key, client=client)

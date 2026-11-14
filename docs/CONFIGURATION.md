# Configuration

## Debian server — `/etc/cahangir/cahangir.env`

Loaded by systemd (`EnvironmentFile=`). Owned by root, mode 600. **Never commit it.** A template is in `backend/cahangir.env.example`.

| Variable | Default | Meaning |
|---|---|---|
| `CAHANGIR_HOST` | `0.0.0.0` | Bind address. Recommended: the server's Tailscale IP. |
| `CAHANGIR_PORT` | `8000` | Port. |
| `CAHANGIR_ADMIN_TOKEN` | generated into `data/admin_token.txt` | Pairing secret. Only used to pair/revoke devices. |
| `CAHANGIR_CORS_ORIGINS` | *(empty = CORS off)* | Comma list of browser origins. Native apps don't need CORS. |
| `CAHANGIR_BACKUP_INTERVAL_HOURS` | `24` | Automatic backup interval (0 = off). |
| `CAHANGIR_BACKUP_KEEP` | `14` | Automatic backups kept. |
| `CAHANGIR_SYNC_PAGE_LIMIT` | `2000` | Max rows per sync response page. |
| `CAHANGIR_DATA_DIR`, `CAHANGIR_BACKUP_DIR`, `CAHANGIR_DB_PATH` | `./data`, `./backups`, `data/cahangir.db` | Paths. |
| `CAHANGIR_LOG_LEVEL` | `INFO` | Log level. |

After editing: `sudo systemctl restart cahangir-backend`.

## AI router

AI is optional. The planner, reminders, sync, clipboard and file transfer never depend on it; when no provider is available the apps say so and use built-in rules.

**A provider is used only if it is listed in `CAHANGIR_AI_PROVIDERS` *and* its key is set.** There is no implicit, default or paid fallback.

```
CAHANGIR_AI_PROVIDERS=groq,gemini,cerebras     # order = priority
GROQ_API_KEY=...
GEMINI_API_KEY=...
CEREBRAS_API_KEY=...
```

| Name | Key variable | Default model | Cahangir's budget (req/min, req/day) | What you must do to stay free |
|---|---|---|---|---|
| `gemini` | `GEMINI_API_KEY` | `gemini-2.5-flash` (OpenAI-compatible endpoint) | 8 / 200 | Create the key in Google AI Studio in a Google Cloud project **without billing enabled**. Free-tier keys cannot be charged. |
| `groq` | `GROQ_API_KEY` | `llama-3.3-70b-versatile` | 25 / 900 | Stay on the free plan (don't upgrade the org to a paid tier). |
| `cerebras` | `CEREBRAS_API_KEY` | `llama-3.3-70b` | 25 / 1000 | Free tier, no payment method needed. |
| `mistral` | `MISTRAL_API_KEY` | `mistral-small-latest` | 20 / 500 | Choose the free **Experiment** plan on La Plateforme. |
| `openrouter` | `OPENROUTER_API_KEY` | `meta-llama/llama-3.3-70b-instruct:free` | 15 / 45 | Only `:free` model ids are accepted by Cahangir; any other model id is refused before a request is made. |
| `github` | `GITHUB_MODELS_TOKEN` | `openai/gpt-4o-mini` (GitHub Models) | 10 / 120 | Fine-grained PAT with *models:read*; leave paid usage for GitHub Models disabled. |

Provider free tiers, model names and limits change over time — check each provider's page. Overrides (budgets can only be **lowered**, never raised above the defaults above):

```
CAHANGIR_AI_<NAME>_MODEL=...
CAHANGIR_AI_<NAME>_RPM=...
CAHANGIR_AI_<NAME>_RPD=...
CAHANGIR_AI_<NAME>_BASE_URL=...
CAHANGIR_AI_ORDER_PARSE=groq,cerebras,gemini      # per task type: parse | chat | plan
```

Behaviour:

* **Rate limit (HTTP 429)** → the provider cools down for `Retry-After` (or 60 s) and the next provider is tried.
* **Daily quota exhausted / HTTP 402 / insufficient_quota / billing errors** → the provider is disabled until the next UTC midnight and is **never retried**.
* **401/403** → disabled for 1 h (check the key). **Timeouts/5xx** → retried once, then fallback.
* Usage (requests, failures, tokens) is recorded per provider per day in the `ai_usage` table; state survives restarts. `GET /api/ai/providers` (device token) shows status; keys are never returned.
* AI task extraction is validated: a deadline, time or duration is kept only if the model quotes the words from your message that state it. Otherwise it is dropped and a question is asked instead.

## Windows app

Settings are stored in `%APPDATA%\CahangirDesktop\cahangir_desktop.db` (`config` table). All are editable in the Settings screen:

| Setting | Default | Notes |
|---|---|---|
| Server URL / device name | — | Pairing stores only the device token. |
| Automatic sync | every 5 min | Also runs 3 s after any local change. 0 = manual. |
| Start with Windows | off | Registers a real Windows login item (`--minimized`). |
| Keep running in tray when closed | on | Required for reminders while the window is closed. |
| Accept clipboard from my devices | on | Writes received text to the Windows clipboard. |
| Share automatically when I copy | **off** | Opt-in clipboard watcher. |
| Download folder, P2P port (8767) | Downloads, 8767 | Port change: *Save & restart*. |
| Planner working hours | 08:00–22:00 | The scheduler only places work inside these hours. |

## Android app

Credentials (server URL, device token, P2P key, sync cursor) are in `EncryptedSharedPreferences` (Android Keystore), excluded from cloud/device-transfer backups. UI preferences are in WebView localStorage. Domain data is in `databases/cahangir_local.db`.

| Setting (Ayarlar) | Default |
|---|---|
| Fon sinxronizasiyası (background sync) | every 15 min (Android minimum); also a few seconds after each change |
| Digər cihazlardan gələn mətni panoya qoy | on |
| Planlayıcı iş saatları | 08:00–22:00 |
| Dil modeli (chat) | *Debian AI router*. The older optional modes (own OpenAI-compatible endpoint, on-device Gemma) are kept for existing users but are not used by default. |

## Network ports

| Port | Where | Purpose | Auth |
|---|---|---|---|
| 8000/tcp | Debian | REST API | Device bearer token; admin token for pairing |
| 8767/tcp | Windows & Android | Direct file/clipboard transfer | HMAC-SHA256 with the server-issued mesh key, ±5 min timestamp, nonce replay protection |

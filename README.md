# Cahangir

A personal assistant for planning and remembering — on Android, Windows and your own Debian home server. Tell it what you need to do; it understands the tasks and deadlines, finds time for them around your commitments, reminds you reliably, and keeps everything in sync across your devices, including offline. Files and clipboard move between your phone and PC directly and securely.

**Release 1.0.0** — see [RELEASE_NOTES.md](RELEASE_NOTES.md).

| | |
|---|---|
| Install & first run | [docs/INSTALL.md](docs/INSTALL.md) |
| Configuration (server, AI providers, apps) | [docs/CONFIGURATION.md](docs/CONFIGURATION.md) |
| Architecture | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Tests & manual verification | [docs/TESTING.md](docs/TESTING.md) |
| Build outputs | `release/v1.0.0/` (APK, Windows installer, SHA256SUMS) |

## Repository layout

```
backend/        FastAPI server: sync, pairing, planner data, AI router, backups (Python)
desktop/        Windows app: Tauri 2 (Rust) + React 19 / TypeScript
app/            Android app: Kotlin + WebView UI (assets/www)
shared/planner/ Planning engine used by both apps (JavaScript, no dependencies)
scripts/        sync-shared.sh, integration-test.sh
docs/           Documentation
```

## Building and testing

```bash
# Backend
cd backend && python -m venv .venv && .venv/bin/pip install -r requirements.txt pytest && .venv/bin/python -m pytest -q tests

# Planner engine
TZ=Asia/Baku node --test shared/planner/planner.test.js

# Windows app (on Windows: npx tauri build)
cd desktop && npm ci && npx tsc --noEmit && npm run build && (cd src-tauri && cargo test --lib)

# Android app (Android SDK 37)
./gradlew assembleDebug testDebugUnitTest

# Everything against a live throw-away backend
scripts/integration-test.sh
```

After editing `shared/planner/planner.js`, run `scripts/sync-shared.sh` (a test fails if the Android copy is stale).

Older Azerbaijani overview: [ARCHITECTURE.md](ARCHITECTURE.md) (pre-1.0).

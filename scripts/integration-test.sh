#!/usr/bin/env bash
# Starts a throw-away backend and runs the cross-component integration tests:
#   - Rust desktop sync engine + P2P against the live FastAPI server
#   - Android (Kotlin) sync protocol test against the same server (if Gradle/SDK available)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="${PYTHON:-python3}"
TMP="$(mktemp -d)"
PORT="${CAHANGIR_TEST_PORT:-8899}"
export CAHANGIR_DATA_DIR="$TMP/data" CAHANGIR_BACKUP_DIR="$TMP/backups" CAHANGIR_ADMIN_TOKEN="it_admin_$RANDOM$RANDOM" CAHANGIR_BACKUP_INTERVAL_HOURS=0
cd "$ROOT/backend"
"$PY" -m uvicorn app.main:app --host 127.0.0.1 --port "$PORT" --log-level warning &
PID=$!
trap 'kill $PID 2>/dev/null; rm -rf "$TMP"' EXIT
for i in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
export CAHANGIR_TEST_SERVER="http://127.0.0.1:$PORT" CAHANGIR_TEST_ADMIN="$CAHANGIR_ADMIN_TOKEN"
echo "== Desktop (Rust) integration =="
(cd "$ROOT/desktop/src-tauri" && cargo test --test integration -- --nocapture)
if [ "${SKIP_ANDROID:-0}" != "1" ]; then
  echo "== Android (Kotlin JVM) protocol integration =="
  (cd "$ROOT" && bash ./gradlew --no-daemon -q :app:testDebugUnitTest --tests '*SyncIntegrationTest*' -Pcahangir.testServer="$CAHANGIR_TEST_SERVER" -Pcahangir.testAdmin="$CAHANGIR_TEST_ADMIN")
fi
echo "Integration tests passed."

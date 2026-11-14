#!/usr/bin/env bash
# Copies shared code into the platform trees that cannot import it directly.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cp "$ROOT/shared/planner/planner.js" "$ROOT/app/src/main/assets/www/js/planner.js"
echo "planner.js synced to Android assets"

#!/usr/bin/env bash
# ==============================================================================
# Cahangir Backend install / upgrade for Debian (safe to re-run; user data is kept)
# ==============================================================================
set -euo pipefail

INSTALL_DIR="/opt/cahangir-backend"
SERVICE_NAME="cahangir-backend.service"
USER_NAME="${SUDO_USER:-$USER}"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "$EUID" -ne 0 ]; then
  echo "[!] Please run with sudo:  sudo bash setup_debian.sh"
  exit 1
fi

echo "[1/7] Installing prerequisites (python3, python3-venv, curl)..."
apt-get update -qq
apt-get install -y -qq python3 python3-venv python3-pip curl

mkdir -p "$INSTALL_DIR"
if [ -f "$INSTALL_DIR/data/cahangir.db" ]; then
  echo "[2/7] Existing database found - creating a safety backup before upgrading..."
  mkdir -p "$INSTALL_DIR/backups"
  STAMP=$(date +%Y%m%d_%H%M%S)
  python3 - "$INSTALL_DIR/data/cahangir.db" "$INSTALL_DIR/backups/pre_upgrade_$STAMP.db" <<'PY'
import sqlite3, sys
src = sqlite3.connect(sys.argv[1]); dst = sqlite3.connect(sys.argv[2])
with dst: src.backup(dst)
print("    backup:", sys.argv[2])
PY
else
  echo "[2/7] Fresh installation."
fi

echo "[3/7] Installing application code (data/ and backups/ are never touched)..."
systemctl stop "$SERVICE_NAME" 2>/dev/null || true
rm -rf "$INSTALL_DIR/app"
cp -r "$SRC_DIR/app" "$SRC_DIR/requirements.txt" "$INSTALL_DIR/"
find "$INSTALL_DIR/app" -name "__pycache__" -type d -prune -exec rm -rf {} +

echo "[4/7] Python virtual environment..."
[ -d "$INSTALL_DIR/venv" ] || python3 -m venv "$INSTALL_DIR/venv"
"$INSTALL_DIR/venv/bin/pip" install --upgrade pip -q
"$INSTALL_DIR/venv/bin/pip" install -r "$INSTALL_DIR/requirements.txt" -q

echo "[5/7] Permissions and configuration..."
chown -R "$USER_NAME":"$USER_NAME" "$INSTALL_DIR"
mkdir -p /etc/cahangir
if [ ! -f /etc/cahangir/cahangir.env ]; then
  cp "$SRC_DIR/cahangir.env.example" /etc/cahangir/cahangir.env
fi
chown root:root /etc/cahangir/cahangir.env
chmod 600 /etc/cahangir/cahangir.env

echo "[6/7] systemd service..."
sed "s/^User=debian/User=$USER_NAME/" "$SRC_DIR/cahangir-backend.service" > /etc/systemd/system/"$SERVICE_NAME"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

echo "[7/7] Verifying..."
for i in $(seq 1 15); do
  if curl -fsS "http://127.0.0.1:${CAHANGIR_PORT:-8000}/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
if systemctl is-active --quiet "$SERVICE_NAME"; then
  echo "OK: service is running."
  curl -fsS "http://127.0.0.1:${CAHANGIR_PORT:-8000}/api/health" || echo "(health endpoint not reachable on 127.0.0.1 - check CAHANGIR_HOST)"
  echo
else
  echo "[!] Service failed to start. Logs: journalctl -u $SERVICE_NAME -e"
  exit 1
fi

if [ -f "$INSTALL_DIR/data/admin_token.txt" ]; then
  chmod 600 "$INSTALL_DIR/data/admin_token.txt"
  echo "Admin pairing token (enter it once on each device when pairing):"
  echo "    $(cat "$INSTALL_DIR/data/admin_token.txt")"
fi
if command -v tailscale &> /dev/null; then
  TS_IP=$(tailscale ip -4 2>/dev/null || true)
  [ -n "$TS_IP" ] && echo "Tailscale URL: http://$TS_IP:${CAHANGIR_PORT:-8000}"
fi
echo "AI providers: edit /etc/cahangir/cahangir.env then: sudo systemctl restart $SERVICE_NAME"

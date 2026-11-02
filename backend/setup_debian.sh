#!/usr/bin/env bash
# ==============================================================================
# Cahangir Backend Setup Script for Debian 13 (Trixie) / Intel Atom D525
# ==============================================================================
set -e

INSTALL_DIR="/opt/cahangir-backend"
SERVICE_NAME="cahangir-backend.service"
USER_NAME="${SUDO_USER:-$USER}"

echo "=========================================="
echo "Installing Cahangir AI Central Backend..."
echo "=========================================="

if [ "$EUID" -ne 0 ]; then
  echo "[!] Please run as root or with sudo:"
  echo "    sudo bash setup_debian.sh"
  exit 1
fi

echo "[1/6] Installing system prerequisites (python3, python3-venv, curl)..."
apt-get update -qq
apt-get install -y -qq python3 python3-venv python3-pip curl

echo "[2/6] Setting up target directory: $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
cp -r app requirements.txt "$INSTALL_DIR/"

echo "[3/6] Creating Python virtual environment..."
python3 -m venv "$INSTALL_DIR/venv"
"$INSTALL_DIR/venv/bin/pip" install --upgrade pip -q
"$INSTALL_DIR/venv/bin/pip" install -r "$INSTALL_DIR/requirements.txt" -q

echo "[4/6] Setting directory permissions..."
chown -R "$USER_NAME":"$USER_NAME" "$INSTALL_DIR"

echo "[5/6] Configuring systemd service..."
sed -i "s/User=debian/User=$USER_NAME/g" cahangir-backend.service
cp cahangir-backend.service /etc/systemd/system/"$SERVICE_NAME"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

echo "[6/6] Verifying service status..."
sleep 2
if systemctl is-active --quiet "$SERVICE_NAME"; then
    echo "✓ Cahangir backend service is ACTIVE and RUNNING."
else
    echo "[!] Service failed to start. Check logs with: journalctl -u $SERVICE_NAME -e"
    exit 1
fi

echo "=========================================="
echo "✓ Installation Complete!"
echo "=========================================="

# Read pairing token
if [ -f "$INSTALL_DIR/data/admin_token.txt" ]; then
    TOKEN=$(cat "$INSTALL_DIR/data/admin_token.txt")
    echo "Your Device Pairing Admin Token is:"
    echo "------------------------------------------"
    echo "$TOKEN"
    echo "------------------------------------------"
    echo "Enter this token on your Galaxy S25 / Android app to pair!"
fi

# Detect Tailscale IP if available
if command -v tailscale &> /dev/null; then
    TS_IP=$(tailscale ip -4 2>/dev/null || echo "")
    if [ -n "$TS_IP" ]; then
        echo "Tailscale IP detected: http://$TS_IP:8000"
    fi
fi
echo "Local LAN address: http://$(hostname -I | awk '{print $1}'):8000"
echo "API Docs: http://localhost:8000/docs"

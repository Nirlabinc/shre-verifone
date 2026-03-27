#!/usr/bin/env bash
set -euo pipefail

# Verifone Edge Relay — Linux Installer
# Usage: curl -fsSL https://download.shreai.com/verifone-edge-relay/install.sh | sudo bash

PRODUCT="verifone-edge-relay"
VERSION="${1:-latest}"
INSTALL_DIR="/opt/$PRODUCT"
DATA_DIR="/var/lib/$PRODUCT"
SERVICE_NAME="$PRODUCT"
DOWNLOAD_URL="https://download.shreai.com/$PRODUCT/$VERSION/linux-x64/$PRODUCT"
PORT=18464

echo "=== Verifone Edge Relay Installer ==="
echo ""

# Check root
if [ "$(id -u)" -ne 0 ]; then
  echo "Error: Please run as root (sudo)"
  exit 1
fi

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  ARCH_LABEL="linux-x64" ;;
  aarch64) ARCH_LABEL="linux-arm64" ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

DOWNLOAD_URL="https://download.shreai.com/$PRODUCT/$VERSION/$ARCH_LABEL/$PRODUCT"

echo "[1/5] Creating directories..."
mkdir -p "$INSTALL_DIR"
mkdir -p "$DATA_DIR/logs"
mkdir -p "$INSTALL_DIR/admin-ui"

echo "[2/5] Downloading edge relay ($ARCH_LABEL)..."
if command -v curl &>/dev/null; then
  curl -fsSL "$DOWNLOAD_URL" -o "$INSTALL_DIR/$PRODUCT"
elif command -v wget &>/dev/null; then
  wget -qO "$INSTALL_DIR/$PRODUCT" "$DOWNLOAD_URL"
else
  echo "Error: curl or wget required"
  exit 1
fi

chmod +x "$INSTALL_DIR/$PRODUCT"

# Download admin UI
for page in index.html setup.html status.html; do
  curl -fsSL "https://download.shreai.com/$PRODUCT/$VERSION/admin-ui/$page" \
    -o "$INSTALL_DIR/admin-ui/$page" 2>/dev/null || true
done

echo "[3/5] Creating service user..."
id -u verifone-relay &>/dev/null || useradd -r -s /usr/sbin/nologin -d "$DATA_DIR" verifone-relay
chown -R verifone-relay:verifone-relay "$DATA_DIR"

echo "[4/5] Installing systemd service..."
cat > /etc/systemd/system/$SERVICE_NAME.service <<EOF
[Unit]
Description=Verifone Edge Relay — POS data sync to Shre AI
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=verifone-relay
Group=verifone-relay
ExecStart=$INSTALL_DIR/$PRODUCT
Restart=on-failure
RestartSec=10
Environment=RELAY_DATA_DIR=$DATA_DIR
Environment=NODE_TLS_REJECT_UNAUTHORIZED=0
WorkingDirectory=$INSTALL_DIR

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR
PrivateTmp=true

# Resource limits
LimitNOFILE=65536
MemoryMax=512M

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable $SERVICE_NAME
systemctl start $SERVICE_NAME

echo "[5/5] Verifying..."
sleep 2

if systemctl is-active --quiet $SERVICE_NAME; then
  echo ""
  echo "=== Installation Complete ==="
  echo ""
  echo "  Status:    systemctl status $SERVICE_NAME"
  echo "  Logs:      journalctl -u $SERVICE_NAME -f"
  echo "  Setup:     http://localhost:$PORT/setup.html"
  echo "  Dashboard: http://localhost:$PORT/status.html"
  echo ""
  echo "Open http://localhost:$PORT in your browser to complete setup."
else
  echo ""
  echo "Warning: Service failed to start. Check: journalctl -u $SERVICE_NAME -e"
  exit 1
fi

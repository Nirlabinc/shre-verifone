#!/usr/bin/env bash
set -euo pipefail

# Verifone Edge Relay — macOS Installer
# Usage: curl -fsSL https://download.shreai.com/verifone-edge-relay/install-mac.sh | bash

PRODUCT="verifone-edge-relay"
VERSION="${1:-latest}"
INSTALL_DIR="$HOME/.local/bin"
DATA_DIR="$HOME/Library/Application Support/VerifoneEdgeRelay"
PLIST_NAME="ai.shre.verifone-edge-relay"
PLIST_DIR="$HOME/Library/LaunchAgents"
PORT=18464

echo "=== Verifone Edge Relay — macOS Installer ==="
echo ""

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  ARCH_LABEL="darwin-x64" ;;
  arm64)   ARCH_LABEL="darwin-arm64" ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

DOWNLOAD_URL="https://download.shreai.com/$PRODUCT/$VERSION/$ARCH_LABEL/$PRODUCT"

echo "[1/5] Creating directories..."
mkdir -p "$INSTALL_DIR"
mkdir -p "$DATA_DIR/logs"
mkdir -p "$INSTALL_DIR/$PRODUCT-ui"

echo "[2/5] Downloading edge relay ($ARCH_LABEL)..."
curl -fsSL "$DOWNLOAD_URL" -o "$INSTALL_DIR/$PRODUCT"
chmod +x "$INSTALL_DIR/$PRODUCT"

# Download admin UI
for page in index.html setup.html status.html; do
  curl -fsSL "https://download.shreai.com/$PRODUCT/$VERSION/admin-ui/$page" \
    -o "$INSTALL_DIR/$PRODUCT-ui/$page" 2>/dev/null || true
done

echo "[3/5] Installing LaunchAgent..."
cat > "$PLIST_DIR/$PLIST_NAME.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$PLIST_NAME</string>
  <key>ProgramArguments</key>
  <array>
    <string>$INSTALL_DIR/$PRODUCT</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>RELAY_DATA_DIR</key>
    <string>$DATA_DIR</string>
    <key>NODE_TLS_REJECT_UNAUTHORIZED</key>
    <string>0</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>$DATA_DIR/logs/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$DATA_DIR/logs/stderr.log</string>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
EOF

echo "[4/5] Starting service..."
launchctl unload "$PLIST_DIR/$PLIST_NAME.plist" 2>/dev/null || true
launchctl load "$PLIST_DIR/$PLIST_NAME.plist"

echo "[5/5] Verifying..."
sleep 2

if curl -s "http://localhost:$PORT/health" >/dev/null 2>&1; then
  echo ""
  echo "=== Installation Complete ==="
  echo ""
  echo "  Setup:     http://localhost:$PORT/setup.html"
  echo "  Dashboard: http://localhost:$PORT/status.html"
  echo "  Logs:      cat '$DATA_DIR/logs/relay.log'"
  echo "  Manage:    launchctl unload '$PLIST_DIR/$PLIST_NAME.plist'"
  echo ""
  echo "Opening setup wizard..."
  open "http://localhost:$PORT/setup.html"
else
  echo ""
  echo "Service starting... Open http://localhost:$PORT in a few seconds."
  echo "Check logs: cat '$DATA_DIR/logs/stderr.log'"
  open "http://localhost:$PORT/setup.html"
fi

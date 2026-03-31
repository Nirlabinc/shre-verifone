#!/usr/bin/env bash
set -euo pipefail

# Verifone Edge Relay — Local macOS Install (from source)
# Usage: ./install-local-mac.sh
#
# Installs the edge relay as a LaunchAgent running from source.
# For site Macs where you want auto-start on boot without a compiled binary.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$HOME/Library/Application Support/VerifoneEdgeRelay"
LOG_DIR="$HOME/Library/Logs/verifone-edge-relay"
PLIST_NAME="ai.shre.verifone-edge-relay"
PLIST_DIR="$HOME/Library/LaunchAgents"
RUN_SCRIPT="$HOME/.local/bin/verifone-edge-relay-run.sh"

echo "=== Verifone Edge Relay — macOS Local Install ==="
echo ""

# 1. Install dependencies
echo "[1/5] Installing dependencies..."
cd "$SCRIPT_DIR" && npm install --production

# 2. Create directories
echo "[2/5] Creating directories..."
mkdir -p "$DATA_DIR/logs"
mkdir -p "$LOG_DIR"
mkdir -p "$HOME/.local/bin"

# 3. Create run script in ~/.local/bin (TCC workaround — launchd can't exec from ~/Documents)
echo "[3/5] Creating run script..."
cat > "$RUN_SCRIPT" <<RUNEOF
#!/usr/bin/env bash
export RELAY_DATA_DIR="$DATA_DIR"
export LOG_LEVEL="info"
export NODE_TLS_REJECT_UNAUTHORIZED=0
exec /usr/local/bin/node "$SCRIPT_DIR/src/main.mjs"
RUNEOF
chmod +x "$RUN_SCRIPT"

# 4. Install LaunchAgent
echo "[4/5] Installing LaunchAgent..."
cat > "$PLIST_DIR/$PLIST_NAME.plist" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$PLIST_NAME</string>
  <key>ProgramArguments</key>
  <array>
    <string>$RUN_SCRIPT</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/stderr.log</string>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
PLISTEOF

# 5. Load the LaunchAgent
echo "[5/5] Starting service..."
launchctl unload "$PLIST_DIR/$PLIST_NAME.plist" 2>/dev/null || true
launchctl load "$PLIST_DIR/$PLIST_NAME.plist"

sleep 2

if curl -s "http://localhost:18464/health" >/dev/null 2>&1; then
  echo ""
  echo "=== Installation Complete ==="
  echo ""
  echo "  Setup wizard: http://localhost:18464/setup.html"
  echo "  Dashboard:    http://localhost:18464/status.html"
  echo "  Logs:         tail -f $LOG_DIR/stderr.log"
  echo "  Stop:         launchctl unload $PLIST_DIR/$PLIST_NAME.plist"
  echo "  Start:        launchctl load $PLIST_DIR/$PLIST_NAME.plist"
  echo ""
  open "http://localhost:18464/setup.html"
else
  echo ""
  echo "Service starting... check: curl http://localhost:18464/health"
  echo "Logs: cat $LOG_DIR/stderr.log"
  open "http://localhost:18464/setup.html"
fi

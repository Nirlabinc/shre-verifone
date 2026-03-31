#!/usr/bin/env bash
set -euo pipefail

# ══════════════════════════════════════════════════════════════════
# Verifone Edge Relay — One-Stop macOS Installer
# ══════════════════════════════════════════════════════════════════
#
# Installs EVERYTHING from scratch on a clean Mac:
#   1. Xcode Command Line Tools (git)
#   2. Node.js 22 LTS
#   3. Edge Relay dependencies
#   4. LaunchAgent (auto-start on boot + auto-restart on crash)
#   5. Opens setup wizard in browser
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Nirlabinc/shre-verifone/main/edge-relay/install-local-mac.sh | bash
#   — OR —
#   ./install-local-mac.sh          (if already cloned)
#

PRODUCT="verifone-edge-relay"
REPO_URL="https://github.com/Nirlabinc/shre-verifone.git"
NODE_VERSION="22.15.0"
NODE_PKG_URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}.pkg"

INSTALL_DIR="$HOME/.local/share/$PRODUCT"
DATA_DIR="$HOME/Library/Application Support/VerifoneEdgeRelay"
LOG_DIR="$HOME/Library/Logs/verifone-edge-relay"
PLIST_NAME="ai.shre.verifone-edge-relay"
PLIST_DIR="$HOME/Library/LaunchAgents"
RUN_SCRIPT="$HOME/.local/bin/${PRODUCT}-run.sh"

TOTAL_STEPS=7
step=0

progress() {
  step=$((step + 1))
  echo ""
  echo "[$step/$TOTAL_STEPS] $1"
  echo "────────────────────────────────────────"
}

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   Verifone Edge Relay — macOS Installer          ║"
echo "║   One-stop setup for Verifone Commander sync     ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ── 1. Xcode Command Line Tools (for git) ────────────────────────

progress "Checking Xcode Command Line Tools (for git)..."

if ! xcode-select -p &>/dev/null; then
  echo "  Installing Xcode Command Line Tools..."
  echo "  A dialog may appear — click 'Install' and wait."
  xcode-select --install 2>/dev/null || true
  # Wait for installation
  echo "  Waiting for Xcode CLT installation to complete..."
  until xcode-select -p &>/dev/null; do
    sleep 5
  done
  echo "  ✓ Xcode CLT installed"
else
  echo "  ✓ Already installed"
fi

# ── 2. Node.js ───────────────────────────────────────────────────

progress "Checking Node.js..."

NODE_BIN=""
if command -v node &>/dev/null; then
  NODE_BIN="$(command -v node)"
  NODE_VER="$(node --version 2>/dev/null || echo "v0")"
  NODE_MAJOR="${NODE_VER#v}"
  NODE_MAJOR="${NODE_MAJOR%%.*}"
  if [ "$NODE_MAJOR" -ge 20 ] 2>/dev/null; then
    echo "  ✓ Node.js $NODE_VER found at $NODE_BIN"
  else
    echo "  Node.js $NODE_VER is too old (need v20+). Installing v${NODE_VERSION}..."
    NODE_BIN=""
  fi
fi

if [ -z "$NODE_BIN" ]; then
  echo "  Downloading Node.js v${NODE_VERSION}..."
  curl -fsSL "$NODE_PKG_URL" -o /tmp/node-installer.pkg

  echo "  Installing Node.js (may ask for password)..."
  sudo installer -pkg /tmp/node-installer.pkg -target / 2>&1 | sed 's/^/  /'
  rm -f /tmp/node-installer.pkg

  # Refresh PATH
  export PATH="/usr/local/bin:$PATH"

  if command -v node &>/dev/null; then
    NODE_BIN="$(command -v node)"
    echo "  ✓ Node.js $(node --version) installed at $NODE_BIN"
  else
    echo "  ERROR: Node.js installation failed."
    echo "  Download manually from https://nodejs.org/ and re-run this script."
    exit 1
  fi
fi

NPM_BIN="$(command -v npm)"
echo "  ✓ npm $(npm --version) at $NPM_BIN"

# ── 3. Clone or update repo ──────────────────────────────────────

progress "Getting Edge Relay source code..."

mkdir -p "$HOME/.local/share" "$HOME/.local/bin" "$PLIST_DIR"

# Determine if we're running from inside the repo or need to clone
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

if [ -f "$SCRIPT_DIR/src/main.mjs" ]; then
  echo "  Running from cloned repo at $SCRIPT_DIR"
  INSTALL_DIR="$SCRIPT_DIR"
elif [ -d "$INSTALL_DIR/.git" ]; then
  echo "  Updating existing installation..."
  cd "$INSTALL_DIR"
  git pull origin main 2>&1 | sed 's/^/  /'
  INSTALL_DIR="$INSTALL_DIR/edge-relay"
else
  echo "  Cloning from $REPO_URL..."
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" 2>&1 | sed 's/^/  /'
  INSTALL_DIR="$INSTALL_DIR/edge-relay"
fi

echo "  ✓ Source ready at $INSTALL_DIR"

# ── 4. Install Node dependencies ─────────────────────────────────

progress "Installing dependencies..."

cd "$INSTALL_DIR"
"$NPM_BIN" install --production 2>&1 | sed 's/^/  /'
echo "  ✓ Dependencies installed"

# ── 5. Create directories ────────────────────────────────────────

progress "Creating data directories..."

mkdir -p "$DATA_DIR/logs"
mkdir -p "$LOG_DIR"
echo "  ✓ $DATA_DIR"
echo "  ✓ $LOG_DIR"

# ── 6. Create run script + LaunchAgent ───────────────────────────

progress "Installing background service..."

# Run script in ~/.local/bin (TCC workaround — launchd can't exec from ~/Documents)
cat > "$RUN_SCRIPT" <<RUNEOF
#!/usr/bin/env bash
export PATH="/usr/local/bin:\$PATH"
export RELAY_DATA_DIR="$DATA_DIR"
export LOG_LEVEL="info"
export NODE_TLS_REJECT_UNAUTHORIZED=0
exec "$NODE_BIN" "$INSTALL_DIR/src/main.mjs"
RUNEOF
chmod +x "$RUN_SCRIPT"
echo "  ✓ Run script: $RUN_SCRIPT"

# LaunchAgent plist
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
echo "  ✓ LaunchAgent: $PLIST_DIR/$PLIST_NAME.plist"

# ── 7. Start and verify ──────────────────────────────────────────

progress "Starting Edge Relay..."

launchctl unload "$PLIST_DIR/$PLIST_NAME.plist" 2>/dev/null || true
launchctl load "$PLIST_DIR/$PLIST_NAME.plist"

echo "  Waiting for service to start..."
sleep 3

if curl -s "http://localhost:18464/health" >/dev/null 2>&1; then
  echo ""
  echo "╔══════════════════════════════════════════════════╗"
  echo "║          Installation Complete!                   ║"
  echo "╠══════════════════════════════════════════════════╣"
  echo "║                                                   ║"
  echo "║  Setup wizard: http://localhost:18464/setup.html  ║"
  echo "║  Dashboard:    http://localhost:18464/status.html  ║"
  echo "║                                                   ║"
  echo "║  Logs:  tail -f $LOG_DIR/stderr.log"
  echo "║  Stop:  launchctl unload ~/Library/LaunchAgents/$PLIST_NAME.plist"
  echo "║  Start: launchctl load  ~/Library/LaunchAgents/$PLIST_NAME.plist"
  echo "║                                                   ║"
  echo "╚══════════════════════════════════════════════════╝"
  echo ""
  open "http://localhost:18464/setup.html"
else
  echo ""
  echo "  Service is starting up..."
  echo "  If it doesn't open automatically, go to: http://localhost:18464/setup.html"
  echo "  Check logs: cat $LOG_DIR/stderr.log"
  echo ""
  sleep 2
  open "http://localhost:18464/setup.html"
fi

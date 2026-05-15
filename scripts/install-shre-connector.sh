#!/usr/bin/env bash
# Install the shre-connector service on a single store device.
#
# Run AFTER the repo is cloned + built (`npm install && npm run build`).
# Idempotent: re-running updates the config and restarts the service.
#
# Usage:
#   ./scripts/install-shre-connector.sh \
#     --tenant-id rapidpos-store-007 \
#     --device-alias "Front Counter Register" \
#     --store-id store_007 \
#     [--bootstrap-key <key>] \
#     [--mode read_only|read_write] \
#     [--app verifone_commander_cstoresku] \
#     [--runtime-root ~/.verifone-shre-cstoresku] \
#     [--install-root <repo-path>]
#
#   ./scripts/install-shre-connector.sh --uninstall

set -euo pipefail

# ─── defaults & arg parsing ──────────────────────────────────────────────────
TENANT_ID=""
DEVICE_ALIAS=""
STORE_ID="default"
BOOTSTRAP_KEY=""
MODE="read_only"
APP="verifone_commander_cstoresku"
INSTALL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_ROOT="${VERIFONE_SHRE_HOME:-$HOME/.verifone-shre-cstoresku}"
UNINSTALL=0
LABEL="com.rapidinfosoft.shre-connector"
LOG_DIR="$HOME/.verifone-cstoresku/logs"

usage() {
  sed -n '2,20p' "$0" >&2
  exit "${1:-1}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tenant-id) TENANT_ID="$2"; shift 2;;
    --device-alias) DEVICE_ALIAS="$2"; shift 2;;
    --store-id) STORE_ID="$2"; shift 2;;
    --bootstrap-key) BOOTSTRAP_KEY="$2"; shift 2;;
    --mode) MODE="$2"; shift 2;;
    --app) APP="$2"; shift 2;;
    --install-root) INSTALL_ROOT="$2"; shift 2;;
    --runtime-root) RUNTIME_ROOT="$2"; shift 2;;
    --uninstall) UNINSTALL=1; shift;;
    -h|--help) usage 0;;
    *) echo "unknown flag: $1" >&2; usage 1;;
  esac
done

OS="$(uname -s)"
case "$OS" in
  Darwin) ;;
  Linux) ;;
  *) echo "unsupported OS: $OS (this installer is mac/linux only)" >&2; exit 2;;
esac

# ─── uninstall path ──────────────────────────────────────────────────────────
if [[ "$UNINSTALL" = "1" ]]; then
  if [[ "$OS" = "Darwin" ]]; then
    PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
    if [[ -f "$PLIST" ]]; then
      launchctl unload "$PLIST" >/dev/null 2>&1 || true
      rm -f "$PLIST"
      echo "unloaded and removed $PLIST"
    else
      echo "no plist at $PLIST (nothing to remove)"
    fi
  else
    UNIT="/etc/systemd/system/${LABEL}.service"
    if [[ -f "$UNIT" ]]; then
      sudo systemctl disable --now "${LABEL}.service" || true
      sudo rm -f "$UNIT"
      sudo systemctl daemon-reload
      echo "stopped and removed $UNIT"
    else
      echo "no systemd unit at $UNIT"
    fi
  fi
  echo "(aros-config.json and .install-device-id at $RUNTIME_ROOT preserved — delete manually if reinstalling cleanly)"
  exit 0
fi

# ─── validate required args ──────────────────────────────────────────────────
[[ -z "$TENANT_ID" ]] && { echo "ERROR: --tenant-id is required" >&2; usage 1; }
[[ -z "$DEVICE_ALIAS" ]] && { echo "ERROR: --device-alias is required" >&2; usage 1; }
if [[ "$MODE" != "read_only" && "$MODE" != "read_write" ]]; then
  echo "ERROR: --mode must be read_only or read_write" >&2; exit 1
fi
if [[ "$MODE" = "read_write" && -z "$BOOTSTRAP_KEY" ]]; then
  echo "ERROR: --mode read_write requires --bootstrap-key" >&2; exit 1
fi
if ! [[ "$APP" =~ ^[a-z][a-z0-9_-]{0,31}$ ]]; then
  echo "ERROR: --app must match ^[a-z][a-z0-9_-]{0,31}$" >&2; exit 1
fi

# ─── pre-flight ──────────────────────────────────────────────────────────────
WORKER_JS="$INSTALL_ROOT/dist/services/shre-connector/src/worker.js"
[[ -f "$WORKER_JS" ]] || {
  echo "ERROR: built worker not found at $WORKER_JS"
  echo "       run: cd '$INSTALL_ROOT' && npm install && npm run build"
  exit 3
}
NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || { echo "ERROR: node not on PATH" >&2; exit 4; }

NODE_VERSION="$($NODE_BIN -v)"
echo "install-root  = $INSTALL_ROOT"
echo "runtime-root  = $RUNTIME_ROOT"
echo "node          = $NODE_BIN ($NODE_VERSION)"
echo "tenant-id     = $TENANT_ID"
echo "app           = $APP"
echo "mode          = $MODE"
echo "store-id      = $STORE_ID"
echo "device-alias  = $DEVICE_ALIAS"
echo "label         = $LABEL"
echo

# ─── write aros-config.json + ensure dirs ────────────────────────────────────
mkdir -p "$RUNTIME_ROOT" "$LOG_DIR" "$HOME/Library/LaunchAgents" 2>/dev/null || true
CONFIG_PATH="$RUNTIME_ROOT/aros-config.json"

# JSON-encode bootstrap_key only if provided (avoid empty-string write)
KEY_FIELD=""
if [[ -n "$BOOTSTRAP_KEY" ]]; then
  KEY_FIELD=$(printf ',\n  "bootstrapKey": %s' "$(printf '%s' "$BOOTSTRAP_KEY" | "$NODE_BIN" -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0,"utf8")))')")
fi

# Use node for JSON encoding to handle quoting safely
"$NODE_BIN" -e "
const fs = require('fs');
const cfg = {
  tenantId:    process.argv[1],
  app:         process.argv[2],
  mode:        process.argv[3],
  storeId:     process.argv[4],
  deviceAlias: process.argv[5],
};
if (process.argv[6]) cfg.bootstrapKey = process.argv[6];
fs.writeFileSync(process.argv[7], JSON.stringify(cfg, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
" "$TENANT_ID" "$APP" "$MODE" "$STORE_ID" "$DEVICE_ALIAS" "$BOOTSTRAP_KEY" "$CONFIG_PATH"
chmod 600 "$CONFIG_PATH" 2>/dev/null || true
echo "wrote $CONFIG_PATH"

# ─── per-OS service install ──────────────────────────────────────────────────
if [[ "$OS" = "Darwin" ]]; then
  PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>WorkingDirectory</key><string>${INSTALL_ROOT}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>dist/services/shre-connector/src/worker.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_DIR}/shre-connector.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/shre-connector.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>VERIFONE_SHRE_HOME</key><string>${RUNTIME_ROOT}</string>
    <key>SHRE_LOG_LEVEL</key><string>info</string>
  </dict>
</dict>
</plist>
PLIST
  echo "wrote $PLIST"
  launchctl unload "$PLIST" >/dev/null 2>&1 || true
  launchctl load "$PLIST"
  echo "loaded LaunchAgent ${LABEL}"
elif [[ "$OS" = "Linux" ]]; then
  UNIT="/etc/systemd/system/${LABEL}.service"
  sudo tee "$UNIT" >/dev/null <<SERVICE
[Unit]
Description=Shre Connector (Verifone Commander CStoreSKU)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_ROOT}
Environment=VERIFONE_SHRE_HOME=${RUNTIME_ROOT}
Environment=SHRE_LOG_LEVEL=info
ExecStart=${NODE_BIN} dist/services/shre-connector/src/worker.js
Restart=always
RestartSec=5
User=$(id -un)
StandardOutput=append:${LOG_DIR}/shre-connector.log
StandardError=append:${LOG_DIR}/shre-connector.err

[Install]
WantedBy=multi-user.target
SERVICE
  echo "wrote $UNIT"
  sudo systemctl daemon-reload
  sudo systemctl enable --now "${LABEL}.service"
  echo "enabled + started systemd service ${LABEL}"
fi

# ─── verify ──────────────────────────────────────────────────────────────────
sleep 6
echo
echo "── post-install verification ──"
if [[ "$OS" = "Darwin" ]]; then
  launchctl list "$LABEL" 2>/dev/null | grep -E '"PID"|"LastExitStatus"' || echo "(launchctl reports the service not running — check logs)"
else
  sudo systemctl status "${LABEL}.service" --no-pager | head -10 || true
fi

echo
echo "── log tail ──"
tail -15 "${LOG_DIR}/shre-connector.log" 2>/dev/null || echo "(no log entries yet)"

echo
echo "── done ──"
echo "Config:  $CONFIG_PATH"
echo "Logs:    ${LOG_DIR}/shre-connector.{log,err}"
echo "Service: ${LABEL}"
echo "Update:  re-run this command with new flags"
echo "Remove:  $0 --uninstall"

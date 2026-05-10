#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-5480}"
RUNTIME_PATH="${VERIFONE_SHRE_HOME:-$HOME/.verifone-shre-cstoresku}"
BACKUP_ROOT="${BACKUP_ROOT:-$HOME/VerifoneCommanderBackups}"
SERVICE_NAME="${SERVICE_NAME:-verifone-commander-shre-cstoresku}"
EXPECTED_VERSION="${EXPECTED_VERSION:-}"
SKIP_INSTALL="${SKIP_INSTALL:-false}"
SKIP_GIT_PULL="${SKIP_GIT_PULL:-false}"
NO_START="${NO_START:-false}"

echo "Starting production update for Verifone Commander Shre CStoreSKU"
echo "Runtime: $RUNTIME_PATH"
echo "Backup root: $BACKUP_ROOT"

./scripts/protect-runtime.sh mark

if [[ "$SKIP_GIT_PULL" != "true" && -d .git ]]; then
  git pull --ff-only
fi

if [[ "$SKIP_INSTALL" != "true" ]]; then
  npm install
fi
npm run build

if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files "${SERVICE_NAME}.service" >/dev/null 2>&1; then
  sudo systemctl stop "$SERVICE_NAME" || true
elif command -v launchctl >/dev/null 2>&1 && launchctl print "gui/$(id -u)/$SERVICE_NAME" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/${SERVICE_NAME}.plist" || true
else
  pkill -f "dist/apps/dashboard-api/src/server.js" || true
fi

stamp="$(date -u +%Y%m%d-%H%M%S)"
backup_path="$BACKUP_ROOT/update-$stamp"
mkdir -p "$backup_path"
for file_name in runtime.sqlite .install-secret .runtime-protected; do
  if [[ -f "$RUNTIME_PATH/$file_name" ]]; then
    cp "$RUNTIME_PATH/$file_name" "$backup_path/$file_name"
  fi
done
cat > "$backup_path/backup-manifest.json" <<JSON
{
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "sourceRuntime": "$RUNTIME_PATH",
  "reason": "production-update",
  "encrypted": true
}
JSON
echo "Runtime backup created: $backup_path"

if [[ "$NO_START" == "true" ]]; then
  echo "NO_START=true. Update stopped after backup/build."
  exit 0
fi

if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files "${SERVICE_NAME}.service" >/dev/null 2>&1; then
  sudo systemctl start "$SERVICE_NAME"
elif command -v launchctl >/dev/null 2>&1 && [[ -f "$HOME/Library/LaunchAgents/${SERVICE_NAME}.plist" ]]; then
  launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/${SERVICE_NAME}.plist"
else
  PORT="$PORT" HOST=127.0.0.1 VERIFONE_SHRE_HOME="$RUNTIME_PATH" nohup node dist/apps/dashboard-api/src/server.js >/tmp/verifone-commander-shre-cstoresku.log 2>&1 &
fi

deadline=$((SECONDS + 30))
until curl -fsS "http://localhost:$PORT/api/health" >/tmp/verifone-health.json; do
  if (( SECONDS > deadline )); then
    echo "Dashboard API did not become healthy on port $PORT" >&2
    exit 1
  fi
  sleep 1
done

version_json="$(curl -fsS "http://localhost:$PORT/api/version")"
if [[ -n "$EXPECTED_VERSION" ]] && ! echo "$version_json" | grep -q "\"version\":\"$EXPECTED_VERSION\""; then
  echo "Version mismatch after update. Expected $EXPECTED_VERSION." >&2
  echo "$version_json" >&2
  exit 1
fi

capabilities_json="$(curl -fsS "http://localhost:$PORT/api/capabilities")"
if ! echo "$capabilities_json" | grep -q '"errorLog"[[:space:]]*:[[:space:]]*true' || ! echo "$capabilities_json" | grep -q '"commanderWriteBack"[[:space:]]*:[[:space:]]*true' || ! echo "$capabilities_json" | grep -q '"typedLocalProjections"[[:space:]]*:[[:space:]]*true' || ! echo "$capabilities_json" | grep -Eq '"pdkCommandTotal"[[:space:]]*:[[:space:]]*2[0-9][0-9]'; then
  echo "Smoke failed: current capabilities do not match expected build, old API process may still be running." >&2
  exit 1
fi
ping_code="$(curl -sS -o /tmp/verifone-ping.json -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' "http://localhost:$PORT/api/verifone/ping")"
if [[ "$ping_code" == "404" ]]; then
  echo "Smoke failed: /api/verifone/ping returned 404, old API process may still be running." >&2
  exit 1
fi

echo "Production update completed and smoke checks passed."

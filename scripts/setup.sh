#!/usr/bin/env bash
# Pilot setup — one command from a fresh extract of the release zip to a
# running, AROS-connected install. Run from anywhere in the repo:
#
#   ./scripts/setup.sh                                # interactive (prompts)
#   ./scripts/setup.sh --tenant-id X --device-alias Y # non-interactive
#
# Mac users can also double-click scripts/setup.command (which calls this).
# Windows users have scripts/setup.cmd + scripts/setup.ps1.

set -euo pipefail

# ─── locate repo root ────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# ─── pre-flight ──────────────────────────────────────────────────────────
echo "== Verifone Commander Shre Cstoresku — pilot setup =="
echo "Repo: $REPO_ROOT"
echo

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: '$1' is required but not installed." >&2
    case "$1" in
      node|npm) echo "  Install Node.js 20+ from https://nodejs.org/  (or 'brew install node@20')" >&2;;
      git) echo "  Install Git (or 'xcode-select --install' on macOS)" >&2;;
    esac
    exit 2
  fi
}
need node
need npm

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "ERROR: Node $NODE_MAJOR detected; this build needs Node 20 or newer." >&2
  exit 2
fi
echo "✓ node $(node -v)"
echo "✓ npm  $(npm -v)"
echo

# ─── parse args (forward all unknown ones to install-shre-connector.sh) ──
TENANT_ID=""
DEVICE_ALIAS=""
STORE_ID=""
USER_ID=""
BOOTSTRAP_KEY=""
MODE="read_only"
APP=""
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tenant-id) TENANT_ID="$2"; shift 2;;
    --device-alias) DEVICE_ALIAS="$2"; shift 2;;
    --store-id) STORE_ID="$2"; shift 2;;
    --user-id) USER_ID="$2"; shift 2;;
    --bootstrap-key) BOOTSTRAP_KEY="$2"; shift 2;;
    --mode) MODE="$2"; shift 2;;
    --app) APP="$2"; shift 2;;
    *) EXTRA_ARGS+=("$1"); shift;;
  esac
done

# ─── interactive prompt for missing required ────────────────────────────
prompt_if_empty() {
  local var_name="$1"; local question="$2"; local current="${!var_name:-}"
  if [[ -z "$current" ]]; then
    printf "%s: " "$question" >&2
    local val; read -r val
    eval "$var_name=\$val"
  fi
}

prompt_if_empty TENANT_ID    "Shre tenant ID (from the marketplace signup)"
prompt_if_empty DEVICE_ALIAS  "Friendly name for this device (e.g., 'Front Counter Register')"

if [[ -z "$STORE_ID" ]]; then
  printf "Store ID (e.g., store_acme_001, or leave blank for 'default'): " >&2
  read -r STORE_ID || true
  [[ -z "$STORE_ID" ]] && STORE_ID="default"
fi

if [[ -z "$USER_ID" ]]; then
  printf "User ID for AROS event attribution (your work email or chosen handle, leave blank to skip): " >&2
  read -r USER_ID || true
fi

if [[ "$MODE" = "read_write" && -z "$BOOTSTRAP_KEY" ]]; then
  printf "Bootstrap key (required for read_write mode): " >&2
  read -rs BOOTSTRAP_KEY; echo
fi

# ─── install deps + build ────────────────────────────────────────────────
echo
echo "== Installing dependencies (this can take 30s) =="
npm install --no-audit --no-fund --loglevel=error

echo
echo "== Building =="
npm run build

# ─── run the connector installer ─────────────────────────────────────────
echo
echo "== Installing shre-connector service =="

CONNECTOR_ARGS=(
  --tenant-id "$TENANT_ID"
  --device-alias "$DEVICE_ALIAS"
  --store-id "$STORE_ID"
  --mode "$MODE"
  --install-root "$REPO_ROOT"
)
[[ -n "$USER_ID" ]] && CONNECTOR_ARGS+=(--user-id "$USER_ID")
[[ -n "$BOOTSTRAP_KEY" ]] && CONNECTOR_ARGS+=(--bootstrap-key "$BOOTSTRAP_KEY")
[[ -n "$APP" ]] && CONNECTOR_ARGS+=(--app "$APP")
CONNECTOR_ARGS+=("${EXTRA_ARGS[@]}")

bash "$REPO_ROOT/scripts/install-shre-connector.sh" "${CONNECTOR_ARGS[@]}"

echo
echo "== Setup complete =="
echo "The shre-connector service is now installed and running."
echo "Service:  com.rapidinfosoft.shre-connector  (launchd on macOS, systemd on Linux)"
echo "Config:   \${VERIFONE_SHRE_HOME:-\$HOME/.verifone-shre-cstoresku}/aros-config.json"
echo "Logs:     \$HOME/.verifone-cstoresku/logs/shre-connector.{log,err}"
echo
echo "Tail logs:    tail -F \$HOME/.verifone-cstoresku/logs/shre-connector.log"
echo "Update:       re-run this script with the same or new flags"
echo "Uninstall:    ./scripts/install-shre-connector.sh --uninstall"

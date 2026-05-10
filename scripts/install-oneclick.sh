#!/usr/bin/env bash
set -euo pipefail

INSTALL_ROOT="${INSTALL_ROOT:-/opt/verifone-commander-shre-cstoresku}"
REPO_URL="${REPO_URL:-https://github.com/Nirpat3/Verifone-Commander-Shre-Cstoresku.git}"
BRANCH="${BRANCH:-master}"
DASHBOARD_PORT="${DASHBOARD_PORT:-5480}"
TUNNEL_NAME="${TUNNEL_NAME:-verifone-commander-store}"
DASHBOARD_HOSTNAME="${DASHBOARD_HOSTNAME:-}"
PORTAL_HOSTNAME="${PORTAL_HOSTNAME:-}"
CHAT_HOSTNAME="${CHAT_HOSTNAME:-}"
VERIFONE_HOSTNAME="${VERIFONE_HOSTNAME:-}"
VERIFONE_IP="${VERIFONE_IP:-}"
TUNNEL_TOKEN="${TUNNEL_TOKEN:-}"
LOCAL_ADMIN_TOKEN="${LOCAL_ADMIN_TOKEN:-}"
INSTALL_CLOUDFLARE_SERVICE="${INSTALL_CLOUDFLARE_SERVICE:-false}"

if [[ -z "$DASHBOARD_HOSTNAME" || -z "$VERIFONE_HOSTNAME" ]]; then
  echo "DASHBOARD_HOSTNAME and VERIFONE_HOSTNAME are required." >&2
  exit 1
fi

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

install_packages() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    if ! need_cmd brew; then
      echo "Homebrew is required for macOS one-click install." >&2
      exit 1
    fi
    need_cmd git || brew install git
    need_cmd node || brew install node@20 node
    need_cmd cloudflared || brew install cloudflared
    return
  fi
  if need_cmd apt-get; then
    export DEBIAN_FRONTEND=noninteractive
    sudo apt-get update
    sudo apt-get install -y git curl ca-certificates nodejs npm
    if ! need_cmd cloudflared; then
      curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$(dpkg --print-architecture).deb" -o /tmp/cloudflared.deb
      sudo dpkg -i /tmp/cloudflared.deb || sudo apt-get install -f -y
    fi
  elif need_cmd dnf; then
    sudo dnf install -y git nodejs npm cloudflared
  elif need_cmd yum; then
    sudo yum install -y git nodejs npm cloudflared
  else
    echo "Unsupported Linux package manager. Install git, nodejs, npm, and cloudflared first." >&2
    exit 1
  fi
}

install_packages

sudo mkdir -p "$INSTALL_ROOT"
sudo chown "$(id -u)":"$(id -g)" "$INSTALL_ROOT"
if [[ -d "$INSTALL_ROOT/.git" ]]; then
  git -C "$INSTALL_ROOT" fetch origin "$BRANCH"
  git -C "$INSTALL_ROOT" checkout "$BRANCH"
  git -C "$INSTALL_ROOT" pull --ff-only origin "$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_ROOT"
fi

cd "$INSTALL_ROOT"
npm install
npm run build
./scripts/protect-runtime.sh mark

HOST=127.0.0.1 PORT="$DASHBOARD_PORT" LOCAL_ADMIN_TOKEN="$LOCAL_ADMIN_TOKEN" nohup node dist/apps/dashboard-api/src/server.js > "${INSTALL_ROOT}/dashboard-api.log" 2>&1 &
API_PID="$!"
sleep 3

if [[ -z "$VERIFONE_IP" ]]; then
  for candidate in 192.168.14.11 192.168.31.11 192.168.1.11 192.168.0.11; do
    if curl -fsS --max-time 3 "http://${candidate}/ConfigClient.html" >/dev/null 2>&1 || curl -fsS --max-time 3 "http://${candidate}/" >/dev/null 2>&1; then
      VERIFONE_IP="$candidate"
      break
    fi
  done
fi
if [[ -z "$VERIFONE_IP" ]]; then
  echo "Unable to auto-detect Verifone IP. Set VERIFONE_IP and rerun." >&2
  exit 1
fi

CLOUDFLARED_CONFIG_DIR="${CLOUDFLARED_CONFIG_DIR:-$HOME/.cloudflared}"
mkdir -p "$CLOUDFLARED_CONFIG_DIR"
CONFIG_PATH="${CLOUDFLARED_CONFIG_DIR}/${TUNNEL_NAME}.yml"
{
  echo "tunnel: ${TUNNEL_NAME}"
  echo "ingress:"
  if [[ -n "$PORTAL_HOSTNAME" ]]; then
    echo "  - hostname: ${PORTAL_HOSTNAME}"
    echo "    service: http://localhost:${DASHBOARD_PORT}"
  fi
  echo "  - hostname: ${DASHBOARD_HOSTNAME}"
  echo "    service: http://localhost:${DASHBOARD_PORT}"
  if [[ -n "$CHAT_HOSTNAME" ]]; then
    echo "  - hostname: ${CHAT_HOSTNAME}"
    echo "    service: http://localhost:${DASHBOARD_PORT}"
  fi
  echo "  - hostname: ${VERIFONE_HOSTNAME}"
  echo "    service: http://${VERIFONE_IP}"
  echo "  - service: http_status:404"
} > "$CONFIG_PATH"

if [[ "$INSTALL_CLOUDFLARE_SERVICE" == "true" ]]; then
  if [[ -z "$TUNNEL_TOKEN" ]]; then
    echo "TUNNEL_TOKEN is required for non-interactive cloudflared service install." >&2
    exit 1
  fi
  sudo cloudflared service install "$TUNNEL_TOKEN"
fi

BODY="$(printf '{"provider":"cloudflare","enabled":true,"tunnelId":"%s","publicUrl":"https://%s","portalUrl":"%s","dashboardUrl":"https://%s","verifoneUrl":"https://%s/ConfigClient.html","verifoneLanUrl":"http://%s/ConfigClient.html","verifoneDetectedIp":"%s"}' "$TUNNEL_NAME" "$DASHBOARD_HOSTNAME" "${PORTAL_HOSTNAME:+https://$PORTAL_HOSTNAME/portal}" "$DASHBOARD_HOSTNAME" "$VERIFONE_HOSTNAME" "$VERIFONE_IP" "$VERIFONE_IP")"
CURL_HEADERS=(-H "content-type: application/json")
if [[ -n "$LOCAL_ADMIN_TOKEN" ]]; then
  CURL_HEADERS+=(-H "x-local-admin-token: $LOCAL_ADMIN_TOKEN")
fi
curl -fsS -X POST "http://127.0.0.1:${DASHBOARD_PORT}/api/remote-access" "${CURL_HEADERS[@]}" -d "$BODY" >/dev/null || true

CHAT_URL="${CHAT_HOSTNAME:+https://$CHAT_HOSTNAME/chat}"
if [[ -z "$CHAT_URL" ]]; then CHAT_URL="https://${DASHBOARD_HOSTNAME}/chat"; fi
PORTAL_URL="${PORTAL_HOSTNAME:+https://$PORTAL_HOSTNAME/portal}"
if [[ -z "$PORTAL_URL" ]]; then PORTAL_URL="https://${DASHBOARD_HOSTNAME}/portal"; fi

cat <<JSON
{
  "ok": true,
  "installRoot": "$INSTALL_ROOT",
  "apiProcessId": "$API_PID",
  "localDashboard": "http://127.0.0.1:$DASHBOARD_PORT",
  "localPortal": "http://127.0.0.1:$DASHBOARD_PORT/portal",
  "localChat": "http://127.0.0.1:$DASHBOARD_PORT/chat",
  "portalUrl": "$PORTAL_URL",
  "dashboardUrl": "https://$DASHBOARD_HOSTNAME",
  "chatUrl": "$CHAT_URL",
  "verifoneUrl": "https://$VERIFONE_HOSTNAME/ConfigClient.html",
  "verifoneLanUrl": "http://$VERIFONE_IP/ConfigClient.html",
  "cloudflaredConfig": "$CONFIG_PATH"
}
JSON

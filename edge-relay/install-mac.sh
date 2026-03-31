#!/usr/bin/env bash
set -euo pipefail

# ══════════════════════════════════════════════════════════════════
# Verifone Edge Relay — One-Command Mac Installer (Docker)
# ══════════════════════════════════════════════════════════════════
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Nirlabinc/shre-verifone/main/edge-relay/install-mac.sh | bash
#
# Prerequisites: NONE — installs Docker Desktop if needed.
#

REPO_URL="https://github.com/Nirlabinc/shre-verifone.git"
INSTALL_DIR="$HOME/.local/share/verifone-edge-relay"

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   Verifone Edge Relay — Mac Installer (Docker)   ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ── 1. Check/install Docker ──────────────────────────────────────

echo "[1/4] Checking Docker..."

if ! command -v docker &>/dev/null; then
  echo "  Docker not found. Installing Docker Desktop..."

  # Download Docker Desktop for Mac
  ARCH=$(uname -m)
  if [ "$ARCH" = "arm64" ]; then
    DOCKER_URL="https://desktop.docker.com/mac/main/arm64/Docker.dmg"
  else
    DOCKER_URL="https://desktop.docker.com/mac/main/amd64/Docker.dmg"
  fi

  echo "  Downloading Docker Desktop..."
  curl -fsSL "$DOCKER_URL" -o /tmp/Docker.dmg

  echo "  Mounting installer..."
  hdiutil attach /tmp/Docker.dmg -quiet

  echo "  Installing Docker Desktop (may ask for password)..."
  cp -R "/Volumes/Docker/Docker.app" /Applications/ 2>/dev/null || \
    sudo cp -R "/Volumes/Docker/Docker.app" /Applications/

  hdiutil detach "/Volumes/Docker" -quiet 2>/dev/null || true
  rm -f /tmp/Docker.dmg

  echo "  Starting Docker Desktop..."
  open /Applications/Docker.app

  echo ""
  echo "  ⏳ Waiting for Docker to start (this takes ~60 seconds on first launch)..."
  echo "  If Docker asks for permissions, please approve them."
  echo ""

  # Wait for Docker daemon
  retries=0
  until docker info &>/dev/null; do
    retries=$((retries + 1))
    if [ "$retries" -gt 60 ]; then
      echo ""
      echo "  Docker is taking too long to start."
      echo "  Please open Docker Desktop manually, wait for it to finish starting,"
      echo "  then re-run this script."
      exit 1
    fi
    sleep 3
    printf "  Waiting... (%ds)\r" "$((retries * 3))"
  done
  echo ""
  echo "  ✓ Docker Desktop installed and running"
else
  # Docker exists but may not be running
  if ! docker info &>/dev/null 2>&1; then
    echo "  Docker found but not running. Starting Docker Desktop..."
    open /Applications/Docker.app 2>/dev/null || true
    retries=0
    until docker info &>/dev/null; do
      retries=$((retries + 1))
      if [ "$retries" -gt 30 ]; then
        echo "  Please start Docker Desktop and re-run this script."
        exit 1
      fi
      sleep 2
    done
  fi
  echo "  ✓ Docker $(docker --version | cut -d' ' -f3 | tr -d ',')"
fi

# ── 2. Clone/update repo ─────────────────────────────────────────

echo "[2/4] Getting source code..."

mkdir -p "$HOME/.local/share"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/Dockerfile" ]; then
  echo "  ✓ Running from local repo"
  RELAY_DIR="$SCRIPT_DIR"
elif [ -d "$INSTALL_DIR/.git" ]; then
  echo "  Updating existing installation..."
  cd "$INSTALL_DIR"
  git pull origin main 2>&1 | sed 's/^/  /'
  RELAY_DIR="$INSTALL_DIR/edge-relay"
else
  echo "  Cloning repo..."
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" 2>&1 | sed 's/^/  /'
  RELAY_DIR="$INSTALL_DIR/edge-relay"
fi

# ── 3. Pull and start ────────────────────────────────────────────

echo "[3/4] Pulling and starting containers..."

cd "$RELAY_DIR"
docker compose pull 2>&1 | sed 's/^/  /'
docker compose up -d 2>&1 | sed 's/^/  /'

# ── 4. Verify ────────────────────────────────────────────────────

echo "[4/4] Verifying..."
sleep 3

if curl -s "http://localhost:18464/health" >/dev/null 2>&1; then
  echo ""
  echo "╔══════════════════════════════════════════════════╗"
  echo "║          Installation Complete!                   ║"
  echo "╠══════════════════════════════════════════════════╣"
  echo "║                                                   ║"
  echo "║  Setup:     http://localhost:18464/setup.html     ║"
  echo "║  Dashboard: http://localhost:18464/status.html    ║"
  echo "║                                                   ║"
  echo "║  Manage:                                          ║"
  echo "║    docker compose logs -f    (view logs)          ║"
  echo "║    docker compose restart    (restart)            ║"
  echo "║    docker compose down       (stop)               ║"
  echo "║                                                   ║"
  echo "╚══════════════════════════════════════════════════╝"
  echo ""
  open "http://localhost:18464/setup.html"
else
  echo ""
  echo "  Container starting... open http://localhost:18464/setup.html in a moment."
  echo "  Logs: docker compose -f $RELAY_DIR/docker-compose.yml logs -f"
  echo ""
  open "http://localhost:18464/setup.html"
fi

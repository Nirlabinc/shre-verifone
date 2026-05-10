#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${PREFIX:-}" || "$PREFIX" != *"com.termux"* ]]; then
  echo "Android pilot install is supported through Termux. Run this inside Termux." >&2
  exit 1
fi

pkg update -y
pkg install -y git nodejs-lts curl

export INSTALL_ROOT="${INSTALL_ROOT:-$HOME/verifone-commander-shre-cstoresku}"
export CLOUDFLARED_CONFIG_DIR="${CLOUDFLARED_CONFIG_DIR:-$HOME/.cloudflared}"

if ! command -v cloudflared >/dev/null 2>&1; then
  ARCH="$(uname -m)"
  case "$ARCH" in
    aarch64|arm64) CF_ARCH="arm64" ;;
    armv7l|arm) CF_ARCH="arm" ;;
    x86_64|amd64) CF_ARCH="amd64" ;;
    *) echo "Unsupported Android architecture for cloudflared: $ARCH" >&2; exit 1 ;;
  esac
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}" -o "$PREFIX/bin/cloudflared"
  chmod +x "$PREFIX/bin/cloudflared"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/install-oneclick.sh" "$@"

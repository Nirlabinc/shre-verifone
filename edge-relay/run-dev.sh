#!/usr/bin/env bash
set -euo pipefail

# Verifone Edge Relay — Run from Source (Dev/Site Setup)
# Usage: ./run-dev.sh
#
# Runs the edge relay directly from source using Node.js.
# No binary build required — just needs Node 20+ installed.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="${RELAY_DATA_DIR:-$HOME/Library/Application Support/VerifoneEdgeRelay}"

echo "=== Verifone Edge Relay (dev mode) ==="
echo "  Data dir: $DATA_DIR"
echo "  Admin UI: http://localhost:18464"
echo ""

# Ensure data directory exists
mkdir -p "$DATA_DIR/logs"

# Install dependencies if needed
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  echo "Installing dependencies..."
  cd "$SCRIPT_DIR" && npm install
fi

# Export data dir for the relay
export RELAY_DATA_DIR="$DATA_DIR"
export LOG_LEVEL="${LOG_LEVEL:-info}"

# Run from source
exec node "$SCRIPT_DIR/src/main.mjs"

#!/usr/bin/env bash
# macOS double-click wrapper. Opens Terminal, runs setup.sh interactively.
# Right-click → Open the first time (Gatekeeper).

cd "$(dirname "$0")/.." || exit 1
exec ./scripts/setup.sh

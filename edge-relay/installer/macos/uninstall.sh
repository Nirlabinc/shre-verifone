#!/usr/bin/env bash
set -euo pipefail

# Verifone Edge Relay — macOS Uninstaller

PRODUCT="verifone-edge-relay"
INSTALL_DIR="$HOME/.local/bin"
DATA_DIR="$HOME/Library/Application Support/VerifoneEdgeRelay"
PLIST_NAME="ai.shre.verifone-edge-relay"
PLIST_DIR="$HOME/Library/LaunchAgents"

echo "=== Uninstalling Verifone Edge Relay ==="

# Stop service
echo "Stopping service..."
launchctl unload "$PLIST_DIR/$PLIST_NAME.plist" 2>/dev/null || true

# Remove binary and UI
echo "Removing files..."
rm -f "$INSTALL_DIR/$PRODUCT"
rm -rf "$INSTALL_DIR/$PRODUCT-ui"
rm -f "$PLIST_DIR/$PLIST_NAME.plist"

# Ask about data
echo ""
read -p "Remove relay data (reports, logs, config)? [y/N] " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  rm -rf "$DATA_DIR"
  echo "Data removed."
else
  echo "Data preserved at: $DATA_DIR"
fi

echo ""
echo "Uninstall complete."

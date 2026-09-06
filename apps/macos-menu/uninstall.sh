#!/usr/bin/env bash
# Removes the LaunchAgent and binary. Does NOT touch astermux itself.
set -euo pipefail

INSTALL_DIR="${HOME}/.local/bin"
BIN_NAME="astermux-menu"
LABEL="io.astermux.widget"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

if [[ -f "$PLIST" ]]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo ">> Removed LaunchAgent $PLIST"
fi

if [[ -f "$INSTALL_DIR/$BIN_NAME" ]]; then
  rm -f "$INSTALL_DIR/$BIN_NAME"
  echo ">> Removed $INSTALL_DIR/$BIN_NAME"
fi

echo "Done. The astermux service was not affected."

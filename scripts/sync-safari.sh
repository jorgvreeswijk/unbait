#!/bin/bash
# Sync Chrome extension files to Safari extension resources.
# Does NOT touch manifest.json or Safari-specific Xcode files.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SAFARI_DIR="$PROJECT_DIR/safari/Unbait/Unbait Extension/Resources"

for file in background/service-worker.js content/content.js content/content.css popup/popup.js popup/popup.html popup/popup.css icons/icon-16.png icons/icon-48.png icons/icon-128.png; do
  cp "$PROJECT_DIR/extension/$file" "$SAFARI_DIR/$file"
done

echo "Safari files synced from Chrome extension."

#!/bin/bash
# Sync Chrome extension files to Safari extension resources.
# Does NOT touch manifest.json or Safari-specific Xcode files.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SAFARI_MAC_DIR="$PROJECT_DIR/safari/Unbait/Unbait Extension/Resources"
SAFARI_IOS_DIR="$PROJECT_DIR/safari/Unbait/Unbait iOS Extension/Resources"

FILES="background/service-worker.js content/shared.js content/html-utils.js content/content.js content/content.css content/gist-only.js content/youtube.js content/yt-main-bridge.js popup/popup.js popup/popup.html popup/popup.css icons/icon-16.png icons/icon-48.png icons/icon-128.png"

for file in $FILES; do
  cp "$PROJECT_DIR/extension/$file" "$SAFARI_MAC_DIR/$file"
  cp "$PROJECT_DIR/extension/$file" "$SAFARI_IOS_DIR/$file"
done

echo "Safari (macOS + iOS) files synced from Chrome extension."

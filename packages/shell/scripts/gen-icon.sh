#!/usr/bin/env bash
# Render the app icon (scripts/icon.html) to resources/icon.png, 1024×1024 with
# transparency. electron-builder derives the Windows and macOS icons from it.
# Only needed when the icon changes; the PNG is committed. Requires Chrome/Chromium.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out="$here/../resources/icon.png"
chrome=${CHROME:-$(command -v google-chrome-stable || command -v chromium || command -v google-chrome)}
mkdir -p "$(dirname "$out")"
profile=$(mktemp -d)
# The font loads asynchronously; the budget gives it time before the screenshot.
"$chrome" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$profile" \
  --allow-file-access-from-files --virtual-time-budget=3000 \
  --default-background-color=00000000 --window-size=1024,1024 \
  --screenshot="$out" "file://$here/icon.html" >/dev/null 2>&1
rm -rf "$profile"
echo "icon.png (1024×1024)"

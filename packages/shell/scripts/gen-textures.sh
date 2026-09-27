#!/usr/bin/env bash
# Rasterise the procedural SVG textures into PNGs under src/renderer/theme/textures.
# Only needed when a texture changes; the PNGs are committed. Requires Chrome/Chromium.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out="$here/../src/renderer/theme/textures"
chrome=${CHROME:-$(command -v google-chrome-stable || command -v chromium || command -v google-chrome)}
mkdir -p "$out"
for svg in "$here"/textures/*.svg; do
  name=$(basename "$svg" .svg)
  size=$(grep -oE 'width="[0-9]+" height="[0-9]+"' "$svg" | head -1 | grep -oE '[0-9]+' | paste -sd,)
  profile=$(mktemp -d)
  "$chrome" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$profile" \
    --default-background-color=00000000 --window-size="$size" \
    --screenshot="$out/$name.png" "file://$svg" >/dev/null 2>&1
  rm -rf "$profile"
  # Grain textures compress far better as WebP; the deckle mask stays a crisp PNG.
  if [ "$name" != deckle ]; then
    scale=100%; [ "$name" = stains ] && scale=50%
    magick "$out/$name.png" -resize "$scale" -quality 82 "$out/$name.webp" && rm "$out/$name.png"
    echo "$name.webp ($size @ $scale)"
  else
    echo "$name.png ($size)"
  fi
done

#!/usr/bin/env bash
# Rasterise the procedural SVG textures into PNGs under src/renderer/theme/textures.
# Only needed when a texture changes; the PNGs are committed. Requires Chrome/Chromium.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out="$here/../src/renderer/theme/textures"
chrome=${CHROME:-$(command -v google-chrome-stable || command -v chromium || command -v google-chrome)}
mkdir -p "$out"
python3 "$here/parchment.py" "$here/textures"
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
    scale=100%
    # Parchment is soft, low-contrast texture: ordinary WebP quality turns it into blocks.
    case "$name" in
      parchment-*) opts=(-quality 96 -define webp:use-sharp-yuv=true -define webp:method=6) ;;
      *) opts=(-quality 82) ;;
    esac
    magick "$out/$name.png" -resize "$scale" "${opts[@]}" "$out/$name.webp" && rm "$out/$name.png"
    echo "$name.webp ($size @ $scale)"
  else
    echo "$name.png ($size)"
  fi
done

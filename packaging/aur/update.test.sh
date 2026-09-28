#!/usr/bin/env bash
set -euo pipefail

staging=$(mktemp -d)
trap 'rm -rf -- "$staging"' EXIT
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cp -r "$source_dir/featherlog-bin" "$staging/"
cp "$source_dir/update.sh" "$staging/"
mkdir "$staging/bin"
cat > "$staging/bin/curl" <<'CURL'
#!/usr/bin/env bash
set -euo pipefail
[[ ${FAIL_DOWNLOAD:-0} == 0 ]] || exit 22
while [[ $1 != --output ]]; do shift; done
printf 'downloaded:%s\n' "$(basename "$2")" > "$2"
CURL
chmod +x "$staging/bin/curl"
export PATH="$staging/bin:$PATH"

recipe="$staging/featherlog-bin/PKGBUILD"
sed -i 's/^pkgrel=.*/pkgrel=9/' "$recipe"
"$staging/update.sh" 1.2.3
image_sha=$(printf 'downloaded:Featherlog-1.2.3-x86_64.AppImage\n' | sha256sum)
license_sha=$(printf 'downloaded:LICENSE\n' | sha256sum)
grep -qx 'pkgver=1.2.3' "$recipe"
grep -qx 'pkgrel=1' "$recipe"
grep -q "${image_sha%% *}" "$recipe"
grep -q "${license_sha%% *}" "$recipe"
(cd "$staging/featherlog-bin" && makepkg --printsrcinfo) > "$staging/expected"
cmp "$staging/expected" "$staging/featherlog-bin/.SRCINFO"
cp "$recipe" "$staging/before"
cp "$staging/featherlog-bin/.SRCINFO" "$staging/before-info"

if FAIL_DOWNLOAD=1 "$staging/update.sh" 2.0.0; then exit 1; fi
if "$staging/update.sh" '../bad'; then exit 1; fi
if "$staging/update.sh"; then exit 1; fi
cat > "$staging/bin/makepkg" <<'MAKEPKG'
#!/bin/sh
exit 1
MAKEPKG
chmod +x "$staging/bin/makepkg"
if "$staging/update.sh" 2.0.0; then exit 1; fi
cmp "$staging/before" "$recipe"
cmp "$staging/before-info" "$staging/featherlog-bin/.SRCINFO"
printf 'AUR update script checks passed\n'

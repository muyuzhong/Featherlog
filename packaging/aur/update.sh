#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 || ! $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: $0 <version, e.g. 0.1.1>" >&2
  exit 1
fi
version=$1
package_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/featherlog-bin" && pwd)
staging=$(mktemp -d)
trap 'rm -rf -- "$staging"' EXIT
image="Featherlog-${version}-x86_64.AppImage"
curl --fail --location --retry 3 --proto '=https' --proto-redir '=https' \
  "https://github.com/muyuzhong/Featherlog/releases/download/v${version}/${image}" \
  --output "$staging/$image"
curl --fail --location --retry 3 --proto '=https' --proto-redir '=https' \
  "https://raw.githubusercontent.com/muyuzhong/Featherlog/v${version}/LICENSE" \
  --output "$staging/LICENSE"
image_sha=$(sha256sum "$staging/$image")
license_sha=$(sha256sum "$staging/LICENSE")

sed -e "s/^pkgver=.*/pkgver=${version}/" -e 's/^pkgrel=.*/pkgrel=1/' \
  -e '/^# v0.1.1 is not published yet\./d' \
  -e "/^sha256sums=(/,/^[[:space:]]*'.*')/c\\sha256sums=('${image_sha%% *}'\\n            '${license_sha%% *}')" \
  "$package_dir/PKGBUILD" > "$staging/PKGBUILD"
(cd -- "$staging" && makepkg --printsrcinfo) > "$staging/.SRCINFO"
# Leave the recipe untouched if either download or metadata generation failed.
install -m644 "$staging/PKGBUILD" "$package_dir/PKGBUILD"
install -m644 "$staging/.SRCINFO" "$package_dir/.SRCINFO"

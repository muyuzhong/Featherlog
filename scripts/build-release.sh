#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <version> (e.g. 2.0.0)" >&2
  exit 1
fi

VERSION="${1#v}"
if [[ ! "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$ ]]; then
  echo "Error: invalid semver version '${1}'" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUT_DIR="${REPO_ROOT}/dist/release"
APPLET_ID="io.github.muyuzhong.featherlog"

ICON_SRC="${REPO_ROOT}/resources/icon.png"
DESKTOP_SRC="${REPO_ROOT}/resources/featherlog.desktop"
PLASMOID_SRC="${REPO_ROOT}/plasmoid/${APPLET_ID}"
LICENSE_SRC="${REPO_ROOT}/LICENSE"
README_SRC="${REPO_ROOT}/README.md"

for req in "${ICON_SRC}" "${DESKTOP_SRC}" "${PLASMOID_SRC}/metadata.json" "${LICENSE_SRC}" "${README_SRC}"; do
  if [[ ! -f "${req}" ]]; then
    echo "Error: required release input missing: ${req}" >&2
    exit 1
  fi
done

for cmd in go pnpm tar gzip python3 sha256sum; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "Error: required tool not found in PATH: ${cmd}" >&2
    exit 1
  fi
done

if [[ -z "${SOURCE_DATE_EPOCH:-}" ]]; then
  if command -v git >/dev/null 2>&1 && git -C "${REPO_ROOT}" rev-parse --git-dir >/dev/null 2>&1; then
    SOURCE_DATE_EPOCH="$(git -C "${REPO_ROOT}" log -1 --format=%ct)"
  else
    SOURCE_DATE_EPOCH="1700000000"
  fi
fi
export SOURCE_DATE_EPOCH

STAGING="$(mktemp -d)"
trap 'rm -rf -- "${STAGING}"' EXIT

make_targz() {
  local parent_dir="$1"
  local entry_name="$2"
  local out_file="$3"
  tar \
    --sort=name \
    --mtime="@${SOURCE_DATE_EPOCH}" \
    --owner=0 \
    --group=0 \
    --numeric-owner \
    -C "${parent_dir}" \
    -cf - "${entry_name}" \
    | gzip -n -9 > "${out_file}"
}

make_zip() {
  local src_dir="$1"
  local out_file="$2"
  local prefix="${3:-}"
  python3 - "${src_dir}" "${out_file}" "${prefix}" "${SOURCE_DATE_EPOCH}" <<'PY'
import os
import stat
import sys
import time
import zipfile

src_dir, out_file, prefix, epoch_str = sys.argv[1:5]
epoch = max(int(epoch_str), 315532800)  # ZIP DOS timestamp minimum: 1980-01-01
dt = time.gmtime(epoch)[:6]

entries = []
for root, dirs, files in os.walk(src_dir):
    dirs.sort()
    files.sort()
    for name in files:
        full_path = os.path.join(root, name)
        rel_path = os.path.relpath(full_path, src_dir).replace(os.sep, "/")
        arc_name = f"{prefix}/{rel_path}" if prefix else rel_path
        entries.append((full_path, arc_name))

with zipfile.ZipFile(out_file, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    for full_path, arc_name in entries:
        st = os.stat(full_path)
        zi = zipfile.ZipInfo(arc_name, date_time=dt)
        zi.compress_type = zipfile.ZIP_DEFLATED
        zi.create_system = 3  # Unix
        mode = stat.S_IFREG | (stat.S_IMODE(st.st_mode) & 0o755)
        zi.external_attr = (mode & 0xFFFF) << 16
        with open(full_path, "rb") as f:
            zf.writestr(zi, f.read())
PY
}

generate_icons() {
  local src_png="$1"
  local out_png512="$2"
  local out_icns="$3"
  cat > "${STAGING}/mkicons.go" <<'GO'
package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
)

func downscale(src image.Image, dstW, dstH int) *image.NRGBA {
	b := src.Bounds()
	srcW, srcH := b.Dx(), b.Dy()
	dst := image.NewNRGBA(image.Rect(0, 0, dstW, dstH))
	for y := 0; y < dstH; y++ {
		y0 := b.Min.Y + y*srcH/dstH
		y1 := b.Min.Y + (y+1)*srcH/dstH
		if y1 <= y0 {
			y1 = y0 + 1
		}
		for x := 0; x < dstW; x++ {
			x0 := b.Min.X + x*srcW/dstW
			x1 := b.Min.X + (x+1)*srcW/dstW
			if x1 <= x0 {
				x1 = x0 + 1
			}
			var rSum, gSum, bSum, aSum, count uint64
			for sy := y0; sy < y1; sy++ {
				for sx := x0; sx < x1; sx++ {
					c := color.NRGBAModel.Convert(src.At(sx, sy)).(color.NRGBA)
					rSum += uint64(c.R)
					gSum += uint64(c.G)
					bSum += uint64(c.B)
					aSum += uint64(c.A)
					count++
				}
			}
			dst.SetNRGBA(x, y, color.NRGBA{
				R: uint8((rSum + count/2) / count),
				G: uint8((gSum + count/2) / count),
				B: uint8((bSum + count/2) / count),
				A: uint8((aSum + count/2) / count),
			})
		}
	}
	return dst
}

func main() {
	if len(os.Args) != 4 {
		fmt.Fprintf(os.Stderr, "usage: mkicons <src.png> <out-512.png> <out.icns>\n")
		os.Exit(2)
	}
	raw1024, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	img, err := png.Decode(bytes.NewReader(raw1024))
	if err != nil {
		panic(err)
	}
	img512 := downscale(img, 512, 512)
	var buf512 bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestCompression}
	if err := enc.Encode(&buf512, img512); err != nil {
		panic(err)
	}
	if err := os.WriteFile(os.Args[2], buf512.Bytes(), 0o644); err != nil {
		panic(err)
	}

	// Build a modern macOS .icns container with ic10 (1024x1024 PNG) and ic09 (512x512 PNG).
	png512 := buf512.Bytes()
	totalLen := uint32(8 + 8 + len(raw1024) + 8 + len(png512))
	var icns bytes.Buffer
	icns.WriteString("icns")
	_ = binary.Write(&icns, binary.BigEndian, totalLen)
	icns.WriteString("ic10")
	_ = binary.Write(&icns, binary.BigEndian, uint32(8+len(raw1024)))
	icns.Write(raw1024)
	icns.WriteString("ic09")
	_ = binary.Write(&icns, binary.BigEndian, uint32(8+len(png512)))
	icns.Write(png512)
	if err := os.WriteFile(os.Args[3], icns.Bytes(), 0o644); err != nil {
		panic(err)
	}
}
GO
  go run "${STAGING}/mkicons.go" "${src_png}" "${out_png512}" "${out_icns}"
}

write_linux_install_sh() {
  local dest="$1"
  cat > "${dest}" <<'INSTALLER'
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLET_ID="io.github.muyuzhong.featherlog"

MODE="user"
PREFIX=""
SKIP_PLASMOID=0
UNINSTALL=0

usage() {
  cat <<'EOF'
Install Featherlog v2 (desktop host, CLI, desktop entry, icon, and KDE Plasma 6 applet).

Usage:
  ./install.sh [options]

Options:
  --user           Install for the current user (default; ~/.local)
  --system         Install system-wide (/usr/local by default; may require sudo)
  --prefix <dir>   Override installation prefix
  --skip-plasmoid  Skip installing the KDE Plasma 6 dock applet
  --uninstall      Remove installed Featherlog files
  -h, --help       Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user)
      MODE="user"
      shift
      ;;
    --system)
      MODE="system"
      shift
      ;;
    --prefix)
      if [[ $# -lt 2 ]]; then
        echo "Error: --prefix requires a directory argument" >&2
        exit 2
      fi
      PREFIX="$2"
      shift 2
      ;;
    --prefix=*)
      PREFIX="${1#--prefix=}"
      shift
      ;;
    --skip-plasmoid)
      SKIP_PLASMOID=1
      shift
      ;;
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown option '$1'" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "${MODE}" == "system" ]]; then
  PREFIX="${PREFIX:-/usr/local}"
  BIN_DIR="${DESTDIR:-}${PREFIX}/bin"
  SHARE_DIR="${DESTDIR:-}${PREFIX}/share"
else
  if [[ -n "${PREFIX}" ]]; then
    BIN_DIR="${PREFIX}/bin"
    SHARE_DIR="${PREFIX}/share"
  else
    BIN_DIR="${HOME}/.local/bin"
    SHARE_DIR="${XDG_DATA_HOME:-${HOME}/.local/share}"
  fi
fi

DESKTOP_PATH="${SHARE_DIR}/applications/featherlog.desktop"
ICON_PATH="${SHARE_DIR}/icons/hicolor/512x512/apps/featherlog.png"
PLASMOID_DIR="${SHARE_DIR}/plasma/plasmoids/${APPLET_ID}"
LICENSE_PATH="${SHARE_DIR}/licenses/featherlog/LICENSE"
DOC_PATH="${SHARE_DIR}/doc/featherlog/README.md"

if [[ "${UNINSTALL}" -eq 1 ]]; then
  rm -f "${BIN_DIR}/featherlog" "${DESKTOP_PATH}" "${ICON_PATH}" "${LICENSE_PATH}" "${DOC_PATH}"
  if [[ "${SKIP_PLASMOID}" -eq 0 ]]; then
    if [[ "${MODE}" == "user" ]] && command -v kpackagetool6 >/dev/null 2>&1; then
      XDG_DATA_HOME="${SHARE_DIR}" kpackagetool6 -t Plasma/Applet -r "${APPLET_ID}" >/dev/null 2>&1 || rm -rf "${PLASMOID_DIR}"
    else
      rm -rf "${PLASMOID_DIR}"
    fi
  fi
  echo "Uninstalled Featherlog from ${BIN_DIR} and ${SHARE_DIR}"
  exit 0
fi

install -Dm755 "${SCRIPT_DIR}/featherlog" "${BIN_DIR}/featherlog"

install -d "${SHARE_DIR}/applications"
if [[ "${MODE}" == "user" && "${BIN_DIR}" != "/usr/bin" && "${BIN_DIR}" != "/usr/local/bin" ]]; then
  sed "s|^Exec=featherlog |Exec=${BIN_DIR}/featherlog |" "${SCRIPT_DIR}/featherlog.desktop" > "${DESKTOP_PATH}"
  chmod 644 "${DESKTOP_PATH}"
else
  install -Dm644 "${SCRIPT_DIR}/featherlog.desktop" "${DESKTOP_PATH}"
fi

install -d "${SHARE_DIR}/icons/hicolor/512x512/apps"
if command -v magick >/dev/null 2>&1; then
  magick "${SCRIPT_DIR}/icon.png" -resize 512x512 "${ICON_PATH}"
  chmod 644 "${ICON_PATH}"
else
  install -Dm644 "${SCRIPT_DIR}/icon.png" "${ICON_PATH}"
fi

install -Dm644 "${SCRIPT_DIR}/LICENSE" "${LICENSE_PATH}"
install -Dm644 "${SCRIPT_DIR}/README.md" "${DOC_PATH}"

if [[ "${SKIP_PLASMOID}" -eq 0 ]]; then
  PLASMOID_SRC="${SCRIPT_DIR}/plasmoid/${APPLET_ID}"
  if [[ "${MODE}" == "user" ]] && command -v kpackagetool6 >/dev/null 2>&1; then
    if [[ -d "${PLASMOID_DIR}" ]]; then
      XDG_DATA_HOME="${SHARE_DIR}" kpackagetool6 -t Plasma/Applet -u "${PLASMOID_SRC}"
    else
      XDG_DATA_HOME="${SHARE_DIR}" kpackagetool6 -t Plasma/Applet -u "${PLASMOID_SRC}" >/dev/null 2>&1 \
        || XDG_DATA_HOME="${SHARE_DIR}" kpackagetool6 -t Plasma/Applet -i "${PLASMOID_SRC}"
    fi
    if command -v kbuildsycoca6 >/dev/null 2>&1; then
      kbuildsycoca6 --noincremental >/dev/null 2>&1 || true
    fi
  else
    rm -rf "${PLASMOID_DIR}"
    install -d "${PLASMOID_DIR}"
    cp -a "${PLASMOID_SRC}/." "${PLASMOID_DIR}/"
    find "${PLASMOID_DIR}" -type d -exec chmod 755 {} +
    find "${PLASMOID_DIR}" -type f -exec chmod 644 {} +
  fi
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "${SHARE_DIR}/applications" >/dev/null 2>&1 || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "${SHARE_DIR}/icons/hicolor" >/dev/null 2>&1 || true
fi

echo "Installed Featherlog:"
echo "  Binary:   ${BIN_DIR}/featherlog"
echo "  Desktop:  ${DESKTOP_PATH}"
echo "  Icon:     ${ICON_PATH}"
if [[ "${SKIP_PLASMOID}" -eq 0 ]]; then
  echo "  Plasmoid: ${PLASMOID_DIR}"
fi
INSTALLER
  chmod 0755 "${dest}"
}

echo "==> Building frontend (${VERSION})"
if [[ ! -d "${REPO_ROOT}/frontend/node_modules" ]]; then
  pnpm --dir "${REPO_ROOT}/frontend" install --frozen-lockfile
fi
pnpm --dir "${REPO_ROOT}/frontend" build

if [[ ! -f "${REPO_ROOT}/frontend/dist/index.html" ]]; then
  echo "Error: frontend build did not produce frontend/dist/index.html" >&2
  exit 1
fi

echo "==> Preparing icons and staged plasmoid"
ICON_512="${STAGING}/icon-512.png"
ICON_ICNS="${STAGING}/featherlog.icns"
generate_icons "${ICON_SRC}" "${ICON_512}" "${ICON_ICNS}"

STAGED_PLASMOID="${STAGING}/plasmoid/${APPLET_ID}"
mkdir -p "${STAGED_PLASMOID}"
cp -a "${PLASMOID_SRC}/." "${STAGED_PLASMOID}/"
python3 - "${STAGED_PLASMOID}/metadata.json" "${VERSION}" <<'PY'
import json
import sys

path, version = sys.argv[1:3]
with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)
if data.get("KPlugin", {}).get("Version") != version:
    data.setdefault("KPlugin", {})["Version"] = version
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=4)
        f.write("\n")
PY
find "${STAGED_PLASMOID}" -type d -exec chmod 755 {} +
find "${STAGED_PLASMOID}" -type f -exec chmod 644 {} +

LDFLAGS="-s -w -X main.version=${VERSION}"
BIN_STAGE="${STAGING}/bin"
mkdir -p "${BIN_STAGE}"

build_go_binary() {
  local goos="$1"
  local goarch="$2"
  local out_path="$3"
  local extra_ldflags="${4:-}"
  echo "==> Building Go binary for ${goos}/${goarch}${extra_ldflags:+ (${extra_ldflags})}"
  (
    cd "${REPO_ROOT}"
    CGO_ENABLED=0 GOOS="${goos}" GOARCH="${goarch}" \
      go build -trimpath -ldflags "${LDFLAGS}${extra_ldflags:+ ${extra_ldflags}}" -o "${out_path}" .
  )
}

build_go_binary linux amd64 "${BIN_STAGE}/featherlog-linux-amd64"
build_go_binary linux arm64 "${BIN_STAGE}/featherlog-linux-arm64"
build_go_binary windows amd64 "${BIN_STAGE}/featherlog-windows-amd64.exe" "-H=windowsgui"
build_go_binary windows amd64 "${BIN_STAGE}/featherlog-cli-windows-amd64.exe"
build_go_binary darwin arm64 "${BIN_STAGE}/featherlog-darwin-arm64"
build_go_binary darwin amd64 "${BIN_STAGE}/featherlog-darwin-amd64"

rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}"

echo "==> Packaging Linux tarballs"
for arch in amd64 arm64; do
  bundle_name="featherlog-${VERSION}-linux-${arch}"
  bundle_dir="${STAGING}/linux-${arch}/${bundle_name}"
  mkdir -p "${bundle_dir}/plasmoid/${APPLET_ID}"
  install -m755 "${BIN_STAGE}/featherlog-linux-${arch}" "${bundle_dir}/featherlog"
  install -m644 "${DESKTOP_SRC}" "${bundle_dir}/featherlog.desktop"
  install -m644 "${ICON_SRC}" "${bundle_dir}/icon.png"
  cp -a "${STAGED_PLASMOID}/." "${bundle_dir}/plasmoid/${APPLET_ID}/"
  write_linux_install_sh "${bundle_dir}/install.sh"
  install -m644 "${LICENSE_SRC}" "${bundle_dir}/LICENSE"
  install -m644 "${README_SRC}" "${bundle_dir}/README.md"
  make_targz "${STAGING}/linux-${arch}" "${bundle_name}" "${OUT_DIR}/${bundle_name}.tar.gz"
done

echo "==> Packaging KDE Plasma 6 .plasmoid archive"
make_zip "${STAGED_PLASMOID}" "${OUT_DIR}/${APPLET_ID}-${VERSION}.plasmoid" ""

echo "==> Packaging Debian amd64 .deb"
if command -v dpkg-deb >/dev/null 2>&1; then
  deb_root="${STAGING}/deb-amd64"
  deb_version="${VERSION//-/\~}"
  mkdir -p \
    "${deb_root}/DEBIAN" \
    "${deb_root}/usr/bin" \
    "${deb_root}/usr/share/applications" \
    "${deb_root}/usr/share/icons/hicolor/512x512/apps" \
    "${deb_root}/usr/share/plasma/plasmoids/${APPLET_ID}" \
    "${deb_root}/usr/share/doc/featherlog"

  install -m755 "${BIN_STAGE}/featherlog-linux-amd64" "${deb_root}/usr/bin/featherlog"
  install -m644 "${DESKTOP_SRC}" "${deb_root}/usr/share/applications/featherlog.desktop"
  install -m644 "${ICON_512}" "${deb_root}/usr/share/icons/hicolor/512x512/apps/featherlog.png"
  cp -a "${STAGED_PLASMOID}/." "${deb_root}/usr/share/plasma/plasmoids/${APPLET_ID}/"

  {
    echo "Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/"
    echo "Upstream-Name: featherlog"
    echo "Source: https://github.com/muyuzhong/Featherlog"
    echo ""
    echo "Files: *"
    echo "Copyright: 2026 muyuzhong"
    echo "License: MIT"
    sed 's/^$/./; s/^/ /' "${LICENSE_SRC}"
  } > "${deb_root}/usr/share/doc/featherlog/copyright"
  chmod 644 "${deb_root}/usr/share/doc/featherlog/copyright"

  installed_kb="$(du -sk "${deb_root}/usr" | awk '{print $1}')"
  cat > "${deb_root}/DEBIAN/control" <<CONTROL
Package: featherlog
Version: ${deb_version}
Section: utils
Priority: optional
Architecture: amd64
Installed-Size: ${installed_kb}
Maintainer: muyuzhong <muyuzhong@users.noreply.github.com>
Homepage: https://github.com/muyuzhong/Featherlog
Depends: libc6, libgtk-3-0t64 | libgtk-3-0, libwebkit2gtk-4.1-0, hicolor-icon-theme
Suggests: libgtk-layer-shell0, plasma-workspace, qt6-tools-dev-tools | qdbus-qt6
Description: Lightweight concurrent workbench panel and CLI hooks (羽记)
 Featherlog v2 is a lightweight native concurrent workbench built with Go
 and MyGo, featuring an opaque workspace popup panel, KDE Plasma 6 bottom
 dock status bar plasmoid, flat tasks and notes, and local Unix socket
 CLI hooks.
CONTROL
  chmod 755 "${deb_root}/DEBIAN"
  chmod 644 "${deb_root}/DEBIAN/control"

  find "${deb_root}" -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +
  dpkg-deb --root-owner-group -Zxz --build "${deb_root}" "${OUT_DIR}/featherlog_${VERSION}_amd64.deb" >/dev/null
else
  echo "Warning: dpkg-deb not found; skipping featherlog_${VERSION}_amd64.deb" >&2
fi

echo "==> Packaging Windows amd64 zip"
win_name="featherlog-${VERSION}-windows-amd64"
win_dir="${STAGING}/win-amd64"
mkdir -p "${win_dir}"
install -m755 "${BIN_STAGE}/featherlog-windows-amd64.exe" "${win_dir}/featherlog.exe"
install -m755 "${BIN_STAGE}/featherlog-cli-windows-amd64.exe" "${win_dir}/featherlog-cli.exe"
install -m644 "${LICENSE_SRC}" "${win_dir}/LICENSE"
install -m644 "${README_SRC}" "${win_dir}/README.md"
make_zip "${win_dir}" "${OUT_DIR}/${win_name}.zip" "${win_name}"

echo "==> Packaging macOS .app tarballs"
for arch in arm64 amd64; do
  bundle_name="featherlog-${VERSION}-darwin-${arch}"
  bundle_dir="${STAGING}/darwin-${arch}/${bundle_name}"
  app_contents="${bundle_dir}/Featherlog.app/Contents"
  mkdir -p "${app_contents}/MacOS" "${app_contents}/Resources"

  install -m755 "${BIN_STAGE}/featherlog-darwin-${arch}" "${app_contents}/MacOS/featherlog"
  install -m644 "${ICON_ICNS}" "${app_contents}/Resources/featherlog.icns"
  install -m644 "${ICON_SRC}" "${app_contents}/Resources/icon.png"
  cat > "${app_contents}/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleDisplayName</key>
    <string>Featherlog</string>
    <key>CFBundleExecutable</key>
    <string>featherlog</string>
    <key>CFBundleIconFile</key>
    <string>featherlog.icns</string>
    <key>CFBundleIdentifier</key>
    <string>${APPLET_ID}</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>Featherlog</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>${VERSION}</string>
    <key>CFBundleVersion</key>
    <string>${VERSION}</string>
    <key>LSMinimumSystemVersion</key>
    <string>12.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSPrincipalClass</key>
    <string>NSApplication</string>
</dict>
</plist>
PLIST
  chmod 644 "${app_contents}/Info.plist"
  install -m644 "${LICENSE_SRC}" "${bundle_dir}/LICENSE"
  install -m644 "${README_SRC}" "${bundle_dir}/README.md"
  make_targz "${STAGING}/darwin-${arch}" "${bundle_name}" "${OUT_DIR}/${bundle_name}.tar.gz"
done

echo "==> Generating SHA256SUMS.txt"
(
  cd "${OUT_DIR}"
  find . -maxdepth 1 -type f ! -name 'SHA256SUMS.txt' -printf '%f\n' \
    | LC_ALL=C sort \
    | xargs sha256sum > SHA256SUMS.txt
)

echo "==> Release artifacts ready in ${OUT_DIR}:"
ls -lh "${OUT_DIR}"

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
APPLET_ID="io.github.muyuzhong.featherlog"
APPLET_SRC="${REPO_ROOT}/plasmoid/${APPLET_ID}"
DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
TARGET_DIR="${DATA_HOME}/plasma/plasmoids/${APPLET_ID}"

if [[ ! -f "${APPLET_SRC}/metadata.json" ]]; then
    echo "Error: plasmoid metadata not found at ${APPLET_SRC}/metadata.json" >&2
    exit 1
fi

if ! command -v kpackagetool6 >/dev/null 2>&1; then
    echo "Error: kpackagetool6 not found. Install KDE Plasma 6 KPackage tools first." >&2
    exit 1
fi

if [[ -d "${TARGET_DIR}" ]]; then
    kpackagetool6 -t Plasma/Applet -u "${APPLET_SRC}"
else
    kpackagetool6 -t Plasma/Applet -u "${APPLET_SRC}" >/dev/null 2>&1 || kpackagetool6 -t Plasma/Applet -i "${APPLET_SRC}"
fi

if command -v kbuildsycoca6 >/dev/null 2>&1; then
    kbuildsycoca6 --noincremental >/dev/null 2>&1 || true
fi

echo "Installed Plasma 6 applet ${APPLET_ID} -> ${TARGET_DIR}"

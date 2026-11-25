package dock

import (
	"os"
	"path/filepath"
	"strings"
)

const plasmoidAppletID = "io.github.muyuzhong.featherlog"

// ShouldShowMiniBar decides whether the standalone floating 3D Drum Mini-Bar
// window should be shown under the single automatic placement policy:
// yield whenever an external /api/bar client (e.g. KDE Plasma 6 applet) is
// active or when running on Linux KDE Plasma with the Plasmoid installed;
// otherwise show the standalone 3D Drum Mini-Bar.
func ShouldShowMiniBar(hasExternalClient bool, goos string, kdeSession bool, plasmoidInstalled bool) bool {
	if hasExternalClient {
		return false
	}
	if goos == "linux" && kdeSession && plasmoidInstalled {
		return false
	}
	return true
}

// DetectKDEPlasmoid inspects session environment variables and standard Plasma
// applet directories to determine whether the desktop is a KDE Plasma session
// and whether the Featherlog KDE Plasmoid metadata.json is installed.
func DetectKDEPlasmoid(getenv func(string) string, homeDir string) (kdeSession bool, installed bool) {
	return detectKDEPlasmoid(getenv, homeDir, []string{"/usr/share"})
}

func detectKDEPlasmoid(getenv func(string) string, homeDir string, systemDataDirs []string) (kdeSession bool, installed bool) {
	if getenv == nil {
		getenv = os.Getenv
	}
	if strings.TrimSpace(homeDir) == "" {
		if h, err := os.UserHomeDir(); err == nil {
			homeDir = h
		}
	}

	desktop := strings.ToLower(strings.TrimSpace(getenv("XDG_CURRENT_DESKTOP")))
	session := strings.ToLower(strings.TrimSpace(getenv("DESKTOP_SESSION")))
	kdeFull := strings.ToLower(strings.TrimSpace(getenv("KDE_FULL_SESSION")))

	kdeSession = strings.Contains(desktop, "kde") ||
		strings.Contains(desktop, "plasma") ||
		strings.Contains(session, "kde") ||
		strings.Contains(session, "plasma") ||
		(kdeFull != "" && kdeFull != "0" && kdeFull != "false")

	var dataDirs []string
	if xdgData := strings.TrimSpace(getenv("XDG_DATA_HOME")); xdgData != "" {
		dataDirs = append(dataDirs, xdgData)
	} else if strings.TrimSpace(homeDir) != "" {
		dataDirs = append(dataDirs, filepath.Join(homeDir, ".local", "share"))
	}
	dataDirs = append(dataDirs, systemDataDirs...)

	for _, base := range dataDirs {
		if strings.TrimSpace(base) == "" {
			continue
		}
		metaPath := filepath.Join(base, "plasma", "plasmoids", plasmoidAppletID, "metadata.json")
		if fi, err := os.Stat(metaPath); err == nil && !fi.IsDir() {
			installed = true
			break
		}
	}

	return kdeSession, installed
}

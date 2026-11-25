//go:build linux && !android && (amd64 || arm64)

package dock

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type recordedCmd struct {
	name string
	args []string
}

func TestIsKDEWayland(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
		want bool
	}{
		{
			name: "KDE Wayland",
			env:  map[string]string{"WAYLAND_DISPLAY": "wayland-0", "XDG_CURRENT_DESKTOP": "KDE"},
			want: true,
		},
		{
			name: "multi-desktop with KDE",
			env:  map[string]string{"WAYLAND_DISPLAY": "wayland-1", "XDG_CURRENT_DESKTOP": "plasma:KDE"},
			want: true,
		},
		{
			name: "KDE X11",
			env:  map[string]string{"DISPLAY": ":0", "XDG_CURRENT_DESKTOP": "KDE"},
			want: false,
		},
		{
			name: "KDE Wayland forced x11 GDK_BACKEND",
			env:  map[string]string{"WAYLAND_DISPLAY": "wayland-0", "XDG_CURRENT_DESKTOP": "KDE", "GDK_BACKEND": "x11"},
			want: false,
		},
		{
			name: "GNOME Wayland",
			env:  map[string]string{"WAYLAND_DISPLAY": "wayland-0", "XDG_CURRENT_DESKTOP": "GNOME"},
			want: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := isKDEWayland(func(k string) string { return tc.env[k] })
			if got != tc.want {
				t.Fatalf("isKDEWayland(%v) = %v, want %v", tc.env, got, tc.want)
			}
		})
	}
}

func TestParseKWinScriptID(t *testing.T) {
	tests := []struct {
		raw    string
		wantID int
		wantOK bool
	}{
		{"2\n", 2, true},
		{"-1\n", -1, true},
		{"(7,)\n", 7, true},
		{"(int32 14,)\n", 14, true},
		{"Detected locale warning\n3\n", 3, true},
		{"", 0, false},
	}
	for _, tc := range tests {
		id, ok := parseKWinScriptID(tc.raw)
		if id != tc.wantID || ok != tc.wantOK {
			t.Fatalf("parseKWinScriptID(%q) = (%d, %v), want (%d, %v)", tc.raw, id, ok, tc.wantID, tc.wantOK)
		}
	}
}

func TestKWinPlacerStartAndCloseWithQdbus6(t *testing.T) {
	dataDir := t.TempDir()
	var cmds []recordedCmd

	placer := NewKWinPlacer(KWinConfig{
		DataDir: dataDir,
		Getenv: func(k string) string {
			switch k {
			case "WAYLAND_DISPLAY":
				return "wayland-0"
			case "XDG_CURRENT_DESKTOP":
				return "KDE"
			default:
				return ""
			}
		},
		LookPath: func(bin string) (string, error) {
			if bin == "qdbus6" {
				return "/usr/bin/qdbus6", nil
			}
			return "", errors.New("not found")
		},
		Runner: func(_ context.Context, name string, args ...string) ([]byte, error) {
			cmds = append(cmds, recordedCmd{name: name, args: append([]string(nil), args...)})
			if len(args) >= 3 && strings.HasSuffix(args[2], ".loadScript") {
				return []byte("4\n"), nil
			}
			return []byte("true\n"), nil
		},
	})

	if !placer.Supported() {
		t.Fatalf("expected Supported()=true on KDE Wayland")
	}
	if err := placer.Start(context.Background()); err != nil {
		t.Fatalf("Start failed: %v", err)
	}

	// Verify script file written atomically with expected permissions and KWin 6 rules.
	scriptPath := filepath.Join(dataDir, "kwin", "featherlog-panel.js")
	info, err := os.Stat(scriptPath)
	if err != nil {
		t.Fatalf("stat script: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("script perm = %o, want 0600", perm)
	}
	raw, err := os.ReadFile(scriptPath)
	if err != nil {
		t.Fatalf("read script: %v", err)
	}
	js := string(raw)
	requiredSnippets := []string{
		`var TARGET_CAPTION = "featherlog-panel"`,
		`var BAR_CAPTION = "featherlog-bar"`,
		`var BOTTOM_GAP = 10`,
		`function isTargetCaption(c)`,
		`c === TARGET_CAPTION || c === BAR_CAPTION`,
		`workspace.windowList()`,
		`workspace.windowAdded.connect`,
		`w.captionChanged.connect`,
		`w.keepAbove = true`,
		`w.onAllDesktops = true`,
		`w.skipTaskbar = true`,
		`w.skipPager = true`,
		`w.skipSwitcher = true`,
		`w.tile = null`,
		`w.tileChanged.connect`,
		`KWin.PlacementArea`,
		`w.minimizedChanged.connect`,
		`w.activeChanged.connect`,
		`w.frameGeometryChanged.connect`,
	}
	for _, snippet := range requiredSnippets {
		if !strings.Contains(js, snippet) {
			t.Errorf("generated KWin script missing %q", snippet)
		}
	}

	// Verify exact D-Bus sequence: unload -> loadScript -> Script4.run.
	if len(cmds) != 3 {
		t.Fatalf("expected 3 commands on Start, got %d: %+v", len(cmds), cmds)
	}
	if cmds[0].name != "qdbus6" || cmds[0].args[2] != "org.kde.kwin.Scripting.unloadScript" || cmds[0].args[3] != "featherlog-panel" {
		t.Fatalf("unexpected unload cmd: %+v", cmds[0])
	}
	if cmds[1].name != "qdbus6" || cmds[1].args[2] != "org.kde.kwin.Scripting.loadScript" || cmds[1].args[3] != scriptPath || cmds[1].args[4] != "featherlog-panel" {
		t.Fatalf("unexpected load cmd: %+v", cmds[1])
	}
	if cmds[2].name != "qdbus6" || cmds[2].args[1] != "/Scripting/Script4" || cmds[2].args[2] != "org.kde.kwin.Script.run" {
		t.Fatalf("unexpected run cmd: %+v", cmds[2])
	}

	// Close unloads the script and is idempotent.
	if err := placer.Close(); err != nil {
		t.Fatalf("Close failed: %v", err)
	}
	if err := placer.Close(); err != nil {
		t.Fatalf("second Close failed: %v", err)
	}
	if len(cmds) != 4 || cmds[3].args[2] != "org.kde.kwin.Scripting.unloadScript" {
		t.Fatalf("expected single unload on Close, got cmds=%+v", cmds)
	}
}

func TestKWinPlacerGdbusFallbackAndStartFallback(t *testing.T) {
	dataDir := t.TempDir()
	var cmds []recordedCmd

	placer := NewKWinPlacer(KWinConfig{
		DataDir: dataDir,
		Getenv: func(k string) string {
			if k == "WAYLAND_DISPLAY" {
				return "wayland-0"
			}
			if k == "XDG_CURRENT_DESKTOP" {
				return "KDE"
			}
			return ""
		},
		LookPath: func(bin string) (string, error) {
			if bin == "gdbus" {
				return "/usr/bin/gdbus", nil
			}
			return "", errors.New("missing")
		},
		Runner: func(_ context.Context, name string, args ...string) ([]byte, error) {
			cmds = append(cmds, recordedCmd{name: name, args: append([]string(nil), args...)})
			joined := strings.Join(args, " ")
			if strings.Contains(joined, "loadScript") {
				return []byte("(9,)\n"), nil
			}
			if strings.Contains(joined, "/Scripting/Script9") {
				return nil, errors.New("no such object path")
			}
			return []byte("()\n"), nil
		},
	})

	if err := placer.Start(context.Background()); err != nil {
		t.Fatalf("Start with gdbus fallback failed: %v", err)
	}
	if len(cmds) != 4 {
		t.Fatalf("expected 4 gdbus calls (unload, load, Script9.run fail, Scripting.start), got %d: %+v", len(cmds), cmds)
	}
	if cmds[0].name != "gdbus" || cmds[3].name != "gdbus" || !strings.Contains(strings.Join(cmds[3].args, " "), "org.kde.kwin.Scripting.start") {
		t.Fatalf("unexpected gdbus fallback sequence: %+v", cmds)
	}
	if err := placer.Close(); err != nil {
		t.Fatalf("Close failed: %v", err)
	}
}

func TestKWinPlacerRejectsNegativeScriptIDAndNoopsOutsideKDE(t *testing.T) {
	t.Run("negative loadScript ID returns error", func(t *testing.T) {
		placer := NewKWinPlacer(KWinConfig{
			DataDir: t.TempDir(),
			Getenv: func(k string) string {
				if k == "WAYLAND_DISPLAY" {
					return "wayland-0"
				}
				if k == "XDG_CURRENT_DESKTOP" {
					return "KDE"
				}
				return ""
			},
			LookPath: func(bin string) (string, error) { return "/usr/bin/" + bin, nil },
			Runner: func(_ context.Context, _ string, args ...string) ([]byte, error) {
				if len(args) >= 3 && strings.HasSuffix(args[2], ".loadScript") {
					return []byte("-1\n"), nil
				}
				return []byte("true\n"), nil
			},
		})
		if err := placer.Start(context.Background()); err == nil {
			t.Fatalf("expected error when loadScript returns -1")
		}
	})

	t.Run("no-op outside KDE Wayland", func(t *testing.T) {
		called := false
		dataDir := t.TempDir()
		placer := NewKWinPlacer(KWinConfig{
			DataDir: dataDir,
			Getenv: func(k string) string {
				if k == "WAYLAND_DISPLAY" {
					return "wayland-0"
				}
				if k == "XDG_CURRENT_DESKTOP" {
					return "GNOME"
				}
				return ""
			},
			Runner: func(_ context.Context, _ string, _ ...string) ([]byte, error) {
				called = true
				return nil, nil
			},
		})
		if err := placer.Start(context.Background()); err != nil {
			t.Fatalf("Start outside KDE failed: %v", err)
		}
		if called {
			t.Fatalf("expected no D-Bus commands outside KDE Wayland")
		}
		if _, err := os.Stat(filepath.Join(dataDir, "kwin")); !os.IsNotExist(err) {
			t.Fatalf("expected no kwin dir written outside KDE Wayland")
		}
	})
}

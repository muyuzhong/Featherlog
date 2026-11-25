//go:build linux && !android && (amd64 || arm64)

package dock

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// DefaultKWinScriptName is the KWin pluginName registered via org.kde.KWin /Scripting.
	DefaultKWinScriptName = "featherlog-panel"

	kwinDBusService   = "org.kde.KWin"
	kwinScriptingPath = "/Scripting"
	kwinScriptingIfc  = "org.kde.kwin.Scripting"
	kwinScriptIfc     = "org.kde.kwin.Script"
)

// KWinCommandRunner runs an external D-Bus CLI helper (qdbus6, qdbus, or gdbus).
type KWinCommandRunner func(ctx context.Context, name string, args ...string) ([]byte, error)

// KWinConfig configures the KDE Plasma Wayland KWin positioning script helper.
type KWinConfig struct {
	DataDir      string
	ScriptName   string
	Caption      string
	BottomOffset int
	Runner       KWinCommandRunner
	LookPath     func(file string) (string, error)
	Getenv       func(string) string
}

// KWinPlacer manages a KWin 6 JavaScript helper that keeps the frameless
// "featherlog-panel" window floating, untiled, and positioned horizontally
// centered right above the KDE bottom dock when libgtk-layer-shell is absent.
type KWinPlacer struct {
	mu           sync.Mutex
	dataDir      string
	scriptName   string
	caption      string
	bottomOffset int
	runner       KWinCommandRunner
	lookPath     func(string) (string, error)
	getenv       func(string) string

	activeTool string
	scriptPath string
	loaded     bool
}

// NewKWinPlacer constructs a KWinPlacer for KDE Wayland sessions.
func NewKWinPlacer(cfg KWinConfig) *KWinPlacer {
	scriptName := strings.TrimSpace(cfg.ScriptName)
	if scriptName == "" {
		scriptName = DefaultKWinScriptName
	}
	caption := strings.TrimSpace(cfg.Caption)
	if caption == "" {
		caption = PanelWindowTitle
	}
	bottomOffset := cfg.BottomOffset
	if bottomOffset <= 0 {
		bottomOffset = PanelBottomInset
	}
	runner := cfg.Runner
	if runner == nil {
		runner = defaultKWinRunner
	}
	lookPath := cfg.LookPath
	if lookPath == nil {
		lookPath = exec.LookPath
	}
	getenv := cfg.Getenv
	if getenv == nil {
		getenv = os.Getenv
	}
	return &KWinPlacer{
		dataDir:      cfg.DataDir,
		scriptName:   scriptName,
		caption:      caption,
		bottomOffset: bottomOffset,
		runner:       runner,
		lookPath:     lookPath,
		getenv:       getenv,
	}
}

func defaultKWinRunner(ctx context.Context, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	return cmd.Output()
}

// isKDEWayland reports whether the current session is KDE Plasma on Wayland.
func isKDEWayland(getenv func(string) string) bool {
	if !isWaylandSession(getenv) {
		return false
	}
	desktop := strings.ToLower(getenv("XDG_CURRENT_DESKTOP"))
	return strings.Contains(desktop, "kde")
}

// Supported reports whether the environment looks like a KDE Plasma Wayland session.
func (k *KWinPlacer) Supported() bool {
	return isKDEWayland(k.getenv)
}

// ScriptPath returns the path of the generated KWin script file (<dataDir>/kwin/<name>.js).
func (k *KWinPlacer) ScriptPath() string {
	return filepath.Join(k.dataDir, "kwin", k.scriptName+".js")
}

// Start writes <dataDir>/kwin/featherlog-panel.js atomically, unloads any
// stale script with the same pluginName, and loads & starts the new script via
// qdbus6, qdbus, or gdbus against org.kde.KWin /Scripting.
func (k *KWinPlacer) Start(ctx context.Context) error {
	k.mu.Lock()
	defer k.mu.Unlock()

	if !isKDEWayland(k.getenv) {
		return nil
	}
	if strings.TrimSpace(k.dataDir) == "" {
		return errors.New("dock/kwin: dataDir is required")
	}

	tool, err := k.resolveDBusTool()
	if err != nil {
		return err
	}

	scriptPath, err := filepath.Abs(k.ScriptPath())
	if err != nil {
		return fmt.Errorf("dock/kwin: resolve script path: %w", err)
	}
	source := KWinScriptSource(k.caption, k.bottomOffset)
	if err := writeFileAtomic(scriptPath, []byte(source), 0o700, 0o600); err != nil {
		return fmt.Errorf("dock/kwin: write script: %w", err)
	}

	if ctx == nil {
		ctx = context.Background()
	}
	callCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	// Always unload any stale script first so re-loading succeeds cleanly.
	_, _ = k.invokeUnload(callCtx, tool)

	out, err := k.invokeLoad(callCtx, tool, scriptPath)
	if err != nil {
		return fmt.Errorf("dock/kwin: loadScript via %s: %w", tool, err)
	}
	id, ok := parseKWinScriptID(string(out))
	if ok && id < 0 {
		return fmt.Errorf("dock/kwin: loadScript returned %d (output=%q)", id, strings.TrimSpace(string(out)))
	}

	if err := k.invokeRun(callCtx, tool, id, ok); err != nil {
		_, _ = k.invokeUnload(callCtx, tool)
		return fmt.Errorf("dock/kwin: start script via %s: %w", tool, err)
	}

	k.activeTool = tool
	k.scriptPath = scriptPath
	k.loaded = true
	return nil
}

// Close unloads the KWin positioning script if it was started. Safe to call multiple times.
func (k *KWinPlacer) Close() error {
	k.mu.Lock()
	if !k.loaded {
		k.mu.Unlock()
		return nil
	}
	tool := k.activeTool
	k.loaded = false
	k.mu.Unlock()

	if tool == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, err := k.invokeUnload(ctx, tool); err != nil {
		return fmt.Errorf("dock/kwin: unloadScript via %s: %w", tool, err)
	}
	return nil
}

func (k *KWinPlacer) resolveDBusTool() (string, error) {
	candidates := []string{"qdbus6", "qdbus", "gdbus"}
	for _, bin := range candidates {
		if path, err := k.lookPath(bin); err == nil && path != "" {
			return bin, nil
		}
	}
	return "", errors.New("dock/kwin: none of qdbus6, qdbus, or gdbus found in PATH")
}

func (k *KWinPlacer) invokeUnload(ctx context.Context, tool string) ([]byte, error) {
	if tool == "gdbus" {
		return k.runner(ctx, "gdbus",
			"call", "--session",
			"--dest", kwinDBusService,
			"--object-path", kwinScriptingPath,
			"--method", kwinScriptingIfc+".unloadScript",
			k.scriptName,
		)
	}
	return k.runner(ctx, tool, kwinDBusService, kwinScriptingPath, kwinScriptingIfc+".unloadScript", k.scriptName)
}

func (k *KWinPlacer) invokeLoad(ctx context.Context, tool, scriptPath string) ([]byte, error) {
	if tool == "gdbus" {
		return k.runner(ctx, "gdbus",
			"call", "--session",
			"--dest", kwinDBusService,
			"--object-path", kwinScriptingPath,
			"--method", kwinScriptingIfc+".loadScript",
			scriptPath,
			k.scriptName,
		)
	}
	return k.runner(ctx, tool, kwinDBusService, kwinScriptingPath, kwinScriptingIfc+".loadScript", scriptPath, k.scriptName)
}

func (k *KWinPlacer) invokeRun(ctx context.Context, tool string, id int, hasID bool) error {
	if hasID && id >= 0 {
		objPath := fmt.Sprintf("%s/Script%d", kwinScriptingPath, id)
		var err error
		if tool == "gdbus" {
			_, err = k.runner(ctx, "gdbus",
				"call", "--session",
				"--dest", kwinDBusService,
				"--object-path", objPath,
				"--method", kwinScriptIfc+".run",
			)
		} else {
			_, err = k.runner(ctx, tool, kwinDBusService, objPath, kwinScriptIfc+".run")
		}
		if err == nil {
			return nil
		}
	}

	// Fallback to org.kde.kwin.Scripting.start (works across KWin 5 and KWin 6).
	if tool == "gdbus" {
		_, err := k.runner(ctx, "gdbus",
			"call", "--session",
			"--dest", kwinDBusService,
			"--object-path", kwinScriptingPath,
			"--method", kwinScriptingIfc+".start",
		)
		return err
	}
	_, err := k.runner(ctx, tool, kwinDBusService, kwinScriptingPath, kwinScriptingIfc+".start")
	return err
}

func parseKWinScriptID(output string) (int, bool) {
	cleaned := strings.NewReplacer("(", " ", ")", " ", ",", " ").Replace(output)
	fields := strings.Fields(cleaned)
	for i := len(fields) - 1; i >= 0; i-- {
		if n, err := strconv.Atoi(fields[i]); err == nil {
			return n, true
		}
	}
	return 0, false
}

// KWinScriptSource generates the KWin 6 JavaScript that adopts windows whose
// caption matches caption, keeps them floating and untiled, and places them
// horizontally centered bottomOffset pixels above KWin.PlacementArea's bottom edge.
func KWinScriptSource(caption string, bottomOffset int) string {
	if strings.TrimSpace(caption) == "" {
		caption = PanelWindowTitle
	}
	if bottomOffset <= 0 {
		bottomOffset = PanelBottomInset
	}
	quotedCaption, _ := json.Marshal(caption)
	return fmt.Sprintf(`// Featherlog v2 KDE Wayland panel positioning script (auto-generated).
(function () {
  var TARGET_CAPTION = %s;
  var BOTTOM_GAP = %d;
  var watched = Object.create(null);
  var adopted = Object.create(null);

  function windowKey(w) {
    if (w && w.internalId !== undefined && w.internalId !== null) {
      return String(w.internalId);
    }
    return "";
  }

  function enforceFlags(w) {
    if (!w || w.deleted) return;
    w.keepAbove = true;
    w.onAllDesktops = true;
    w.skipTaskbar = true;
    w.skipPager = true;
    w.skipSwitcher = true;
    if (w.tile) {
      w.tile = null;
    }
  }

  function place(w, state) {
    if (!w || w.deleted) return;
    if (state && state.placing) return;
    var g = w.frameGeometry;
    if (!g || g.width <= 0 || g.height <= 0) return;
    var output = w.output || workspace.activeScreen;
    var area = workspace.clientArea(KWin.PlacementArea, output, workspace.currentDesktop);
    if (!area || area.width <= 0 || area.height <= 0) return;
    var x = Math.round(area.x + (area.width - g.width) / 2);
    var maxX = Math.max(area.x, Math.round(area.x + area.width - g.width));
    if (x < area.x) x = area.x;
    if (x > maxX) x = maxX;
    var y = Math.max(area.y, Math.round(area.y + area.height - g.height - BOTTOM_GAP));
    if (Math.abs(g.x - x) <= 1 && Math.abs(g.y - y) <= 1) return;
    if (state) state.placing = true;
    try {
      w.frameGeometry = {
        x: x,
        y: y,
        width: g.width,
        height: g.height
      };
    } finally {
      if (state) state.placing = false;
    }
  }

  function adopt(w) {
    if (!w || w.deleted || w.caption !== TARGET_CAPTION) return;
    var key = windowKey(w);
    if (key && adopted[key]) {
      enforceFlags(w);
      place(w, adopted[key]);
      return;
    }
    var state = { placing: false };
    if (key) {
      adopted[key] = state;
    }
    enforceFlags(w);
    place(w, state);

    if (w.tileChanged) {
      w.tileChanged.connect(function () {
        if (w.deleted || w.caption !== TARGET_CAPTION) return;
        if (w.tile) {
          w.tile = null;
          place(w, state);
        }
      });
    }
    if (w.minimizedChanged) {
      w.minimizedChanged.connect(function () {
        if (w.deleted || w.caption !== TARGET_CAPTION) return;
        if (!w.minimized) {
          enforceFlags(w);
          place(w, state);
        }
      });
    }
    if (w.activeChanged) {
      w.activeChanged.connect(function () {
        if (w.deleted || w.caption !== TARGET_CAPTION) return;
        if (w.active) {
          enforceFlags(w);
          place(w, state);
        }
      });
    }
    if (w.frameGeometryChanged) {
      w.frameGeometryChanged.connect(function () {
        if (w.deleted || w.caption !== TARGET_CAPTION) return;
        if (!w.move && !w.resize) {
          place(w, state);
        }
      });
    }
    if (w.outputChanged) {
      w.outputChanged.connect(function () {
        if (w.deleted || w.caption !== TARGET_CAPTION) return;
        place(w, state);
      });
    }
    if (w.closed) {
      w.closed.connect(function () {
        if (key) {
          delete adopted[key];
          delete watched[key];
        }
      });
    }
  }

  function watchWindow(w) {
    if (!w || w.deleted) return;
    if (w.caption === TARGET_CAPTION) {
      adopt(w);
      return;
    }
    var key = windowKey(w);
    if (key && watched[key]) return;
    if (key) watched[key] = true;
    if (w.captionChanged) {
      w.captionChanged.connect(function () {
        if (!w.deleted && w.caption === TARGET_CAPTION) {
          adopt(w);
        }
      });
    }
    if (w.closed) {
      w.closed.connect(function () {
        if (key) delete watched[key];
      });
    }
  }

  var existing = workspace.windowList();
  for (var i = 0; i < existing.length; i++) {
    watchWindow(existing[i]);
  }
  workspace.windowAdded.connect(watchWindow);
})();
`, string(quotedCaption), bottomOffset)
}

func writeFileAtomic(path string, data []byte, dirPerm, filePerm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, dirPerm); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpPath)
		}
	}()

	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(filePerm); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return err
	}
	cleanup = false
	return nil
}

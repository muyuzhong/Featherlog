package dock

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/muyuzhong/featherlog/internal/clock"
)

type fakeWindow struct {
	bounds        Rect
	setBoundsLog  []Rect
	shown         int
	shownInactive int
	hidden        int
	focused       int
	bgColors      []string
	handle        uintptr
	destroyed     bool
	blurHandlers  []func()
	moveHandlers  []func()
	emitMoveOnSet bool
	mainRuns      int
}

func (f *fakeWindow) Bounds() Rect                { return f.bounds }
func (f *fakeWindow) Show()                       { f.shown++ }
func (f *fakeWindow) ShowInactive()               { f.shown++; f.shownInactive++ }
func (f *fakeWindow) Hide()                       { f.hidden++ }
func (f *fakeWindow) Focus()                      { f.focused++ }
func (f *fakeWindow) SetBackgroundColor(c string) { f.bgColors = append(f.bgColors, c) }
func (f *fakeWindow) NativeHandle() uintptr       { return f.handle }
func (f *fakeWindow) IsDestroyed() bool           { return f.destroyed }
func (f *fakeWindow) SetBounds(r Rect) {
	f.bounds = r
	f.setBoundsLog = append(f.setBoundsLog, r)
	if f.emitMoveOnSet {
		f.triggerMove()
	}
}
func (f *fakeWindow) RunOnMain(fn func()) {
	f.mainRuns++
	fn()
}
func (f *fakeWindow) OnBlur(fn func()) func() {
	f.blurHandlers = append(f.blurHandlers, fn)
	idx := len(f.blurHandlers) - 1
	return func() { f.blurHandlers[idx] = nil }
}
func (f *fakeWindow) OnMove(fn func()) func() {
	f.moveHandlers = append(f.moveHandlers, fn)
	idx := len(f.moveHandlers) - 1
	return func() { f.moveHandlers[idx] = nil }
}
func (f *fakeWindow) triggerBlur() {
	for _, fn := range f.blurHandlers {
		if fn != nil {
			fn()
		}
	}
}
func (f *fakeWindow) triggerMove() {
	for _, fn := range f.moveHandlers {
		if fn != nil {
			fn()
		}
	}
}

type fakeScreen struct {
	display       Display
	displays      []Display
	changeHandler func()
}

func (s *fakeScreen) ActiveDisplay(r Rect) Display {
	if len(s.displays) > 0 && r.Width > 0 && r.Height > 0 {
		for _, d := range s.displays {
			if rectsOverlap(r, d.Bounds) {
				return d
			}
		}
		return s.displays[0]
	}
	if len(s.displays) > 0 {
		return s.displays[0]
	}
	return s.display
}
func (s *fakeScreen) OnDisplaysChanged(fn func()) func() {
	s.changeHandler = fn
	return func() { s.changeHandler = nil }
}

type fakeLayerShell struct {
	available    bool
	anchorResult bool
	calls        []struct {
		handle uintptr
		margin int
	}
}

func (l *fakeLayerShell) Available() bool { return l.available }
func (l *fakeLayerShell) AnchorBottomCenter(handle uintptr, marginBottom int) bool {
	l.calls = append(l.calls, struct {
		handle uintptr
		margin int
	}{handle: handle, margin: marginBottom})
	return l.anchorResult
}

type fakeShortcuts struct {
	failFor      map[string]error
	registered   map[string]func()
	unregistered []string
}

func (s *fakeShortcuts) Register(acc, _ string, fn func()) error {
	if err := s.failFor[acc]; err != nil {
		return err
	}
	if s.registered == nil {
		s.registered = map[string]func(){}
	}
	s.registered[acc] = fn
	return nil
}

func (s *fakeShortcuts) Unregister(acc string) {
	delete(s.registered, acc)
	s.unregistered = append(s.unregistered, acc)
}

func TestWindowOptionsOpaquePanelDefaultsAndThemes(t *testing.T) {
	initial := Rect{X: 520, Y: 500, Width: 880, Height: 520}

	stoneOpts := WindowOptions("/", "preload()", initial)
	if stoneOpts.Title != PanelWindowTitle {
		t.Fatalf("Title = %q, want %q", stoneOpts.Title, PanelWindowTitle)
	}
	if stoneOpts.Width != 880 || stoneOpts.Height != 520 ||
		stoneOpts.MinWidth != 880 || stoneOpts.MinHeight != 520 ||
		stoneOpts.MaxWidth != 880 || stoneOpts.MaxHeight != 520 {
		t.Fatalf("unexpected fixed panel dimensions: %+v", stoneOpts)
	}
	if stoneOpts.Transparent {
		t.Fatalf("Transparent must be false for opaque WebKitGTK rendering")
	}
	if stoneOpts.DisableShadow {
		t.Fatalf("DisableShadow must be false for opaque popup panel")
	}
	if !stoneOpts.Frameless || !stoneOpts.AlwaysOnTop || !stoneOpts.SkipTaskbar {
		t.Fatalf("expected Frameless/AlwaysOnTop/SkipTaskbar true: %+v", stoneOpts)
	}
	if !stoneOpts.Hidden {
		t.Fatalf("expected Hidden=true by default on daemon startup")
	}
	if stoneOpts.BackgroundColor != StoneBackgroundColor {
		t.Fatalf("BackgroundColor = %q, want %q", stoneOpts.BackgroundColor, StoneBackgroundColor)
	}
	if stoneOpts.CornerRadius != 18 {
		t.Fatalf("CornerRadius = %d, want 18", stoneOpts.CornerRadius)
	}
	if stoneOpts.Panel != (runtime.GOOS == "darwin") {
		t.Fatalf("Panel = %v, want %v", stoneOpts.Panel, runtime.GOOS == "darwin")
	}

	graphiteVisible := WindowOptions("/", "preload()", initial, WithTheme("graphite"), WithHidden(false))
	if graphiteVisible.Hidden {
		t.Fatalf("expected Hidden=false when WithHidden(false) is set")
	}
	if graphiteVisible.BackgroundColor != GraphiteBackgroundColor {
		t.Fatalf("BackgroundColor = %q, want %q", graphiteVisible.BackgroundColor, GraphiteBackgroundColor)
	}
	if graphiteVisible.Transparent {
		t.Fatalf("Transparent must remain false for graphite theme")
	}
}

func TestComputeBoundsUpwardExpansionKeepsBottomEdgeFixed(t *testing.T) {
	display := Display{
		Bounds:   Rect{X: 0, Y: 0, Width: 1920, Height: 1080},
		WorkArea: Rect{X: 0, Y: 0, Width: 1920, Height: 1032}, // 48px bottom taskbar
		Primary:  true,
	}

	collapsed := ComputeBounds(display, 640, 44, DefaultBottomInset)
	expanded := ComputeBounds(display, 880, 520, DefaultBottomInset)

	// Horizontally centered on WorkArea.
	if collapsed.X != (1920-640)/2 {
		t.Fatalf("collapsed.X = %d, want %d", collapsed.X, (1920-640)/2)
	}
	if expanded.X != (1920-880)/2 {
		t.Fatalf("expanded.X = %d, want %d", expanded.X, (1920-880)/2)
	}

	// Bottom edges must remain identically anchored at WorkArea bottom - inset.
	wantBottom := 1032 - DefaultBottomInset
	if got := collapsed.Y + collapsed.Height; got != wantBottom {
		t.Fatalf("collapsed bottom = %d, want %d", got, wantBottom)
	}
	if got := expanded.Y + expanded.Height; got != wantBottom {
		t.Fatalf("expanded bottom = %d, want %d", got, wantBottom)
	}
	if expanded.Y >= collapsed.Y {
		t.Fatalf("expanded.Y (%d) should move upward above collapsed.Y (%d)", expanded.Y, collapsed.Y)
	}

	// Layer-shell bottom margin includes the 48px taskbar + 12px inset = 60px.
	if margin := ComputeBottomMargin(display, expanded, DefaultBottomInset); margin != 60 {
		t.Fatalf("bottom margin = %d, want 60", margin)
	}
}

func TestComputeBoundsClampsToSmallAndNegativeOriginDisplays(t *testing.T) {
	small := Display{
		Bounds:   Rect{X: -800, Y: 100, Width: 800, Height: 480},
		WorkArea: Rect{X: -800, Y: 100, Width: 800, Height: 480},
	}

	got := ComputeBounds(small, 880, 520, 12)
	if got.Width != 800 || got.Height != 480 {
		t.Fatalf("clamped size = %dx%d, want 800x480", got.Width, got.Height)
	}
	if got.X != -800 || got.Y != 100 {
		t.Fatalf("clamped pos = (%d,%d), want (-800,100)", got.X, got.Y)
	}
}

func TestControllerWaylandLayerShellAndFallback(t *testing.T) {
	screen := &fakeScreen{
		display: Display{
			Bounds:   Rect{X: 0, Y: 0, Width: 2560, Height: 1440},
			WorkArea: Rect{X: 0, Y: 0, Width: 2560, Height: 1400},
		},
	}

	t.Run("uses layer-shell bottom anchor when available", func(t *testing.T) {
		win := &fakeWindow{handle: 0xdeadbeef}
		layer := &fakeLayerShell{available: true, anchorResult: true}
		ctrl := NewController(Config{Screen: screen, Layer: layer})
		ctrl.Attach(win)

		r := ctrl.Resize(Geometry{Width: 880, Height: 520, Expanded: true})
		if r.Y+r.Height != 1400-DefaultBottomInset {
			t.Fatalf("bottom edge = %d, want %d", r.Y+r.Height, 1400-DefaultBottomInset)
		}
		if len(layer.calls) != 2 {
			t.Fatalf("layer anchor calls = %d, want 2 (attach + resize)", len(layer.calls))
		}
		last := layer.calls[len(layer.calls)-1]
		if last.handle != 0xdeadbeef || last.margin != 52 {
			t.Fatalf("last layer call = %+v, want handle=0xdeadbeef margin=52", last)
		}
		expanded, _, anchored, _ := ctrl.State()
		if !expanded || !anchored {
			t.Fatalf("state expanded=%v anchored=%v, want true/true", expanded, anchored)
		}
	})

	t.Run("falls back safely when libgtk-layer-shell is absent and hides on collapse", func(t *testing.T) {
		win := &fakeWindow{handle: 0xdeadbeef}
		layer := &fakeLayerShell{available: false}
		ctrl := NewController(Config{Screen: screen, Layer: layer})
		ctrl.Attach(win)

		r := ctrl.Resize(Geometry{Width: 700, Height: 44, Expanded: false})
		if r.Width != 700 || r.Height != 44 {
			t.Fatalf("bounds = %+v, want 700x44", r)
		}
		if win.hidden != 1 {
			t.Fatalf("expected Hide() called on collapse, got hidden=%d", win.hidden)
		}
		if len(layer.calls) != 0 {
			t.Fatalf("expected zero layer calls when unavailable, got %d", len(layer.calls))
		}
		_, _, anchored, _ := ctrl.State()
		if anchored {
			t.Fatalf("expected anchored=false on fallback")
		}
	})
}

func TestControllerPanelLifecycleHideOnCollapseAndStartHidden(t *testing.T) {
	screen := &fakeScreen{
		display: Display{
			Bounds:   Rect{X: 0, Y: 0, Width: 1920, Height: 1080},
			WorkArea: Rect{X: 0, Y: 0, Width: 1920, Height: 1032},
		},
	}
	win := &fakeWindow{}
	var toggleEvents []bool
	var expandedChanges []bool
	ctrl := NewController(Config{
		Screen:      screen,
		Layer:       &fakeLayerShell{available: false},
		StartHidden: true,
		BottomInset: PanelBottomInset,
		OnToggle: func(expanded bool) {
			toggleEvents = append(toggleEvents, expanded)
		},
	})
	off := ctrl.OnExpandedChange(func(expanded bool) {
		expandedChanges = append(expandedChanges, expanded)
	})
	defer off()

	ctrl.Attach(win)
	if win.shown != 0 || win.hidden != 0 {
		t.Fatalf("Attach on StartHidden must not show or hide window, got shown=%d hidden=%d", win.shown, win.hidden)
	}

	// Frontend startup calling Resize(expanded=true) while window is hidden must not
	// falsely report panelOpen=true or show the hidden daemon window.
	ctrl.Resize(Geometry{Width: 880, Height: 520, Expanded: true})
	if expanded, _, _, _ := ctrl.State(); expanded {
		t.Fatalf("expected expanded=false while panel starts hidden")
	}
	if win.shown != 0 {
		t.Fatalf("expected shown=0, got %d", win.shown)
	}

	// Toggle(nil) shows & focuses the 880x520 panel and notifies both callbacks.
	if !ctrl.Toggle(nil) {
		t.Fatalf("Toggle() = false, want true")
	}
	if win.shown != 1 || win.focused != 1 || win.mainRuns < 1 {
		t.Fatalf("expected RunOnMain(Show+Focus), got shown=%d focused=%d mainRuns=%d", win.shown, win.focused, win.mainRuns)
	}
	if win.bounds.Width != PanelWidth || win.bounds.Height != PanelHeight {
		t.Fatalf("shown panel size = %dx%d, want %dx%d", win.bounds.Width, win.bounds.Height, PanelWidth, PanelHeight)
	}
	if gotBottom := win.bounds.Y + win.bounds.Height; gotBottom != 1032-PanelBottomInset {
		t.Fatalf("shown panel bottom = %d, want %d", gotBottom, 1032-PanelBottomInset)
	}

	// User presses Esc -> frontend calls Resize(expanded=false) -> hides window & notifies.
	ctrl.Resize(Geometry{Width: 880, Height: 520, Expanded: false})
	if win.hidden != 1 {
		t.Fatalf("expected Hide() called once on Resize(expanded=false), got %d", win.hidden)
	}
	if expanded, _, _, _ := ctrl.State(); expanded {
		t.Fatalf("expected expanded=false after Resize(expanded=false)")
	}
	if len(expandedChanges) != 2 || expandedChanges[0] != true || expandedChanges[1] != false {
		t.Fatalf("expandedChanges = %v, want [true false]", expandedChanges)
	}
	if len(toggleEvents) != 2 || toggleEvents[0] != true || toggleEvents[1] != false {
		t.Fatalf("toggleEvents = %v, want [true false]", toggleEvents)
	}
	// Duplicate Resize(expanded=false) while already collapsed must not emit another toggle event.
	ctrl.Resize(Geometry{Width: 880, Height: 520, Expanded: false})
	if len(toggleEvents) != 2 {
		t.Fatalf("duplicate collapse emitted extra toggleEvent: %v", toggleEvents)
	}

	// Theme update updates solid native window background color.
	ctrl.SetTheme("graphite")
	ctrl.SetTheme("stone")
	if len(win.bgColors) != 2 || win.bgColors[0] != GraphiteBackgroundColor || win.bgColors[1] != StoneBackgroundColor {
		t.Fatalf("bgColors = %v, want [%s %s]", win.bgColors, GraphiteBackgroundColor, StoneBackgroundColor)
	}
}

func TestControllerBlurRespectsPinnedStateAndGraceWindow(t *testing.T) {
	clk := clock.NewFake(time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC))
	screen := &fakeScreen{
		display: Display{
			Bounds:   Rect{X: 0, Y: 0, Width: 1920, Height: 1080},
			WorkArea: Rect{X: 0, Y: 0, Width: 1920, Height: 1080},
		},
	}
	win := &fakeWindow{}
	var toggles []bool
	ctrl := NewController(Config{
		Screen:          screen,
		Layer:           &fakeLayerShell{available: false},
		Clock:           clk,
		StartHidden:     true,
		BlurToggleGrace: 300 * time.Millisecond,
		OnToggle: func(expanded bool) {
			toggles = append(toggles, expanded)
		},
	})
	ctrl.Attach(win)

	// Expand via toggle -> focuses window and emits expanded=true.
	if got := ctrl.Toggle(nil); !got {
		t.Fatalf("Toggle() = false, want true")
	}
	if win.shown != 1 || win.focused != 1 {
		t.Fatalf("expected window show+focus on expand, got shown=%d focused=%d", win.shown, win.focused)
	}

	// Blur while unpinned collapses & hides the panel.
	win.triggerBlur()
	if len(toggles) != 2 || toggles[1] != false {
		t.Fatalf("expected blur to emit collapse, toggles=%v", toggles)
	}
	if win.hidden != 1 {
		t.Fatalf("expected blur collapse to hide window, hidden=%d", win.hidden)
	}

	// Implicit Toggle(nil) 100ms after blur is suppressed (dock button click race).
	clk.Advance(100 * time.Millisecond)
	if got := ctrl.Toggle(nil); got {
		t.Fatalf("expected implicit Toggle(nil) within blur grace to stay closed")
	}

	// Explicit Toggle(&true) always reopens even within grace window.
	open := true
	if got := ctrl.Toggle(&open); !got {
		t.Fatalf("expected explicit Toggle(&true) to reopen panel")
	}

	// Pin it and blur -> must stay expanded!
	pinned := true
	ctrl.Resize(Geometry{Width: 880, Height: 520, Expanded: true, Pinned: &pinned})
	win.triggerBlur()
	if expanded, _, _, _ := ctrl.State(); !expanded {
		t.Fatalf("expected pinned panel to ignore blur")
	}

	// Unpin, blur, advance past grace window -> implicit Toggle(nil) reopens cleanly.
	ctrl.SetPinned(false)
	win.triggerBlur()
	clk.Advance(400 * time.Millisecond)
	if got := ctrl.Toggle(nil); !got {
		t.Fatalf("expected Toggle(nil) after grace window to reopen panel")
	}
}

func TestControllerShortcutFallbackAndCleanup(t *testing.T) {
	var toggled int
	shortcuts := &fakeShortcuts{
		failFor: map[string]error{
			"Alt+Shift+Space": errors.New("already taken"),
		},
	}
	ctrl := NewController(Config{
		Screen:    &fakeScreen{display: Display{Bounds: Rect{Width: 1920, Height: 1080}}},
		Layer:     &fakeLayerShell{},
		Shortcuts: shortcuts,
		OnToggle:  func(bool) { toggled++ },
	})

	acc, err := ctrl.RegisterShortcut(nil)
	if err != nil {
		t.Fatalf("RegisterShortcut failed: %v", err)
	}
	if acc != "CommandOrControl+Shift+Space" {
		t.Fatalf("registered = %q, want fallback CommandOrControl+Shift+Space", acc)
	}

	shortcuts.registered[acc]()
	if toggled != 1 {
		t.Fatalf("toggled = %d, want 1", toggled)
	}

	ctrl.Close()
	if len(shortcuts.unregistered) != 1 || shortcuts.unregistered[0] != acc {
		t.Fatalf("expected shortcut unregister on Close, got %v", shortcuts.unregistered)
	}
}

func intPtr(v int) *int    { return &v }
func boolPtr(v bool) *bool { return &v }

func TestMiniBarWindowOptions(t *testing.T) {
	initial := Rect{X: 804, Y: 984, Width: MiniBarWidth, Height: MiniBarHeight}
	opts := MiniBarWindowOptions("/?mode=bar", "preload()", initial, "graphite")

	if opts.Title != MiniBarWindowTitle {
		t.Fatalf("Title = %q, want %q", opts.Title, MiniBarWindowTitle)
	}
	if opts.URL != "/?mode=bar" {
		t.Fatalf("URL = %q, want /?mode=bar", opts.URL)
	}
	if opts.X != 804 || opts.Y != 984 ||
		opts.Width != MiniBarWidth || opts.Height != MiniBarHeight ||
		opts.MinWidth != MiniBarWidth || opts.MinHeight != MiniBarHeight ||
		opts.MaxWidth != MiniBarWidth || opts.MaxHeight != MiniBarHeight {
		t.Fatalf("unexpected MiniBar geometry: %+v", opts)
	}
	if !opts.Hidden || !opts.Frameless || opts.Transparent || opts.DisableShadow {
		t.Fatalf("unexpected MiniBar surface flags: %+v", opts)
	}
	if opts.CornerRadius != 14 {
		t.Fatalf("CornerRadius = %d, want 14", opts.CornerRadius)
	}
	if !opts.AlwaysOnTop || !opts.SkipTaskbar ||
		!opts.DisableResize || !opts.DisableMaximize || !opts.DisableMinimize || !opts.DisableFullScreen {
		t.Fatalf("unexpected MiniBar window constraints: %+v", opts)
	}
	if opts.Panel != (runtime.GOOS == "darwin") {
		t.Fatalf("Panel = %v, want %v", opts.Panel, runtime.GOOS == "darwin")
	}
	if opts.BackgroundColor != GraphiteBackgroundColor {
		t.Fatalf("BackgroundColor = %q, want %q", opts.BackgroundColor, GraphiteBackgroundColor)
	}
	if opts.Page.PreloadScript != "preload()" {
		t.Fatalf("PreloadScript = %q, want preload()", opts.Page.PreloadScript)
	}
}

func TestShouldShowMiniBarMatrix(t *testing.T) {
	cases := []struct {
		name              string
		barMode           string
		hasExternalClient bool
		goos              string
		kdeSession        bool
		plasmoidInstalled bool
		want              bool
	}{
		{"tray-only_windows", "tray-only", false, "windows", false, false, false},
		{"tray-only_darwin", "tray-only", false, "darwin", false, false, false},
		{"tray-only_linux", "tray-only", false, "linux", false, false, false},
		{"standalone_overrides_external", "standalone", true, "linux", true, true, true},
		{"standalone_windows", "standalone", false, "windows", false, false, true},
		{"auto_windows_no_ext", "auto", false, "windows", false, false, true},
		{"auto_darwin_no_ext", "auto", false, "darwin", false, false, true},
		{"auto_windows_with_ext_yields", "auto", true, "windows", false, false, false},
		{"auto_linux_kde_plasmoid_yields", "auto", false, "linux", true, true, false},
		{"auto_linux_kde_no_plasmoid_shows", "auto", false, "linux", true, false, true},
		{"auto_linux_gnome_plasmoid_shows", "auto", false, "linux", false, true, true},
		{"auto_linux_gnome_with_ext_yields", "auto", true, "linux", false, false, false},
		{"empty_mode_acts_as_auto_linux_kde", "", false, "linux", true, true, false},
		{"empty_mode_acts_as_auto_darwin", "", false, "darwin", false, false, true},
		{"darwin_ignores_kde_flags", "auto", false, "darwin", true, true, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ShouldShowMiniBar(tc.barMode, tc.hasExternalClient, tc.goos, tc.kdeSession, tc.plasmoidInstalled)
			if got != tc.want {
				t.Fatalf("ShouldShowMiniBar(%q, ext=%v, %q, kde=%v, plasmoid=%v) = %v, want %v",
					tc.barMode, tc.hasExternalClient, tc.goos, tc.kdeSession, tc.plasmoidInstalled, got, tc.want)
			}
		})
	}
}

func TestDetectKDEPlasmoid(t *testing.T) {
	home := t.TempDir()
	sysDir := t.TempDir()

	envMap := func(m map[string]string) func(string) string {
		return func(k string) string { return m[k] }
	}

	// Non-KDE session, no plasmoid.
	kde, inst := detectKDEPlasmoid(envMap(map[string]string{"XDG_CURRENT_DESKTOP": "GNOME"}), home, []string{sysDir})
	if kde || inst {
		t.Fatalf("GNOME empty = (%v, %v), want (false, false)", kde, inst)
	}

	// KDE session via KDE_FULL_SESSION, plasmoid installed under homeDir/.local/share.
	userMeta := filepath.Join(home, ".local", "share", "plasma", "plasmoids", plasmoidAppletID, "metadata.json")
	if err := os.MkdirAll(filepath.Dir(userMeta), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(userMeta, []byte(`{}`), 0o644); err != nil {
		t.Fatalf("write metadata: %v", err)
	}
	kde, inst = detectKDEPlasmoid(envMap(map[string]string{"KDE_FULL_SESSION": "true"}), home, []string{sysDir})
	if !kde || !inst {
		t.Fatalf("KDE user plasmoid = (%v, %v), want (true, true)", kde, inst)
	}

	// XDG_DATA_HOME overrides homeDir/.local/share; system dir fallback still detects plasmoid.
	customXDG := t.TempDir()
	kde, inst = detectKDEPlasmoid(envMap(map[string]string{
		"XDG_CURRENT_DESKTOP": "KDE",
		"XDG_DATA_HOME":       customXDG,
	}), home, []string{sysDir})
	if !kde || inst {
		t.Fatalf("empty XDG_DATA_HOME + empty sysDir = (%v, %v), want (true, false)", kde, inst)
	}

	sysMeta := filepath.Join(sysDir, "plasma", "plasmoids", plasmoidAppletID, "metadata.json")
	if err := os.MkdirAll(filepath.Dir(sysMeta), 0o755); err != nil {
		t.Fatalf("mkdir sys: %v", err)
	}
	if err := os.WriteFile(sysMeta, []byte(`{}`), 0o644); err != nil {
		t.Fatalf("write sys metadata: %v", err)
	}
	kde, inst = detectKDEPlasmoid(envMap(map[string]string{
		"DESKTOP_SESSION": "plasmawayland",
		"XDG_DATA_HOME":   customXDG,
	}), home, []string{sysDir})
	if !kde || !inst {
		t.Fatalf("system dir plasmoid = (%v, %v), want (true, true)", kde, inst)
	}
}

func TestComputeMiniBarBoundsDefaultTaskbarOverlayAndFallback(t *testing.T) {
	win11Display := Display{
		Bounds:   Rect{X: 0, Y: 0, Width: 1920, Height: 1080},
		WorkArea: Rect{X: 0, Y: 0, Width: 1920, Height: 1032}, // 48px bottom taskbar
		Primary:  true,
	}

	// 1. Default bottom-center: exact 312x40 (NOT clamped up to MinWidth=320), 8px above WorkArea bottom.
	def := ComputeMiniBarBounds(win11Display, nil, nil)
	if def.Width != 312 || def.Height != 40 {
		t.Fatalf("default MiniBar size = %dx%d, want 312x40", def.Width, def.Height)
	}
	if def.X != (1920-312)/2 || def.Y != 1032-MiniBarBottomInset-40 {
		t.Fatalf("default MiniBar pos = (%d,%d), want (%d,%d)", def.X, def.Y, (1920-312)/2, 1032-MiniBarBottomInset-40)
	}

	// 2. Windows 11 taskbar overlay: custom coords inside physical Bounds (1036..1076) but outside WorkArea (0..1032).
	taskbarOverlay := ComputeMiniBarBounds(win11Display, intPtr(1200), intPtr(1036))
	if taskbarOverlay.X != 1200 || taskbarOverlay.Y != 1036 || taskbarOverlay.Width != 312 || taskbarOverlay.Height != 40 {
		t.Fatalf("taskbar overlay = %+v, want {1200 1036 312 40}", taskbarOverlay)
	}

	// 3. Partial overhang on right/bottom edge clamps strictly inside physical Bounds.
	overhang := ComputeMiniBarBounds(win11Display, intPtr(1800), intPtr(1060))
	if overhang.X != 1920-312 || overhang.Y != 1080-40 {
		t.Fatalf("overhang clamped = (%d,%d), want (%d,%d)", overhang.X, overhang.Y, 1920-312, 1080-40)
	}

	// 4. Disconnected monitor (zero overlap with Bounds) falls back cleanly to default bottom-center.
	offscreen := ComputeMiniBarBounds(win11Display, intPtr(2400), intPtr(1036))
	if offscreen != def {
		t.Fatalf("offscreen fallback = %+v, want default %+v", offscreen, def)
	}

	// 5. Small display narrower than 312px clamps cleanly.
	tiny := Display{
		Bounds:   Rect{X: 0, Y: 0, Width: 280, Height: 200},
		WorkArea: Rect{X: 0, Y: 0, Width: 280, Height: 200},
	}
	clampedTiny := ComputeMiniBarBounds(tiny, nil, nil)
	if clampedTiny.Width != 280 || clampedTiny.Height != 40 || clampedTiny.X != 0 || clampedTiny.Y != 200-8-40 {
		t.Fatalf("tiny display = %+v, want {0 152 280 40}", clampedTiny)
	}

	// 6. Empty display falls back cleanly without panicking.
	empty := ComputeMiniBarBounds(Display{}, intPtr(100), intPtr(200))
	if empty.Width != MiniBarWidth || empty.Height != MiniBarHeight {
		t.Fatalf("empty display = %+v, want 312x40", empty)
	}
}

func TestControllerMiniBarLifecycleThemeAndDebouncedMove(t *testing.T) {
	clk := clock.NewFake(time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC))
	primary := Display{
		ID:       1,
		Bounds:   Rect{X: 0, Y: 0, Width: 1920, Height: 1080},
		WorkArea: Rect{X: 0, Y: 0, Width: 1920, Height: 1032},
		Primary:  true,
	}
	secondary := Display{
		ID:       2,
		Bounds:   Rect{X: 1920, Y: 0, Width: 1920, Height: 1080},
		WorkArea: Rect{X: 1920, Y: 0, Width: 1920, Height: 1032},
	}
	screen := &fakeScreen{displays: []Display{primary, secondary}}

	type moveEvent struct{ x, y int }
	var moves []moveEvent

	ctrl := NewController(Config{
		Screen:            screen,
		Layer:             &fakeLayerShell{available: false},
		Clock:             clk,
		StartHidden:       true,
		PlatformOS:        "windows",
		KDESession:        boolPtr(false),
		PlasmoidInstalled: boolPtr(false),
		InitialBarMode:    "auto",
		OnMiniBarMoved: func(x, y int) {
			moves = append(moves, moveEvent{x: x, y: y})
		},
	})
	defer ctrl.Close()

	panelWin := &fakeWindow{}
	miniWin := &fakeWindow{emitMoveOnSet: true}
	ctrl.Attach(panelWin)
	applied := ctrl.AttachMiniBar(miniWin)

	// 1. On Windows "auto" without external client: MiniBar shows via ShowInactive (never Focus!).
	wantDefault := ComputeMiniBarBounds(primary, nil, nil)
	if applied != wantDefault {
		t.Fatalf("AttachMiniBar bounds = %+v, want %+v", applied, wantDefault)
	}
	if miniWin.shownInactive != 1 || miniWin.focused != 0 {
		t.Fatalf("expected ShowInactive once without Focus, got shownInactive=%d focused=%d", miniWin.shownInactive, miniWin.focused)
	}
	// Synchronous OnMove triggered by programmatic SetBounds must NOT trigger OnMiniBarMoved!
	clk.Advance(time.Second)
	if len(moves) != 0 {
		t.Fatalf("programmatic SetBounds triggered OnMiniBarMoved: %+v", moves)
	}

	// 2. SetTheme syncs BackgroundColor to BOTH Panel and MiniBar.
	ctrl.SetTheme("graphite")
	if len(panelWin.bgColors) != 1 || panelWin.bgColors[0] != GraphiteBackgroundColor ||
		len(miniWin.bgColors) != 1 || miniWin.bgColors[0] != GraphiteBackgroundColor {
		t.Fatalf("theme sync mismatch: panel=%v mini=%v", panelWin.bgColors, miniWin.bgColors)
	}

	// 3. Debounced user drag (400ms via FakeClock): rapid drags coalesce to final coordinates.
	miniWin.bounds = Rect{X: 1100, Y: 1036, Width: MiniBarWidth, Height: MiniBarHeight}
	miniWin.triggerMove()
	clk.Advance(250 * time.Millisecond)
	if len(moves) != 0 {
		t.Fatalf("expected no move callback before 400ms, got %+v", moves)
	}
	miniWin.bounds = Rect{X: 2200, Y: 1036, Width: MiniBarWidth, Height: MiniBarHeight}
	miniWin.triggerMove()
	clk.Advance(300 * time.Millisecond)
	if len(moves) != 0 {
		t.Fatalf("expected debounce timer reset after second move, got %+v", moves)
	}
	clk.Advance(100 * time.Millisecond)
	if len(moves) != 1 || moves[0] != (moveEvent{x: 2200, y: 1036}) {
		t.Fatalf("moves = %+v, want [{2200 1036}]", moves)
	}

	// 4. Multi-display unplug: secondary monitor removed -> display change falls back to primary bottom-center.
	screen.displays = []Display{primary}
	screen.changeHandler()
	vis, curBounds := ctrl.MiniBarState()
	if !vis || curBounds != wantDefault {
		t.Fatalf("after secondary display unplug: vis=%v bounds=%+v, want true %+v", vis, curBounds, wantDefault)
	}

	// 5. External client connects (e.g. KDE Plasmoid) -> "auto" yields & hides MiniBar.
	ctrl.SetExternalBarActive(true)
	if vis, _ := ctrl.MiniBarState(); vis {
		t.Fatalf("expected MiniBar hidden when external client active in auto mode")
	}
	if miniWin.hidden != 1 {
		t.Fatalf("expected Hide called once, got %d", miniWin.hidden)
	}

	// 6. Explicit "standalone" overrides external client and shows MiniBar with custom taskbar coords.
	ctrl.SetBarPrefs("standalone", intPtr(1200), intPtr(1036))
	if vis, curBounds := ctrl.MiniBarState(); !vis || curBounds.X != 1200 || curBounds.Y != 1036 {
		t.Fatalf("standalone custom coords: vis=%v bounds=%+v", vis, curBounds)
	}
	if miniWin.shownInactive != 2 {
		t.Fatalf("expected ShowInactive=2, got %d", miniWin.shownInactive)
	}

	// 7. ResetBarPosition (nil, nil) moves back to default bottom-center and cancels pending drag.
	miniWin.bounds = Rect{X: 900, Y: 900, Width: MiniBarWidth, Height: MiniBarHeight}
	miniWin.triggerMove()
	ctrl.SetBarPrefs("standalone", nil, nil)
	clk.Advance(time.Second)
	if len(moves) != 1 {
		t.Fatalf("reset should cancel pending drag debounce, moves=%+v", moves)
	}
	if _, curBounds := ctrl.MiniBarState(); curBounds != wantDefault {
		t.Fatalf("after reset: bounds=%+v, want %+v", curBounds, wantDefault)
	}

	// 8. "tray-only" hides MiniBar.
	ctrl.SetBarPrefs("tray-only", nil, nil)
	if vis, _ := ctrl.MiniBarState(); vis {
		t.Fatalf("expected MiniBar hidden in tray-only mode")
	}
	if miniWin.hidden != 2 {
		t.Fatalf("expected Hide=2, got %d", miniWin.hidden)
	}
}

type deferredWindow struct {
	fakeWindow
	queue []func()
}

func (d *deferredWindow) RunOnMain(fn func()) {
	d.mainRuns++
	d.queue = append(d.queue, fn)
}

func (d *deferredWindow) drainMain() {
	for len(d.queue) > 0 {
		fn := d.queue[0]
		d.queue = d.queue[1:]
		fn()
	}
}

func TestControllerMiniBarAsyncRunOnMainConvergence(t *testing.T) {
	primary := Display{
		ID:       1,
		Bounds:   Rect{X: 0, Y: 0, Width: 1920, Height: 1080},
		WorkArea: Rect{X: 0, Y: 0, Width: 1920, Height: 1032},
		Primary:  true,
	}
	screen := &fakeScreen{display: primary}

	t.Run("a_noop_sync_does_not_drop_pending_show_or_hide", func(t *testing.T) {
		ctrl := NewController(Config{
			Screen:            screen,
			Layer:             &fakeLayerShell{available: false},
			StartHidden:       true,
			PlatformOS:        "windows",
			KDESession:        boolPtr(false),
			PlasmoidInstalled: boolPtr(false),
			InitialBarMode:    "auto",
		})
		defer ctrl.Close()

		miniWin := &deferredWindow{}
		// AttachMiniBar queues ShowInactive + SetBounds without running them yet.
		ctrl.AttachMiniBar(miniWin)
		// Follow immediately with no-op syncMiniBar calls before main thread runs.
		ctrl.SetExternalBarActive(false)
		ctrl.SetBarPrefs("auto", nil, nil)

		miniWin.drainMain()
		wantDefault := ComputeMiniBarBounds(primary, nil, nil)
		if miniWin.shownInactive != 1 || miniWin.hidden != 0 || miniWin.bounds != wantDefault {
			t.Fatalf("after show+noop drain: shownInactive=%d hidden=%d bounds=%+v, want 1/0/%+v",
				miniWin.shownInactive, miniWin.hidden, miniWin.bounds, wantDefault)
		}

		// Queue Hide, then follow with a no-op SetExternalBarActive(true) before drain.
		ctrl.SetExternalBarActive(true)
		ctrl.SetExternalBarActive(true)
		miniWin.drainMain()
		if miniWin.hidden != 1 {
			t.Fatalf("after hide+noop drain: hidden=%d, want 1", miniWin.hidden)
		}
	})

	t.Run("b_rapid_show_bounds_update_before_drain_still_shows_at_latest_bounds", func(t *testing.T) {
		ctrl := NewController(Config{
			Screen:            screen,
			Layer:             &fakeLayerShell{available: false},
			StartHidden:       true,
			PlatformOS:        "windows",
			KDESession:        boolPtr(false),
			PlasmoidInstalled: boolPtr(false),
			InitialBarMode:    "tray-only",
		})
		defer ctrl.Close()

		miniWin := &deferredWindow{}
		ctrl.AttachMiniBar(miniWin)
		miniWin.drainMain()
		if miniWin.shownInactive != 0 {
			t.Fatalf("expected hidden initially in tray-only")
		}

		// hidden -> show(B1) immediately followed by show(B2) before main thread runs.
		ctrl.SetBarPrefs("standalone", intPtr(400), intPtr(900))
		ctrl.SetBarPrefs("standalone", intPtr(1200), intPtr(1036))

		miniWin.drainMain()
		wantB2 := Rect{X: 1200, Y: 1036, Width: MiniBarWidth, Height: MiniBarHeight}
		if miniWin.shownInactive != 1 || miniWin.bounds != wantB2 {
			t.Fatalf("after show(B1)+show(B2) drain: shownInactive=%d bounds=%+v, want 1/%+v",
				miniWin.shownInactive, miniWin.bounds, wantB2)
		}
	})

	t.Run("c_show_canceled_by_hide_before_drain_never_flashes", func(t *testing.T) {
		ctrl := NewController(Config{
			Screen:            screen,
			Layer:             &fakeLayerShell{available: false},
			StartHidden:       true,
			PlatformOS:        "windows",
			KDESession:        boolPtr(false),
			PlasmoidInstalled: boolPtr(false),
			InitialBarMode:    "auto",
		})
		defer ctrl.Close()

		miniWin := &deferredWindow{}
		ctrl.AttachMiniBar(miniWin)
		ctrl.SetBarPrefs("tray-only", nil, nil)
		miniWin.drainMain()
		if miniWin.shownInactive != 0 || miniWin.hidden != 0 {
			t.Fatalf("canceled show flashed window: shownInactive=%d hidden=%d", miniWin.shownInactive, miniWin.hidden)
		}
	})
}

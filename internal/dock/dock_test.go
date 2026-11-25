package dock

import (
	"errors"
	"testing"
	"time"

	"github.com/muyuzhong/featherlog/internal/clock"
)

type fakeWindow struct {
	bounds       Rect
	setBoundsLog []Rect
	shown        int
	hidden       int
	focused      int
	bgColors     []string
	handle       uintptr
	destroyed    bool
	blurHandlers []func()
	mainRuns     int
}

func (f *fakeWindow) Bounds() Rect                { return f.bounds }
func (f *fakeWindow) Show()                       { f.shown++ }
func (f *fakeWindow) ShowInactive()               { f.shown++ }
func (f *fakeWindow) Hide()                       { f.hidden++ }
func (f *fakeWindow) Focus()                      { f.focused++ }
func (f *fakeWindow) SetBackgroundColor(c string) { f.bgColors = append(f.bgColors, c) }
func (f *fakeWindow) NativeHandle() uintptr       { return f.handle }
func (f *fakeWindow) IsDestroyed() bool           { return f.destroyed }
func (f *fakeWindow) SetBounds(r Rect) {
	f.bounds = r
	f.setBoundsLog = append(f.setBoundsLog, r)
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
func (f *fakeWindow) triggerBlur() {
	for _, fn := range f.blurHandlers {
		if fn != nil {
			fn()
		}
	}
}

type fakeScreen struct {
	display       Display
	changeHandler func()
}

func (s *fakeScreen) ActiveDisplay(Rect) Display { return s.display }
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
	if len(toggleEvents) != 1 || toggleEvents[0] != true {
		t.Fatalf("toggleEvents = %v, want [true]", toggleEvents)
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

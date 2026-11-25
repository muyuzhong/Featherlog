package dock

import (
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/muyuzhong/featherlog/internal/clock"
)

// DefaultToggleShortcuts are tried in order when registering the global dock toggle shortcut.
var DefaultToggleShortcuts = []string{
	"Alt+Shift+Space",
	"CommandOrControl+Shift+Space",
}

// Window abstracts the native window operations needed by the dock controller.
type Window interface {
	Bounds() Rect
	SetBounds(r Rect)
	Show()
	ShowInactive()
	Hide()
	Focus()
	SetBackgroundColor(color string)
	NativeHandle() uintptr
	RunOnMain(fn func())
	OnBlur(fn func()) func()
	IsDestroyed() bool
}

// Screen abstracts monitor queries and display change events.
type Screen interface {
	ActiveDisplay(current Rect) Display
	OnDisplaysChanged(fn func()) func()
}

// ShortcutRegistrar abstracts global keyboard shortcut registration.
type ShortcutRegistrar interface {
	Register(accelerator, description string, fn func()) error
	Unregister(accelerator string)
}

// WindowOption customizes WindowOptions for the opaque Featherlog Workspace Panel.
type WindowOption func(*windowConfig)

type windowConfig struct {
	theme  string
	hidden bool
}

// WithTheme sets the solid window background color matching theme ("stone" or "graphite").
func WithTheme(theme string) WindowOption {
	return func(cfg *windowConfig) {
		cfg.theme = theme
	}
}

// WithHidden controls whether the panel window starts hidden (true by default).
func WithHidden(hidden bool) WindowOption {
	return func(cfg *windowConfig) {
		cfg.hidden = hidden
	}
}

// WindowOptions returns the MyGo WindowOptions for the opaque 880x520
// frameless Workspace Panel window ("featherlog-panel").
//
// Transparent is explicitly false with a solid theme-matched BackgroundColor so
// GTK3/WebKitGTK renders the full surface reliably on hybrid Intel+NVIDIA
// Wayland systems (even with WEBKIT_DISABLE_DMABUF_RENDERER=1).
func WindowOptions(url, preloadScript string, initial Rect, opts ...WindowOption) mygo.WindowOptions {
	cfg := windowConfig{
		theme:  "stone",
		hidden: true,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}
	return mygo.WindowOptions{
		Title:             PanelWindowTitle,
		URL:               url,
		X:                 initial.X,
		Y:                 initial.Y,
		Width:             PanelWidth,
		Height:            PanelHeight,
		MinWidth:          PanelWidth,
		MinHeight:         PanelHeight,
		MaxWidth:          PanelWidth,
		MaxHeight:         PanelHeight,
		Hidden:            cfg.hidden,
		Frameless:         true,
		Transparent:       false,
		DisableShadow:     false,
		AlwaysOnTop:       true,
		SkipTaskbar:       true,
		DisableResize:     true,
		DisableMaximize:   true,
		DisableMinimize:   true,
		DisableFullScreen: true,
		BackgroundColor:   ThemeBackgroundColor(cfg.theme),
		Page: mygo.PageOptions{
			PreloadScript: preloadScript,
		},
	}
}

// MyGoWindow adapts a *mygo.Window to the Window interface.
type MyGoWindow struct {
	W *mygo.Window
}

func (m MyGoWindow) Bounds() Rect {
	if m.W == nil {
		return Rect{}
	}
	b := m.W.Bounds()
	return Rect{X: b.X, Y: b.Y, Width: b.Width, Height: b.Height}
}

func (m MyGoWindow) SetBounds(r Rect) {
	if m.W == nil {
		return
	}
	m.W.SetBounds(mygo.Rectangle{X: r.X, Y: r.Y, Width: r.Width, Height: r.Height})
}

func (m MyGoWindow) Show() {
	if m.W != nil {
		m.W.Show()
	}
}

func (m MyGoWindow) ShowInactive() {
	if m.W != nil {
		m.W.ShowInactive()
	}
}

func (m MyGoWindow) Hide() {
	if m.W != nil {
		m.W.Hide()
	}
}

func (m MyGoWindow) Focus() {
	if m.W != nil {
		m.W.Focus()
	}
}

func (m MyGoWindow) SetBackgroundColor(color string) {
	if m.W != nil {
		_ = m.W.SetBackgroundColor(color)
	}
}

func (m MyGoWindow) NativeHandle() uintptr {
	if m.W == nil {
		return 0
	}
	return m.W.NativeHandle()
}

func (m MyGoWindow) RunOnMain(fn func()) {
	mygo.RunOnMain(fn)
}

func (m MyGoWindow) OnBlur(fn func()) func() {
	if m.W == nil {
		return func() {}
	}
	return m.W.OnBlur(fn)
}

func (m MyGoWindow) IsDestroyed() bool {
	if m.W == nil {
		return true
	}
	return m.W.IsDestroyed()
}

// MyGoScreen adapts mygo.Screen to the Screen interface.
type MyGoScreen struct{}

func (MyGoScreen) ActiveDisplay(current Rect) Display {
	var d mygo.Display
	if current.Width > 0 && current.Height > 0 {
		d = mygo.Screen.DisplayMatching(mygo.Rectangle{
			X:      current.X,
			Y:      current.Y,
			Width:  current.Width,
			Height: current.Height,
		})
	}
	if d.Bounds.Width <= 0 || d.Bounds.Height <= 0 {
		cursor := mygo.Screen.CursorScreenPoint()
		d = mygo.Screen.DisplayNearestPoint(cursor)
	}
	if d.Bounds.Width <= 0 || d.Bounds.Height <= 0 {
		d = mygo.Screen.PrimaryDisplay()
	}
	return Display{
		ID: d.ID,
		Bounds: Rect{
			X:      d.Bounds.X,
			Y:      d.Bounds.Y,
			Width:  d.Bounds.Width,
			Height: d.Bounds.Height,
		},
		WorkArea: Rect{
			X:      d.WorkArea.X,
			Y:      d.WorkArea.Y,
			Width:  d.WorkArea.Width,
			Height: d.WorkArea.Height,
		},
		Primary: d.Primary,
	}
}

func (MyGoScreen) OnDisplaysChanged(fn func()) func() {
	return mygo.Screen.OnDisplaysChanged(fn)
}

// MyGoShortcuts adapts mygo.GlobalShortcut to ShortcutRegistrar.
type MyGoShortcuts struct{}

func (MyGoShortcuts) Register(accelerator, description string, fn func()) error {
	return mygo.GlobalShortcut.RegisterWith(accelerator, mygo.GlobalShortcutOptions{
		Description: description,
	}, fn)
}

func (MyGoShortcuts) Unregister(accelerator string) {
	mygo.GlobalShortcut.Unregister(accelerator)
}

type expandedListener struct {
	id uint64
	fn func(expanded bool)
}

// Controller manages bottom-center anchoring, show/hide popup panel lifecycle,
// layer-shell placement, blur-to-collapse, and global toggle shortcut state.
type Controller struct {
	mu              sync.Mutex
	screen          Screen
	layer           LayerShell
	shortcuts       ShortcutRegistrar
	clk             clock.Clock
	win             Window
	bottomInset     int
	blurToggleGrace time.Duration

	width          int
	height         int
	expanded       bool
	visible        bool
	pinned         bool
	lastBounds     Rect
	anchored       bool
	lastCollapseAt time.Time
	lastBlurHideAt time.Time

	registeredShortcut string
	onToggle           func(expanded bool)
	nextListener       uint64
	expandedListeners  []expandedListener
	cleanups           []func()
}

// Config configures a Controller.
type Config struct {
	Screen          Screen
	Layer           LayerShell
	Shortcuts       ShortcutRegistrar
	Clock           clock.Clock
	BottomInset     int
	InitialPin      bool
	InitialExpanded bool
	StartHidden     bool
	BlurToggleGrace time.Duration
	OnToggle        func(expanded bool)
}

// NewController creates a new dock controller.
func NewController(cfg Config) *Controller {
	screen := cfg.Screen
	if screen == nil {
		screen = MyGoScreen{}
	}
	layer := cfg.Layer
	if layer == nil {
		layer = DefaultLayerShell()
	}
	shortcuts := cfg.Shortcuts
	if shortcuts == nil {
		shortcuts = MyGoShortcuts{}
	}
	clk := cfg.Clock
	if clk == nil {
		clk = clock.NewReal()
	}
	inset := cfg.BottomInset
	if inset <= 0 {
		inset = DefaultBottomInset
	}
	visible := cfg.InitialExpanded || !cfg.StartHidden
	return &Controller{
		screen:          screen,
		layer:           layer,
		shortcuts:       shortcuts,
		clk:             clk,
		bottomInset:     inset,
		blurToggleGrace: cfg.BlurToggleGrace,
		width:           PanelWidth,
		height:          PanelHeight,
		expanded:        cfg.InitialExpanded,
		visible:         visible,
		pinned:          cfg.InitialPin,
		onToggle:        cfg.OnToggle,
	}
}

// InitialRect computes the initial bottom-center rectangle on the active display.
func (c *Controller) InitialRect() Rect {
	c.mu.Lock()
	w, h, inset := c.width, c.height, c.bottomInset
	screen := c.screen
	c.mu.Unlock()
	display := screen.ActiveDisplay(Rect{})
	return ComputeBounds(display, w, h, inset)
}

// Attach binds a window to the controller, anchors it at bottom-center, and
// wires display-change and blur-to-collapse listeners.
func (c *Controller) Attach(win Window) Rect {
	c.mu.Lock()
	c.win = win
	w, h, inset := c.width, c.height, c.bottomInset
	c.mu.Unlock()

	applied := c.applyBounds(win, w, h, inset)

	offBlur := win.OnBlur(func() {
		c.handleBlur()
	})
	offDisplays := c.screen.OnDisplaysChanged(func() {
		c.reanchorCurrent()
	})

	c.mu.Lock()
	c.cleanups = append(c.cleanups, offBlur, offDisplays)
	c.mu.Unlock()

	return applied
}

// Resize applies new dock geometry. When geom.Expanded is false (e.g. Esc,
// collapse button, or blur while unpinned), the popup panel window is hidden
// cleanly instead of shrinking to a bar.
func (c *Controller) Resize(geom Geometry) Rect {
	c.mu.Lock()
	wasExpanded := c.expanded
	if geom.Pinned != nil {
		c.pinned = *geom.Pinned
	}
	win := c.win
	inset := c.bottomInset
	screen := c.screen

	if !geom.Expanded {
		c.expanded = false
		c.visible = false
		c.lastCollapseAt = c.clk.Now()
		w := defaultIfNonPositive(geom.Width, c.width)
		h := defaultIfNonPositive(geom.Height, c.height)
		cur := c.lastBounds
		listeners := c.snapshotExpandedListenersLocked()
		c.mu.Unlock()

		if win != nil && !win.IsDestroyed() {
			win.RunOnMain(win.Hide)
		}

		display := screen.ActiveDisplay(cur)
		next := ComputeBounds(display, w, h, inset)

		c.mu.Lock()
		c.lastBounds = next
		c.mu.Unlock()

		if wasExpanded {
			for _, fn := range listeners {
				fn(false)
			}
		}
		return next
	}

	if geom.Width > 0 {
		c.width = geom.Width
	}
	if geom.Height > 0 {
		c.height = geom.Height
	}
	w, h := c.width, c.height

	// Ignore stale or initial startup Resize(expanded=true) calls while the
	// panel window is hidden; only Toggle(true) or --show opens a hidden panel.
	if !c.visible {
		cur := c.lastBounds
		c.mu.Unlock()
		display := screen.ActiveDisplay(cur)
		next := ComputeBounds(display, w, h, inset)
		c.mu.Lock()
		c.lastBounds = next
		c.mu.Unlock()
		return next
	}

	c.expanded = true
	listeners := c.snapshotExpandedListenersLocked()
	c.mu.Unlock()

	next := c.applyBounds(win, w, h, inset)
	if !wasExpanded {
		for _, fn := range listeners {
			fn(true)
		}
	}
	return next
}

// SetPinned updates whether the expanded panel stays open on window blur.
func (c *Controller) SetPinned(pinned bool) {
	c.mu.Lock()
	c.pinned = pinned
	c.mu.Unlock()
}

// SetTheme updates the opaque native window background color to match theme.
func (c *Controller) SetTheme(theme string) {
	c.mu.Lock()
	win := c.win
	c.mu.Unlock()
	if win != nil && !win.IsDestroyed() {
		win.SetBackgroundColor(ThemeBackgroundColor(theme))
	}
}

// OnExpandedChange subscribes to panel open/close transitions triggered either
// by Toggle or by Resize(expanded=false). The returned function unsubscribes.
func (c *Controller) OnExpandedChange(fn func(expanded bool)) func() {
	if fn == nil {
		return func() {}
	}
	c.mu.Lock()
	c.nextListener++
	id := c.nextListener
	c.expandedListeners = append(c.expandedListeners, expandedListener{id: id, fn: fn})
	c.mu.Unlock()

	return func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		for i, entry := range c.expandedListeners {
			if entry.id == id {
				c.expandedListeners = append(c.expandedListeners[:i], c.expandedListeners[i+1:]...)
				return
			}
		}
	}
}

// State returns the current expanded, pinned, layer-anchored flags and last bounds.
func (c *Controller) State() (expanded, pinned, layerAnchored bool, bounds Rect) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.expanded, c.pinned, c.anchored, c.lastBounds
}

// Toggle toggles (or explicitly sets) the panel visibility.
// When expanding, it positions the 880x520 panel bottom-center right above the
// dock, shows and focuses the window on the main thread, and emits dock:toggle.
// When collapsing, it hides the window on the main thread and emits dock:toggle.
func (c *Controller) Toggle(target *bool) bool {
	c.mu.Lock()
	wasExpanded := c.expanded
	next := !c.expanded
	if target != nil {
		next = *target
	} else if next && c.withinBlurGraceLocked(c.clk.Now()) {
		// Suppress bounce when clicking the KDE dock button first triggers blur
		// on mouse-down and then calls POST /api/panel/toggle {} on mouse-up.
		c.mu.Unlock()
		return false
	}

	c.expanded = next
	c.visible = next
	if next {
		c.width = PanelWidth
		c.height = PanelHeight
		c.lastBlurHideAt = time.Time{}
	} else {
		c.lastCollapseAt = c.clk.Now()
	}
	w, h, inset := c.width, c.height, c.bottomInset
	win := c.win
	cb := c.onToggle
	listeners := c.snapshotExpandedListenersLocked()
	c.mu.Unlock()

	if next {
		c.applyBounds(win, w, h, inset)
		if win != nil && !win.IsDestroyed() {
			win.RunOnMain(func() {
				win.Show()
				win.Focus()
			})
		}
	} else if win != nil && !win.IsDestroyed() {
		win.RunOnMain(win.Hide)
	}

	if cb != nil {
		cb(next)
	}
	if wasExpanded != next {
		for _, fn := range listeners {
			fn(next)
		}
	}
	return next
}

// RegisterShortcut tries each candidate accelerator in order and registers
// the first one accepted by the platform to toggle the dock panel.
func (c *Controller) RegisterShortcut(candidates []string) (string, error) {
	if len(candidates) == 0 {
		candidates = DefaultToggleShortcuts
	}
	var errs []error
	for _, acc := range candidates {
		err := c.shortcuts.Register(acc, "Toggle Featherlog panel", func() {
			c.Toggle(nil)
		})
		if err == nil {
			c.mu.Lock()
			c.registeredShortcut = acc
			c.mu.Unlock()
			return acc, nil
		}
		errs = append(errs, fmt.Errorf("%s: %w", acc, err))
	}
	return "", errors.Join(errs...)
}

// Close releases listeners and unregisters any global shortcut.
func (c *Controller) Close() {
	c.mu.Lock()
	acc := c.registeredShortcut
	c.registeredShortcut = ""
	cleanups := c.cleanups
	c.cleanups = nil
	c.expandedListeners = nil
	shortcuts := c.shortcuts
	c.mu.Unlock()

	if acc != "" && shortcuts != nil {
		shortcuts.Unregister(acc)
	}
	for _, fn := range cleanups {
		if fn != nil {
			fn()
		}
	}
}

func (c *Controller) applyBounds(win Window, w, h, inset int) Rect {
	c.mu.Lock()
	cur := c.lastBounds
	screen := c.screen
	layer := c.layer
	c.mu.Unlock()

	if win != nil && !win.IsDestroyed() && (cur.Width == 0 || cur.Height == 0) {
		cur = win.Bounds()
	}
	display := screen.ActiveDisplay(cur)
	next := ComputeBounds(display, w, h, inset)
	marginBottom := ComputeBottomMargin(display, next, inset)

	anchored := false
	if win != nil && !win.IsDestroyed() {
		win.SetBounds(next)
		if layer != nil && layer.Available() {
			handle := win.NativeHandle()
			if handle != 0 {
				win.RunOnMain(func() {
					anchored = layer.AnchorBottomCenter(handle, marginBottom)
				})
			}
		}
	}

	c.mu.Lock()
	c.lastBounds = next
	c.anchored = anchored
	c.mu.Unlock()

	return next
}

func (c *Controller) handleBlur() {
	c.mu.Lock()
	now := c.clk.Now()
	shouldCollapse := c.expanded && !c.pinned
	if shouldCollapse {
		c.lastBlurHideAt = now
	} else if !c.pinned && !c.lastCollapseAt.IsZero() && now.Sub(c.lastCollapseAt) < 100*time.Millisecond {
		// WebView JS blur may have already called Resize(expanded=false) moments earlier.
		c.lastBlurHideAt = now
	}
	c.mu.Unlock()
	if shouldCollapse {
		collapsed := false
		c.Toggle(&collapsed)
	}
}

func (c *Controller) withinBlurGraceLocked(now time.Time) bool {
	if c.blurToggleGrace <= 0 || c.lastBlurHideAt.IsZero() {
		return false
	}
	elapsed := now.Sub(c.lastBlurHideAt)
	return elapsed >= 0 && elapsed < c.blurToggleGrace
}

func (c *Controller) reanchorCurrent() {
	c.mu.Lock()
	win := c.win
	w, h, inset := c.width, c.height, c.bottomInset
	c.mu.Unlock()
	c.applyBounds(win, w, h, inset)
}

func (c *Controller) snapshotExpandedListenersLocked() []func(bool) {
	if len(c.expandedListeners) == 0 {
		return nil
	}
	out := make([]func(bool), len(c.expandedListeners))
	for i, l := range c.expandedListeners {
		out[i] = l.fn
	}
	return out
}

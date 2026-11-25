//go:build linux && !android && (amd64 || arm64)

package dock

import (
	"os"
	"strings"
	"sync"

	"github.com/ebitengine/purego"
)

// LayerShell controls optional Wayland wlr-layer-shell bottom anchoring.
type LayerShell interface {
	Available() bool
	AnchorBottomCenter(windowHandle uintptr, marginBottom int) bool
}

const (
	gtkLayerEdgeLeft   int32 = 0
	gtkLayerEdgeRight  int32 = 1
	gtkLayerEdgeTop    int32 = 2
	gtkLayerEdgeBottom int32 = 3

	gtkLayerOverlay int32 = 3 // GTK_LAYER_SHELL_LAYER_OVERLAY

	gtkLayerKeyboardOnDemand int32 = 2 // GTK_LAYER_SHELL_KEYBOARD_MODE_ON_DEMAND
)

type gtkLayerShell struct {
	once      sync.Once
	supported bool

	isSupported    func() bool
	isLayerWindow  func(win uintptr) bool
	setLayer       func(win uintptr, layer int32)
	setAnchor      func(win uintptr, edge int32, anchor bool)
	setMargin      func(win uintptr, edge int32, margin int32)
	setExclusive   func(win uintptr, zone int32)
	setKeyboardMod func(win uintptr, mode int32)
}

var defaultLayerShellInstance = &gtkLayerShell{}

// DefaultLayerShell returns the Linux Wayland gtk-layer-shell adapter.
func DefaultLayerShell() LayerShell {
	return defaultLayerShellInstance
}

func isWaylandSession(getenv func(string) string) bool {
	if getenv("WAYLAND_DISPLAY") == "" {
		return false
	}
	// Respect explicit X11 override (e.g. GDK_BACKEND=x11).
	backend := strings.TrimSpace(strings.ToLower(getenv("GDK_BACKEND")))
	if backend != "" {
		first, _, _ := strings.Cut(backend, ",")
		if first == "x11" {
			return false
		}
	}
	return true
}

func (g *gtkLayerShell) load() bool {
	g.once.Do(func() {
		if !isWaylandSession(os.Getenv) {
			return
		}
		lib, err := purego.Dlopen("libgtk-layer-shell.so.0", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			return
		}
		if !registerSymbol(lib, &g.isSupported, "gtk_layer_is_supported") ||
			!registerSymbol(lib, &g.isLayerWindow, "gtk_layer_is_layer_window") ||
			!registerSymbol(lib, &g.setLayer, "gtk_layer_set_layer") ||
			!registerSymbol(lib, &g.setAnchor, "gtk_layer_set_anchor") ||
			!registerSymbol(lib, &g.setMargin, "gtk_layer_set_margin") ||
			!registerSymbol(lib, &g.setExclusive, "gtk_layer_set_exclusive_zone") {
			return
		}
		// Optional on gtk-layer-shell < 0.6.
		_ = registerSymbol(lib, &g.setKeyboardMod, "gtk_layer_set_keyboard_mode")
		g.supported = g.isSupported()
	})
	return g.supported
}

func registerSymbol(lib uintptr, fn any, name string) bool {
	sym, err := purego.Dlsym(lib, name)
	if err != nil || sym == 0 {
		return false
	}
	purego.RegisterFunc(fn, sym)
	return true
}

func (g *gtkLayerShell) Available() bool {
	return g.load()
}

// AnchorBottomCenter anchors an already-initialized gtk-layer-shell overlay
// window to the bottom edge (horizontally centered) with no exclusive zone,
// so KDE/Wayland tiling never interferes and upward expansion keeps the bottom
// edge fixed. Must be called on the GTK main thread.
func (g *gtkLayerShell) AnchorBottomCenter(windowHandle uintptr, marginBottom int) bool {
	if windowHandle == 0 || !g.load() {
		return false
	}
	if !g.isLayerWindow(windowHandle) {
		return false
	}
	if marginBottom < 0 {
		marginBottom = 0
	}
	g.setLayer(windowHandle, gtkLayerOverlay)
	// -1 avoids displacing Plasma panels or tiled windows on KDE Wayland.
	g.setExclusive(windowHandle, -1)
	g.setAnchor(windowHandle, gtkLayerEdgeTop, false)
	g.setAnchor(windowHandle, gtkLayerEdgeLeft, false)
	g.setAnchor(windowHandle, gtkLayerEdgeRight, false)
	g.setAnchor(windowHandle, gtkLayerEdgeBottom, true)
	g.setMargin(windowHandle, gtkLayerEdgeTop, 0)
	g.setMargin(windowHandle, gtkLayerEdgeLeft, 0)
	g.setMargin(windowHandle, gtkLayerEdgeRight, 0)
	g.setMargin(windowHandle, gtkLayerEdgeBottom, int32(marginBottom))
	if g.setKeyboardMod != nil {
		g.setKeyboardMod(windowHandle, gtkLayerKeyboardOnDemand)
	}
	return true
}

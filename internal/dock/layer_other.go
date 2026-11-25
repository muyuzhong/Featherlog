//go:build !(linux && !android && (amd64 || arm64))

package dock

// LayerShell controls optional Wayland wlr-layer-shell bottom anchoring.
type LayerShell interface {
	Available() bool
	AnchorBottomCenter(windowHandle uintptr, marginBottom int) bool
}

type noopLayerShell struct{}

func (noopLayerShell) Available() bool                      { return false }
func (noopLayerShell) AnchorBottomCenter(uintptr, int) bool { return false }

// DefaultLayerShell returns a no-op LayerShell on non-Linux platforms.
func DefaultLayerShell() LayerShell {
	return noopLayerShell{}
}

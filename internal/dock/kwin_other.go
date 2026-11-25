//go:build !(linux && !android && (amd64 || arm64))

package dock

import "context"

// KWinCommandRunner runs an external D-Bus CLI helper on Linux.
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

// KWinPlacer is a no-op outside Linux.
type KWinPlacer struct{}

// NewKWinPlacer returns a no-op KWinPlacer on non-Linux platforms.
func NewKWinPlacer(KWinConfig) *KWinPlacer { return &KWinPlacer{} }

// Supported reports false on non-Linux platforms.
func (*KWinPlacer) Supported() bool { return false }

// Start is a no-op on non-Linux platforms.
func (*KWinPlacer) Start(context.Context) error { return nil }

// Close is a no-op on non-Linux platforms.
func (*KWinPlacer) Close() error { return nil }

package dock

const (
	DefaultCollapsedWidth  = 640
	DefaultCollapsedHeight = 44
	DefaultExpandedWidth   = 880
	DefaultExpandedHeight  = 520
	DefaultBottomInset     = 12

	PanelWindowTitle        = "featherlog-panel"
	PanelWidth              = DefaultExpandedWidth
	PanelHeight             = DefaultExpandedHeight
	PanelBottomInset        = 10
	MiniBarWindowTitle      = "featherlog-bar"
	MiniBarWidth            = 312
	MiniBarHeight           = 40
	MiniBarBottomInset      = 8
	StoneBackgroundColor    = "#F6F5F2"
	GraphiteBackgroundColor = "#131416"

	MinWidth  = 320
	MaxWidth  = 1280
	MinHeight = 36
	MaxHeight = 900
)

// ThemeBackgroundColor returns the solid opaque window background color for
// the given Featherlog theme ("stone" or "graphite"). Keeping the window
// opaque avoids GTK3/WebKitGTK partial dirty-rect rendering bugs on hybrid GPU
// Wayland setups.
func ThemeBackgroundColor(theme string) string {
	if theme == "graphite" {
		return GraphiteBackgroundColor
	}
	return StoneBackgroundColor
}

// Rect represents a window or display rectangle in DIPs.
type Rect struct {
	X      int `json:"x"`
	Y      int `json:"y"`
	Width  int `json:"width"`
	Height int `json:"height"`
}

// Display describes a monitor's physical bounds and usable work area.
type Display struct {
	ID       int64
	Bounds   Rect
	WorkArea Rect
	Primary  bool
}

// Geometry matches the shared frontend DockGeometry contract (§4.1).
type Geometry struct {
	Width    int   `json:"width"`
	Height   int   `json:"height"`
	Expanded bool  `json:"expanded"`
	Pinned   *bool `json:"pinned,omitempty"`
}

// DefaultInitialRect returns the initial collapsed dock rectangle on display.
func DefaultInitialRect(display Display) Rect {
	return ComputeBounds(display, DefaultCollapsedWidth, DefaultCollapsedHeight, DefaultBottomInset)
}

// ComputeBounds computes a horizontally centered, bottom-anchored rectangle
// clamped strictly inside the display's usable work area. Increasing height
// keeps the bottom edge fixed so the drawer expands strictly upward.
func ComputeBounds(display Display, width, height, bottomInset int) Rect {
	area := usableArea(display)
	if area.Width <= 0 || area.Height <= 0 {
		w := clampInt(defaultIfNonPositive(width, DefaultCollapsedWidth), MinWidth, MaxWidth)
		h := clampInt(defaultIfNonPositive(height, DefaultCollapsedHeight), MinHeight, MaxHeight)
		return Rect{X: 0, Y: 0, Width: w, Height: h}
	}

	w := clampInt(defaultIfNonPositive(width, DefaultCollapsedWidth), MinWidth, MaxWidth)
	if w > area.Width {
		w = area.Width
	}
	if w < 1 {
		w = 1
	}

	h := clampInt(defaultIfNonPositive(height, DefaultCollapsedHeight), MinHeight, MaxHeight)
	if h > area.Height {
		h = area.Height
	}
	if h < 1 {
		h = 1
	}

	if bottomInset < 0 {
		bottomInset = 0
	}
	maxInset := area.Height - h
	if maxInset < 0 {
		maxInset = 0
	}
	effectiveInset := bottomInset
	if effectiveInset > maxInset {
		effectiveInset = maxInset
	}

	x := area.X + (area.Width-w)/2
	x = clampInt(x, area.X, area.X+area.Width-w)

	bottomY := area.Y + area.Height - effectiveInset
	y := bottomY - h
	y = clampInt(y, area.Y, area.Y+area.Height-h)

	return Rect{
		X:      x,
		Y:      y,
		Width:  w,
		Height: h,
	}
}

// ComputeMiniBarBounds computes the 312x40 standalone Mini-Bar rectangle on display.
//
// When customX or customY is nil, the Mini-Bar is horizontally centered in the
// display's usable work area, MiniBarBottomInset (8px) above its bottom edge,
// keeping the exact 312px width without clamping up to MinWidth.
//
// When both customX and customY are non-nil, the saved position is validated
// against display.Bounds (physical screen bounds rather than WorkArea so
// Windows 11 users can place the Mini-Bar onto empty taskbar space). If the
// saved rectangle does not overlap display.Bounds (e.g., an unplugged monitor),
// it falls back cleanly to default bottom-center.
func ComputeMiniBarBounds(display Display, customX, customY *int) Rect {
	if customX == nil || customY == nil {
		return computeDefaultMiniBarBounds(display)
	}

	phys := display.Bounds
	if phys.Width <= 0 || phys.Height <= 0 {
		phys = usableArea(display)
	}
	if phys.Width <= 0 || phys.Height <= 0 {
		return Rect{X: 0, Y: 0, Width: MiniBarWidth, Height: MiniBarHeight}
	}

	w := MiniBarWidth
	if w > phys.Width {
		w = phys.Width
	}
	if w < 1 {
		w = 1
	}
	h := MiniBarHeight
	if h > phys.Height {
		h = phys.Height
	}
	if h < 1 {
		h = 1
	}

	saved := Rect{X: *customX, Y: *customY, Width: w, Height: h}
	if !rectsOverlap(saved, phys) {
		return computeDefaultMiniBarBounds(display)
	}

	x := clampInt(*customX, phys.X, phys.X+phys.Width-w)
	y := clampInt(*customY, phys.Y, phys.Y+phys.Height-h)
	return Rect{
		X:      x,
		Y:      y,
		Width:  w,
		Height: h,
	}
}

func computeDefaultMiniBarBounds(display Display) Rect {
	area := usableArea(display)
	if area.Width <= 0 || area.Height <= 0 {
		return Rect{X: 0, Y: 0, Width: MiniBarWidth, Height: MiniBarHeight}
	}

	w := MiniBarWidth
	if w > area.Width {
		w = area.Width
	}
	if w < 1 {
		w = 1
	}
	h := MiniBarHeight
	if h > area.Height {
		h = area.Height
	}
	if h < 1 {
		h = 1
	}

	maxInset := area.Height - h
	if maxInset < 0 {
		maxInset = 0
	}
	effectiveInset := MiniBarBottomInset
	if effectiveInset > maxInset {
		effectiveInset = maxInset
	}

	x := clampInt(area.X+(area.Width-w)/2, area.X, area.X+area.Width-w)
	y := clampInt(area.Y+area.Height-effectiveInset-h, area.Y, area.Y+area.Height-h)
	return Rect{
		X:      x,
		Y:      y,
		Width:  w,
		Height: h,
	}
}

func rectsOverlap(a, b Rect) bool {
	if a.Width <= 0 || a.Height <= 0 || b.Width <= 0 || b.Height <= 0 {
		return false
	}
	return a.X < b.X+b.Width && a.X+a.Width > b.X &&
		a.Y < b.Y+b.Height && a.Y+a.Height > b.Y
}

// ComputeBottomMargin returns the distance from the display's bottom physical
// edge to the bottom edge of bounds, used for Wayland layer-shell bottom anchoring.
func ComputeBottomMargin(display Display, bounds Rect, bottomInset int) int {
	if bottomInset < 0 {
		bottomInset = 0
	}
	if display.Bounds.Height <= 0 {
		return bottomInset
	}
	monitorBottom := display.Bounds.Y + display.Bounds.Height
	dockBottom := bounds.Y + bounds.Height
	margin := monitorBottom - dockBottom
	if margin < 0 {
		return 0
	}
	return margin
}

func usableArea(d Display) Rect {
	if d.WorkArea.Width > 0 && d.WorkArea.Height > 0 {
		return d.WorkArea
	}
	return d.Bounds
}

func defaultIfNonPositive(v, fallback int) int {
	if v <= 0 {
		return fallback
	}
	return v
}

func clampInt(v, lo, hi int) int {
	if hi < lo {
		return lo
	}
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

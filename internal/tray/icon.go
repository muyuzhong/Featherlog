package tray

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"math"
	"sync"
)

const (
	iconSize = 32
	inkR     = 24
	inkG     = 24
	inkB     = 27
)

var (
	iconOnce  sync.Once
	iconBytes []byte
)

// TemplateIconPNG returns a 32x32 anti-aliased monochrome PNG icon (transparent
// background with dark ink R=24, G=24, B=27, zero colored accents) suitable for
// MyGo TrayOptions{IconIsTemplate: true} across macOS, Windows 11, and Linux.
func TemplateIconPNG() []byte {
	iconOnce.Do(func() {
		iconBytes = renderTemplateIconPNG()
	})
	out := make([]byte, len(iconBytes))
	copy(out, iconBytes)
	return out
}

func renderTemplateIconPNG() []byte {
	img := image.NewNRGBA(image.Rect(0, 0, iconSize, iconSize))

	// 4x4 subpixel supersampling produces crisp anti-aliased silhouettes at 16pt/32px.
	const samples = 4
	const totalSamples = samples * samples

	for py := 0; py < iconSize; py++ {
		for px := 0; px < iconSize; px++ {
			hits := 0
			for sy := 0; sy < samples; sy++ {
				y := float64(py) + (float64(sy)+0.5)/float64(samples)
				for sx := 0; sx < samples; sx++ {
					x := float64(px) + (float64(sx)+0.5)/float64(samples)
					if insideFeatherDrumMark(x, y) {
						hits++
					}
				}
			}
			if hits == 0 {
				continue
			}
			alpha := uint8((hits*255 + totalSamples/2) / totalSamples)
			img.SetNRGBA(px, py, color.NRGBA{
				R: inkR,
				G: inkG,
				B: inkB,
				A: alpha,
			})
		}
	}

	var buf bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestCompression}
	if err := enc.Encode(&buf, img); err != nil {
		// Encoding an in-memory NRGBA image into bytes.Buffer never fails.
		panic(err)
	}
	return buf.Bytes()
}

// insideFeatherDrumMark tests whether (x, y) in 32x32 coordinates lies inside
// the minimalist Featherlog quill-and-drum silhouette.
func insideFeatherDrumMark(x, y float64) bool {
	// 1. Slim horizontal drum bar along the base: capsule from (6.5, 26.5) to (25.5, 26.5).
	if distToSegment(x, y, 6.5, 26.5, 25.5, 26.5) <= 1.45 {
		return true
	}

	// 2. Diagonal quill sweeping from base (8.5, 22.5) to tip (24.5, 5.5).
	const (
		bx, by = 8.5, 22.5
		tx, ty = 24.5, 5.5
	)
	dx, dy := tx-bx, ty-by
	axisLen := math.Hypot(dx, dy)
	ux, uy := dx/axisLen, dy/axisLen
	vx, vy := -uy, ux

	rx, ry := x-bx, y-by
	t := (rx*ux + ry*uy) / axisLen
	s := rx*vx + ry*vy

	if t < -0.04 || t > 1.02 {
		return false
	}

	// Quill nib / stem near the bottom-left.
	if t >= 0.0 && t <= 0.28 {
		if distToSegment(x, y, bx, by, bx+0.28*dx, by+0.28*dy) <= 1.25 {
			return true
		}
	}

	// Asymmetric feather vane silhouette for t in [0.16, 1.0].
	if t >= 0.16 && t <= 1.0 {
		tn := (t - 0.16) / 0.84
		wNeg := 5.7 * math.Sin(math.Pi*math.Pow(tn, 0.72))
		wPos := 4.4 * math.Sin(math.Pi*math.Pow(tn, 0.78))
		if s >= -wNeg && s <= wPos {
			// Single crisp barb notch on the upper vane edge for readability at 16pt.
			if math.Abs(t-0.55) < 0.055 && s < -1.9 {
				return false
			}
			// Engraved central rachis (spine) cutout.
			if t >= 0.26 && t <= 0.78 && math.Abs(s) <= 0.75 {
				return false
			}
			return true
		}
	}

	return false
}

func distToSegment(px, py, ax, ay, bx, by float64) float64 {
	dx, dy := bx-ax, by-ay
	lenSq := dx*dx + dy*dy
	if lenSq == 0 {
		return math.Hypot(px-ax, py-ay)
	}
	proj := ((px-ax)*dx + (py-ay)*dy) / lenSq
	if proj < 0 {
		proj = 0
	} else if proj > 1 {
		proj = 1
	}
	cx, cy := ax+proj*dx, ay+proj*dy
	return math.Hypot(px-cx, py-cy)
}

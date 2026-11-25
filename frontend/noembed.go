//go:build noembed

package frontend

import "io/fs"

// DistFS reports that frontend assets were not embedded into this build.
func DistFS() (fs.FS, bool) {
	return nil, false
}

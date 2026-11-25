//go:build !noembed

package main

import (
	"embed"
	"io/fs"

	"github.com/egoist/mygo"
)

//go:embed all:frontend/dist
var embeddedFrontend embed.FS

func configureFrontend(devMode bool) {
	if devMode {
		ensureDevURL()
		return
	}
	sub, err := fs.Sub(embeddedFrontend, "frontend/dist")
	if err == nil {
		mygo.SetFrontend(sub)
	}
}

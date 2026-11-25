package main

import (
	"os"
	"path/filepath"

	"github.com/egoist/mygo"
	"github.com/muyuzhong/featherlog/frontend"
)

func configureFrontend(devMode bool) {
	if devMode {
		ensureDevURL()
		return
	}
	if distFS, ok := frontend.DistFS(); ok {
		mygo.SetFrontend(distFS)
		return
	}
	if os.Getenv("MYGO_DEV_URL") != "" {
		return
	}
	candidates := []string{filepath.Join("frontend", "dist")}
	if exe, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(exe), "frontend", "dist"))
	}
	for _, dir := range candidates {
		if fi, err := os.Stat(filepath.Join(dir, "index.html")); err == nil && !fi.IsDir() {
			mygo.SetFrontend(os.DirFS(dir))
			return
		}
	}
	ensureDevURL()
}

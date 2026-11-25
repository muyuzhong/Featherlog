//go:build windows

package main

import (
	"os"
	"syscall"
)

const attachParentProcess = ^uintptr(0) // ATTACH_PARENT_PROCESS ((DWORD)-1)

// attachParentConsoleIfCLI best-effort attaches the -H=windowsgui binary to its
// parent terminal console when invoked with CLI arguments so interactive usage
// can still emit output without popping up a console window on double-click.
func attachParentConsoleIfCLI(args []string) {
	if len(args) <= 1 {
		return
	}
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	attachConsole := kernel32.NewProc("AttachConsole")
	r1, _, _ := attachConsole.Call(attachParentProcess)
	if r1 == 0 {
		return
	}
	// Only rebind stdout/stderr when they are not already redirected to a pipe/file.
	if _, err := os.Stdout.Stat(); err != nil {
		if f, openErr := os.OpenFile("CONOUT$", os.O_WRONLY, 0); openErr == nil {
			os.Stdout = f
		}
	}
	if _, err := os.Stderr.Stat(); err != nil {
		if f, openErr := os.OpenFile("CONOUT$", os.O_WRONLY, 0); openErr == nil {
			os.Stderr = f
		}
	}
}

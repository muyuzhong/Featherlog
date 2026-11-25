//go:build !windows

package ipcsock

func isPlatformNotRunningErr(error) bool {
	return false
}

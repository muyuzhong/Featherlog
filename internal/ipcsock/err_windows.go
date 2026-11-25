//go:build windows

package ipcsock

import (
	"errors"
	"syscall"
)

const (
	errFileNotFound syscall.Errno = 2     // ERROR_FILE_NOT_FOUND
	errPathNotFound syscall.Errno = 3     // ERROR_PATH_NOT_FOUND
	wsaENotSock     syscall.Errno = 10038 // WSAENOTSOCK
	wsaEConnRefused syscall.Errno = 10061 // WSAECONNREFUSED
)

func isPlatformNotRunningErr(err error) bool {
	return errors.Is(err, wsaEConnRefused) ||
		errors.Is(err, wsaENotSock) ||
		errors.Is(err, errFileNotFound) ||
		errors.Is(err, errPathNotFound)
}

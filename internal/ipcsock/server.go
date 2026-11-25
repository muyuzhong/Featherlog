package ipcsock

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// Handler processes decoded IPC requests from CLI clients.
type Handler func(ctx context.Context, req Request) (any, error)

// Server owns the single-instance Unix domain socket and dispatches CLI commands.
type Server struct {
	sockPath string
	listener net.Listener
	handler  Handler

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	closeOnce sync.Once
	closeErr  error
}

// Listen binds a single-instance Unix domain socket at sockPath with 0600
// permissions. If an active instance already answers on sockPath, Listen
// returns ErrAlreadyRunning. If a stale socket file exists from a crashed
// process, Listen removes it before binding.
func Listen(sockPath string, handler Handler) (*Server, error) {
	if strings.TrimSpace(sockPath) == "" {
		return nil, errors.New("ipcsock/invalid-path: socket path is empty")
	}
	if handler == nil {
		return nil, errors.New("ipcsock/invalid-handler: handler is nil")
	}

	dir := filepath.Dir(sockPath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("ipcsock/mkdir: %w", err)
	}

	if fi, err := os.Lstat(sockPath); err == nil {
		if !isStaleSocketCandidate(runtime.GOOS, fi) {
			return nil, fmt.Errorf("ipcsock/path-conflict: %q exists and is not a Unix socket", sockPath)
		}
		if probeAlive(sockPath, 300*time.Millisecond) {
			return nil, ErrAlreadyRunning
		}
		if err := os.Remove(sockPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("ipcsock/cleanup-stale: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("ipcsock/stat: %w", err)
	}

	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		// Handle race where another process bound the socket right after Lstat.
		if probeAlive(sockPath, 300*time.Millisecond) {
			return nil, ErrAlreadyRunning
		}
		return nil, fmt.Errorf("ipcsock/listen: %w", err)
	}

	if runtime.GOOS != "windows" {
		if err := os.Chmod(sockPath, 0o600); err != nil {
			_ = ln.Close()
			_ = os.Remove(sockPath)
			return nil, fmt.Errorf("ipcsock/chmod: %w", err)
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	s := &Server{
		sockPath: sockPath,
		listener: ln,
		handler:  handler,
		ctx:      ctx,
		cancel:   cancel,
	}

	s.wg.Add(1)
	go s.acceptLoop()
	return s, nil
}

// Path returns the bound socket path.
func (s *Server) Path() string {
	return s.sockPath
}

// Close stops accepting connections, waits for in-flight requests, and removes
// the socket file.
func (s *Server) Close() error {
	s.closeOnce.Do(func() {
		s.cancel()
		err := s.listener.Close()
		s.wg.Wait()
		if remErr := os.Remove(s.sockPath); remErr != nil && !errors.Is(remErr, os.ErrNotExist) && err == nil {
			err = remErr
		}
		s.closeErr = err
	})
	return s.closeErr
}

func (s *Server) acceptLoop() {
	defer s.wg.Done()
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			select {
			case <-s.ctx.Done():
				return
			default:
			}
			if errors.Is(err, net.ErrClosed) {
				return
			}
			continue
		}
		s.wg.Add(1)
		go func(c net.Conn) {
			defer s.wg.Done()
			s.serveConn(c)
		}(conn)
	}
}

func (s *Server) serveConn(conn net.Conn) {
	defer func() { _ = conn.Close() }()
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))

	reader := bufio.NewReader(io.LimitReader(conn, MaxMessageBytes+1))
	line, err := reader.ReadBytes('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		writeResponse(conn, errorResponse("ipcsock/read-failed", err.Error()))
		return
	}
	if len(line) > MaxMessageBytes {
		writeResponse(conn, errorResponse("ipcsock/message-too-large", "request exceeds 1 MiB limit"))
		return
	}
	trimmed := strings.TrimSpace(string(line))
	if trimmed == "" {
		// Probe connections (like probeAlive) connect and immediately close.
		return
	}

	var req Request
	if err := json.Unmarshal([]byte(trimmed), &req); err != nil {
		writeResponse(conn, errorResponse("ipcsock/invalid-json", err.Error()))
		return
	}
	if req.Command == CmdPing {
		writeResponse(conn, okResponse(map[string]bool{"pong": true}))
		return
	}

	data, err := s.handler(s.ctx, req)
	if err != nil {
		writeResponse(conn, errorFromErr(err))
		return
	}
	writeResponse(conn, okResponse(data))
}

func okResponse(data any) Response {
	if data == nil {
		return Response{OK: true}
	}
	raw, err := json.Marshal(data)
	if err != nil {
		return errorResponse("ipcsock/encode-failed", err.Error())
	}
	return Response{OK: true, Data: raw}
}

func errorResponse(code, msg string) Response {
	return Response{
		OK:    false,
		Error: &ErrorPayload{Code: code, Message: msg},
	}
}

func errorFromErr(err error) Response {
	var coded *CodedError
	if errors.As(err, &coded) {
		return errorResponse(coded.Code, coded.Message)
	}
	msg := err.Error()
	// Extract "<module>/<reason>" prefix if present.
	if idx := strings.Index(msg, ":"); idx > 0 {
		prefix := strings.TrimSpace(msg[:idx])
		if strings.Contains(prefix, "/") && !strings.ContainsAny(prefix, " \t\n") {
			return errorResponse(prefix, strings.TrimSpace(msg[idx+1:]))
		}
	}
	return errorResponse("ipcsock/handler-error", msg)
}

func writeResponse(w io.Writer, resp Response) {
	b, err := json.Marshal(resp)
	if err != nil {
		return
	}
	b = append(b, '\n')
	_, _ = w.Write(b)
}

func isStaleSocketCandidate(goos string, fi os.FileInfo) bool {
	if fi == nil || fi.IsDir() {
		return false
	}
	if fi.Mode()&os.ModeSocket != 0 {
		return true
	}
	if goos == "windows" {
		// Windows AF_UNIX sockets appear as NTFS reparse points (ModeIrregular /
		// ModeSymlink) or zero-byte stubs depending on Go / Windows version.
		return fi.Mode()&(os.ModeIrregular|os.ModeSymlink) != 0 || fi.Size() == 0
	}
	return false
}

func probeAlive(sockPath string, timeout time.Duration) bool {
	conn, err := net.DialTimeout("unix", sockPath, timeout)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

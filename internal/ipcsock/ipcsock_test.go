package ipcsock

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"
)

func TestServerSingleInstancePermissionsAndRPC(t *testing.T) {
	dir := t.TempDir()
	sockPath := SocketPath(dir)

	srv, err := Listen(sockPath, func(_ context.Context, req Request) (any, error) {
		switch req.Command {
		case CmdFocus:
			var p FocusParams
			if err := json.Unmarshal(req.Params, &p); err != nil {
				return nil, err
			}
			return map[string]string{"focused": p.Title, "tag": p.Tag}, nil
		case CmdDone:
			return nil, &CodedError{Code: "workbench/not-found", Message: "slot missing"}
		default:
			return nil, &CodedError{Code: "ipcsock/unknown-command", Message: req.Command}
		}
	})
	if err != nil {
		t.Fatalf("Listen failed: %v", err)
	}
	defer func() { _ = srv.Close() }()

	if runtime.GOOS != "windows" {
		fi, err := os.Stat(sockPath)
		if err != nil {
			t.Fatalf("stat socket: %v", err)
		}
		if perm := fi.Mode().Perm(); perm != 0o600 {
			t.Fatalf("socket perms = %o, want 0600", perm)
		}
	}

	// Second Listen on the same live socket must return ErrAlreadyRunning.
	if _, err := Listen(sockPath, func(context.Context, Request) (any, error) { return nil, nil }); !errors.Is(err, ErrAlreadyRunning) {
		t.Fatalf("second Listen error = %v, want ErrAlreadyRunning", err)
	}

	client := NewClient(sockPath)
	ctx := context.Background()

	if err := client.Ping(ctx); err != nil {
		t.Fatalf("Ping failed: %v", err)
	}

	var got map[string]string
	if err := client.Call(ctx, CmdFocus, FocusParams{Title: "Review PR", Tag: "Featherlog"}, &got); err != nil {
		t.Fatalf("Call focus failed: %v", err)
	}
	if got["focused"] != "Review PR" || got["tag"] != "Featherlog" {
		t.Fatalf("focus response = %v", got)
	}

	// Coded errors propagate intact.
	err = client.Call(ctx, CmdDone, DoneParams{Target: "nope"}, nil)
	var coded *CodedError
	if !errors.As(err, &coded) || coded.Code != "workbench/not-found" {
		t.Fatalf("expected CodedError workbench/not-found, got %v", err)
	}

	// Close cleans up the socket file.
	if err := srv.Close(); err != nil {
		t.Fatalf("Close failed: %v", err)
	}
	if _, err := os.Stat(sockPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected socket removed on Close, stat err = %v", err)
	}
	if err := client.Ping(ctx); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("Ping after Close = %v, want ErrNotRunning", err)
	}
}

func TestServerCleansUpStaleSocket(t *testing.T) {
	dir := t.TempDir()
	sockPath := SocketPath(dir)

	// Create a Unix socket listener and abandon its socket file without removing it.
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatalf("setup listen: %v", err)
	}
	if ul, ok := ln.(*net.UnixListener); ok {
		ul.SetUnlinkOnClose(false)
	}
	_ = ln.Close()

	// Confirm the stale socket file still exists on disk.
	if _, err := os.Lstat(sockPath); err != nil {
		t.Fatalf("expected stale socket file to exist: %v", err)
	}

	// Client probing the stale socket should get ErrNotRunning.
	if err := NewClient(sockPath).Ping(context.Background()); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("Ping stale socket = %v, want ErrNotRunning", err)
	}

	// Listen should clean up the stale socket and succeed.
	srv, err := Listen(sockPath, func(context.Context, Request) (any, error) {
		return map[string]bool{"ok": true}, nil
	})
	if err != nil {
		t.Fatalf("Listen after stale socket failed: %v", err)
	}
	defer func() { _ = srv.Close() }()

	if err := NewClient(sockPath).Ping(context.Background()); err != nil {
		t.Fatalf("Ping recovered socket failed: %v", err)
	}
}

func TestServerRefusesNonSocketFileConflict(t *testing.T) {
	dir := t.TempDir()
	sockPath := filepath.Join(dir, SocketFileName)
	if err := os.WriteFile(sockPath, []byte("keep me"), 0o600); err != nil {
		t.Fatalf("write regular file: %v", err)
	}
	if _, err := Listen(sockPath, func(context.Context, Request) (any, error) { return nil, nil }); err == nil {
		t.Fatalf("expected Listen to refuse overwriting a regular file")
	}
	data, err := os.ReadFile(sockPath)
	if err != nil || string(data) != "keep me" {
		t.Fatalf("regular file was corrupted: data=%q err=%v", string(data), err)
	}
}

func TestServerConcurrentRequests(t *testing.T) {
	dir := t.TempDir()
	sockPath := SocketPath(dir)

	srv, err := Listen(sockPath, func(_ context.Context, req Request) (any, error) {
		var p NoteParams
		if err := json.Unmarshal(req.Params, &p); err != nil {
			return nil, err
		}
		return map[string]string{"echo": p.Text}, nil
	})
	if err != nil {
		t.Fatalf("Listen failed: %v", err)
	}
	defer func() { _ = srv.Close() }()

	client := NewClient(sockPath)
	var wg sync.WaitGroup
	errs := make(chan error, 16)
	for i := range 16 {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			var res map[string]string
			want := "note-" + string(rune('a'+n))
			if err := client.Call(context.Background(), CmdNote, NoteParams{Text: want}, &res); err != nil {
				errs <- err
				return
			}
			if res["echo"] != want {
				errs <- errors.New("mismatch")
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent request failed: %v", err)
	}
}

type fakeFileInfo struct {
	name  string
	size  int64
	mode  os.FileMode
	isDir bool
}

func (f fakeFileInfo) Name() string       { return f.name }
func (f fakeFileInfo) Size() int64        { return f.size }
func (f fakeFileInfo) Mode() os.FileMode  { return f.mode }
func (f fakeFileInfo) ModTime() time.Time { return time.Time{} }
func (f fakeFileInfo) IsDir() bool        { return f.isDir }
func (f fakeFileInfo) Sys() any           { return nil }

func TestIsStaleSocketCandidate(t *testing.T) {
	cases := []struct {
		name string
		goos string
		fi   os.FileInfo
		want bool
	}{
		{"nil_info", "linux", nil, false},
		{"dir_unix", "linux", fakeFileInfo{isDir: true, mode: os.ModeDir}, false},
		{"dir_windows", "windows", fakeFileInfo{isDir: true, mode: os.ModeDir}, false},
		{"socket_unix", "linux", fakeFileInfo{mode: os.ModeSocket}, true},
		{"socket_windows", "windows", fakeFileInfo{mode: os.ModeSocket}, true},
		{"regular_nonempty_unix", "linux", fakeFileInfo{size: 10, mode: 0o600}, false},
		{"regular_nonempty_windows", "windows", fakeFileInfo{size: 10, mode: 0o600}, false},
		{"zero_file_unix_rejected", "linux", fakeFileInfo{size: 0, mode: 0o600}, false},
		{"zero_file_windows_allowed", "windows", fakeFileInfo{size: 0, mode: 0o600}, true},
		{"irregular_windows_allowed", "windows", fakeFileInfo{size: 12, mode: os.ModeIrregular}, true},
		{"symlink_windows_allowed", "windows", fakeFileInfo{size: 12, mode: os.ModeSymlink}, true},
		{"symlink_unix_rejected", "linux", fakeFileInfo{size: 0, mode: os.ModeSymlink}, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isStaleSocketCandidate(tc.goos, tc.fi); got != tc.want {
				t.Fatalf("isStaleSocketCandidate(%q, %+v) = %v, want %v", tc.goos, tc.fi, got, tc.want)
			}
		})
	}
}

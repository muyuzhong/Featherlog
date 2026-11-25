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
	"syscall"
	"time"
)

// Client sends CLI commands to a running Featherlog host over Unix domain socket.
type Client struct {
	SockPath string
	Timeout  time.Duration
}

// NewClient creates an IPC client targeting sockPath.
func NewClient(sockPath string) *Client {
	return &Client{
		SockPath: sockPath,
		Timeout:  5 * time.Second,
	}
}

// Ping checks whether a live Featherlog instance is listening on SockPath.
func (c *Client) Ping(ctx context.Context) error {
	return c.Call(ctx, CmdPing, nil, nil)
}

// Call invokes cmd with optional params and decodes the response payload into out.
// If no live server is listening, Call returns ErrNotRunning.
func (c *Client) Call(ctx context.Context, cmd string, params any, out any) error {
	timeout := c.Timeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	dialer := net.Dialer{Timeout: timeout}
	conn, err := dialer.DialContext(ctx, "unix", c.SockPath)
	if err != nil {
		if isNotRunningErr(err) {
			return ErrNotRunning
		}
		return fmt.Errorf("ipcsock/dial: %w", err)
	}
	defer func() { _ = conn.Close() }()

	deadline := time.Now().Add(timeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = conn.SetDeadline(deadline)

	req := Request{Command: cmd}
	if params != nil {
		raw, err := json.Marshal(params)
		if err != nil {
			return fmt.Errorf("ipcsock/marshal-params: %w", err)
		}
		req.Params = raw
	}
	frame, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("ipcsock/marshal-request: %w", err)
	}
	frame = append(frame, '\n')
	if _, err := conn.Write(frame); err != nil {
		return fmt.Errorf("ipcsock/write: %w", err)
	}

	reader := bufio.NewReader(io.LimitReader(conn, MaxMessageBytes+1))
	line, err := reader.ReadBytes('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return fmt.Errorf("ipcsock/read: %w", err)
	}
	if len(line) == 0 {
		return errors.New("ipcsock/empty-response: server closed connection")
	}

	var resp Response
	if err := json.Unmarshal(line, &resp); err != nil {
		return fmt.Errorf("ipcsock/decode-response: %w", err)
	}
	if !resp.OK {
		if resp.Error != nil {
			return &CodedError{Code: resp.Error.Code, Message: resp.Error.Message}
		}
		return errors.New("ipcsock/unknown-error")
	}
	if out != nil && len(resp.Data) > 0 {
		if err := json.Unmarshal(resp.Data, out); err != nil {
			return fmt.Errorf("ipcsock/decode-data: %w", err)
		}
	}
	return nil
}

func isNotRunningErr(err error) bool {
	if errors.Is(err, os.ErrNotExist) ||
		errors.Is(err, syscall.ENOENT) ||
		errors.Is(err, syscall.ECONNREFUSED) ||
		isPlatformNotRunningErr(err) {
		return true
	}
	return false
}

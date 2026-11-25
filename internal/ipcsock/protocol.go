package ipcsock

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
)

const (
	// SocketFileName is the Unix domain socket filename inside <userData>.
	SocketFileName = "featherlog.sock"

	// MaxMessageBytes caps a single IPC request/response line.
	MaxMessageBytes = 1 << 20
)

const (
	CmdPing   = "ping"
	CmdToggle = "toggle"
	CmdStatus = "status"
	CmdFocus  = "focus"
	CmdRun    = "run"
	CmdReady  = "ready"
	CmdDone   = "done"
	CmdNote   = "note"
)

var (
	// ErrAlreadyRunning indicates another Featherlog GUI instance owns the socket.
	ErrAlreadyRunning = errors.New("ipcsock/already-running")
	// ErrNotRunning indicates no running Featherlog instance is listening on the socket.
	ErrNotRunning = errors.New("ipcsock/not-running")
)

// SocketPath returns the canonical Unix socket path under userDataDir.
func SocketPath(userDataDir string) string {
	return filepath.Join(userDataDir, SocketFileName)
}

// Request is a single newline-delimited JSON RPC frame sent from CLI to host.
type Request struct {
	Command string          `json:"command"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// Response is a single newline-delimited JSON RPC reply sent from host to CLI.
type Response struct {
	OK    bool            `json:"ok"`
	Data  json.RawMessage `json:"data,omitempty"`
	Error *ErrorPayload   `json:"error,omitempty"`
}

// ErrorPayload carries a structured error code and human-readable message.
type ErrorPayload struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// CodedError represents an application error with a stable machine-readable code.
type CodedError struct {
	Code    string
	Message string
}

func (e *CodedError) Error() string {
	if e.Code == "" {
		return e.Message
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// ToggleParams toggles or explicitly sets dock expansion.
type ToggleParams struct {
	Expanded *bool `json:"expanded,omitempty"`
}

// ToggleResult reports the resulting dock expansion state.
type ToggleResult struct {
	Expanded bool `json:"expanded"`
}

// FocusParams starts or switches focus to a concurrent work slot.
type FocusParams struct {
	Title string `json:"title"`
	Tag   string `json:"tag,omitempty"`
	Note  string `json:"note,omitempty"`
}

// RunParams starts or updates a background running work slot.
type RunParams struct {
	Title         string `json:"title"`
	Tag           string `json:"tag,omitempty"`
	Note          string `json:"note,omitempty"`
	RemindSeconds int    `json:"remindSeconds,omitempty"`
}

// ReadyParams marks a matching work slot as ready for review.
type ReadyParams struct {
	Target string `json:"target"`
	Note   string `json:"note,omitempty"`
}

// DoneParams completes a matching work slot.
type DoneParams struct {
	Target             string `json:"target"`
	CompleteLinkedTask bool   `json:"completeLinkedTask,omitempty"`
}

// NoteParams creates a quick note or task note.
type NoteParams struct {
	Text   string  `json:"text"`
	TaskID *string `json:"taskId,omitempty"`
}

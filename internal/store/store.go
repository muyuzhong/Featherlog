package store

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const (
	// ErrCodeCorrupt indicates a stored JSON file is unreadable as valid JSON
	// or violates expected structure. Corrupt files are never overwritten or deleted.
	ErrCodeCorrupt = "store/corrupt"
	// ErrCodeInvalid indicates an invalid store argument such as a bad filename.
	ErrCodeInvalid = "store/invalid"

	// AppDirProd is the directory name under the OS config directory for production runs.
	AppDirProd = "Featherlog"
	// AppDirDev is the directory name under the OS config directory for dev runs.
	AppDirDev = "Featherlog-dev"
)

// Error is a domain error with a stable "<module>/<reason>" code.
type Error struct {
	Code    string
	Message string
	Cause   error
}

// NewError creates a coded Error.
func NewError(code, message string, cause error) *Error {
	return &Error{Code: code, Message: message, Cause: cause}
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	if e.Cause != nil {
		return fmt.Sprintf("%s: %s: %v", e.Code, e.Message, e.Cause)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

// ErrorCode returns the structured error code.
func (e *Error) ErrorCode() string {
	if e == nil {
		return ""
	}
	return e.Code
}

type codedError interface {
	ErrorCode() string
}

// CodeOf extracts the structured error code from err, or "" if none is present.
func CodeOf(err error) string {
	var ce codedError
	if errors.As(err, &ce) {
		return ce.ErrorCode()
	}
	return ""
}

// IsCode reports whether err has the given structured error code.
func IsCode(err error, code string) bool {
	return CodeOf(err) == code
}

// DirName returns the scoped application directory name ("Featherlog" or "Featherlog-dev").
func DirName(dev bool) string {
	if dev {
		return AppDirDev
	}
	return AppDirProd
}

// DataDirIn resolves the scoped Featherlog data directory under configRoot.
func DataDirIn(configRoot string, dev bool) string {
	return filepath.Join(configRoot, DirName(dev))
}

// DataDir resolves the OS-standard user data directory scoped for production or dev mode.
func DataDir(dev bool) (string, error) {
	configRoot, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("resolve user config dir: %w", err)
	}
	return DataDirIn(configRoot, dev), nil
}

// EnsureDir creates dir (and parents) with owner-only permissions (0700).
func EnsureDir(dir string) error {
	return os.MkdirAll(dir, 0o700)
}

// NewID generates a random RFC 4122 version 4 UUID string.
func NewID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(fmt.Sprintf("store.NewID: crypto/rand failed: %v", err))
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	var dst [36]byte
	hex.Encode(dst[0:8], b[0:4])
	dst[8] = '-'
	hex.Encode(dst[9:13], b[4:6])
	dst[13] = '-'
	hex.Encode(dst[14:18], b[6:8])
	dst[18] = '-'
	hex.Encode(dst[19:23], b[8:10])
	dst[23] = '-'
	hex.Encode(dst[24:36], b[10:16])
	return string(dst[:])
}

// Store provides atomic JSON file persistence rooted at a single directory.
type Store struct {
	dir   string
	mu    sync.Mutex
	locks map[string]*sync.Mutex
}

// New creates a Store rooted at dir.
func New(dir string) *Store {
	return &Store{
		dir:   filepath.Clean(dir),
		locks: make(map[string]*sync.Mutex),
	}
}

// Dir returns the store's root directory.
func (s *Store) Dir() string {
	return s.dir
}

// Path resolves a relative file name inside the store directory and rejects
// absolute paths or path traversal outside the store root.
func (s *Store) Path(name string) (string, error) {
	if strings.TrimSpace(name) == "" {
		return "", NewError(ErrCodeInvalid, "file name must not be empty", nil)
	}
	if filepath.IsAbs(name) {
		return "", NewError(ErrCodeInvalid, "file name must be relative", nil)
	}
	cleaned := filepath.Clean(name)
	if cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) {
		return "", NewError(ErrCodeInvalid, "file name escapes store directory", nil)
	}
	full := filepath.Join(s.dir, cleaned)
	rel, err := filepath.Rel(s.dir, full)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", NewError(ErrCodeInvalid, "file name escapes store directory", nil)
	}
	return full, nil
}

func (s *Store) fileLock(key string) *sync.Mutex {
	s.mu.Lock()
	defer s.mu.Unlock()
	lk, ok := s.locks[key]
	if !ok {
		lk = &sync.Mutex{}
		s.locks[key] = lk
	}
	return lk
}

// ReadRaw reads raw bytes of a file in the store. It returns (nil, false, nil)
// if the file does not exist.
func (s *Store) ReadRaw(name string) ([]byte, bool, error) {
	target, err := s.Path(name)
	if err != nil {
		return nil, false, err
	}
	lk := s.fileLock(target)
	lk.Lock()
	defer lk.Unlock()

	data, err := os.ReadFile(target)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, false, nil
		}
		return nil, false, err
	}
	return data, true, nil
}

// ReadJSON reads and decodes a JSON file into dst.
//   - If the file does not exist, it returns (false, nil).
//   - If the file contains invalid, empty, or top-level null JSON, it leaves the
//     file untouched on disk and returns (false, *Error{Code: ErrCodeCorrupt}).
//   - Other I/O errors are returned as-is.
func (s *Store) ReadJSON(name string, dst any) (bool, error) {
	data, found, err := s.ReadRaw(name)
	if err != nil || !found {
		return false, err
	}
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return false, NewError(ErrCodeCorrupt, fmt.Sprintf("corrupt JSON in %s", name), nil)
	}
	if err := json.Unmarshal(trimmed, dst); err != nil {
		return false, NewError(ErrCodeCorrupt, fmt.Sprintf("corrupt JSON in %s", name), err)
	}
	return true, nil
}

// WriteJSON atomically persists v as formatted JSON using the write-tmp -> fsync -> rename protocol.
func (s *Store) WriteJSON(name string, v any) error {
	target, err := s.Path(name)
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return NewError(ErrCodeInvalid, fmt.Sprintf("marshal JSON for %s", name), err)
	}
	data = append(data, '\n')

	lk := s.fileLock(target)
	lk.Lock()
	defer lk.Unlock()

	return writeFileAtomic(target, data)
}

// Delete removes a file if it exists. Missing files are ignored.
func (s *Store) Delete(name string) error {
	target, err := s.Path(name)
	if err != nil {
		return err
	}
	lk := s.fileLock(target)
	lk.Lock()
	defer lk.Unlock()

	err = os.Remove(target)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// BackupCorrupt renames name to "<name>.corrupt-<nowMs>-<uniqueID>" in the same
// directory so corrupt user files are preserved for recovery.
func (s *Store) BackupCorrupt(name string, nowMs int64, uniqueID string) (string, error) {
	target, err := s.Path(name)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(uniqueID) == "" {
		uniqueID = NewID()
	}
	lk := s.fileLock(target)
	lk.Lock()
	defer lk.Unlock()

	backup := fmt.Sprintf("%s.corrupt-%d-%s", target, nowMs, uniqueID)
	if err := os.Rename(target, backup); err != nil {
		return "", err
	}
	syncDirBestEffort(filepath.Dir(target))
	return backup, nil
}

func writeFileAtomic(target string, data []byte) error {
	dir := filepath.Dir(target)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}

	tmpPath := fmt.Sprintf("%s.%s.tmp", target, NewID())
	f, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}

	renamed := false
	defer func() {
		if !renamed {
			_ = os.Remove(tmpPath)
		}
	}()

	if err := writeAll(f, data); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, target); err != nil {
		return err
	}
	renamed = true
	syncDirBestEffort(dir)
	return nil
}

func writeAll(f *os.File, data []byte) error {
	for len(data) > 0 {
		n, err := f.Write(data)
		if err != nil {
			return err
		}
		data = data[n:]
	}
	return nil
}

func syncDirBestEffort(dir string) {
	d, err := os.Open(dir)
	if err != nil {
		return
	}
	defer func() { _ = d.Close() }()
	// Ignore unsupported filesystem sync errors (e.g., EINVAL on some platforms).
	_ = d.Sync()
}

package settings

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"sync"

	"github.com/muyuzhong/featherlog/internal/clock"
	"github.com/muyuzhong/featherlog/internal/store"
)

const (
	// FileName is the JSON file used to persist user settings.
	FileName = "settings.json"

	// ErrCodeInvalid is returned when settings fail schema validation.
	ErrCodeInvalid = "settings/invalid"

	// MinBarCoord and MaxBarCoord bound persisted custom Mini-Bar coordinates.
	MinBarCoord = -32768
	MaxBarCoord = 32767
)

// ThemeMode selects the monochrome visual theme.
type ThemeMode string

const (
	ThemeStone    ThemeMode = "stone"
	ThemeGraphite ThemeMode = "graphite"
)

// BarMode selects how the ambient Featherlog status bar is presented.
type BarMode string

const (
	BarModeAuto       BarMode = "auto"
	BarModeStandalone BarMode = "standalone"
	BarModeTrayOnly   BarMode = "tray-only"
)

// Settings holds all persisted Featherlog v2 application preferences.
type Settings struct {
	Theme        ThemeMode `json:"theme"`
	DayStartHour int       `json:"dayStartHour"`
	Sound        bool      `json:"sound"`
	Volume       int       `json:"volume"`
	Pinned       bool      `json:"pinned"`
	BarMode      BarMode   `json:"barMode"`
	BarX         *int      `json:"barX,omitempty"`
	BarY         *int      `json:"barY,omitempty"`
}

// Patch represents a partial update to Settings. Nil fields are left unchanged.
// Passing JSON `"barX": null` / `"barY": null` or setting ClearBarX / ClearBarY
// clears the corresponding saved Mini-Bar coordinate.
type Patch struct {
	Theme        *ThemeMode `json:"theme,omitempty"`
	DayStartHour *int       `json:"dayStartHour,omitempty"`
	Sound        *bool      `json:"sound,omitempty"`
	Volume       *int       `json:"volume,omitempty"`
	Pinned       *bool      `json:"pinned,omitempty"`
	BarMode      *BarMode   `json:"barMode,omitempty"`
	BarX         *int       `json:"barX,omitempty"`
	BarY         *int       `json:"barY,omitempty"`
	ClearBarX    bool       `json:"-"`
	ClearBarY    bool       `json:"-"`
}

// UnmarshalJSON distinguishes omitted barX/barY fields from explicit JSON null.
func (p *Patch) UnmarshalJSON(data []byte) error {
	type alias Patch
	var raw alias
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*p = Patch(raw)

	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	if v, ok := fields["barX"]; ok && bytes.Equal(bytes.TrimSpace(v), []byte("null")) {
		p.ClearBarX = true
		p.BarX = nil
	}
	if v, ok := fields["barY"]; ok && bytes.Equal(bytes.TrimSpace(v), []byte("null")) {
		p.ClearBarY = true
		p.BarY = nil
	}
	return nil
}

// Default returns the default Featherlog v2 settings.
func Default() Settings {
	return Settings{
		Theme:        ThemeStone,
		DayStartHour: 4,
		Sound:        true,
		Volume:       5,
		Pinned:       false,
		BarMode:      BarModeAuto,
	}
}

// Equal reports whether two Settings values have identical field values,
// comparing BarX/BarY pointee values rather than pointer addresses.
func Equal(a, b Settings) bool {
	return settingsEqual(a, b)
}

func settingsEqual(a, b Settings) bool {
	return a.Theme == b.Theme &&
		a.DayStartHour == b.DayStartHour &&
		a.Sound == b.Sound &&
		a.Volume == b.Volume &&
		a.Pinned == b.Pinned &&
		a.BarMode == b.BarMode &&
		intPtrEqual(a.BarX, b.BarX) &&
		intPtrEqual(a.BarY, b.BarY)
}

func intPtrEqual(a, b *int) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func cloneSettings(s Settings) Settings {
	if s.BarX != nil {
		v := *s.BarX
		s.BarX = &v
	}
	if s.BarY != nil {
		v := *s.BarY
		s.BarY = &v
	}
	return s
}

// Validate enforces the Settings schema constraints.
func Validate(s Settings) error {
	if s.Theme != ThemeStone && s.Theme != ThemeGraphite {
		return store.NewError(ErrCodeInvalid, fmt.Sprintf("invalid theme %q: must be %q or %q", s.Theme, ThemeStone, ThemeGraphite), nil)
	}
	if s.DayStartHour < 0 || s.DayStartHour > 23 {
		return store.NewError(ErrCodeInvalid, fmt.Sprintf("invalid dayStartHour %d: must be in 0..23", s.DayStartHour), nil)
	}
	if s.Volume < 0 || s.Volume > 10 {
		return store.NewError(ErrCodeInvalid, fmt.Sprintf("invalid volume %d: must be in 0..10", s.Volume), nil)
	}
	if s.BarMode != BarModeAuto && s.BarMode != BarModeStandalone && s.BarMode != BarModeTrayOnly {
		return store.NewError(ErrCodeInvalid, fmt.Sprintf("invalid barMode %q: must be %q, %q, or %q", s.BarMode, BarModeAuto, BarModeStandalone, BarModeTrayOnly), nil)
	}
	if (s.BarX == nil) != (s.BarY == nil) {
		return store.NewError(ErrCodeInvalid, "barX and barY must both be set or both be null", nil)
	}
	if s.BarX != nil {
		if *s.BarX < MinBarCoord || *s.BarX > MaxBarCoord {
			return store.NewError(ErrCodeInvalid, fmt.Sprintf("invalid barX %d: must be in %d..%d", *s.BarX, MinBarCoord, MaxBarCoord), nil)
		}
		if *s.BarY < MinBarCoord || *s.BarY > MaxBarCoord {
			return store.NewError(ErrCodeInvalid, fmt.Sprintf("invalid barY %d: must be in %d..%d", *s.BarY, MinBarCoord, MaxBarCoord), nil)
		}
	}
	return nil
}

// Option customizes Service creation.
type Option func(*options)

type options struct {
	idGen           func() string
	onCorruptBackup func(backupPath string, cause error)
}

// WithIDGenerator overrides the unique ID generator used for corrupt backup names.
func WithIDGenerator(fn func() string) Option {
	return func(o *options) {
		if fn != nil {
			o.idGen = fn
		}
	}
}

// WithCorruptBackupHook registers a callback invoked if Open backs up a corrupt
// settings file and falls back to defaults.
func WithCorruptBackupHook(fn func(backupPath string, cause error)) Option {
	return func(o *options) {
		o.onCorruptBackup = fn
	}
}

type listenerEntry struct {
	id uint64
	fn func(Settings)
}

// Service manages validated, atomically persisted application settings.
type Service struct {
	mu           sync.Mutex
	store        *store.Store
	clk          clock.Clock
	current      Settings
	backupPath   string
	nextListener uint64
	listeners    []listenerEntry
}

// Open loads settings from st. If settings.json does not exist, defaults are used.
// If settings.json contains corrupt JSON or invalid schema values, it is renamed to
// settings.json.corrupt-<ms>-<id> and defaults are returned. Non-corrupt I/O errors
// (or backup failure) are returned immediately without overwriting the file.
func Open(st *store.Store, clk clock.Clock, opts ...Option) (*Service, error) {
	if st == nil {
		return nil, store.NewError(ErrCodeInvalid, "store is required", nil)
	}
	if clk == nil {
		clk = clock.NewReal()
	}
	cfg := options{idGen: store.NewID}
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}

	svc := &Service{
		store:   st,
		clk:     clk,
		current: Default(),
	}

	raw, found, err := st.ReadRaw(FileName)
	if err != nil {
		return nil, err
	}
	if !found {
		return svc, nil
	}

	parsed, parseErr := parseSettingsJSON(raw)
	if parseErr == nil {
		svc.current = parsed
		return svc, nil
	}

	if !store.IsCode(parseErr, store.ErrCodeCorrupt) && !store.IsCode(parseErr, ErrCodeInvalid) {
		return nil, parseErr
	}

	// Preserve the original corrupt file before continuing with defaults.
	backup, backupErr := st.BackupCorrupt(FileName, clk.Now().UnixMilli(), cfg.idGen())
	if backupErr != nil {
		return nil, fmt.Errorf("backup corrupt settings: %w", backupErr)
	}
	svc.backupPath = backup
	svc.current = Default()
	if cfg.onCorruptBackup != nil {
		cfg.onCorruptBackup(backup, parseErr)
	}
	return svc, nil
}

// BackupPath returns the backup path created during Open if the stored file was
// corrupt, or "" if settings loaded cleanly.
func (s *Service) BackupPath() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.backupPath
}

// Get returns the current Settings snapshot.
func (s *Service) Get() Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return cloneSettings(s.current)
}

// Update validates and applies patch, atomically persists settings.json if any
// field changed, and notifies registered OnChange listeners.
func (s *Service) Update(patch Patch) (Settings, error) {
	s.mu.Lock()
	next := cloneSettings(s.current)
	if patch.Theme != nil {
		next.Theme = *patch.Theme
	}
	if patch.DayStartHour != nil {
		next.DayStartHour = *patch.DayStartHour
	}
	if patch.Sound != nil {
		next.Sound = *patch.Sound
	}
	if patch.Volume != nil {
		next.Volume = *patch.Volume
	}
	if patch.Pinned != nil {
		next.Pinned = *patch.Pinned
	}
	if patch.BarMode != nil {
		next.BarMode = *patch.BarMode
	}
	if patch.ClearBarX {
		next.BarX = nil
	} else if patch.BarX != nil {
		v := *patch.BarX
		next.BarX = &v
	}
	if patch.ClearBarY {
		next.BarY = nil
	} else if patch.BarY != nil {
		v := *patch.BarY
		next.BarY = &v
	}

	if err := Validate(next); err != nil {
		s.mu.Unlock()
		return Settings{}, err
	}
	if settingsEqual(next, s.current) {
		cur := cloneSettings(s.current)
		s.mu.Unlock()
		return cur, nil
	}
	if err := s.store.WriteJSON(FileName, next); err != nil {
		s.mu.Unlock()
		return Settings{}, err
	}
	s.current = cloneSettings(next)
	listeners := s.snapshotListenersLocked()
	s.mu.Unlock()

	for _, fn := range listeners {
		fn(cloneSettings(next))
	}
	return cloneSettings(next), nil
}

// OnChange subscribes to settings updates. The returned function unsubscribes.
func (s *Service) OnChange(fn func(Settings)) func() {
	if fn == nil {
		return func() {}
	}
	s.mu.Lock()
	s.nextListener++
	id := s.nextListener
	s.listeners = append(s.listeners, listenerEntry{id: id, fn: fn})
	s.mu.Unlock()

	return func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		for i, entry := range s.listeners {
			if entry.id == id {
				s.listeners = append(s.listeners[:i], s.listeners[i+1:]...)
				return
			}
		}
	}
}

func (s *Service) snapshotListenersLocked() []func(Settings) {
	if len(s.listeners) == 0 {
		return nil
	}
	out := make([]func(Settings), len(s.listeners))
	for i, l := range s.listeners {
		out[i] = l.fn
	}
	return out
}

func parseSettingsJSON(raw []byte) (Settings, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return Settings{}, store.NewError(store.ErrCodeCorrupt, "settings.json must be a JSON object", nil)
	}

	var fields map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &fields); err != nil || fields == nil {
		return Settings{}, store.NewError(store.ErrCodeCorrupt, "settings.json contains invalid JSON", err)
	}

	s := Default()
	if v, ok := fields["theme"]; ok {
		str, err := decodeStrictString(v)
		if err != nil {
			return Settings{}, store.NewError(ErrCodeInvalid, "theme must be a string", err)
		}
		s.Theme = ThemeMode(str)
	}
	if v, ok := fields["dayStartHour"]; ok {
		n, err := decodeStrictInt(v)
		if err != nil {
			return Settings{}, store.NewError(ErrCodeInvalid, "dayStartHour must be an integer", err)
		}
		s.DayStartHour = n
	}
	if v, ok := fields["sound"]; ok {
		b, err := decodeStrictBool(v)
		if err != nil {
			return Settings{}, store.NewError(ErrCodeInvalid, "sound must be a boolean", err)
		}
		s.Sound = b
	}
	if v, ok := fields["volume"]; ok {
		n, err := decodeStrictInt(v)
		if err != nil {
			return Settings{}, store.NewError(ErrCodeInvalid, "volume must be an integer", err)
		}
		s.Volume = n
	}
	if v, ok := fields["pinned"]; ok {
		b, err := decodeStrictBool(v)
		if err != nil {
			return Settings{}, store.NewError(ErrCodeInvalid, "pinned must be a boolean", err)
		}
		s.Pinned = b
	}
	if v, ok := fields["barMode"]; ok {
		str, err := decodeStrictString(v)
		if err != nil {
			return Settings{}, store.NewError(ErrCodeInvalid, "barMode must be a string", err)
		}
		s.BarMode = BarMode(str)
	}
	if v, ok := fields["barX"]; ok {
		if bytes.Equal(bytes.TrimSpace(v), []byte("null")) {
			s.BarX = nil
		} else {
			n, err := decodeStrictInt(v)
			if err != nil {
				return Settings{}, store.NewError(ErrCodeInvalid, "barX must be an integer or null", err)
			}
			s.BarX = &n
		}
	}
	if v, ok := fields["barY"]; ok {
		if bytes.Equal(bytes.TrimSpace(v), []byte("null")) {
			s.BarY = nil
		} else {
			n, err := decodeStrictInt(v)
			if err != nil {
				return Settings{}, store.NewError(ErrCodeInvalid, "barY must be an integer or null", err)
			}
			s.BarY = &n
		}
	}

	if err := Validate(s); err != nil {
		return Settings{}, err
	}
	return s, nil
}

func decodeStrictString(raw json.RawMessage) (string, error) {
	t := bytes.TrimSpace(raw)
	if len(t) == 0 || t[0] != '"' {
		return "", fmt.Errorf("expected string")
	}
	var out string
	if err := json.Unmarshal(t, &out); err != nil {
		return "", err
	}
	return out, nil
}

func decodeStrictBool(raw json.RawMessage) (bool, error) {
	t := bytes.TrimSpace(raw)
	if !bytes.Equal(t, []byte("true")) && !bytes.Equal(t, []byte("false")) {
		return false, fmt.Errorf("expected boolean")
	}
	var out bool
	if err := json.Unmarshal(t, &out); err != nil {
		return false, err
	}
	return out, nil
}

func decodeStrictInt(raw json.RawMessage) (int, error) {
	t := bytes.TrimSpace(raw)
	if len(t) == 0 || t[0] == '"' || bytes.Equal(t, []byte("null")) {
		return 0, fmt.Errorf("expected integer")
	}
	// Reject fractional or scientific notation that is not an exact integer.
	if n, err := strconv.Atoi(string(t)); err == nil {
		return n, nil
	}
	var f float64
	if err := json.Unmarshal(t, &f); err != nil {
		return 0, err
	}
	if math.IsNaN(f) || math.IsInf(f, 0) || math.Trunc(f) != f {
		return 0, fmt.Errorf("expected integer, got %s", string(t))
	}
	if f < math.MinInt32 || f > math.MaxInt32 {
		return 0, fmt.Errorf("integer out of range")
	}
	return int(f), nil
}

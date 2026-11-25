package barhttp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/muyuzhong/featherlog/internal/app"
	"github.com/muyuzhong/featherlog/internal/clock"
	"github.com/muyuzhong/featherlog/internal/settings"
	"github.com/muyuzhong/featherlog/internal/store"
	"github.com/muyuzhong/featherlog/internal/tasks"
	"github.com/muyuzhong/featherlog/internal/workbench"
)

const (
	// DefaultProdPort is the loopback HTTP port used for the production dataDir.
	DefaultProdPort = 39173
	// DefaultDevPort is the loopback HTTP port used for --dev or custom --data-dir.
	DefaultDevPort = 39174
	// URLFileName is written atomically inside dataDir with the active base URL.
	URLFileName = "bar-http.url"
	// MaxWaitSeconds caps long-poll duration on GET /api/bar.
	MaxWaitSeconds = 25
	// ClientActiveWindow is how long an external /api/bar consumer (such as the
	// KDE Plasma 6 applet) is considered active after its most recent request.
	ClientActiveWindow = 35 * time.Second

	maxRequestBodyBytes = 64 << 10
)

// Config configures the local loopback HTTP server for the KDE Plasma 6 applet.
type Config struct {
	App     *app.App
	DataDir string
	Port    int
}

// BarSlot is the JSON representation of a concurrent work slot on GET /api/bar.
type BarSlot struct {
	ID             string                  `json:"id"`
	Title          string                  `json:"title"`
	State          workbench.WorkSlotState `json:"state"`
	Breadcrumb     string                  `json:"breadcrumb"`
	Tag            string                  `json:"tag"`
	StateChangedAt int64                   `json:"stateChangedAt"`
	RemindAt       *int64                  `json:"remindAt"`
	Order          int                     `json:"order"`
}

// BarSnapshot is returned by GET /api/bar and slot mutation endpoints.
type BarSnapshot struct {
	Rev        uint64    `json:"rev"`
	PanelOpen  bool      `json:"panelOpen"`
	Pinned     bool      `json:"pinned"`
	Theme      string    `json:"theme"`
	Language   string    `json:"language"`
	TodayDone  int       `json:"todayDone"`
	TodayTotal int       `json:"todayTotal"`
	Slots      []BarSlot `json:"slots"`
}

// ToggleResponse is returned by POST /api/panel/toggle.
type ToggleResponse struct {
	PanelOpen bool   `json:"panelOpen"`
	Rev       uint64 `json:"rev"`
}

// ErrorDetail carries a machine-readable error code and message.
type ErrorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// ErrorResponse wraps an API error payload.
type ErrorResponse struct {
	Error ErrorDetail `json:"error"`
}

type activityListener struct {
	id uint64
	fn func(active bool)
}

// Server serves the loopback-only HTTP status & control API for the KDE Plasma 6 dock applet.
type Server struct {
	app       *app.App
	ln        net.Listener
	httpSrv   *http.Server
	url       string
	urlFile   string
	port      int
	unsubs    []func()
	cycleMu   sync.Mutex
	serveDone chan struct{}
	closeOnce sync.Once

	mu                   sync.Mutex
	rev                  uint64
	notify               chan struct{}
	waiters              int
	closed               bool
	lastClientAt         time.Time
	clientActive         bool
	clientExpiryGen      uint64
	clientExpiryStop     clock.StopFunc
	nextActivityListener uint64
	activityListeners    []activityListener
}

// Start binds strictly to 127.0.0.1:<cfg.Port>, subscribes to domain & dock
// change notifications, writes <cfg.DataDir>/bar-http.url atomically, and
// begins serving requests.
func Start(cfg Config) (*Server, error) {
	if cfg.App == nil {
		return nil, store.NewError("barhttp/invalid-config", "app is required", nil)
	}
	if cfg.Port < 0 || cfg.Port > 65535 {
		return nil, store.NewError("barhttp/invalid-config", fmt.Sprintf("invalid port %d", cfg.Port), nil)
	}

	addr := fmt.Sprintf("127.0.0.1:%d", cfg.Port)
	ln, err := net.Listen("tcp4", addr)
	if err != nil {
		return nil, fmt.Errorf("barhttp: listen %s: %w", addr, err)
	}

	tcpAddr, ok := ln.Addr().(*net.TCPAddr)
	if !ok {
		_ = ln.Close()
		return nil, errors.New("barhttp: listener did not return a TCP address")
	}
	actualPort := tcpAddr.Port
	baseURL := fmt.Sprintf("http://127.0.0.1:%d", actualPort)

	var urlFile string
	if strings.TrimSpace(cfg.DataDir) != "" {
		urlFile = filepath.Join(cfg.DataDir, URLFileName)
		if err := writeFileAtomic(urlFile, []byte(baseURL), 0o700, 0o600); err != nil {
			_ = ln.Close()
			return nil, fmt.Errorf("barhttp: write %s: %w", urlFile, err)
		}
	}

	s := &Server{
		app:       cfg.App,
		ln:        ln,
		url:       baseURL,
		urlFile:   urlFile,
		port:      actualPort,
		serveDone: make(chan struct{}),
		rev:       1,
		notify:    make(chan struct{}),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/bar", s.handleBar)
	mux.HandleFunc("/api/panel/toggle", s.handlePanelToggle)
	mux.HandleFunc("/api/slot/focus", s.handleSlotFocus)
	mux.HandleFunc("/api/slot/cycle", s.handleSlotCycle)
	mux.HandleFunc("/api/slot/state", s.handleSlotState)
	mux.HandleFunc("/api/slot/done", s.handleSlotDone)

	s.httpSrv = &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	// Subscribe to all state domains that affect GET /api/bar so long-pollers
	// wake immediately on UI edits, CLI hooks, reminder timers, rollovers, and panel toggles.
	s.unsubs = append(s.unsubs,
		cfg.App.Workbench.OnChange(func([]workbench.WorkSlot) { s.NotifyChange() }),
		cfg.App.Tasks.OnChange(func(tasks.ListResult) { s.NotifyChange() }),
		cfg.App.Settings.OnChange(func(settings.Settings) { s.NotifyChange() }),
		cfg.App.Dock.OnExpandedChange(func(bool) { s.NotifyChange() }),
	)

	go func() {
		defer close(s.serveDone)
		_ = s.httpSrv.Serve(ln)
	}()

	return s, nil
}

// URL returns the active loopback base URL (e.g. "http://127.0.0.1:39173").
func (s *Server) URL() string {
	return s.url
}

// Port returns the actual TCP port bound on 127.0.0.1.
func (s *Server) Port() int {
	return s.port
}

// Rev returns the current monotonic revision counter.
func (s *Server) Rev() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.rev
}

// WaiterCount returns the number of currently parked long-poll requests.
func (s *Server) WaiterCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.waiters
}

func (s *Server) clock() clock.Clock {
	if s.app != nil && s.app.Clock != nil {
		return s.app.Clock
	}
	return clock.NewReal()
}

// HasActiveClient reports whether an external /api/bar consumer (such as the
// KDE Plasma 6 applet) is currently connected or polled within ClientActiveWindow.
func (s *Server) HasActiveClient() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return false
	}
	if s.waiters > 0 {
		return true
	}
	if s.lastClientAt.IsZero() {
		return false
	}
	return s.clock().Now().Sub(s.lastClientAt) <= ClientActiveWindow
}

// OnClientActivity subscribes to transitions in external /api/bar client
// presence (true when a client connects, false on timeout or Close).
// The returned function unsubscribes.
func (s *Server) OnClientActivity(fn func(active bool)) func() {
	if fn == nil {
		return func() {}
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return func() {}
	}
	s.nextActivityListener++
	id := s.nextActivityListener
	s.activityListeners = append(s.activityListeners, activityListener{id: id, fn: fn})
	s.mu.Unlock()

	return func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		for i, entry := range s.activityListeners {
			if entry.id == id {
				s.activityListeners = append(s.activityListeners[:i], s.activityListeners[i+1:]...)
				return
			}
		}
	}
}

func (s *Server) snapshotActivityListenersLocked() []func(bool) {
	if len(s.activityListeners) == 0 {
		return nil
	}
	out := make([]func(bool), len(s.activityListeners))
	for i, l := range s.activityListeners {
		out[i] = l.fn
	}
	return out
}

func (s *Server) touchClientActivity() {
	clk := s.clock()
	now := clk.Now()

	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.lastClientAt = now
	becameActive := !s.clientActive
	s.clientActive = true
	s.scheduleClientExpiryLocked(clk, ClientActiveWindow+time.Millisecond)
	var listeners []func(bool)
	if becameActive {
		listeners = s.snapshotActivityListenersLocked()
	}
	s.mu.Unlock()

	for _, fn := range listeners {
		fn(true)
	}
}

func (s *Server) scheduleClientExpiryLocked(clk clock.Clock, delay time.Duration) {
	if s.clientExpiryStop != nil {
		s.clientExpiryStop()
		s.clientExpiryStop = nil
	}
	if s.closed {
		return
	}
	if delay < time.Millisecond {
		delay = time.Millisecond
	}
	s.clientExpiryGen++
	gen := s.clientExpiryGen
	s.clientExpiryStop = clk.AfterFunc(delay, func() {
		s.handleClientExpiry(gen)
	})
}

func (s *Server) handleClientExpiry(gen uint64) {
	clk := s.clock()
	now := clk.Now()

	s.mu.Lock()
	if s.closed || gen != s.clientExpiryGen || !s.clientActive {
		s.mu.Unlock()
		return
	}
	if s.waiters > 0 {
		// Defer expiration while a long-poll request is actively parked; the
		// waiter's exit handler refreshes and reschedules expiry.
		s.clientExpiryStop = nil
		s.mu.Unlock()
		return
	}
	if !s.lastClientAt.IsZero() {
		elapsed := now.Sub(s.lastClientAt)
		if elapsed <= ClientActiveWindow {
			s.scheduleClientExpiryLocked(clk, ClientActiveWindow-elapsed+time.Millisecond)
			s.mu.Unlock()
			return
		}
	}
	s.clientActive = false
	s.clientExpiryStop = nil
	listeners := s.snapshotActivityListenersLocked()
	s.mu.Unlock()

	for _, fn := range listeners {
		fn(false)
	}
}

// NotifyChange increments the monotonic revision counter and wakes all parked
// long-poll clients.
func (s *Server) NotifyChange() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return s.rev
	}
	s.rev++
	close(s.notify)
	s.notify = make(chan struct{})
	return s.rev
}

// Close unsubscribes listeners, wakes parked long-pollers, shuts down the HTTP
// server, and removes <dataDir>/bar-http.url. Safe to call multiple times.
func (s *Server) Close() error {
	var closeErr error
	s.closeOnce.Do(func() {
		for _, fn := range s.unsubs {
			if fn != nil {
				fn()
			}
		}
		s.unsubs = nil

		var activityListeners []func(bool)
		s.mu.Lock()
		if s.clientExpiryStop != nil {
			s.clientExpiryStop()
			s.clientExpiryStop = nil
		}
		s.clientExpiryGen++
		if s.clientActive {
			s.clientActive = false
			activityListeners = s.snapshotActivityListenersLocked()
		}
		s.lastClientAt = time.Time{}
		s.activityListeners = nil
		if !s.closed {
			s.closed = true
			close(s.notify)
		}
		s.mu.Unlock()

		for _, fn := range activityListeners {
			fn(false)
		}

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if err := s.httpSrv.Shutdown(ctx); err != nil && !errors.Is(err, http.ErrServerClosed) {
			closeErr = err
		}
		<-s.serveDone

		if s.urlFile != "" {
			if err := os.Remove(s.urlFile); err != nil && !os.IsNotExist(err) && closeErr == nil {
				closeErr = err
			}
		}
	})
	return closeErr
}

func (s *Server) handleBar(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}

	q := r.URL.Query()
	var clientRev uint64
	if rawRev := strings.TrimSpace(q.Get("rev")); rawRev != "" {
		v, err := strconv.ParseUint(rawRev, 10, 64)
		if err != nil {
			writeError(w, http.StatusBadRequest, "barhttp/invalid-input", "invalid rev query parameter")
			return
		}
		clientRev = v
	}

	waitSec := 0
	if rawWait := strings.TrimSpace(q.Get("wait")); rawWait != "" {
		v, err := strconv.Atoi(rawWait)
		if err != nil {
			writeError(w, http.StatusBadRequest, "barhttp/invalid-input", "invalid wait query parameter")
			return
		}
		if v < 0 {
			v = 0
		}
		if v > MaxWaitSeconds {
			v = MaxWaitSeconds
		}
		waitSec = v
	}

	s.touchClientActivity()

	if clientRev > 0 && waitSec > 0 {
		s.waitForChange(r.Context(), clientRev, waitSec)
		if r.Context().Err() != nil {
			return
		}
	}

	snap, err := s.snapshot()
	if err != nil {
		writeMappedError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snap)
}

func (s *Server) waitForChange(ctx context.Context, clientRev uint64, waitSec int) {
	s.mu.Lock()
	if s.closed || s.rev != clientRev {
		s.mu.Unlock()
		return
	}
	ch := s.notify
	s.waiters++
	s.mu.Unlock()

	defer func() {
		clk := s.clock()
		now := clk.Now()
		var listeners []func(bool)

		s.mu.Lock()
		s.waiters--
		if !s.closed {
			if ctx.Err() == nil {
				s.lastClientAt = now
			}
			if s.waiters == 0 && s.clientActive {
				if s.lastClientAt.IsZero() || now.Sub(s.lastClientAt) > ClientActiveWindow {
					s.clientActive = false
					if s.clientExpiryStop != nil {
						s.clientExpiryStop()
						s.clientExpiryStop = nil
					}
					listeners = s.snapshotActivityListenersLocked()
				} else {
					s.scheduleClientExpiryLocked(clk, ClientActiveWindow-now.Sub(s.lastClientAt)+time.Millisecond)
				}
			}
		}
		s.mu.Unlock()

		for _, fn := range listeners {
			fn(false)
		}
	}()

	// HTTP long-poll timeout uses a real transport timer so advancing FakeClock
	// for domain reminder/rollover tests does not prematurely cut short a wait.
	timer := time.NewTimer(time.Duration(waitSec) * time.Second)
	defer timer.Stop()

	select {
	case <-ch:
	case <-timer.C:
	case <-ctx.Done():
	}
}

func (s *Server) handlePanelToggle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}

	var req struct {
		Open *bool `json:"open"`
	}
	if err := decodeOptionalJSONBody(r.Body, &req); err != nil {
		writeError(w, http.StatusBadRequest, "barhttp/invalid-input", err.Error())
		return
	}

	panelOpen := s.app.Dock.Toggle(req.Open)
	writeJSON(w, http.StatusOK, ToggleResponse{
		PanelOpen: panelOpen,
		Rev:       s.Rev(),
	})
}

func (s *Server) handleSlotFocus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}

	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(r.Body, &req); err != nil {
		writeError(w, http.StatusBadRequest, "barhttp/invalid-input", err.Error())
		return
	}
	if strings.TrimSpace(req.ID) == "" {
		writeError(w, http.StatusBadRequest, "barhttp/invalid-input", "id is required")
		return
	}

	if _, err := s.app.Workbench.SetState(workbench.SetStateInput{
		ID:    req.ID,
		State: workbench.StateFocus,
	}); err != nil {
		writeMappedError(w, err)
		return
	}

	snap, err := s.snapshot()
	if err != nil {
		writeMappedError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snap)
}

func (s *Server) handleSlotCycle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}

	var req struct {
		Delta int `json:"delta"`
	}
	if err := decodeJSONBody(r.Body, &req); err != nil {
		writeError(w, http.StatusBadRequest, "barhttp/invalid-input", err.Error())
		return
	}
	if req.Delta == 0 {
		writeError(w, http.StatusBadRequest, "barhttp/invalid-input", "delta must be non-zero")
		return
	}

	s.cycleMu.Lock()
	err := s.cycleFocusLocked(req.Delta)
	s.cycleMu.Unlock()
	if err != nil {
		writeMappedError(w, err)
		return
	}

	snap, err := s.snapshot()
	if err != nil {
		writeMappedError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snap)
}

func (s *Server) cycleFocusLocked(delta int) error {
	slots, err := s.app.Workbench.List()
	if err != nil {
		return err
	}
	n := len(slots)
	if n == 0 {
		return nil
	}

	focusIdx := -1
	for i := range slots {
		if slots[i].State == workbench.StateFocus {
			focusIdx = i
			break
		}
	}

	var targetIdx int
	if focusIdx < 0 {
		if delta > 0 {
			targetIdx = 0
		} else {
			targetIdx = n - 1
		}
	} else {
		targetIdx = ((focusIdx+delta)%n + n) % n
		if targetIdx == focusIdx {
			return nil
		}
	}

	_, err = s.app.Workbench.SetState(workbench.SetStateInput{
		ID:    slots[targetIdx].ID,
		State: workbench.StateFocus,
	})
	return err
}

func (s *Server) handleSlotState(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}

	var req workbench.SetStateInput
	if err := decodeJSONBody(r.Body, &req); err != nil {
		writeError(w, http.StatusBadRequest, "barhttp/invalid-input", err.Error())
		return
	}
	if strings.TrimSpace(req.ID) == "" {
		writeError(w, http.StatusBadRequest, "barhttp/invalid-input", "id is required")
		return
	}

	if _, err := s.app.Workbench.SetState(req); err != nil {
		writeMappedError(w, err)
		return
	}

	snap, err := s.snapshot()
	if err != nil {
		writeMappedError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snap)
}

func (s *Server) handleSlotDone(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}

	var req app.WorkbenchCompleteInput
	if err := decodeJSONBody(r.Body, &req); err != nil {
		writeError(w, http.StatusBadRequest, "barhttp/invalid-input", err.Error())
		return
	}
	if strings.TrimSpace(req.ID) == "" {
		writeError(w, http.StatusBadRequest, "barhttp/invalid-input", "id is required")
		return
	}

	if _, err := s.app.WorkbenchSvc.Complete(req); err != nil {
		writeMappedError(w, err)
		return
	}

	snap, err := s.snapshot()
	if err != nil {
		writeMappedError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snap)
}

func (s *Server) snapshot() (BarSnapshot, error) {
	slots, err := s.app.Workbench.List()
	if err != nil {
		return BarSnapshot{}, err
	}
	taskList, err := s.app.Tasks.List()
	if err != nil {
		return BarSnapshot{}, err
	}
	st := s.app.Settings.Get()
	panelOpen, _, _, _ := s.app.Dock.State()

	var loc *time.Location
	if s.app.Clock != nil {
		loc = s.app.Clock.Now().Location()
	}
	todayDone, todayTotal := computeTodayCounts(taskList.Tasks, taskList.PeriodKey, st.DayStartHour, loc)

	outSlots := make([]BarSlot, len(slots))
	for i, slot := range slots {
		var remindAt *int64
		if slot.RemindAt != nil {
			v := *slot.RemindAt
			remindAt = &v
		}
		outSlots[i] = BarSlot{
			ID:             slot.ID,
			Title:          slot.Title,
			State:          slot.State,
			Breadcrumb:     slot.Breadcrumb,
			Tag:            slot.Tag,
			StateChangedAt: slot.StateChangedAt,
			RemindAt:       remindAt,
			Order:          slot.Order,
		}
	}

	return BarSnapshot{
		Rev:        s.Rev(),
		PanelOpen:  panelOpen,
		Pinned:     st.Pinned,
		Theme:      string(st.Theme),
		Language:   string(st.Language),
		TodayDone:  todayDone,
		TodayTotal: todayTotal,
		Slots:      outSlots,
	}, nil
}

// computeTodayCounts tallies the unified flat task list for the bottom dock:
// all active tasks (excluding weekly recurring tasks not due in the current
// period) plus tasks completed in the current periodKey.
func computeTodayCounts(list []tasks.Task, periodKey string, dayStartHour int, loc *time.Location) (done, total int) {
	if loc == nil {
		loc = time.Local
	}
	for _, t := range list {
		switch t.Status {
		case tasks.StatusArchived:
			continue
		case tasks.StatusActive:
			if t.Recurrence != nil && t.Recurrence.Freq == tasks.FreqWeekly && !t.DueToday {
				continue
			}
			total++
		case tasks.StatusCompleted:
			completedThisPeriod := t.DueToday
			if !completedThisPeriod && t.CompletedAt != nil && periodKey != "" {
				completedThisPeriod = tasks.PeriodKey(time.UnixMilli(*t.CompletedAt).In(loc), dayStartHour) == periodKey
			}
			if completedThisPeriod {
				total++
				done++
			}
		}
	}
	return done, total
}

func decodeJSONBody(body io.Reader, dst any) error {
	raw, err := io.ReadAll(io.LimitReader(body, maxRequestBodyBytes+1))
	if err != nil {
		return fmt.Errorf("read request body: %w", err)
	}
	if len(raw) > maxRequestBodyBytes {
		return errors.New("request body too large")
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		return errors.New("request body is required")
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		return fmt.Errorf("invalid JSON body: %w", err)
	}
	return nil
}

func decodeOptionalJSONBody(body io.Reader, dst any) error {
	raw, err := io.ReadAll(io.LimitReader(body, maxRequestBodyBytes+1))
	if err != nil {
		return fmt.Errorf("read request body: %w", err)
	}
	if len(raw) > maxRequestBodyBytes {
		return errors.New("request body too large")
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		return fmt.Errorf("invalid JSON body: %w", err)
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeMethodNotAllowed(w http.ResponseWriter, allowed string) {
	w.Header().Set("Allow", allowed)
	writeError(w, http.StatusMethodNotAllowed, "barhttp/method-not-allowed", fmt.Sprintf("only %s is allowed", allowed))
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, ErrorResponse{
		Error: ErrorDetail{
			Code:    code,
			Message: message,
		},
	})
}

func writeMappedError(w http.ResponseWriter, err error) {
	code := "barhttp/internal"
	status := http.StatusInternalServerError
	var se *store.Error
	if errors.As(err, &se) {
		code = se.Code
		switch se.Code {
		case workbench.ErrCodeNotFound, tasks.ErrCodeNotFound:
			status = http.StatusNotFound
		case workbench.ErrCodeInvalidInput, tasks.ErrCodeInvalidInput, settings.ErrCodeInvalid:
			status = http.StatusBadRequest
		case workbench.ErrCodeAmbiguous:
			status = http.StatusConflict
		}
	}
	writeError(w, status, code, err.Error())
}

func writeFileAtomic(path string, data []byte, dirPerm, filePerm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, dirPerm); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpPath)
		}
	}()

	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(filePerm); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return err
	}
	cleanup = false
	return nil
}

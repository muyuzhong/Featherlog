package barhttp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/muyuzhong/featherlog/internal/app"
	"github.com/muyuzhong/featherlog/internal/clock"
	"github.com/muyuzhong/featherlog/internal/dock"
	"github.com/muyuzhong/featherlog/internal/settings"
	"github.com/muyuzhong/featherlog/internal/tasks"
	"github.com/muyuzhong/featherlog/internal/workbench"
)

type testScreen struct{}

func (testScreen) ActiveDisplay(dock.Rect) dock.Display {
	return dock.Display{
		Bounds:   dock.Rect{Width: 1920, Height: 1080},
		WorkArea: dock.Rect{Width: 1920, Height: 1032},
		Primary:  true,
	}
}
func (testScreen) OnDisplaysChanged(func()) func() { return func() {} }

type testLayer struct{}

func (testLayer) Available() bool                      { return false }
func (testLayer) AnchorBottomCenter(uintptr, int) bool { return false }

type testSink struct{}

func (testSink) WorkbenchChanged([]workbench.WorkSlot) {}
func (testSink) TasksChanged(tasks.ListResult)         {}
func (testSink) NotesChanged(app.NotesChangedEvent)    {}
func (testSink) SettingsChanged(settings.Settings)     {}
func (testSink) DockToggle(app.DockToggleEvent)        {}

type testWindow struct {
	mu      sync.Mutex
	bounds  dock.Rect
	shown   int
	hidden  int
	focused int
}

func (w *testWindow) Bounds() dock.Rect {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.bounds
}
func (w *testWindow) SetBounds(r dock.Rect) {
	w.mu.Lock()
	w.bounds = r
	w.mu.Unlock()
}
func (w *testWindow) Show() {
	w.mu.Lock()
	w.shown++
	w.mu.Unlock()
}
func (w *testWindow) ShowInactive() {
	w.mu.Lock()
	w.shown++
	w.mu.Unlock()
}
func (w *testWindow) Hide() {
	w.mu.Lock()
	w.hidden++
	w.mu.Unlock()
}
func (w *testWindow) Focus() {
	w.mu.Lock()
	w.focused++
	w.mu.Unlock()
}
func (w *testWindow) SetBackgroundColor(string) {}
func (w *testWindow) NativeHandle() uintptr     { return 0 }
func (w *testWindow) RunOnMain(fn func())       { fn() }
func (w *testWindow) OnBlur(func()) func()      { return func() {} }
func (w *testWindow) IsDestroyed() bool         { return false }

func startTestServer(t *testing.T) (*Server, *app.App, *clock.FakeClock, *testWindow, string) {
	t.Helper()
	dataDir := t.TempDir()
	clk := clock.NewFake(time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC))
	application, err := app.Open(app.Config{
		DataDir: dataDir,
		Clock:   clk,
		Events:  testSink{},
		DockCfg: dock.Config{
			Screen:      testScreen{},
			Layer:       testLayer{},
			StartHidden: true,
		},
		QuitFunc: func() {},
	})
	if err != nil {
		t.Fatalf("app.Open: %v", err)
	}
	win := &testWindow{}
	application.Dock.Attach(win)

	srv, err := Start(Config{
		App:     application,
		DataDir: dataDir,
		Port:    0,
	})
	if err != nil {
		application.Close()
		t.Fatalf("barhttp.Start: %v", err)
	}

	t.Cleanup(func() {
		_ = srv.Close()
		application.Close()
	})
	return srv, application, clk, win, dataDir
}

func doJSON(t *testing.T, method, url, body string, out any) (int, []byte) {
	t.Helper()
	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, url, rdr)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s failed: %v", method, url, err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			t.Fatalf("decode JSON from %s %s (%d): %v\nraw=%s", method, url, resp.StatusCode, err, string(raw))
		}
	}
	return resp.StatusCode, raw
}

func waitForWaiter(t *testing.T, srv *Server, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if srv.WaiterCount() >= want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %d long-poll waiters (have %d)", want, srv.WaiterCount())
}

func TestLoopbackBindingAndURLFileLifecycle(t *testing.T) {
	srv, _, _, _, dataDir := startTestServer(t)

	if !strings.HasPrefix(srv.URL(), "http://127.0.0.1:") {
		t.Fatalf("URL = %q, must bind strictly to 127.0.0.1", srv.URL())
	}

	urlPath := filepath.Join(dataDir, URLFileName)
	info, err := os.Stat(urlPath)
	if err != nil {
		t.Fatalf("stat bar-http.url: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("bar-http.url perm = %o, want 0600", perm)
	}
	raw, err := os.ReadFile(urlPath)
	if err != nil {
		t.Fatalf("read bar-http.url: %v", err)
	}
	if string(raw) != srv.URL() {
		t.Fatalf("bar-http.url = %q, want %q", string(raw), srv.URL())
	}

	if err := srv.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, err := os.Stat(urlPath); !os.IsNotExist(err) {
		t.Fatalf("expected bar-http.url removed on Close, stat err=%v", err)
	}
}

func TestGetBarSnapshotSchemaAndTodayTally(t *testing.T) {
	srv, application, _, _, _ := startTestServer(t)

	// Empty state returns slots: [] (never null).
	status, raw := doJSON(t, http.MethodGet, srv.URL()+"/api/bar", "", nil)
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200", status)
	}
	if !bytes.Contains(raw, []byte(`"slots":[]`)) {
		t.Fatalf("expected empty slots array in JSON, got %s", string(raw))
	}

	// Create tasks: 1 completed today, 1 daily active, 1 overdue active, 1 normal active with future date.
	// In the unified flat task model, all 4 count toward todayTotal (1/4).
	doneTask, err := application.Tasks.Create(tasks.CreateInput{
		Kind:         tasks.KindSide,
		Title:        "Done today",
		ScheduledFor: "2026-11-25",
	})
	if err != nil {
		t.Fatalf("create doneTask: %v", err)
	}
	if _, err := application.Tasks.Complete(tasks.CompleteInput{ID: doneTask.ID, Completed: true}); err != nil {
		t.Fatalf("complete doneTask: %v", err)
	}
	if _, err := application.Tasks.Create(tasks.CreateInput{
		Kind:       tasks.KindDaily,
		Title:      "Daily habit",
		Recurrence: &tasks.TaskRecurrence{Freq: tasks.FreqDaily},
	}); err != nil {
		t.Fatalf("create daily: %v", err)
	}
	if _, err := application.Tasks.Create(tasks.CreateInput{
		Kind:     tasks.KindMain,
		Title:    "Overdue task",
		Deadline: "2026-11-24",
	}); err != nil {
		t.Fatalf("create overdue: %v", err)
	}
	if _, err := application.Tasks.Create(tasks.CreateInput{
		Kind:         tasks.KindSide,
		Title:        "Future task",
		ScheduledFor: "2026-11-30",
	}); err != nil {
		t.Fatalf("create future: %v", err)
	}

	// Create one focus slot without reminder to check `"remindAt":null` encoding.
	slot, err := application.Workbench.Create(workbench.CreateInput{
		Title:      "KDE Plasmoid API",
		Tag:        "Featherlog",
		Breadcrumb: "verify /api/bar fields",
		State:      workbench.StateFocus,
	})
	if err != nil {
		t.Fatalf("create slot: %v", err)
	}

	var snap BarSnapshot
	status, raw = doJSON(t, http.MethodGet, srv.URL()+"/api/bar", "", &snap)
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200", status)
	}
	if !bytes.Contains(raw, []byte(`"remindAt":null`)) {
		t.Fatalf("expected explicit remindAt:null in JSON, got %s", string(raw))
	}
	if snap.Theme != "stone" || snap.Pinned || snap.PanelOpen {
		t.Fatalf("unexpected header fields: %+v", snap)
	}
	if snap.TodayDone != 1 || snap.TodayTotal != 4 {
		t.Fatalf("today tally = %d/%d, want 1/4", snap.TodayDone, snap.TodayTotal)
	}
	if len(snap.Slots) != 1 || snap.Slots[0].ID != slot.ID || snap.Slots[0].Tag != "Featherlog" || snap.Slots[0].Breadcrumb != "verify /api/bar fields" {
		t.Fatalf("unexpected slots: %+v", snap.Slots)
	}
}

func TestTodayTallyFlatModelBoundaries(t *testing.T) {
	// startTestServer initializes clock at 2026-11-25 10:00 UTC (Wednesday = 3).
	srv, application, clk, _, _ := startTestServer(t)

	// 1. Plain active flat task (no kind, no dates) -> counts toward todayTotal.
	if _, err := application.Tasks.Create(tasks.CreateInput{Title: "Plain flat todo"}); err != nil {
		t.Fatalf("create plain: %v", err)
	}
	// 2. Daily recurring task (completed today) -> counts toward todayDone and todayTotal.
	daily, err := application.Tasks.Create(tasks.CreateInput{
		Title:      "Daily check",
		Recurrence: &tasks.TaskRecurrence{Freq: tasks.FreqDaily},
	})
	if err != nil {
		t.Fatalf("create daily: %v", err)
	}
	if _, err := application.Tasks.Complete(tasks.CompleteInput{ID: daily.ID, Completed: true}); err != nil {
		t.Fatalf("complete daily: %v", err)
	}
	// 3. Weekly recurring task DUE today (Wed = 3) -> counts toward todayTotal.
	if _, err := application.Tasks.Create(tasks.CreateInput{
		Title:      "Wednesday sync",
		Recurrence: &tasks.TaskRecurrence{Freq: tasks.FreqWeekly, Weekdays: []int{3}},
	}); err != nil {
		t.Fatalf("create due weekly: %v", err)
	}
	// 4. Weekly recurring task NOT due today (Mon = 1) -> excluded from todayTotal.
	if _, err := application.Tasks.Create(tasks.CreateInput{
		Title:      "Monday retro",
		Recurrence: &tasks.TaskRecurrence{Freq: tasks.FreqWeekly, Weekdays: []int{1}},
	}); err != nil {
		t.Fatalf("create off-day weekly: %v", err)
	}
	// 5. Normal flat task completed today -> counts toward todayDone and todayTotal.
	doneFlat, err := application.Tasks.Create(tasks.CreateInput{Title: "Shipped today"})
	if err != nil {
		t.Fatalf("create doneFlat: %v", err)
	}
	if _, err := application.Tasks.Complete(tasks.CompleteInput{ID: doneFlat.ID, Completed: true}); err != nil {
		t.Fatalf("complete doneFlat: %v", err)
	}
	// 6. Archived task -> excluded.
	archived, err := application.Tasks.Create(tasks.CreateInput{Title: "Archived item"})
	if err != nil {
		t.Fatalf("create archived: %v", err)
	}
	archStatus := tasks.StatusArchived
	if _, err := application.Tasks.Update(tasks.UpdateInput{ID: archived.ID, Status: &archStatus}); err != nil {
		t.Fatalf("archive task: %v", err)
	}

	// On Wednesday 2026-11-25:
	// Active counted: plain + Wednesday sync (2); Completed today: daily + doneFlat (2) -> 2/4.
	var snap BarSnapshot
	status, _ := doJSON(t, http.MethodGet, srv.URL()+"/api/bar", "", &snap)
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200", status)
	}
	if snap.TodayDone != 2 || snap.TodayTotal != 4 {
		t.Fatalf("Wed tally = %d/%d, want 2/4", snap.TodayDone, snap.TodayTotal)
	}

	// Advance 24h to Thursday 2026-11-26 (weekday = 4):
	// - daily resets to active (counted)
	// - plain stays active (counted)
	// - Wednesday sync is NOT due on Thu (excluded)
	// - Monday retro is NOT due on Thu (excluded)
	// - doneFlat was completed in previous period 2026-11-25 (excluded)
	// - archived remains excluded
	// Expected: 0/2.
	clk.Advance(24 * time.Hour)
	var nextSnap BarSnapshot
	status, _ = doJSON(t, http.MethodGet, srv.URL()+"/api/bar", "", &nextSnap)
	if status != http.StatusOK {
		t.Fatalf("next day status = %d, want 200", status)
	}
	if nextSnap.TodayDone != 0 || nextSnap.TodayTotal != 2 {
		t.Fatalf("Thu tally = %d/%d, want 0/2", nextSnap.TodayDone, nextSnap.TodayTotal)
	}
}

func TestLongPollWakeupOnDomainSettingsAndPanelChanges(t *testing.T) {
	srv, application, clk, _, _ := startTestServer(t)

	// Initial fetch gets rev=1.
	var initial BarSnapshot
	doJSON(t, http.MethodGet, srv.URL()+"/api/bar", "", &initial)
	if initial.Rev == 0 {
		t.Fatalf("expected rev > 0, got 0")
	}

	// Helper starts a long-poll request parked on currentRev, triggers fn, and asserts quick wakeup.
	assertWakes := func(name string, currentRev uint64, trigger func()) BarSnapshot {
		t.Helper()
		type result struct {
			snap BarSnapshot
			err  error
		}
		ch := make(chan result, 1)
		go func() {
			url := fmt.Sprintf("%s/api/bar?rev=%d&wait=10", srv.URL(), currentRev)
			resp, err := http.Get(url)
			if err != nil {
				ch <- result{err: err}
				return
			}
			defer func() { _ = resp.Body.Close() }()
			var s BarSnapshot
			if err := json.NewDecoder(resp.Body).Decode(&s); err != nil {
				ch <- result{err: err}
				return
			}
			ch <- result{snap: s}
		}()

		waitForWaiter(t, srv, 1)
		trigger()

		select {
		case res := <-ch:
			if res.err != nil {
				t.Fatalf("%s: long-poll error: %v", name, res.err)
			}
			if res.snap.Rev <= currentRev {
				t.Fatalf("%s: expected rev > %d, got %d", name, currentRev, res.snap.Rev)
			}
			return res.snap
		case <-time.After(2 * time.Second):
			t.Fatalf("%s: long-poll did not wake up", name)
			return BarSnapshot{}
		}
	}

	// 1. Workbench slot creation with reminder wakes long-poll.
	remind := 5
	snap1 := assertWakes("workbench create", initial.Rev, func() {
		if _, err := application.Workbench.Create(workbench.CreateInput{
			Title:           "CI run",
			State:           workbench.StateRunning,
			RemindInMinutes: &remind,
		}); err != nil {
			t.Errorf("create slot: %v", err)
		}
	})
	if len(snap1.Slots) != 1 || snap1.Slots[0].State != workbench.StateRunning {
		t.Fatalf("unexpected snap1 slots: %+v", snap1.Slots)
	}

	// 2. Reminder timer firing (running -> ready) wakes long-poll.
	snap2 := assertWakes("reminder fire", snap1.Rev, func() {
		clk.Advance(5 * time.Minute)
	})
	if snap2.Slots[0].State != workbench.StateReady {
		t.Fatalf("expected slot ready after reminder, got %s", snap2.Slots[0].State)
	}

	// 3. Settings change wakes long-poll.
	snap3 := assertWakes("settings theme", snap2.Rev, func() {
		theme := settings.ThemeGraphite
		pinned := true
		if _, err := application.Settings.Update(settings.Patch{Theme: &theme, Pinned: &pinned}); err != nil {
			t.Errorf("settings update: %v", err)
		}
	})
	if snap3.Theme != "graphite" || !snap3.Pinned {
		t.Fatalf("expected graphite+pinned, got %+v", snap3)
	}

	// 4. Panel open via Dock.Toggle wakes long-poll.
	snap4 := assertWakes("dock toggle open", snap3.Rev, func() {
		open := true
		application.Dock.Toggle(&open)
	})
	if !snap4.PanelOpen {
		t.Fatalf("expected panelOpen=true")
	}

	// 5. Panel hide via DockService.Resize(expanded=false) wakes long-poll.
	snap5 := assertWakes("dock resize collapse", snap4.Rev, func() {
		_ = application.DockSvc.Resize(dock.Geometry{Width: 880, Height: 520, Expanded: false})
	})
	if snap5.PanelOpen {
		t.Fatalf("expected panelOpen=false after Resize collapse")
	}

	// 6. Stale rev returns immediately without blocking.
	start := time.Now()
	var immediate BarSnapshot
	doJSON(t, http.MethodGet, fmt.Sprintf("%s/api/bar?rev=%d&wait=25", srv.URL(), initial.Rev), "", &immediate)
	if time.Since(start) > time.Second {
		t.Fatalf("stale rev request blocked unexpectedly for %v", time.Since(start))
	}
	if immediate.Rev != snap5.Rev {
		t.Fatalf("immediate rev = %d, want %d", immediate.Rev, snap5.Rev)
	}
}

func TestLongPollUnblocksCleanlyOnShutdown(t *testing.T) {
	srv, _, _, _, _ := startTestServer(t)
	curRev := srv.Rev()

	done := make(chan struct{})
	go func() {
		defer close(done)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("%s/api/bar?rev=%d&wait=25", srv.URL(), curRev), nil)
		resp, err := http.DefaultClient.Do(req)
		if err == nil && resp != nil {
			_ = resp.Body.Close()
		}
	}()

	waitForWaiter(t, srv, 1)
	if err := srv.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatalf("long-poll request did not terminate after server Close")
	}
}

func TestPanelToggleEndpoint(t *testing.T) {
	srv, _, _, win, _ := startTestServer(t)

	// Toggle with empty JSON body opens panel.
	var res ToggleResponse
	status, _ := doJSON(t, http.MethodPost, srv.URL()+"/api/panel/toggle", `{}`, &res)
	if status != http.StatusOK || !res.PanelOpen || res.Rev < 2 {
		t.Fatalf("toggle open = status:%d %+v", status, res)
	}
	win.mu.Lock()
	shown, focused := win.shown, win.focused
	win.mu.Unlock()
	if shown != 1 || focused != 1 {
		t.Fatalf("expected Show+Focus once, got shown=%d focused=%d", shown, focused)
	}

	// Toggle with empty body closes panel.
	var res2 ToggleResponse
	status, _ = doJSON(t, http.MethodPost, srv.URL()+"/api/panel/toggle", "", &res2)
	if status != http.StatusOK || res2.PanelOpen || res2.Rev <= res.Rev {
		t.Fatalf("toggle close = status:%d %+v", status, res2)
	}
	win.mu.Lock()
	hidden := win.hidden
	win.mu.Unlock()
	if hidden != 1 {
		t.Fatalf("expected Hide once, got hidden=%d", hidden)
	}

	// Explicit open=true.
	var res3 ToggleResponse
	status, _ = doJSON(t, http.MethodPost, srv.URL()+"/api/panel/toggle", `{"open":true}`, &res3)
	if status != http.StatusOK || !res3.PanelOpen {
		t.Fatalf("explicit open = status:%d %+v", status, res3)
	}
}

func TestSlotFocusCycleStateAndDoneEndpoints(t *testing.T) {
	srv, application, _, _, _ := startTestServer(t)

	// Cycle on empty workbench is a clean 200 OK no-op.
	var emptySnap BarSnapshot
	status, _ := doJSON(t, http.MethodPost, srv.URL()+"/api/slot/cycle", `{"delta":1}`, &emptySnap)
	if status != http.StatusOK || len(emptySnap.Slots) != 0 {
		t.Fatalf("cycle empty = status:%d %+v", status, emptySnap)
	}

	// Create 3 running slots (none focused initially).
	s1, err := application.Workbench.Create(workbench.CreateInput{Title: "First", State: workbench.StateRunning})
	if err != nil {
		t.Fatalf("create s1: %v", err)
	}
	s2, err := application.Workbench.Create(workbench.CreateInput{Title: "Second", State: workbench.StateRunning})
	if err != nil {
		t.Fatalf("create s2: %v", err)
	}
	s3, err := application.Workbench.Create(workbench.CreateInput{Title: "Third", State: workbench.StateRunning})
	if err != nil {
		t.Fatalf("create s3: %v", err)
	}

	focusedID := func(snap BarSnapshot) string {
		for _, s := range snap.Slots {
			if s.State == workbench.StateFocus {
				return s.ID
			}
		}
		return ""
	}

	// None focused + delta=-1 focuses LAST slot (s3).
	var snap BarSnapshot
	status, _ = doJSON(t, http.MethodPost, srv.URL()+"/api/slot/cycle", `{"delta":-1}`, &snap)
	if status != http.StatusOK || focusedID(snap) != s3.ID {
		t.Fatalf("cycle -1 with none focused: status=%d focused=%s want %s", status, focusedID(snap), s3.ID)
	}

	// Delta=+1 wraps s3 -> s1.
	status, _ = doJSON(t, http.MethodPost, srv.URL()+"/api/slot/cycle", `{"delta":1}`, &snap)
	if status != http.StatusOK || focusedID(snap) != s1.ID {
		t.Fatalf("cycle +1 wrap: status=%d focused=%s want %s", status, focusedID(snap), s1.ID)
	}

	// Delta=+1 advances s1 -> s2.
	status, _ = doJSON(t, http.MethodPost, srv.URL()+"/api/slot/cycle", `{"delta":1}`, &snap)
	if status != http.StatusOK || focusedID(snap) != s2.ID {
		t.Fatalf("cycle +1: status=%d focused=%s want %s", status, focusedID(snap), s2.ID)
	}

	// Reset all to non-focused, then delta=+1 focuses FIRST slot (s1).
	status, _ = doJSON(t, http.MethodPost, srv.URL()+"/api/slot/state", fmt.Sprintf(`{"id":%q,"state":"ready"}`, s2.ID), &snap)
	if status != http.StatusOK || focusedID(snap) != "" {
		t.Fatalf("set s2 ready: status=%d focused=%q", status, focusedID(snap))
	}
	status, _ = doJSON(t, http.MethodPost, srv.URL()+"/api/slot/cycle", `{"delta":1}`, &snap)
	if status != http.StatusOK || focusedID(snap) != s1.ID {
		t.Fatalf("cycle +1 with none focused: status=%d focused=%s want %s", status, focusedID(snap), s1.ID)
	}

	// Explicit /api/slot/focus switches focus to s3 and demotes s1 to running.
	status, _ = doJSON(t, http.MethodPost, srv.URL()+"/api/slot/focus", fmt.Sprintf(`{"id":%q}`, s3.ID), &snap)
	if status != http.StatusOK || focusedID(snap) != s3.ID {
		t.Fatalf("focus s3: status=%d focused=%s want %s", status, focusedID(snap), s3.ID)
	}
	if snap.Slots[0].State != workbench.StateRunning {
		t.Fatalf("expected s1 demoted to running, got %s", snap.Slots[0].State)
	}

	// Concurrent wheel cycle requests remain race-free.
	var wg sync.WaitGroup
	for range 6 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var s BarSnapshot
			code, _ := doJSON(t, http.MethodPost, srv.URL()+"/api/slot/cycle", `{"delta":1}`, &s)
			if code != http.StatusOK {
				t.Errorf("concurrent cycle status = %d", code)
			}
		}()
	}
	wg.Wait()

	// Complete slot via /api/slot/done removes it from snapshot.
	status, _ = doJSON(t, http.MethodPost, srv.URL()+"/api/slot/done", fmt.Sprintf(`{"id":%q}`, s2.ID), &snap)
	if status != http.StatusOK || len(snap.Slots) != 2 {
		t.Fatalf("done s2: status=%d len=%d want 2", status, len(snap.Slots))
	}
}

func TestErrorHandlingAndMethodGuards(t *testing.T) {
	srv, _, _, _, _ := startTestServer(t)

	var errResp ErrorResponse
	if code, _ := doJSON(t, http.MethodPost, srv.URL()+"/api/bar", `{}`, &errResp); code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /api/bar status = %d, want 405", code)
	}
	if code, _ := doJSON(t, http.MethodGet, srv.URL()+"/api/panel/toggle", "", &errResp); code != http.StatusMethodNotAllowed {
		t.Fatalf("GET /api/panel/toggle status = %d, want 405", code)
	}
	if code, _ := doJSON(t, http.MethodGet, srv.URL()+"/api/bar?rev=abc", "", &errResp); code != http.StatusBadRequest {
		t.Fatalf("invalid rev status = %d, want 400", code)
	}
	if code, _ := doJSON(t, http.MethodPost, srv.URL()+"/api/slot/focus", `{"id":"missing"}`, &errResp); code != http.StatusNotFound || errResp.Error.Code != workbench.ErrCodeNotFound {
		t.Fatalf("missing slot focus = %d %+v, want 404 workbench/not-found", code, errResp)
	}
	if code, _ := doJSON(t, http.MethodPost, srv.URL()+"/api/slot/cycle", `{"delta":0}`, &errResp); code != http.StatusBadRequest {
		t.Fatalf("cycle delta=0 status = %d, want 400", code)
	}
	if code, _ := doJSON(t, http.MethodPost, srv.URL()+"/api/slot/state", `{"id":"x","state":"bogus"}`, &errResp); code != http.StatusBadRequest {
		t.Fatalf("invalid state status = %d, want 400", code)
	}
}

func TestExternalClientActivityTrackingAndExpiry(t *testing.T) {
	srv, _, clk, _, _ := startTestServer(t)

	if srv.HasActiveClient() {
		t.Fatalf("expected HasActiveClient=false before any /api/bar request")
	}

	var mu sync.Mutex
	var transitions []bool
	unsub := srv.OnClientActivity(func(active bool) {
		mu.Lock()
		transitions = append(transitions, active)
		mu.Unlock()
	})
	defer unsub()

	snapshotTransitions := func() []bool {
		mu.Lock()
		defer mu.Unlock()
		out := make([]bool, len(transitions))
		copy(out, transitions)
		return out
	}

	// Bad request does not mark an external client active.
	if code, _ := doJSON(t, http.MethodGet, srv.URL()+"/api/bar?rev=bad", "", nil); code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", code)
	}
	if srv.HasActiveClient() || len(snapshotTransitions()) != 0 {
		t.Fatalf("bad request should not activate client: active=%v transitions=%v", srv.HasActiveClient(), snapshotTransitions())
	}

	// First valid GET /api/bar transitions false -> true.
	var snap BarSnapshot
	if code, _ := doJSON(t, http.MethodGet, srv.URL()+"/api/bar", "", &snap); code != http.StatusOK {
		t.Fatalf("status = %d, want 200", code)
	}
	if !srv.HasActiveClient() {
		t.Fatalf("expected HasActiveClient=true right after GET /api/bar")
	}
	if got := snapshotTransitions(); len(got) != 1 || !got[0] {
		t.Fatalf("transitions = %v, want [true]", got)
	}

	// Another poll at +20s extends the window without emitting duplicate true.
	clk.Advance(20 * time.Second)
	doJSON(t, http.MethodGet, srv.URL()+"/api/bar", "", &snap)
	if !srv.HasActiveClient() {
		t.Fatalf("expected HasActiveClient=true after refresh poll")
	}
	if got := snapshotTransitions(); len(got) != 1 {
		t.Fatalf("expected no duplicate true transition, got %v", got)
	}

	// At exact 35s boundary, client is still active.
	clk.Advance(ClientActiveWindow)
	if !srv.HasActiveClient() {
		t.Fatalf("expected HasActiveClient=true at exact 35s boundary")
	}
	if got := snapshotTransitions(); len(got) != 1 {
		t.Fatalf("expected no false transition at exact 35s boundary, got %v", got)
	}

	// Advancing past 35s expires client activity and emits false.
	clk.Advance(10 * time.Millisecond)
	if srv.HasActiveClient() {
		t.Fatalf("expected HasActiveClient=false after >35s idle")
	}
	if got := snapshotTransitions(); len(got) != 2 || got[1] {
		t.Fatalf("transitions = %v, want [true false]", got)
	}

	// Parked long-poll waiter keeps client active even past 35s, and wakes cleanly.
	done := make(chan struct{})
	go func() {
		defer close(done)
		var s BarSnapshot
		doJSON(t, http.MethodGet, fmt.Sprintf("%s/api/bar?rev=%d&wait=10", srv.URL(), snap.Rev), "", &s)
	}()
	waitForWaiter(t, srv, 1)

	if !srv.HasActiveClient() {
		t.Fatalf("expected HasActiveClient=true while long-poll waiter is parked")
	}
	if got := snapshotTransitions(); len(got) != 3 || !got[2] {
		t.Fatalf("transitions = %v, want [true false true]", got)
	}

	clk.Advance(60 * time.Second)
	if !srv.HasActiveClient() {
		t.Fatalf("expected HasActiveClient=true while long-poll waiter remains parked after 60s")
	}
	if got := snapshotTransitions(); len(got) != 3 {
		t.Fatalf("expected no false transition while waiter parked, got %v", got)
	}

	// Wake the waiter; the post-response window stays active until Close.
	srv.NotifyChange()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatalf("long-poll waiter did not finish")
	}
	if !srv.HasActiveClient() {
		t.Fatalf("expected HasActiveClient=true immediately after long-poll wakeup")
	}

	// Closing server while active notifies false.
	if err := srv.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if srv.HasActiveClient() {
		t.Fatalf("expected HasActiveClient=false after Close")
	}
	if got := snapshotTransitions(); len(got) != 4 || got[3] {
		t.Fatalf("transitions = %v, want [true false true false]", got)
	}
}

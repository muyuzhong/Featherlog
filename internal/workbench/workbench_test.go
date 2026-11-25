package workbench

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/muyuzhong/featherlog/internal/clock"
	"github.com/muyuzhong/featherlog/internal/store"
)

func ptr[T any](v T) *T { return &v }

func TestSingleFocusInvariantAndStateTransitions(t *testing.T) {
	dir := t.TempDir()
	st := store.New(dir)
	base := time.Date(2026, 5, 10, 10, 0, 0, 0, time.UTC)
	clk := clock.NewFake(base)

	svc, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer svc.Close()

	// Create first slot (defaults to focus).
	s1, err := svc.Create(CreateInput{
		Title:        "Refactor storage layer",
		Tag:          "Featherlog",
		Breadcrumb:   "Finish atomic rename tests",
		LinkedTaskID: "task-1",
	})
	if err != nil {
		t.Fatalf("Create s1 failed: %v", err)
	}
	if s1.State != StateFocus || s1.Order != 0 || s1.StateChangedAt != base.UnixMilli() {
		t.Fatalf("unexpected s1: %+v", s1)
	}

	// Create second slot as focus -> s1 must automatically demote to running!
	clk.Advance(5 * time.Minute)
	s2, err := svc.Create(CreateInput{
		Title: "Review PR #42",
		Tag:   "seamline",
		State: StateFocus,
	})
	if err != nil {
		t.Fatalf("Create s2 failed: %v", err)
	}
	if s2.State != StateFocus || s2.Order != 1 {
		t.Fatalf("unexpected s2: %+v", s2)
	}

	list, err := svc.List()
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("len = %d, want 2", len(list))
	}
	if list[0].ID != s1.ID || list[0].State != StateRunning || list[0].StateChangedAt != base.Add(5*time.Minute).UnixMilli() {
		t.Fatalf("s1 should have demoted to running at +5m: %+v", list[0])
	}
	if list[1].ID != s2.ID || list[1].State != StateFocus {
		t.Fatalf("s2 should be focus: %+v", list[1])
	}

	// Switch s1 back to focus -> s2 demotes to running!
	clk.Advance(10 * time.Minute)
	after, err := svc.SetState(SetStateInput{ID: s1.ID, State: StateFocus})
	if err != nil {
		t.Fatalf("SetState s1 focus failed: %v", err)
	}
	focusCount := 0
	for _, sl := range after {
		if sl.State == StateFocus {
			focusCount++
			if sl.ID != s1.ID {
				t.Fatalf("wrong focus slot: %+v", sl)
			}
		}
	}
	if focusCount != 1 {
		t.Fatalf("focusCount = %d, want 1", focusCount)
	}
	if after[1].State != StateRunning {
		t.Fatalf("s2 should be running, got %q", after[1].State)
	}

	// Creating a running slot must NOT demote current focus.
	s3, err := svc.Create(CreateInput{Title: "CI pipeline", State: StateRunning})
	if err != nil {
		t.Fatalf("Create s3 failed: %v", err)
	}
	if s3.State != StateRunning {
		t.Fatalf("expected s3 running, got %q", s3.State)
	}
	gotS1, err := svc.Get(s1.ID)
	if err != nil || gotS1.State != StateFocus {
		t.Fatalf("s1 should still be focus: %+v, %v", gotS1, err)
	}
}

func TestReminderTimerFiresAndNotifiesListener(t *testing.T) {
	dir := t.TempDir()
	st := store.New(dir)
	base := time.Date(2026, 5, 10, 10, 0, 0, 0, time.UTC)
	clk := clock.NewFake(base)

	svc, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer svc.Close()

	s1, err := svc.Create(CreateInput{Title: "Agent run A", State: StateRunning, RemindInMinutes: ptr(10)})
	if err != nil {
		t.Fatalf("Create s1 failed: %v", err)
	}
	s2, err := svc.Create(CreateInput{Title: "Agent run B", State: StateRunning, RemindInMinutes: ptr(25)})
	if err != nil {
		t.Fatalf("Create s2 failed: %v", err)
	}
	if s1.RemindAt == nil || *s1.RemindAt != base.Add(10*time.Minute).UnixMilli() {
		t.Fatalf("unexpected s1 RemindAt: %v", s1.RemindAt)
	}

	var mu sync.Mutex
	var notifications [][]WorkSlot
	svc.OnChange(func(slots []WorkSlot) {
		mu.Lock()
		notifications = append(notifications, slots)
		mu.Unlock()
	})

	// Advance 9 minutes -> nothing fires yet.
	clk.Advance(9 * time.Minute)
	mu.Lock()
	if len(notifications) != 0 {
		t.Fatalf("reminder fired too early: %d notifications", len(notifications))
	}
	mu.Unlock()

	// Advance 1 more minute -> s1 becomes ready, s2 still running.
	clk.Advance(1 * time.Minute)
	mu.Lock()
	if len(notifications) != 1 {
		t.Fatalf("expected 1 reminder notification, got %d", len(notifications))
	}
	snap1 := notifications[0]
	mu.Unlock()

	if snap1[0].ID != s1.ID || snap1[0].State != StateReady || snap1[0].RemindAt != nil {
		t.Fatalf("s1 should be ready with cleared RemindAt: %+v", snap1[0])
	}
	if snap1[0].StateChangedAt != base.Add(10*time.Minute).UnixMilli() {
		t.Fatalf("s1 StateChangedAt = %d, want %d", snap1[0].StateChangedAt, base.Add(10*time.Minute).UnixMilli())
	}
	if snap1[1].ID != s2.ID || snap1[1].State != StateRunning || snap1[1].RemindAt == nil {
		t.Fatalf("s2 should still be running with RemindAt: %+v", snap1[1])
	}

	// Verify transition was persisted to disk!
	reopened, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Reopen failed: %v", err)
	}
	defer reopened.Close()
	got, err := reopened.Get(s1.ID)
	if err != nil || got.State != StateReady || got.RemindAt != nil {
		t.Fatalf("persisted s1 should be ready: %+v, err=%v", got, err)
	}

	// Advance another 15 minutes -> s2 becomes ready too.
	clk.Advance(15 * time.Minute)
	got2, err := svc.Get(s2.ID)
	if err != nil || got2.State != StateReady || got2.RemindAt != nil {
		t.Fatalf("s2 should be ready after 25m: %+v, err=%v", got2, err)
	}
	if clk.PendingCount() != 0 {
		t.Fatalf("expected 0 pending timers after all reminders fired, got %d", clk.PendingCount())
	}
}

func TestReminderSleepRecoveryBeforeEveryOperation(t *testing.T) {
	dir := t.TempDir()
	st := store.New(dir)
	base := time.Date(2026, 5, 10, 10, 0, 0, 0, time.UTC)
	clk := clock.NewFake(base)

	svc, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer svc.Close()

	s1, err := svc.Create(CreateInput{Title: "Build kernel", State: StateRunning, RemindInMinutes: ptr(15)})
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}

	var events int
	svc.OnChange(func([]WorkSlot) { events++ })

	// Simulate laptop sleep: wall clock jumps +2 hours WITHOUT firing timer!
	clk.Set(base.Add(2 * time.Hour))
	if events != 0 {
		t.Fatalf("Set should not have fired timer yet")
	}

	// Calling List must detect overdue reminder, transition running -> ready, persist, and notify.
	slots, err := svc.List()
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	if slots[0].ID != s1.ID || slots[0].State != StateReady || slots[0].RemindAt != nil {
		t.Fatalf("expected sleep-recovered ready slot, got %+v", slots[0])
	}
	if events != 1 {
		t.Fatalf("expected 1 sleep-recovery change notification, got %d", events)
	}

	// Also verify startup recovery when app was closed across reminder deadline.
	s2, err := svc.Create(CreateInput{Title: "Run E2E", State: StateRunning, RemindInMinutes: ptr(20)})
	if err != nil {
		t.Fatalf("Create s2 failed: %v", err)
	}
	svc.Close()

	// Clock jumps past s2 reminder while app is closed.
	clk.Set(base.Add(3 * time.Hour))
	reopened, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Reopen after offline reminder failed: %v", err)
	}
	defer reopened.Close()

	got2, err := reopened.Get(s2.ID)
	if err != nil || got2.State != StateReady || got2.RemindAt != nil {
		t.Fatalf("expected startup-recovered ready slot, got %+v, err=%v", got2, err)
	}
}

func TestRunningReminderPreservesStateChangedAtAndClearsProperly(t *testing.T) {
	st := store.New(t.TempDir())
	base := time.Date(2026, 5, 10, 10, 0, 0, 0, time.UTC)
	clk := clock.NewFake(base)

	svc, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer svc.Close()

	s1, err := svc.Create(CreateInput{Title: "Long compile", State: StateRunning})
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	enteredRunningAt := s1.StateChangedAt

	// Wait 12 minutes, then attach a +10m reminder while staying running.
	clk.Advance(12 * time.Minute)
	slots, err := svc.SetState(SetStateInput{ID: s1.ID, State: StateRunning, RemindInMinutes: ptr(10)})
	if err != nil {
		t.Fatalf("SetState remind failed: %v", err)
	}
	if slots[0].StateChangedAt != enteredRunningAt {
		t.Fatalf("adding reminder while already running must preserve StateChangedAt: got %d want %d", slots[0].StateChangedAt, enteredRunningAt)
	}
	if slots[0].RemindAt == nil {
		t.Fatalf("expected RemindAt to be set")
	}

	// Cancel reminder via JSON null unmarshaling.
	var clearIn SetStateInput
	if err := json.Unmarshal([]byte(`{"id":"`+s1.ID+`","state":"running","remindInMinutes":null}`), &clearIn); err != nil {
		t.Fatalf("Unmarshal SetStateInput failed: %v", err)
	}
	slots, err = svc.SetState(clearIn)
	if err != nil {
		t.Fatalf("SetState clear remind failed: %v", err)
	}
	if slots[0].RemindAt != nil {
		t.Fatalf("expected RemindAt cleared, got %v", slots[0].RemindAt)
	}
	if clk.PendingCount() != 0 {
		t.Fatalf("expected timer cancelled after clearing reminder, got %d", clk.PendingCount())
	}

	// Setting RemindInMinutes on focus/ready must fail validation.
	if _, err := svc.SetState(SetStateInput{ID: s1.ID, State: StateFocus, RemindInMinutes: ptr(5)}); !store.IsCode(err, ErrCodeInvalidInput) {
		t.Fatalf("expected invalid-input for reminder on focus, got %v", err)
	}
	if _, err := svc.SetState(SetStateInput{ID: s1.ID, State: StateRunning, RemindInMinutes: ptr(0)}); !store.IsCode(err, ErrCodeInvalidInput) {
		t.Fatalf("expected invalid-input for 0 minute reminder, got %v", err)
	}
}

func TestUpdateCompleteReorderAndFind(t *testing.T) {
	st := store.New(t.TempDir())
	base := time.Date(2026, 5, 10, 10, 0, 0, 0, time.UTC)
	clk := clock.NewFake(base)

	svc, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer svc.Close()

	s1, _ := svc.Create(CreateInput{Title: "Alpha task", LinkedTaskID: "t-1"})
	s2, _ := svc.Create(CreateInput{Title: "Beta build", State: StateRunning, RemindInMinutes: ptr(30)})
	s3, _ := svc.Create(CreateInput{Title: "Gamma docs", State: StateReady})

	// Update breadcrumb + clear linkedTaskId via JSON null.
	var upd UpdateInput
	if err := json.Unmarshal([]byte(`{"id":"`+s1.ID+`","breadcrumb":"Next: run bench","tag":"core","linkedTaskId":null}`), &upd); err != nil {
		t.Fatalf("Unmarshal UpdateInput failed: %v", err)
	}
	updated, err := svc.Update(upd)
	if err != nil {
		t.Fatalf("Update failed: %v", err)
	}
	if updated.Breadcrumb != "Next: run bench" || updated.Tag != "core" || updated.LinkedTaskID != "" {
		t.Fatalf("unexpected updated slot: %+v", updated)
	}

	// Reorder [s3, s1, s2].
	reordered, err := svc.Reorder([]string{s3.ID, s1.ID, s2.ID})
	if err != nil {
		t.Fatalf("Reorder failed: %v", err)
	}
	if reordered[0].ID != s3.ID || reordered[0].Order != 0 || reordered[1].ID != s1.ID || reordered[2].ID != s2.ID {
		t.Fatalf("unexpected reorder result: %+v", reordered)
	}
	// Bad reorder (missing / duplicate / unknown).
	if _, err := svc.Reorder([]string{s1.ID}); !store.IsCode(err, ErrCodeInvalidInput) {
		t.Fatalf("expected invalid-input on wrong length reorder, got %v", err)
	}
	if _, err := svc.Reorder([]string{s1.ID, s1.ID, s2.ID}); !store.IsCode(err, ErrCodeInvalidInput) {
		t.Fatalf("expected invalid-input on duplicate reorder, got %v", err)
	}
	if _, err := svc.Reorder([]string{s1.ID, s2.ID, "missing"}); !store.IsCode(err, ErrCodeNotFound) {
		t.Fatalf("expected not-found on unknown id reorder, got %v", err)
	}

	// Find by exact ID and case-insensitive substring.
	found, err := svc.Find("BETA")
	if err != nil || found.ID != s2.ID {
		t.Fatalf("Find(BETA) = %+v, %v", found, err)
	}
	if _, err := svc.Find("a"); !store.IsCode(err, ErrCodeAmbiguous) {
		t.Fatalf("expected ambiguous for 'a', got %v", err)
	}

	// Complete s2 (which holds the reminder timer) -> cancels timer and re-indexes remaining slots!
	removed, remaining, err := svc.Complete(s2.ID)
	if err != nil {
		t.Fatalf("Complete failed: %v", err)
	}
	if removed.ID != s2.ID {
		t.Fatalf("removed = %+v, want s2", removed)
	}
	if len(remaining) != 2 || remaining[0].ID != s3.ID || remaining[0].Order != 0 || remaining[1].ID != s1.ID || remaining[1].Order != 1 {
		t.Fatalf("unexpected remaining slots: %+v", remaining)
	}
	if clk.PendingCount() != 0 {
		t.Fatalf("completing running slot with reminder should cancel timer, got %d", clk.PendingCount())
	}
}

func TestCorruptWorkbenchFilePreserved(t *testing.T) {
	dir := t.TempDir()
	st := store.New(dir)
	clk := clock.NewFake(time.Date(2026, 5, 10, 10, 0, 0, 0, time.UTC))

	cases := []struct {
		name string
		raw  string
	}{
		{"bad_json", "{not json"},
		{"bad_schema", `{"schemaVersion":99,"slots":[]}`},
		{"two_focus_slots", `{"schemaVersion":1,"slots":[{"id":"1","title":"A","state":"focus"},{"id":"2","title":"B","state":"focus"}]}`},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sub := t.TempDir()
			file := filepath.Join(sub, FileName)
			if err := os.WriteFile(file, []byte(tc.raw), 0o600); err != nil {
				t.Fatalf("write fixture: %v", err)
			}
			if _, err := Open(store.New(sub), clk); !store.IsCode(err, store.ErrCodeCorrupt) {
				t.Fatalf("expected store/corrupt, got %v", err)
			}
			// Corrupt file must stay untouched on disk.
			after, err := os.ReadFile(file)
			if err != nil || string(after) != tc.raw {
				t.Fatalf("corrupt file was modified or removed: %q, %v", string(after), err)
			}
		})
	}
	_ = st
}

func TestSimultaneousRemindersAndCancelOnFocus(t *testing.T) {
	st := store.New(t.TempDir())
	base := time.Date(2026, 5, 10, 10, 0, 0, 0, time.UTC)
	clk := clock.NewFake(base)

	svc, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer svc.Close()

	s1, _ := svc.Create(CreateInput{Title: "Job 1", State: StateRunning, RemindInMinutes: ptr(10)})
	s2, _ := svc.Create(CreateInput{Title: "Job 2", State: StateRunning, RemindInMinutes: ptr(10)})
	s3, _ := svc.Create(CreateInput{Title: "Job 3", State: StateRunning, RemindInMinutes: ptr(10)})

	// Promote s3 to focus before timer fires -> its reminder must be cancelled.
	if _, err := svc.SetState(SetStateInput{ID: s3.ID, State: StateFocus}); err != nil {
		t.Fatalf("SetState s3 focus failed: %v", err)
	}

	var count int
	svc.OnChange(func([]WorkSlot) { count++ })

	clk.Advance(10 * time.Minute)

	if count != 1 {
		t.Fatalf("simultaneous reminders should trigger one batched notification, got %d", count)
	}
	g1, _ := svc.Get(s1.ID)
	g2, _ := svc.Get(s2.ID)
	g3, _ := svc.Get(s3.ID)
	if g1.State != StateReady || g2.State != StateReady {
		t.Fatalf("s1 and s2 should both be ready: %+v %+v", g1, g2)
	}
	if g3.State != StateFocus || g3.RemindAt != nil {
		t.Fatalf("s3 must remain focus without reminder: %+v", g3)
	}
}

func TestWorkbenchConcurrentRace(t *testing.T) {
	st := store.New(t.TempDir())
	clk := clock.NewFake(time.Date(2026, 5, 10, 10, 0, 0, 0, time.UTC))
	svc, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer svc.Close()

	s1, _ := svc.Create(CreateInput{Title: "Initial"})

	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			sl, err := svc.Create(CreateInput{Title: "Worker slot", State: StateFocus})
			if err == nil {
				_, _ = svc.SetState(SetStateInput{ID: sl.ID, State: StateRunning, RemindInMinutes: ptr(5)})
			}
			_, _ = svc.SetState(SetStateInput{ID: s1.ID, State: StateFocus})
			_, _ = svc.List()
		}(i)
	}
	wg.Wait()

	// Single-focus invariant must still hold after concurrent mutations.
	slots, err := svc.List()
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	focusCount := 0
	for _, sl := range slots {
		if sl.State == StateFocus {
			focusCount++
		}
	}
	if focusCount > 1 {
		t.Fatalf("single-focus invariant violated: %d focus slots", focusCount)
	}
}

func TestReminderTimerPersistErrorBacksOffWithoutSpinning(t *testing.T) {
	dir := t.TempDir()
	st := store.New(dir)
	base := time.Date(2026, 5, 10, 10, 0, 0, 0, time.UTC)
	clk := clock.NewFake(base)

	svc, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer svc.Close()

	s1, err := svc.Create(CreateInput{
		Title:           "Wait on CI",
		State:           StateRunning,
		RemindInMinutes: ptr(10),
	})
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}

	var notifications int
	svc.OnChange(func([]WorkSlot) { notifications++ })

	// Replace workbench.json with a directory so atomic rename fails deterministically
	// (works even when running tests as root).
	target := filepath.Join(dir, FileName)
	if err := os.Remove(target); err != nil {
		t.Fatalf("remove workbench.json: %v", err)
	}
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatalf("mkdir blocker: %v", err)
	}

	// Advancing to the 10m deadline triggers onReminderTimer, which fails to persist
	// and MUST schedule a non-zero backoff retry instead of spinning in a 0ms loop!
	clk.Advance(10 * time.Minute)
	if notifications != 0 {
		t.Fatalf("failed persist must not notify listeners, got %d", notifications)
	}
	if clk.PendingCount() != 1 {
		t.Fatalf("expected 1 backoff retry timer scheduled, got %d", clk.PendingCount())
	}

	// Remove the blocker directory and advance by the backoff duration -> retry succeeds!
	if err := os.Remove(target); err != nil {
		t.Fatalf("remove blocker dir: %v", err)
	}
	clk.Advance(errorRetryBackoff)

	if notifications != 1 {
		t.Fatalf("expected retry to transition & notify once, got %d", notifications)
	}
	got, err := svc.Get(s1.ID)
	if err != nil {
		t.Fatalf("Get after retry failed: %v", err)
	}
	if got.State != StateReady || got.RemindAt != nil {
		t.Fatalf("slot should be ready after retry succeeded: %+v", got)
	}
	if clk.PendingCount() != 0 {
		t.Fatalf("expected 0 pending timers after retry succeeded, got %d", clk.PendingCount())
	}
}

package tasks

import (
	"encoding/json"
	jsonv2 "encoding/json/v2"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/muyuzhong/featherlog/internal/clock"
	"github.com/muyuzhong/featherlog/internal/store"
)

func ptr[T any](v T) *T { return &v }

func TestFreeOrderItemsAndQuotaStepper(t *testing.T) {
	st := store.New(t.TempDir())
	base := time.Date(2026, 5, 10, 10, 0, 0, 0, time.UTC)
	clk := clock.NewFake(base)

	svc, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer svc.Close()

	// Create main task with 3 items (item 2 has quota 3).
	task, err := svc.Create(CreateInput{
		Kind:  KindMain,
		Title: "Ship Featherlog v2",
		Items: []CreateItemInput{
			{Text: "Step A"},
			{Text: "Step B"},
			{Text: "Read chapters", Target: ptr(3)},
		},
	})
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	if task.Status != StatusActive || len(task.Items) != 3 {
		t.Fatalf("unexpected created task: %+v", task)
	}

	// NO sequential lock: toggle item 1 BEFORE item 0!
	t1, err := svc.ToggleItem(ToggleItemInput{TaskID: task.ID, ItemID: task.Items[1].ID})
	if err != nil {
		t.Fatalf("ToggleItem index 1 failed (must not lock!): %v", err)
	}
	if t1.Items[0].Done || !t1.Items[1].Done || t1.Status != StatusActive {
		t.Fatalf("unexpected state after out-of-order toggle: %+v", t1)
	}

	// Step item 2 quota: +1, +1, -1, +1, +1 -> reaches 3/3 and marks item 2 done.
	item2ID := task.Items[2].ID
	t2, err := svc.StepQuota(StepQuotaInput{ID: task.ID, ItemID: item2ID, Delta: 1})
	if err != nil || *t2.Items[2].Current != 1 || t2.Items[2].Done {
		t.Fatalf("after +1: %+v, err=%v", t2.Items[2], err)
	}
	t2, _ = svc.StepQuota(StepQuotaInput{ID: task.ID, ItemID: item2ID, Delta: 1})
	t2, _ = svc.StepQuota(StepQuotaInput{ID: task.ID, ItemID: item2ID, Delta: -1})
	if *t2.Items[2].Current != 1 {
		t.Fatalf("after -1: current = %d, want 1", *t2.Items[2].Current)
	}
	t2, _ = svc.StepQuota(StepQuotaInput{ID: task.ID, ItemID: item2ID, Delta: 1})
	t2, _ = svc.StepQuota(StepQuotaInput{ID: task.ID, ItemID: item2ID, Delta: 1})
	if *t2.Items[2].Current != 3 || !t2.Items[2].Done {
		t.Fatalf("after reaching 3/3: %+v", t2.Items[2])
	}

	// Now toggle item 0 -> all 3 items done -> task auto-completes!
	t3, err := svc.ToggleItem(ToggleItemInput{TaskID: task.ID, ItemID: task.Items[0].ID, Done: ptr(true)})
	if err != nil {
		t.Fatalf("ToggleItem 0 failed: %v", err)
	}
	if t3.Status != StatusCompleted || t3.CompletedAt == nil {
		t.Fatalf("task should auto-complete when all items done: %+v", t3)
	}

	// Step item 2 by -1 -> drops to 2/3, item 2 not done, task reopens!
	t4, err := svc.StepQuota(StepQuotaInput{ID: task.ID, ItemID: item2ID, Delta: -1})
	if err != nil {
		t.Fatalf("StepQuota -1 failed: %v", err)
	}
	if t4.Status != StatusActive || t4.CompletedAt != nil || *t4.Items[2].Current != 2 || t4.Items[2].Done {
		t.Fatalf("expected task reopen on item quota decrement: %+v", t4)
	}

	// Clamping at 0: stepping -10 stops at 0.
	t5, err := svc.StepQuota(StepQuotaInput{ID: task.ID, ItemID: item2ID, Delta: -10})
	if err != nil || *t5.Items[2].Current != 0 {
		t.Fatalf("expected clamp at 0, got %+v, err=%v", t5.Items[2], err)
	}

	// Task-level quota on a side task.
	side, err := svc.Create(CreateInput{Kind: KindSide, Title: "Review 2 PRs", QuotaTarget: ptr(2)})
	if err != nil {
		t.Fatalf("Create side with quota failed: %v", err)
	}
	side, _ = svc.StepQuota(StepQuotaInput{ID: side.ID, Delta: 1})
	if side.Quota.Current != 1 || side.Status != StatusActive {
		t.Fatalf("side after +1: %+v", side)
	}
	side, _ = svc.StepQuota(StepQuotaInput{ID: side.ID, Delta: 1})
	if side.Quota.Current != 2 || side.Status != StatusCompleted {
		t.Fatalf("side should complete at 2/2: %+v", side)
	}
	// Uncomplete preserves progress (target - 1 = 1).
	side, _ = svc.Complete(CompleteInput{ID: side.ID, Completed: false})
	if side.Status != StatusActive || side.Quota.Current != 1 {
		t.Fatalf("uncomplete side should keep target-1 progress: %+v", side)
	}
}

func TestDayStartHourRolloverScheduledAndSleepRecovery(t *testing.T) {
	dir := t.TempDir()
	st := store.New(dir)
	// 2026-05-10 03:30 UTC with default dayStartHour=4 -> still period 2026-05-09!
	start := time.Date(2026, 5, 10, 3, 30, 0, 0, time.UTC)
	clk := clock.NewFake(start)

	svc, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer svc.Close()

	daily, err := svc.Create(CreateInput{
		Kind:        KindDaily,
		Title:       "Read 20 pages",
		QuotaTarget: ptr(2),
		Recurrence:  &TaskRecurrence{Freq: FreqDaily},
	})
	if err != nil {
		t.Fatalf("Create daily failed: %v", err)
	}
	if daily.PeriodKey != "2026-05-09" || !daily.DueToday || *daily.Streak != 0 {
		t.Fatalf("unexpected initial daily at 03:30: %+v", daily)
	}

	// Complete daily in period 2026-05-09 via StepQuota.
	daily, _ = svc.StepQuota(StepQuotaInput{ID: daily.ID, Delta: 1})
	daily, _ = svc.StepQuota(StepQuotaInput{ID: daily.ID, Delta: 1})
	if daily.Status != StatusCompleted || daily.Quota.Current != 2 || *daily.Streak != 1 {
		t.Fatalf("daily should be completed with streak 1: %+v", daily)
	}

	var mu sync.Mutex
	var events []ListResult
	svc.OnChange(func(r ListResult) {
		mu.Lock()
		events = append(events, r)
		mu.Unlock()
	})

	// Advance 29m (03:59) -> NO rollover yet!
	clk.Advance(29 * time.Minute)
	mu.Lock()
	if len(events) != 0 {
		t.Fatalf("rollover fired too early at 03:59")
	}
	mu.Unlock()

	// Advance 1m (04:00) -> scheduled timer fires rollover to 2026-05-10!
	clk.Advance(1 * time.Minute)
	mu.Lock()
	if len(events) != 1 || events[0].PeriodKey != "2026-05-10" {
		t.Fatalf("expected scheduled rollover to 2026-05-10, got %+v", events)
	}
	mu.Unlock()

	got, err := svc.Get(daily.ID)
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if got.PeriodKey != "2026-05-10" || got.Status != StatusActive || got.Quota.Current != 0 || *got.Streak != 1 {
		t.Fatalf("after rollover daily should reset quota and keep streak 1: %+v", got)
	}

	// Complete on 2026-05-10 -> streak becomes 2!
	got, _ = svc.Complete(CompleteInput{ID: daily.ID, Completed: true})
	if *got.Streak != 2 {
		t.Fatalf("streak = %d, want 2", *got.Streak)
	}

	// Simulate laptop sleep across 2026-05-11 04:00 WITHOUT firing timers (clk.Set)!
	clk.Set(time.Date(2026, 5, 11, 9, 0, 0, 0, time.UTC))
	res, err := svc.List()
	if err != nil {
		t.Fatalf("List after sleep failed: %v", err)
	}
	if res.PeriodKey != "2026-05-11" {
		t.Fatalf("periodKey after sleep = %q, want 2026-05-11", res.PeriodKey)
	}
	if res.Tasks[0].PeriodKey != "2026-05-11" || res.Tasks[0].Status != StatusActive || res.Tasks[0].Quota.Current != 0 || *res.Tasks[0].Streak != 2 {
		t.Fatalf("sleep recovery failed to reset daily / preserve streak 2: %+v", res.Tasks[0])
	}

	// Also verify startup rollover when app was closed across a day boundary.
	_, _ = svc.Complete(CompleteInput{ID: daily.ID, Completed: true}) // streak = 3
	svc.Close()

	clk.Set(time.Date(2026, 5, 12, 5, 0, 0, 0, time.UTC))
	reopened, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Reopen failed: %v", err)
	}
	defer reopened.Close()
	got2, err := reopened.Get(daily.ID)
	if err != nil {
		t.Fatalf("Get reopened failed: %v", err)
	}
	if got2.PeriodKey != "2026-05-12" || got2.Status != StatusActive || got2.Quota.Current != 0 || *got2.Streak != 3 {
		t.Fatalf("startup rollover failed: %+v", got2)
	}
}

func TestMonotonicPeriodRollbackProtection(t *testing.T) {
	st := store.New(t.TempDir())
	// 2026-05-10 07:00 UTC with dayStartHour=4 -> period 2026-05-10.
	clk := clock.NewFake(time.Date(2026, 5, 10, 7, 0, 0, 0, time.UTC))

	svc, err := Open(st, clk, WithDayStartHour(4))
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer svc.Close()

	daily, _ := svc.Create(CreateInput{
		Kind:        KindDaily,
		Title:       "Morning stretch",
		QuotaTarget: ptr(3),
	})
	side, _ := svc.Create(CreateInput{
		Kind:     KindSide,
		Title:    "File expense report",
		Deadline: "2026-05-09",
	})

	// Progress daily to 2/3 on period 2026-05-10.
	daily, _ = svc.StepQuota(StepQuotaInput{ID: daily.ID, Delta: 2})
	if daily.Quota.Current != 2 || daily.PeriodKey != "2026-05-10" {
		t.Fatalf("unexpected daily progress: %+v", daily)
	}
	// On period 2026-05-10, side task with deadline 2026-05-09 is overdue!
	gotSide, _ := svc.Get(side.ID)
	if !gotSide.Overdue || !gotSide.DueToday {
		t.Fatalf("side task should be overdue on 2026-05-10: %+v", gotSide)
	}

	// Change dayStartHour from 4 -> 10 at 07:00 -> current period moves BACKWARDS to 2026-05-09!
	if err := svc.SetDayStartHour(10); err != nil {
		t.Fatalf("SetDayStartHour failed: %v", err)
	}

	// Daily progress and periodKey MUST be preserved (monotonic protection)!
	gotDaily, _ := svc.Get(daily.ID)
	if gotDaily.PeriodKey != "2026-05-10" || gotDaily.Quota.Current != 2 {
		t.Fatalf("monotonic rollback protection violated on dayStartHour change: %+v", gotDaily)
	}

	// Non-daily task date math adopts new setting immediately (2026-05-09 deadline is dueToday, NOT overdue!).
	gotSide, _ = svc.Get(side.ID)
	if gotSide.Overdue || !gotSide.DueToday {
		t.Fatalf("side task should use new period 2026-05-09 (dueToday=true, overdue=false): %+v", gotSide)
	}

	// Also simulate NTP/system clock jumping backwards 2 days!
	clk.Set(time.Date(2026, 5, 8, 12, 0, 0, 0, time.UTC))
	gotDaily, _ = svc.Get(daily.ID)
	if gotDaily.PeriodKey != "2026-05-10" || gotDaily.Quota.Current != 2 {
		t.Fatalf("monotonic rollback protection violated on backward clock jump: %+v", gotDaily)
	}

	// Completing daily during rollback still records against lastPeriodKey (2026-05-10).
	gotDaily, _ = svc.StepQuota(StepQuotaInput{ID: daily.ID, Delta: 1})
	if gotDaily.Status != StatusCompleted || *gotDaily.Streak != 1 {
		t.Fatalf("completing daily during rollback failed: %+v", gotDaily)
	}

	// Once clock advances strictly past 2026-05-10 (to 2026-05-11 10:00), normal rollover resumes!
	clk.Set(time.Date(2026, 5, 11, 10, 0, 0, 0, time.UTC))
	gotDaily, _ = svc.Get(daily.ID)
	if gotDaily.PeriodKey != "2026-05-11" || gotDaily.Status != StatusActive || gotDaily.Quota.Current != 0 || *gotDaily.Streak != 1 {
		t.Fatalf("rollover after catching up past lastPeriodKey failed: %+v", gotDaily)
	}
}

func TestWeeklyRecurrenceStreakWithoutPenalty(t *testing.T) {
	st := store.New(t.TempDir())
	// 2026-05-04 is a Monday (weekday 1).
	clk := clock.NewFake(time.Date(2026, 5, 4, 10, 0, 0, 0, time.UTC))

	svc, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer svc.Close()

	gym, err := svc.Create(CreateInput{
		Kind:       KindDaily,
		Title:      "Strength training",
		Recurrence: &TaskRecurrence{Freq: FreqWeekly, Weekdays: []int{1, 3, 5}}, // Mon, Wed, Fri
	})
	if err != nil {
		t.Fatalf("Create weekly daily failed: %v", err)
	}
	if !gym.DueToday || *gym.Streak != 0 {
		t.Fatalf("Mon should be dueToday: %+v", gym)
	}

	// Complete Mon (May 4) -> streak 1.
	gym, _ = svc.Complete(CompleteInput{ID: gym.ID, Completed: true})
	if *gym.Streak != 1 {
		t.Fatalf("Mon streak = %d, want 1", *gym.Streak)
	}

	// Tue (May 5) -> not dueToday, streak stays 1!
	clk.Advance(24 * time.Hour)
	gym, _ = svc.Get(gym.ID)
	if gym.DueToday || *gym.Streak != 1 {
		t.Fatalf("Tue should not be dueToday and keep streak 1: %+v", gym)
	}

	// Wed (May 6) -> dueToday, not yet done -> streak still 1; complete -> streak 2!
	clk.Advance(24 * time.Hour)
	gym, _ = svc.Get(gym.ID)
	if !gym.DueToday || *gym.Streak != 1 {
		t.Fatalf("Wed before completion: %+v", gym)
	}
	gym, _ = svc.Complete(CompleteInput{ID: gym.ID, Completed: true})
	if *gym.Streak != 2 {
		t.Fatalf("Wed after completion streak = %d, want 2", *gym.Streak)
	}

	// Skip Fri (May 8)! Jump to Mon (May 11) -> streak resets cleanly to 0 (no penalty).
	clk.Advance(5 * 24 * time.Hour)
	gym, _ = svc.Get(gym.ID)
	if !gym.DueToday || *gym.Streak != 0 {
		t.Fatalf("Mon after missed Fri should have streak 0: %+v", gym)
	}
	gym, _ = svc.Complete(CompleteInput{ID: gym.ID, Completed: true})
	if *gym.Streak != 1 {
		t.Fatalf("Mon after recovery completion should have streak 1: %+v", gym)
	}
}

func TestDueTodayOverdueUpdateReorderDeleteAndCorrupt(t *testing.T) {
	st := store.New(t.TempDir())
	// 2026-05-10 02:00 UTC with dayStartHour=4 -> current period is 2026-05-09!
	clk := clock.NewFake(time.Date(2026, 5, 10, 2, 0, 0, 0, time.UTC))

	svc, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer svc.Close()

	tDue, _ := svc.Create(CreateInput{Kind: KindSide, Title: "Due on May 9", Deadline: "2026-05-09"})
	tSched, _ := svc.Create(CreateInput{Kind: KindSide, Title: "Scheduled May 9", ScheduledFor: "2026-05-09"})
	tFuture, _ := svc.Create(CreateInput{Kind: KindSide, Title: "Future May 15", Deadline: "2026-05-15"})

	// At 02:00 AM on May 10 (period May 9): May 9 deadline is dueToday, NOT overdue!
	if !tDue.DueToday || tDue.Overdue {
		t.Fatalf("at 02:00 AM May 9 deadline must be dueToday & not overdue: %+v", tDue)
	}
	if !tSched.DueToday || tSched.Overdue {
		t.Fatalf("scheduled May 9 must be dueToday: %+v", tSched)
	}
	if tFuture.DueToday || tFuture.Overdue {
		t.Fatalf("future task must not be dueToday/overdue: %+v", tFuture)
	}

	// Cross 04:00 AM boundary -> period becomes 2026-05-10 -> tDue becomes overdue!
	clk.Advance(2 * time.Hour)
	gotDue, _ := svc.Get(tDue.ID)
	if !gotDue.DueToday || !gotDue.Overdue {
		t.Fatalf("after 04:00 AM May 9 deadline must be overdue: %+v", gotDue)
	}

	// Update clears deadline via JSON null.
	var upd UpdateInput
	if err := json.Unmarshal([]byte(`{"id":"`+tDue.ID+`","deadline":null}`), &upd); err != nil {
		t.Fatalf("Unmarshal UpdateInput failed: %v", err)
	}
	updated, err := svc.Update(upd)
	if err != nil || updated.Deadline != "" || updated.Overdue || updated.DueToday {
		t.Fatalf("clearing deadline failed: %+v, err=%v", updated, err)
	}

	// Reorder side tasks.
	reordered, err := svc.Reorder(ReorderInput{Kind: KindSide, IDs: []string{tFuture.ID, tSched.ID, tDue.ID}})
	if err != nil {
		t.Fatalf("Reorder failed: %v", err)
	}
	if len(reordered) != 3 || reordered[0].ID != tFuture.ID || reordered[0].Order != 0 || reordered[2].ID != tDue.ID {
		t.Fatalf("unexpected reorder result: %+v", reordered)
	}

	// SetItems preserves progress on matching IDs.
	tMain, _ := svc.Create(CreateInput{
		Kind:  KindMain,
		Title: "Main plan",
		Items: []CreateItemInput{{Text: "Part 1", Target: ptr(5)}},
	})
	tMain, _ = svc.StepQuota(StepQuotaInput{ID: tMain.ID, ItemID: tMain.Items[0].ID, Delta: 3})
	tMain, err = svc.SetItems(SetItemsInput{
		ID: tMain.ID,
		Items: []ItemDraft{
			{ID: tMain.Items[0].ID, Text: "Part 1 renamed", Target: ptr(5)},
			{Text: "Part 2"},
		},
	})
	if err != nil || len(tMain.Items) != 2 || *tMain.Items[0].Current != 3 {
		t.Fatalf("SetItems did not preserve item quota progress: %+v, err=%v", tMain, err)
	}

	// Invalid date rejected.
	if _, err := svc.Create(CreateInput{Kind: KindSide, Title: "Bad date", Deadline: "2026-02-30"}); !store.IsCode(err, ErrCodeInvalidInput) {
		t.Fatalf("expected invalid-input for 2026-02-30, got %v", err)
	}

	// Delete task.
	if err := svc.Delete(tSched.ID); err != nil {
		t.Fatalf("Delete failed: %v", err)
	}
	if _, err := svc.Get(tSched.ID); !store.IsCode(err, ErrCodeNotFound) {
		t.Fatalf("expected not-found after delete, got %v", err)
	}

	// Corrupt tasks.json preserved without overwrite.
	corruptDir := t.TempDir()
	raw := `{"schemaVersion":1,"lastPeriodKey":"not-a-date","tasks":[]}`
	file := filepath.Join(corruptDir, FileName)
	if err := os.WriteFile(file, []byte(raw), 0o600); err != nil {
		t.Fatalf("write corrupt fixture: %v", err)
	}
	if _, err := Open(store.New(corruptDir), clk); !store.IsCode(err, store.ErrCodeCorrupt) {
		t.Fatalf("expected store/corrupt, got %v", err)
	}
	after, err := os.ReadFile(file)
	if err != nil || string(after) != raw {
		t.Fatalf("corrupt tasks file must stay untouched")
	}
}

func TestNextBoundaryAcrossDSTAndZeroDayStartHour(t *testing.T) {
	ny, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skipf("America/New_York tzdata unavailable: %v", err)
	}

	samples := []struct {
		name string
		t    time.Time
		hour int
	}{
		{"spring_forward_4am", time.Date(2026, 3, 8, 1, 30, 0, 0, ny), 4},
		{"fall_back_4am", time.Date(2026, 11, 1, 1, 30, 0, 0, ny), 4},
		{"midnight_hour_0", time.Date(2026, 5, 10, 23, 59, 0, 0, time.UTC), 0},
		{"late_hour_23", time.Date(2026, 5, 10, 22, 59, 0, 0, time.UTC), 23},
	}

	for _, sc := range samples {
		t.Run(sc.name, func(t *testing.T) {
			b := NextBoundary(sc.t, sc.hour)
			if !b.After(sc.t) {
				t.Fatalf("boundary %v is not strictly after %v", b, sc.t)
			}
			before := PeriodKey(b.Add(-time.Millisecond), sc.hour)
			at := PeriodKey(b, sc.hour)
			if before == at {
				t.Fatalf("boundary %v did not change PeriodKey (both %q)", b, at)
			}
			if PeriodKey(sc.t, sc.hour) != before {
				t.Fatalf("expected PeriodKey(%v)=%q to match just-before-boundary %q", sc.t, PeriodKey(sc.t, sc.hour), before)
			}
		})
	}
}

func TestTasksJSONContractNoRPGFields(t *testing.T) {
	st := store.New(t.TempDir())
	clk := clock.NewFake(time.Date(2026, 5, 10, 10, 0, 0, 0, time.UTC))
	svc, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer svc.Close()

	side, _ := svc.Create(CreateInput{Kind: KindSide, Title: "Simple side"})
	daily, _ := svc.Create(CreateInput{Kind: KindDaily, Title: "Simple daily"})

	rawSide, _ := json.Marshal(side)
	var mSide map[string]any
	_ = json.Unmarshal(rawSide, &mSide)

	if _, ok := mSide["items"]; !ok || mSide["items"] == nil {
		t.Fatalf("items must serialize as non-null array: %s", string(rawSide))
	}
	for _, forbidden := range []string{"attributes", "story", "revealed", "chapters", "tracked", "periodKey", "streak"} {
		if _, exists := mSide[forbidden]; exists {
			t.Fatalf("side task JSON must not contain %q: %s", forbidden, string(rawSide))
		}
	}

	rawDaily, _ := json.Marshal(daily)
	var mDaily map[string]any
	_ = json.Unmarshal(rawDaily, &mDaily)
	if _, ok := mDaily["streak"]; !ok {
		t.Fatalf("daily task JSON must include streak (even when 0): %s", string(rawDaily))
	}
	if _, ok := mDaily["periodKey"]; !ok {
		t.Fatalf("daily task JSON must include periodKey: %s", string(rawDaily))
	}
}

func TestTasksConcurrentRace(t *testing.T) {
	st := store.New(t.TempDir())
	clk := clock.NewFake(time.Date(2026, 5, 10, 10, 0, 0, 0, time.UTC))
	svc, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer svc.Close()

	daily, _ := svc.Create(CreateInput{Kind: KindDaily, Title: "Hydrate", QuotaTarget: ptr(100)})

	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, _ = svc.StepQuota(StepQuotaInput{ID: daily.ID, Delta: 1})
			_, _ = svc.List()
			_, _ = svc.Create(CreateInput{Kind: KindSide, Title: "Concurrent side"})
		}(i)
	}
	wg.Wait()

	got, err := svc.Get(daily.ID)
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if got.Quota.Current != 12 {
		t.Fatalf("expected 12 increments, got %d", got.Quota.Current)
	}
}

func TestDailyChecklistItemsAndRolloverReset(t *testing.T) {
	st := store.New(t.TempDir())
	start := time.Date(2026, 5, 10, 10, 0, 0, 0, time.UTC)
	clk := clock.NewFake(start)

	svc, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer svc.Close()

	// Create daily task with checklist items (including a counted item) + task-level quota.
	daily, err := svc.Create(CreateInput{
		Kind:        KindDaily,
		Title:       "Morning routine",
		QuotaTarget: ptr(2),
		Items: []CreateItemInput{
			{Text: "Stretch"},
			{Text: "Drink water", Target: ptr(2)},
		},
	})
	if err != nil {
		t.Fatalf("Create daily with items failed: %v", err)
	}
	if len(daily.Items) != 2 || daily.Status != StatusActive || *daily.Streak != 0 {
		t.Fatalf("unexpected daily with items: %+v", daily)
	}

	// Complete both items, but quota is still 0/2 -> daily must stay active!
	daily, err = svc.ToggleItem(ToggleItemInput{TaskID: daily.ID, ItemID: daily.Items[0].ID})
	if err != nil {
		t.Fatalf("ToggleItem on daily failed: %v", err)
	}
	daily, err = svc.StepQuota(StepQuotaInput{ID: daily.ID, ItemID: daily.Items[1].ID, Delta: 2})
	if err != nil {
		t.Fatalf("StepQuota on daily item failed: %v", err)
	}
	if !daily.Items[0].Done || !daily.Items[1].Done || *daily.Items[1].Current != 2 {
		t.Fatalf("expected both daily items done: %+v", daily.Items)
	}
	if daily.Status != StatusActive || *daily.Streak != 0 {
		t.Fatalf("daily should stay active until task quota is also met: %+v", daily)
	}

	// Satisfy task quota too -> daily completes and records streak=1!
	daily, err = svc.StepQuota(StepQuotaInput{ID: daily.ID, Delta: 2})
	if err != nil {
		t.Fatalf("StepQuota on daily task failed: %v", err)
	}
	if daily.Status != StatusCompleted || *daily.Streak != 1 {
		t.Fatalf("daily should complete with streak=1: %+v", daily)
	}

	// Uncheck item 0 via ToggleItem -> daily reopens and removes today from history (streak=0)!
	daily, err = svc.ToggleItem(ToggleItemInput{TaskID: daily.ID, ItemID: daily.Items[0].ID, Done: ptr(false)})
	if err != nil {
		t.Fatalf("ToggleItem undo on daily failed: %v", err)
	}
	if daily.Status != StatusActive || *daily.Streak != 0 {
		t.Fatalf("unchecking daily item should reopen daily and clear streak: %+v", daily)
	}

	// Use SetItems on daily to complete all items -> completes daily again (streak=1)!
	daily, err = svc.SetItems(SetItemsInput{
		ID: daily.ID,
		Items: []ItemDraft{
			{ID: daily.Items[0].ID, Text: "Stretch", Done: ptr(true)},
			{ID: daily.Items[1].ID, Text: "Drink water", Target: ptr(2), Current: ptr(2), Done: ptr(true)},
		},
	})
	if err != nil {
		t.Fatalf("SetItems on daily failed: %v", err)
	}
	if daily.Status != StatusCompleted || *daily.Streak != 1 {
		t.Fatalf("SetItems completing daily items should record streak=1: %+v", daily)
	}

	// Advance past next dayStartHour (2026-05-11 04:00) -> rollover resets status, quota, AND all items!
	clk.Advance(18 * time.Hour)
	rolled, err := svc.Get(daily.ID)
	if err != nil {
		t.Fatalf("Get after rollover failed: %v", err)
	}
	if rolled.PeriodKey != "2026-05-11" || rolled.Status != StatusActive || rolled.Quota.Current != 0 || *rolled.Streak != 1 {
		t.Fatalf("rollover did not reset daily cleanly: %+v", rolled)
	}
	if rolled.Items[0].Done || rolled.Items[1].Done || *rolled.Items[1].Current != 0 {
		t.Fatalf("rollover did not reset daily items: %+v", rolled.Items)
	}

	// Reopen from disk to verify validatePersisted accepts daily items cleanly.
	svc.Close()
	reopened, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Reopen daily with items failed: %v", err)
	}
	defer reopened.Close()
	got, err := reopened.Get(daily.ID)
	if err != nil || len(got.Items) != 2 {
		t.Fatalf("reopened daily items missing: %+v, err=%v", got, err)
	}
}

func TestCompletedNonDailyDueToday(t *testing.T) {
	st := store.New(t.TempDir())
	// 2026-05-10 10:00 UTC, dayStartHour=4 -> period 2026-05-10.
	clk := clock.NewFake(time.Date(2026, 5, 10, 10, 0, 0, 0, time.UTC))

	svc, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer svc.Close()

	side, err := svc.Create(CreateInput{
		Kind:     KindSide,
		Title:    "Ship patch",
		Deadline: "2026-05-10",
	})
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	if !side.DueToday || side.Overdue {
		t.Fatalf("active due-today task: %+v", side)
	}

	// Completing today must keep DueToday=true (so todayTally counts 1/1 and 今日 fold shows it).
	side, err = svc.Complete(CompleteInput{ID: side.ID, Completed: true})
	if err != nil {
		t.Fatalf("Complete failed: %v", err)
	}
	if !side.DueToday || side.Overdue {
		t.Fatalf("completed today non-daily task must have DueToday=true, Overdue=false: %+v", side)
	}

	// After rolling into 2026-05-11 (past 04:00), yesterday's completed task has DueToday=false.
	clk.Advance(18 * time.Hour)
	nextDay, err := svc.Get(side.ID)
	if err != nil {
		t.Fatalf("Get next day failed: %v", err)
	}
	if nextDay.DueToday || nextDay.Overdue {
		t.Fatalf("yesterday's completed task must not be DueToday on next period: %+v", nextDay)
	}
}

func TestFlatCreateOmittedAndTaskKind(t *testing.T) {
	st := store.New(t.TempDir())
	clk := clock.NewFake(time.Date(2026, 5, 11, 10, 0, 0, 0, time.UTC)) // Monday (1)

	svc, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer svc.Close()

	// Omitted Kind defaults to KindSide.
	flat, err := svc.Create(CreateInput{Title: "Flat task without kind"})
	if err != nil {
		t.Fatalf("Create with omitted kind failed: %v", err)
	}
	if flat.Kind != KindSide || flat.Recurrence != nil || flat.PeriodKey != "" || flat.Streak != nil {
		t.Fatalf("unexpected flat task: %+v", flat)
	}

	// Explicit "task" Kind also defaults to KindSide.
	explicitTask, err := svc.Create(CreateInput{Kind: KindTask, Title: "Explicit task kind"})
	if err != nil {
		t.Fatalf("Create with kind=task failed: %v", err)
	}
	if explicitTask.Kind != KindSide || explicitTask.Recurrence != nil {
		t.Fatalf("unexpected kind=task result: %+v", explicitTask)
	}

	// Omitted Kind with Recurrence promotes to KindDaily.
	dailyFlat, err := svc.Create(CreateInput{
		Title:      "Daily without kind",
		Recurrence: &TaskRecurrence{Freq: FreqDaily},
	})
	if err != nil {
		t.Fatalf("Create omitted kind + recurrence failed: %v", err)
	}
	if dailyFlat.Kind != KindDaily || dailyFlat.Recurrence == nil || dailyFlat.Recurrence.Freq != FreqDaily || dailyFlat.PeriodKey != "2026-05-11" || dailyFlat.Streak == nil || *dailyFlat.Streak != 0 || !dailyFlat.DueToday {
		t.Fatalf("unexpected dailyFlat: %+v", dailyFlat)
	}

	// "task" Kind with weekly Recurrence promotes to KindDaily.
	weeklyTask, err := svc.Create(CreateInput{
		Kind:       KindTask,
		Title:      "Weekly review",
		Recurrence: &TaskRecurrence{Freq: FreqWeekly, Weekdays: []int{1, 3}},
	})
	if err != nil {
		t.Fatalf("Create kind=task + weekly recurrence failed: %v", err)
	}
	if weeklyTask.Kind != KindDaily || weeklyTask.Recurrence == nil || weeklyTask.Recurrence.Freq != FreqWeekly || !weeklyTask.DueToday {
		t.Fatalf("unexpected weeklyTask: %+v", weeklyTask)
	}

	// Legacy "main", "side", "daily" remain accepted.
	legacyMain, err := svc.Create(CreateInput{Kind: KindMain, Title: "Legacy main"})
	if err != nil || legacyMain.Kind != KindMain {
		t.Fatalf("legacy main create failed: %+v, err=%v", legacyMain, err)
	}
	if _, err := svc.Create(CreateInput{Kind: "bogus", Title: "Invalid kind"}); !store.IsCode(err, ErrCodeInvalidInput) {
		t.Fatalf("expected invalid-input for bogus kind, got %v", err)
	}

	// Persisted tasks reopen cleanly via validatePersisted.
	svc.Close()
	reopened, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Reopen failed: %v", err)
	}
	defer reopened.Close()
	res, err := reopened.List()
	if err != nil || len(res.Tasks) != 5 {
		t.Fatalf("expected 5 persisted tasks, got %d (err=%v)", len(res.Tasks), err)
	}
}

func TestUpdateToggleRecurrenceOnAnyTask(t *testing.T) {
	st := store.New(t.TempDir())
	// 2026-05-11 10:00 UTC (Monday), dayStartHour=4 -> period 2026-05-11.
	clk := clock.NewFake(time.Date(2026, 5, 11, 10, 0, 0, 0, time.UTC))

	svc, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer svc.Close()

	// Verify tri-state JSON decoding for recurrence under both encoding/json and encoding/json/v2.
	var decNullV1, decNullV2 UpdateInput
	if err := json.Unmarshal([]byte(`{"id":"t1","recurrence":null}`), &decNullV1); err != nil {
		t.Fatalf("json v1 unmarshal recurrence:null: %v", err)
	}
	if err := jsonv2.Unmarshal([]byte(`{"id":"t1","recurrence":null}`), &decNullV2); err != nil {
		t.Fatalf("json v2 unmarshal recurrence:null: %v", err)
	}
	if !decNullV1.ClearRecurrence || decNullV1.Recurrence != nil || !decNullV2.ClearRecurrence || decNullV2.Recurrence != nil {
		t.Fatalf("expected ClearRecurrence=true on null, got v1=%+v v2=%+v", decNullV1, decNullV2)
	}
	var decOmit UpdateInput
	if err := jsonv2.Unmarshal([]byte(`{"id":"t1","title":"Keep"}`), &decOmit); err != nil {
		t.Fatalf("json v2 unmarshal omitted recurrence: %v", err)
	}
	if decOmit.ClearRecurrence || decOmit.Recurrence != nil {
		t.Fatalf("omitted recurrence must not set ClearRecurrence: %+v", decOmit)
	}

	task, err := svc.Create(CreateInput{Title: "Walk 30 minutes"})
	if err != nil {
		t.Fatalf("Create flat task: %v", err)
	}
	legacyMain, err := svc.Create(CreateInput{Kind: KindMain, Title: "Legacy main task"})
	if err != nil {
		t.Fatalf("Create legacy main: %v", err)
	}

	// Clearing recurrence on a non-daily task is an idempotent no-op.
	var noopUpd UpdateInput
	if err := json.Unmarshal([]byte(`{"id":"`+task.ID+`","recurrence":null}`), &noopUpd); err != nil {
		t.Fatalf("unmarshal noopUpd: %v", err)
	}
	same, err := svc.Update(noopUpd)
	if err != nil || same.Kind != KindSide || same.Recurrence != nil {
		t.Fatalf("clearing recurrence on non-daily should be no-op: %+v, err=%v", same, err)
	}

	// Invalid recurrence rejected without mutating Kind.
	if _, err := svc.Update(UpdateInput{ID: task.ID, Recurrence: &TaskRecurrence{Freq: FreqWeekly}}); !store.IsCode(err, ErrCodeInvalidInput) {
		t.Fatalf("expected invalid-input for empty weekly weekdays, got %v", err)
	}

	// Toggle recurrence ON via JSON {"recurrence":{"freq":"daily"}} on flat task.
	var enableUpd UpdateInput
	if err := json.Unmarshal([]byte(`{"id":"`+task.ID+`","recurrence":{"freq":"daily"}}`), &enableUpd); err != nil {
		t.Fatalf("unmarshal enableUpd: %v", err)
	}
	daily, err := svc.Update(enableUpd)
	if err != nil {
		t.Fatalf("enable recurrence failed: %v", err)
	}
	if daily.Kind != KindDaily || daily.Recurrence == nil || daily.Recurrence.Freq != FreqDaily || daily.PeriodKey != "2026-05-11" || daily.Streak == nil || *daily.Streak != 0 || !daily.DueToday {
		t.Fatalf("unexpected task after enabling recurrence: %+v", daily)
	}

	// Complete today -> streak=1, then rollover next day -> resets to active & preserves streak=1!
	daily, err = svc.Complete(CompleteInput{ID: task.ID, Completed: true})
	if err != nil || daily.Status != StatusCompleted || *daily.Streak != 1 {
		t.Fatalf("complete promoted daily failed: %+v, err=%v", daily, err)
	}
	clk.Advance(24 * time.Hour) // 2026-05-12 10:00 (Tuesday)
	rolled, err := svc.Get(task.ID)
	if err != nil {
		t.Fatalf("Get after rollover failed: %v", err)
	}
	if rolled.Status != StatusActive || rolled.PeriodKey != "2026-05-12" || *rolled.Streak != 1 {
		t.Fatalf("promoted daily must roll over across day boundary: %+v", rolled)
	}

	// Toggle recurrence ON for legacy KindMain task with weekly schedule.
	weeklyMain, err := svc.Update(UpdateInput{
		ID:         legacyMain.ID,
		Recurrence: &TaskRecurrence{Freq: FreqWeekly, Weekdays: []int{2, 4}},
	})
	if err != nil {
		t.Fatalf("enable weekly recurrence on legacy main failed: %v", err)
	}
	if weeklyMain.Kind != KindDaily || weeklyMain.Recurrence == nil || weeklyMain.Recurrence.Freq != FreqWeekly || !weeklyMain.DueToday {
		t.Fatalf("unexpected weeklyMain: %+v", weeklyMain)
	}

	// Complete task on 2026-05-12, toggle recurrence OFF, reopen, toggle recurrence ON ->
	// today's cleared status must not retain a stale history entry for 2026-05-12 (streak stays 1 from May 11).
	_, _ = svc.Complete(CompleteInput{ID: task.ID, Completed: true})
	var disableUpd UpdateInput
	if err := json.Unmarshal([]byte(`{"id":"`+task.ID+`","recurrence":null}`), &disableUpd); err != nil {
		t.Fatalf("unmarshal disableUpd: %v", err)
	}
	plain, err := svc.Update(disableUpd)
	if err != nil {
		t.Fatalf("disable recurrence failed: %v", err)
	}
	if plain.Kind != KindSide || plain.Recurrence != nil || plain.PeriodKey != "" || plain.Streak != nil {
		t.Fatalf("unexpected task after disabling recurrence: %+v", plain)
	}

	// Reopen while plain, then re-enable recurrence on same day: streak should be 1 (May 11), not 2.
	_, err = svc.Complete(CompleteInput{ID: task.ID, Completed: false})
	if err != nil {
		t.Fatalf("reopen plain task failed: %v", err)
	}
	reEnabled, err := svc.Update(enableUpd)
	if err != nil {
		t.Fatalf("re-enable recurrence failed: %v", err)
	}
	if reEnabled.Kind != KindDaily || reEnabled.Status != StatusActive || reEnabled.Streak == nil || *reEnabled.Streak != 1 {
		t.Fatalf("expected streak=1 after reopen+re-enable on May 12, got %+v", reEnabled)
	}

	// Disable recurrence again, complete it, advance past next dayStartHour -> must stay completed (no rollover!).
	plain, err = svc.Update(disableUpd)
	if err != nil {
		t.Fatalf("second disable recurrence failed: %v", err)
	}
	plain, err = svc.Complete(CompleteInput{ID: plain.ID, Completed: true})
	if err != nil || plain.Status != StatusCompleted {
		t.Fatalf("complete plain task failed: %+v, err=%v", plain, err)
	}
	clk.Advance(24 * time.Hour) // 2026-05-13 10:00
	afterDay, err := svc.Get(plain.ID)
	if err != nil {
		t.Fatalf("Get after day boundary failed: %v", err)
	}
	if afterDay.Kind != KindSide || afterDay.Status != StatusCompleted || afterDay.Recurrence != nil {
		t.Fatalf("non-recurring task must remain completed across rollover: %+v", afterDay)
	}

	// Reopen from disk to confirm persisted schema invariants hold.
	svc.Close()
	reopened, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Reopen after recurrence toggles failed: %v", err)
	}
	defer reopened.Close()
	got, err := reopened.Get(plain.ID)
	if err != nil || got.Kind != KindSide || got.Recurrence != nil {
		t.Fatalf("persisted plain task mismatch: %+v, err=%v", got, err)
	}
}

func TestFlatReorderWithoutKind(t *testing.T) {
	st := store.New(t.TempDir())
	clk := clock.NewFake(time.Date(2026, 5, 11, 10, 0, 0, 0, time.UTC))

	svc, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer svc.Close()

	t1, _ := svc.Create(CreateInput{Title: "Normal A"})
	t2, _ := svc.Create(CreateInput{Title: "Daily B", Recurrence: &TaskRecurrence{Freq: FreqDaily}})
	t3, _ := svc.Create(CreateInput{Kind: KindMain, Title: "Legacy Main C"})
	t4, _ := svc.Create(CreateInput{Kind: KindTask, Title: "Normal D"})

	// Initial flat list preserves creation order regardless of kind.
	initial, err := svc.List()
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	if len(initial.Tasks) != 4 ||
		initial.Tasks[0].ID != t1.ID ||
		initial.Tasks[1].ID != t2.ID ||
		initial.Tasks[2].ID != t3.ID ||
		initial.Tasks[3].ID != t4.ID {
		t.Fatalf("unexpected initial flat order: %+v", initial.Tasks)
	}

	// Reorder across all tasks with omitted Kind.
	reordered, err := svc.Reorder(ReorderInput{IDs: []string{t2.ID, t4.ID, t1.ID, t3.ID}})
	if err != nil {
		t.Fatalf("flat Reorder failed: %v", err)
	}
	wantFull := []string{t2.ID, t4.ID, t1.ID, t3.ID}
	for i, wantID := range wantFull {
		if reordered[i].ID != wantID || reordered[i].Order != i {
			t.Fatalf("pos %d: got id=%s order=%d, want id=%s order=%d", i, reordered[i].ID, reordered[i].Order, wantID, i)
		}
	}

	// Partial subset reorder with empty Kind places specified IDs first and keeps remaining stably after.
	partial, err := svc.Reorder(ReorderInput{IDs: []string{t3.ID, t1.ID}})
	if err != nil {
		t.Fatalf("partial flat Reorder failed: %v", err)
	}
	wantPartial := []string{t3.ID, t1.ID, t2.ID, t4.ID}
	for i, wantID := range wantPartial {
		if partial[i].ID != wantID || partial[i].Order != i {
			t.Fatalf("partial pos %d: got id=%s order=%d, want id=%s order=%d", i, partial[i].ID, partial[i].Order, wantID, i)
		}
	}

	// Duplicate and unknown IDs return expected coded errors.
	if _, err := svc.Reorder(ReorderInput{IDs: []string{t1.ID, t1.ID}}); !store.IsCode(err, ErrCodeInvalidInput) {
		t.Fatalf("expected invalid-input for duplicate id, got %v", err)
	}
	if _, err := svc.Reorder(ReorderInput{IDs: []string{t1.ID, "missing"}}); !store.IsCode(err, ErrCodeNotFound) {
		t.Fatalf("expected not-found for unknown id, got %v", err)
	}

	// Backward-compatible Reorder with explicit Kind still works cleanly.
	byKind, err := svc.Reorder(ReorderInput{Kind: KindSide, IDs: []string{t4.ID, t1.ID}})
	if err != nil {
		t.Fatalf("legacy kind Reorder failed: %v", err)
	}
	// t3(0), t4(1), t2(2), t1(3) -> t4 is ordered before t1 while other tasks keep their slots.
	posT4, posT1 := -1, -1
	for i, task := range byKind {
		if task.ID == t4.ID {
			posT4 = i
		}
		if task.ID == t1.ID {
			posT1 = i
		}
	}
	if posT4 < 0 || posT1 < 0 || posT4 >= posT1 {
		t.Fatalf("expected t4 before t1 after legacy KindSide reorder, got posT4=%d posT1=%d", posT4, posT1)
	}

	// Persist & reopen preserves flat order.
	svc.Close()
	reopened, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Reopen failed: %v", err)
	}
	defer reopened.Close()
	persisted, err := reopened.List()
	if err != nil || len(persisted.Tasks) != 4 || persisted.Tasks[0].ID != byKind[0].ID || persisted.Tasks[3].ID != byKind[3].ID {
		t.Fatalf("reopened order mismatch: got=%+v want=%+v err=%v", persisted.Tasks, byKind, err)
	}
}

package app

import (
	"context"
	"encoding/json/v2"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo"
	"github.com/muyuzhong/featherlog/internal/clock"
	"github.com/muyuzhong/featherlog/internal/dock"
	"github.com/muyuzhong/featherlog/internal/ipcsock"
	"github.com/muyuzhong/featherlog/internal/notes"
	"github.com/muyuzhong/featherlog/internal/settings"
	"github.com/muyuzhong/featherlog/internal/tasks"
	"github.com/muyuzhong/featherlog/internal/workbench"
)

type recordingSink struct {
	mu        sync.Mutex
	workbench [][]workbench.WorkSlot
	tasks     []tasks.ListResult
	notes     []NotesChangedEvent
	settings  []settings.Settings
	toggles   []DockToggleEvent
}

func (r *recordingSink) WorkbenchChanged(slots []workbench.WorkSlot) {
	r.mu.Lock()
	r.workbench = append(r.workbench, slots)
	r.mu.Unlock()
}

func (r *recordingSink) TasksChanged(res tasks.ListResult) {
	r.mu.Lock()
	r.tasks = append(r.tasks, res)
	r.mu.Unlock()
}

func (r *recordingSink) NotesChanged(evt NotesChangedEvent) {
	r.mu.Lock()
	r.notes = append(r.notes, evt)
	r.mu.Unlock()
}

func (r *recordingSink) SettingsChanged(s settings.Settings) {
	r.mu.Lock()
	r.settings = append(r.settings, s)
	r.mu.Unlock()
}

func (r *recordingSink) DockToggle(evt DockToggleEvent) {
	r.mu.Lock()
	r.toggles = append(r.toggles, evt)
	r.mu.Unlock()
}

type noopScreen struct{}

func (noopScreen) ActiveDisplay(dock.Rect) dock.Display {
	return dock.Display{
		Bounds:   dock.Rect{Width: 1920, Height: 1080},
		WorkArea: dock.Rect{Width: 1920, Height: 1032},
		Primary:  true,
	}
}
func (noopScreen) OnDisplaysChanged(func()) func() { return func() {} }

type noopLayer struct{}

func (noopLayer) Available() bool                      { return false }
func (noopLayer) AnchorBottomCenter(uintptr, int) bool { return false }

func openTestApp(t *testing.T, start time.Time) (*App, *clock.FakeClock, *recordingSink) {
	t.Helper()
	clk := clock.NewFake(start)
	sink := &recordingSink{}
	quitCalls := 0
	a, err := Open(Config{
		DataDir: t.TempDir(),
		Clock:   clk,
		Events:  sink,
		DockCfg: dock.Config{
			Screen: noopScreen{},
			Layer:  noopLayer{},
		},
		QuitFunc: func() { quitCalls++ },
	})
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	t.Cleanup(a.Close)
	return a, clk, sink
}

func TestMyGoBindAndTypeScriptGeneration(t *testing.T) {
	a, _, _ := openTestApp(t, time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC))
	// Verify mygo.Bind accepts all 5 contract services without panicking.
	a.BindMyGo()

	outPath := filepath.Join(t.TempDir(), "mygo.ts")
	if err := mygo.WriteTypeScript(outPath); err != nil {
		t.Fatalf("mygo.WriteTypeScript failed: %v", err)
	}
	raw, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatalf("read generated TS: %v", err)
	}
	ts := string(raw)

	expectedSnippets := []string{
		"export const WorkbenchService",
		`"WorkbenchService.List"`,
		`"WorkbenchService.Create"`,
		`"WorkbenchService.Update"`,
		`"WorkbenchService.SetState"`,
		`"WorkbenchService.Complete"`,
		`"WorkbenchService.Reorder"`,
		"export const TaskService",
		`"TaskService.List"`,
		`"TaskService.Create"`,
		`"TaskService.Update"`,
		`"TaskService.SetItems"`,
		`"TaskService.ToggleItem"`,
		`"TaskService.StepQuota"`,
		`"TaskService.Complete"`,
		`"TaskService.Delete"`,
		`"TaskService.Reorder"`,
		"export const NoteService",
		`"NoteService.List"`,
		`"NoteService.Create"`,
		`"NoteService.Update"`,
		`"NoteService.Delete"`,
		"export const SettingsService",
		`"SettingsService.Get"`,
		`"SettingsService.Update"`,
		"export const DockService",
		`"DockService.Resize"`,
		`"DockService.Quit"`,
		`"workbench:changed"`,
		`"tasks:changed"`,
		`"notes:changed"`,
		`"settings:changed"`,
		`"dock:toggle"`,
	}
	for _, want := range expectedSnippets {
		if !strings.Contains(ts, want) {
			t.Errorf("generated TS missing %s\n--- TS ---\n%s", want, ts)
		}
	}
}

func TestCrossDomainTaskDeletionDetachesNotesAndClearsSlotLink(t *testing.T) {
	a, _, sink := openTestApp(t, time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC))

	task, err := a.TaskSvc.Create(tasks.CreateInput{
		Kind:  tasks.KindSide,
		Title: "Refactor auth",
	})
	if err != nil {
		t.Fatalf("Create task: %v", err)
	}

	taskID := task.ID
	note, err := a.NoteSvc.Create(notes.CreateInput{
		Content: "Remember refresh token rotation",
		TaskID:  &taskID,
	})
	if err != nil {
		t.Fatalf("Create note: %v", err)
	}
	if note.TaskID == nil || *note.TaskID != task.ID {
		t.Fatalf("expected note attached to task %s", task.ID)
	}

	slot, err := a.WorkbenchSvc.Create(workbench.CreateInput{
		Title:        "Auth work",
		LinkedTaskID: task.ID,
	})
	if err != nil {
		t.Fatalf("Create slot: %v", err)
	}

	// Delete task: notes must detach into standalone 随笔 (not deleted), and slot link cleared.
	if err := a.TaskSvc.Delete(IDInput{ID: task.ID}); err != nil {
		t.Fatalf("Delete task: %v", err)
	}

	allNotes, err := a.NoteSvc.List(nil)
	if err != nil {
		t.Fatalf("List notes: %v", err)
	}
	if len(allNotes) != 1 || allNotes[0].TaskID != nil || allNotes[0].Content != "Remember refresh token rotation" {
		t.Fatalf("expected detached standalone note, got %+v", allNotes)
	}

	updatedSlot, err := a.Workbench.Get(slot.ID)
	if err != nil {
		t.Fatalf("Get slot: %v", err)
	}
	if updatedSlot.LinkedTaskID != "" {
		t.Fatalf("expected dangling linkedTaskId cleared, got %q", updatedSlot.LinkedTaskID)
	}

	sink.mu.Lock()
	foundDetached := false
	for _, evt := range sink.notes {
		if evt.Reason == "detached" {
			foundDetached = true
		}
	}
	sink.mu.Unlock()
	if !foundDetached {
		t.Fatalf("expected notes:changed event with reason=detached")
	}
}

func TestWorkbenchCompleteOptionallyCompletesLinkedTask(t *testing.T) {
	a, _, _ := openTestApp(t, time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC))

	t1, err := a.TaskSvc.Create(tasks.CreateInput{Kind: tasks.KindSide, Title: "Ship PR"})
	if err != nil {
		t.Fatalf("Create t1: %v", err)
	}
	t2, err := a.TaskSvc.Create(tasks.CreateInput{Kind: tasks.KindSide, Title: "Keep open"})
	if err != nil {
		t.Fatalf("Create t2: %v", err)
	}

	s1, err := a.WorkbenchSvc.Create(workbench.CreateInput{Title: "S1", LinkedTaskID: t1.ID})
	if err != nil {
		t.Fatalf("Create s1: %v", err)
	}
	s2, err := a.WorkbenchSvc.Create(workbench.CreateInput{Title: "S2", LinkedTaskID: t2.ID})
	if err != nil {
		t.Fatalf("Create s2: %v", err)
	}

	if _, err := a.WorkbenchSvc.Complete(WorkbenchCompleteInput{ID: s1.ID, CompleteLinkedTask: true}); err != nil {
		t.Fatalf("Complete s1: %v", err)
	}
	if _, err := a.WorkbenchSvc.Complete(WorkbenchCompleteInput{ID: s2.ID, CompleteLinkedTask: false}); err != nil {
		t.Fatalf("Complete s2: %v", err)
	}

	got1, err := a.Tasks.Get(t1.ID)
	if err != nil || got1.Status != tasks.StatusCompleted {
		t.Fatalf("expected t1 completed, got status=%q err=%v", got1.Status, err)
	}
	got2, err := a.Tasks.Get(t2.ID)
	if err != nil || got2.Status != tasks.StatusActive {
		t.Fatalf("expected t2 still active, got status=%q err=%v", got2.Status, err)
	}
}

func TestReminderTimerPeriodRolloverAndSettingsSyncEmitEvents(t *testing.T) {
	start := time.Date(2026, 11, 25, 3, 50, 0, 0, time.UTC)
	a, clk, sink := openTestApp(t, start)

	// Daily task + running slot with 5m reminder.
	if _, err := a.TaskSvc.Create(tasks.CreateInput{
		Kind:       tasks.KindDaily,
		Title:      "Read docs",
		Recurrence: &tasks.TaskRecurrence{Freq: tasks.FreqDaily},
	}); err != nil {
		t.Fatalf("Create daily task: %v", err)
	}
	remind := 5
	slot, err := a.WorkbenchSvc.Create(workbench.CreateInput{
		Title:           "CI pipeline",
		State:           workbench.StateRunning,
		RemindInMinutes: &remind,
	})
	if err != nil {
		t.Fatalf("Create running slot: %v", err)
	}

	// Advance 5 minutes -> reminder timer transitions running -> ready and broadcasts workbench:changed.
	clk.Advance(5 * time.Minute)
	gotSlot, err := a.Workbench.Get(slot.ID)
	if err != nil {
		t.Fatalf("Get slot: %v", err)
	}
	if gotSlot.State != workbench.StateReady {
		t.Fatalf("expected slot ready after 5m, got %s", gotSlot.State)
	}

	// Advance another 6 minutes past 04:00 dayStartHour -> triggers period rollover & tasks:changed.
	clk.Advance(6 * time.Minute)
	listRes, err := a.TaskSvc.List()
	if err != nil {
		t.Fatalf("TaskSvc.List: %v", err)
	}
	if listRes.PeriodKey != "2026-11-25" {
		t.Fatalf("periodKey = %q, want 2026-11-25", listRes.PeriodKey)
	}

	// Update settings (pinned=true, dayStartHour=6) -> syncs Dock and emits settings:changed.
	pinned := true
	hour := 6
	updatedSettings, err := a.SettingsSvc.Update(settings.Patch{
		Pinned:       &pinned,
		DayStartHour: &hour,
	})
	if err != nil {
		t.Fatalf("SettingsSvc.Update: %v", err)
	}
	if !updatedSettings.Pinned || updatedSettings.DayStartHour != 6 {
		t.Fatalf("unexpected settings: %+v", updatedSettings)
	}
	_, dockPinned, _, _ := a.Dock.State()
	if !dockPinned {
		t.Fatalf("expected Dock controller pinned synced to true")
	}

	sink.mu.Lock()
	wbEvents := len(sink.workbench)
	taskEvents := len(sink.tasks)
	settingsEvents := len(sink.settings)
	sink.mu.Unlock()
	if wbEvents < 2 {
		t.Fatalf("expected >=2 workbench:changed events (create + reminder), got %d", wbEvents)
	}
	if taskEvents < 2 {
		t.Fatalf("expected >=2 tasks:changed events (create + rollover), got %d", taskEvents)
	}
	if settingsEvents != 1 {
		t.Fatalf("expected 1 settings:changed event, got %d", settingsEvents)
	}
}

func TestJSONv2TriStateDecodingCompatibility(t *testing.T) {
	// MyGo decodes bound method args using encoding/json/v2. Verify @core's
	// custom UnmarshalJSON methods preserve tri-state null semantics under v2.
	var wbUpd workbench.UpdateInput
	if err := json.Unmarshal([]byte(`{"id":"s1","linkedTaskId":null}`), &wbUpd); err != nil {
		t.Fatalf("json/v2 workbench.UpdateInput: %v", err)
	}
	if !wbUpd.ClearLinkedTaskID || wbUpd.LinkedTaskID != nil {
		t.Fatalf("expected ClearLinkedTaskID=true, got %+v", wbUpd)
	}

	var wbState workbench.SetStateInput
	if err := json.Unmarshal([]byte(`{"id":"s1","state":"running","remindInMinutes":null}`), &wbState); err != nil {
		t.Fatalf("json/v2 workbench.SetStateInput: %v", err)
	}
	if !wbState.ClearRemind || wbState.RemindInMinutes != nil {
		t.Fatalf("expected ClearRemind=true, got %+v", wbState)
	}

	var taskUpd tasks.UpdateInput
	if err := json.Unmarshal([]byte(`{"id":"t1","quotaTarget":null,"deadline":null}`), &taskUpd); err != nil {
		t.Fatalf("json/v2 tasks.UpdateInput: %v", err)
	}
	if !taskUpd.ClearQuota || !taskUpd.ClearDeadline || taskUpd.ClearScheduledFor {
		t.Fatalf("unexpected taskUpd clear flags: %+v", taskUpd)
	}

	var noteList notes.ListInput
	if err := json.Unmarshal([]byte(`{"taskId":null,"query":"hi"}`), &noteList); err != nil {
		t.Fatalf("json/v2 notes.ListInput: %v", err)
	}
	if !noteList.FilterByTask || noteList.TaskID != nil || noteList.Query != "hi" {
		t.Fatalf("unexpected noteList: %+v", noteList)
	}
}

func TestEndToEndUnixSocketIPCCommands(t *testing.T) {
	a, _, sink := openTestApp(t, time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC))
	sockPath := ipcsock.SocketPath(t.TempDir())
	srv, err := ipcsock.Listen(sockPath, a.HandleIPC)
	if err != nil {
		t.Fatalf("ipcsock.Listen: %v", err)
	}
	defer func() { _ = srv.Close() }()

	client := ipcsock.NewClient(sockPath)
	ctx := context.Background()

	// focus creates a focus slot.
	var focused workbench.WorkSlot
	if err := client.Call(ctx, ipcsock.CmdFocus, ipcsock.FocusParams{
		Title: "Build host",
		Tag:   "Featherlog",
		Note:  "wire mygo services",
	}, &focused); err != nil {
		t.Fatalf("IPC focus: %v", err)
	}
	if focused.State != workbench.StateFocus || focused.Tag != "Featherlog" || focused.Breadcrumb != "wire mygo services" {
		t.Fatalf("unexpected focused slot: %+v", focused)
	}

	// run creates a running slot with reminder without stealing focus.
	var running workbench.WorkSlot
	if err := client.Call(ctx, ipcsock.CmdRun, ipcsock.RunParams{
		Title:         "Claude frontend",
		Tag:           "UI",
		Note:          "waiting for vitest",
		RemindSeconds: 900,
	}, &running); err != nil {
		t.Fatalf("IPC run: %v", err)
	}
	if running.State != workbench.StateRunning || running.RemindAt == nil {
		t.Fatalf("unexpected running slot: %+v", running)
	}

	// ready matches by substring and updates breadcrumb.
	var ready workbench.WorkSlot
	if err := client.Call(ctx, ipcsock.CmdReady, ipcsock.ReadyParams{
		Target: "frontend",
		Note:   "vitest passed",
	}, &ready); err != nil {
		t.Fatalf("IPC ready: %v", err)
	}
	if ready.State != workbench.StateReady || ready.Breadcrumb != "vitest passed" {
		t.Fatalf("unexpected ready slot: %+v", ready)
	}

	// status returns both slots.
	var slots []workbench.WorkSlot
	if err := client.Call(ctx, ipcsock.CmdStatus, nil, &slots); err != nil {
		t.Fatalf("IPC status: %v", err)
	}
	if len(slots) != 2 {
		t.Fatalf("status len = %d, want 2", len(slots))
	}

	// done completes matched slot.
	var doneRes DoneResult
	if err := client.Call(ctx, ipcsock.CmdDone, ipcsock.DoneParams{Target: "frontend"}, &doneRes); err != nil {
		t.Fatalf("IPC done: %v", err)
	}
	if doneRes.Removed.ID != running.ID || len(doneRes.Remaining) != 1 {
		t.Fatalf("unexpected done result: %+v", doneRes)
	}

	// note creates a standalone note.
	var note notes.Note
	if err := client.Call(ctx, ipcsock.CmdNote, ipcsock.NoteParams{Text: "shipped IPC"}, &note); err != nil {
		t.Fatalf("IPC note: %v", err)
	}
	if note.Content != "shipped IPC" || note.TaskID != nil {
		t.Fatalf("unexpected note: %+v", note)
	}

	// toggle broadcasts dock:toggle.
	var toggleRes ipcsock.ToggleResult
	if err := client.Call(ctx, ipcsock.CmdToggle, ipcsock.ToggleParams{}, &toggleRes); err != nil {
		t.Fatalf("IPC toggle: %v", err)
	}
	if !toggleRes.Expanded {
		t.Fatalf("expected toggle expanded=true")
	}

	sink.mu.Lock()
	toggles := len(sink.toggles)
	sink.mu.Unlock()
	if toggles != 1 {
		t.Fatalf("expected 1 dock:toggle event, got %d", toggles)
	}
}

type fakeAppWindow struct {
	bounds dock.Rect
	shown  int
	hidden int
	bg     string
}

func (f *fakeAppWindow) Bounds() dock.Rect           { return f.bounds }
func (f *fakeAppWindow) SetBounds(r dock.Rect)       { f.bounds = r }
func (f *fakeAppWindow) Show()                       { f.shown++ }
func (f *fakeAppWindow) ShowInactive()               { f.shown++ }
func (f *fakeAppWindow) Hide()                       { f.hidden++ }
func (f *fakeAppWindow) Focus()                      {}
func (f *fakeAppWindow) SetBackgroundColor(c string) { f.bg = c }
func (f *fakeAppWindow) NativeHandle() uintptr       { return 0 }
func (f *fakeAppWindow) RunOnMain(fn func())         { fn() }
func (f *fakeAppWindow) OnBlur(func()) func()        { return func() {} }
func (f *fakeAppWindow) IsDestroyed() bool           { return false }

func TestSettingsThemeSyncAndDockHideOnCollapse(t *testing.T) {
	a, _, _ := openTestApp(t, time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC))
	win := &fakeAppWindow{}
	a.Dock.Attach(win)

	theme := settings.ThemeGraphite
	if _, err := a.SettingsSvc.Update(settings.Patch{Theme: &theme}); err != nil {
		t.Fatalf("SettingsSvc.Update theme: %v", err)
	}
	if win.bg != dock.GraphiteBackgroundColor {
		t.Fatalf("window bg = %q, want %q", win.bg, dock.GraphiteBackgroundColor)
	}

	open := true
	a.Dock.Toggle(&open)
	if win.shown != 1 {
		t.Fatalf("expected window shown once, got %d", win.shown)
	}
	if err := a.DockSvc.Resize(dock.Geometry{Width: 880, Height: 520, Expanded: false}); err != nil {
		t.Fatalf("DockSvc.Resize collapse: %v", err)
	}
	if win.hidden != 1 {
		t.Fatalf("expected window hidden on Resize(expanded=false), got %d", win.hidden)
	}
}

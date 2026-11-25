package migrate

import (
	"bytes"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/muyuzhong/featherlog/internal/clock"
	"github.com/muyuzhong/featherlog/internal/notes"
	"github.com/muyuzhong/featherlog/internal/settings"
	"github.com/muyuzhong/featherlog/internal/store"
	"github.com/muyuzhong/featherlog/internal/tasks"
)

func mustWriteFile(t *testing.T, path string, content []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func snapshotDir(t *testing.T, root string) map[string][]byte {
	t.Helper()
	out := make(map[string][]byte)
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		out[rel] = data
		return nil
	})
	if err != nil {
		t.Fatalf("snapshotDir %s: %v", root, err)
	}
	return out
}

func assertSnapshotsEqual(t *testing.T, before, after map[string][]byte) {
	t.Helper()
	if len(before) != len(after) {
		t.Fatalf("plugins file count changed: before=%d after=%d", len(before), len(after))
	}
	for k, want := range before {
		got, ok := after[k]
		if !ok {
			t.Fatalf("plugins file %q was deleted", k)
		}
		if !bytes.Equal(want, got) {
			t.Fatalf("plugins file %q was modified", k)
		}
	}
}

func TestMigrateSettingsV1ToV2(t *testing.T) {
	dir := t.TempDir()
	st := store.New(dir)
	clk := clock.NewFake(time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC))

	v1Raw := []byte(`{
  "shell": {
    "paper": "vellum",
    "compatMode": false,
    "autoUpdate": true,
    "sound": false,
    "volume": 8
  },
  "plugins": {
    "quest": {
      "dayStartHour": 6
    },
    "scribe": {
      "enabled": true
    }
  }
}`)
	mustWriteFile(t, filepath.Join(dir, settings.FileName), v1Raw)

	report, err := Run(st, clk)
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	if !report.SettingsMigrated {
		t.Fatalf("expected SettingsMigrated=true")
	}
	if report.SettingsBackup != filepath.Join(dir, SettingsBackupFileName) {
		t.Fatalf("SettingsBackup = %q, want %q", report.SettingsBackup, filepath.Join(dir, SettingsBackupFileName))
	}

	bakBytes, err := os.ReadFile(report.SettingsBackup)
	if err != nil {
		t.Fatalf("read backup: %v", err)
	}
	if !bytes.Equal(bakBytes, v1Raw) {
		t.Fatalf("backup bytes differ from original v1 settings.json")
	}

	corruptCalled := false
	svc, err := settings.Open(st, clk, settings.WithCorruptBackupHook(func(string, error) {
		corruptCalled = true
	}))
	if err != nil {
		t.Fatalf("settings.Open failed: %v", err)
	}
	if corruptCalled || svc.BackupPath() != "" {
		t.Fatalf("settings.Open triggered OnCorrupt after migration (backup=%q)", svc.BackupPath())
	}

	got := svc.Get()
	want := settings.Settings{
		Theme:        settings.ThemeStone,
		DayStartHour: 6,
		Sound:        false,
		Volume:       8,
		Pinned:       false,
		BarMode:      settings.BarModeAuto,
	}
	if !settings.Equal(got, want) {
		t.Fatalf("migrated settings = %+v, want %+v", got, want)
	}

	// Second Run must be a no-op and preserve existing backup.
	report2, err := Run(st, clk)
	if err != nil {
		t.Fatalf("second Run failed: %v", err)
	}
	if report2.Migrated() {
		t.Fatalf("expected second Run to be idempotent no-op, got %+v", report2)
	}
}

func TestMigrateSettingsEdgeCases(t *testing.T) {
	clk := clock.NewFake(time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC))

	t.Run("preserves explicit zero values", func(t *testing.T) {
		dir := t.TempDir()
		st := store.New(dir)
		mustWriteFile(t, filepath.Join(dir, settings.FileName), []byte(`{
			"shell": {"sound": false, "volume": 0},
			"plugins": {"quest": {"dayStartHour": 0}}
		}`))

		report, err := Run(st, clk)
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		if !report.SettingsMigrated {
			t.Fatalf("expected SettingsMigrated=true")
		}
		svc, err := settings.Open(st, clk)
		if err != nil {
			t.Fatalf("settings.Open: %v", err)
		}
		got := svc.Get()
		if got.Sound != false || got.Volume != 0 || got.DayStartHour != 0 || got.Theme != settings.ThemeStone || got.Pinned {
			t.Fatalf("unexpected settings: %+v", got)
		}
	})

	t.Run("clamps out of range values", func(t *testing.T) {
		dir := t.TempDir()
		st := store.New(dir)
		mustWriteFile(t, filepath.Join(dir, settings.FileName), []byte(`{
			"shell": {"volume": 42},
			"plugins": {"quest": {"dayStartHour": -3}}
		}`))

		if _, err := Run(st, clk); err != nil {
			t.Fatalf("Run: %v", err)
		}
		svc, err := settings.Open(st, clk)
		if err != nil {
			t.Fatalf("settings.Open: %v", err)
		}
		got := svc.Get()
		if got.Volume != 10 || got.DayStartHour != 0 || !got.Sound {
			t.Fatalf("unexpected clamped settings: %+v", got)
		}
	})

	t.Run("does not overwrite existing settings.v1.json.bak", func(t *testing.T) {
		dir := t.TempDir()
		st := store.New(dir)
		sentinel := []byte(`{"sentinel":"keep-original-backup"}`)
		mustWriteFile(t, filepath.Join(dir, SettingsBackupFileName), sentinel)
		mustWriteFile(t, filepath.Join(dir, settings.FileName), []byte(`{"shell":{"volume":9}}`))

		report, err := Run(st, clk)
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		if !report.SettingsMigrated {
			t.Fatalf("expected SettingsMigrated=true")
		}
		gotBak, err := os.ReadFile(filepath.Join(dir, SettingsBackupFileName))
		if err != nil {
			t.Fatalf("read backup: %v", err)
		}
		if !bytes.Equal(gotBak, sentinel) {
			t.Fatalf("existing backup was overwritten: got %s", string(gotBak))
		}
	})

	t.Run("leaves v2 and corrupt settings untouched", func(t *testing.T) {
		dirV2 := t.TempDir()
		stV2 := store.New(dirV2)
		v2Raw := []byte(`{"theme":"graphite","dayStartHour":5,"sound":false,"volume":3,"pinned":true}`)
		mustWriteFile(t, filepath.Join(dirV2, settings.FileName), v2Raw)

		report, err := Run(stV2, clk)
		if err != nil {
			t.Fatalf("Run v2: %v", err)
		}
		if report.SettingsMigrated {
			t.Fatalf("v2 settings must not be migrated")
		}
		if _, err := os.Stat(filepath.Join(dirV2, SettingsBackupFileName)); !os.IsNotExist(err) {
			t.Fatalf("v2 settings must not create backup")
		}

		dirCorrupt := t.TempDir()
		stCorrupt := store.New(dirCorrupt)
		mustWriteFile(t, filepath.Join(dirCorrupt, settings.FileName), []byte(`{not valid json`))
		reportC, err := Run(stCorrupt, clk)
		if err != nil {
			t.Fatalf("Run corrupt settings should not fail migration: %v", err)
		}
		if reportC.SettingsMigrated {
			t.Fatalf("corrupt settings must be left for settings.Open")
		}
		corruptHooked := false
		if _, err := settings.Open(stCorrupt, clk, settings.WithCorruptBackupHook(func(string, error) {
			corruptHooked = true
		})); err != nil {
			t.Fatalf("settings.Open corrupt: %v", err)
		}
		if !corruptHooked {
			t.Fatalf("expected settings.Open to invoke OnCorrupt on invalid JSON")
		}
	})
}

func TestMigrateQuestsFullScenariosAndTasksOpen(t *testing.T) {
	dir := t.TempDir()
	st := store.New(dir)
	now := time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)
	clk := clock.NewFake(now)

	questDir := filepath.Join(dir, "plugins", "quest")

	stateJSON := `{
		"schemaVersion": 2,
		"quests": [
			{"id": "q-side-active", "key": "record:11111111-1111-1111-1111-111111111111"},
			{"id": "q-main-active", "key": "record:22222222-2222-2222-2222-222222222222"},
			{"id": "q-daily-progress", "key": "record:33333333-3333-3333-3333-333333333333"},
			{"id": "q-daily-done", "key": "record:44444444-4444-4444-4444-444444444444"},
			{"id": "q-completed", "key": "record:55555555-5555-5555-5555-555555555555"},
			{"id": "q-archived", "key": "record:66666666-6666-6666-6666-666666666666"},
			{"id": "q-daily-stale", "key": "record:77777777-7777-7777-7777-777777777777"}
		],
		"meta": {"lastPeriodKey": "2026-11-25"}
	}`
	mustWriteFile(t, filepath.Join(questDir, "state.json"), []byte(stateJSON))

	// 1. Active side quest (untitled chapter, deadline + scheduledFor).
	mustWriteFile(t, filepath.Join(questDir, "record%3A11111111-1111-1111-1111-111111111111.json"), []byte(`{
		"quest": {
			"id": "q-side-active",
			"kind": "side",
			"title": "整理秋招投递表",
			"status": "active",
			"chapters": [
				{
					"id": "ch-side-1",
					"title": "",
					"objectives": [
						{"id": "obj-s1", "text": "汇总岗位链接", "doneAt": "2026-11-24T09:00:00.000Z"},
						{"id": "obj-s2", "text": "跟进内推状态"}
					]
				}
			],
			"deadline": "2026-11-30",
			"scheduledFor": "2026-11-25",
			"order": 3,
			"createdAt": "2026-11-20T08:00:00.000Z",
			"updatedAt": "2026-11-24T09:00:00.000Z"
		},
		"history": []
	}`))

	// 2. Active main quest covering every smart chapter-title merge rule & counted objectives.
	mustWriteFile(t, filepath.Join(questDir, "record%3A22222222-2222-2222-2222-222222222222.json"), []byte(`{
		"quest": {
			"id": "q-main-active",
			"kind": "main",
			"title": "求职与技术提升",
			"status": "active",
			"chapters": [
				{
					"id": "ch-1",
					"title": "简历",
					"objectives": [
						{"id": "obj-m1", "text": "1"}
					]
				},
				{
					"id": "ch-2",
					"title": "完成实习项目包装",
					"deadline": "2026-10-11",
					"doneAt": "2026-11-13T12:25:09.189Z",
					"objectives": [
						{"id": "obj-m2", "text": "完成实习项目包装", "doneAt": "2026-11-13T12:25:09.189Z"}
					]
				},
				{
					"id": "ch-3",
					"title": "经典书籍",
					"objectives": [
						{
							"id": "obj-m3",
							"text": "读完人月神话",
							"count": {"target": 19, "current": 4, "unit": "章"}
						}
					]
				},
				{
					"id": "ch-4",
					"title": "人月神话",
					"objectives": [
						{
							"id": "obj-m4",
							"text": "精读人月神话",
							"count": {"target": 10, "current": 6, "unit": "章"},
							"doneAt": "2026-11-21T10:00:00Z"
						}
					]
				},
				{
					"id": "ch-5",
					"title": "刷题",
					"objectives": [
						{
							"id": "obj-m5",
							"text": "Hot 100",
							"count": {"target": 5, "current": 8, "unit": "题"}
						}
					]
				}
			],
			"order": 1,
			"createdAt": "2026-10-29T16:24:45.897Z",
			"updatedAt": "2026-11-13T12:25:09.189Z"
		},
		"history": []
	}`))

	// 3. Active weekly daily quest with partial quota progress & history.
	mustWriteFile(t, filepath.Join(questDir, "record%3A33333333-3333-3333-3333-333333333333.json"), []byte(`{
		"quest": {
			"id": "q-daily-progress",
			"kind": "daily",
			"title": "算法练习",
			"status": "active",
			"chapters": [],
			"recurrence": {"freq": "weekly", "weekdays": [1, 3, 5]},
			"quota": {"target": 5},
			"cycle": {"periodKey": "2026-11-25", "current": 2, "done": false},
			"order": 0,
			"createdAt": "2026-11-01T08:00:00.000Z",
			"updatedAt": "2026-11-25T07:00:00.000Z"
		},
		"history": ["2026-11-20", "2026-11-23"]
	}`))

	// 4. Daily quest completed for today in v1 (v1 stores status="active", cycle.done=true).
	// Stored with literal colon filename to verify fallback resolution too.
	mustWriteFile(t, filepath.Join(questDir, "record:44444444-4444-4444-4444-444444444444.json"), []byte(`{
		"quest": {
			"id": "q-daily-done",
			"kind": "daily",
			"title": "背八股卡片",
			"status": "active",
			"chapters": [],
			"recurrence": {"freq": "daily"},
			"quota": {"target": 3},
			"cycle": {"periodKey": "2026-11-25", "current": 3, "done": true},
			"order": 1,
			"createdAt": "2026-11-10T08:00:00.000Z",
			"updatedAt": "2026-11-25T08:30:00.000Z"
		},
		"history": ["2026-11-24"]
	}`))

	// 5. Completed non-daily quest (with an incomplete counted objective in v1 JSON to ensure normalization).
	mustWriteFile(t, filepath.Join(questDir, "record%3A55555555-5555-5555-5555-555555555555.json"), []byte(`{
		"quest": {
			"id": "q-completed",
			"kind": "main",
			"title": "完成毕设开题",
			"status": "completed",
			"chapters": [
				{
					"id": "ch-c1",
					"title": "开题报告",
					"objectives": [
						{"id": "obj-c1", "text": "初稿", "count": {"target": 3, "current": 1}}
					]
				}
			],
			"order": 0,
			"createdAt": "2026-10-01T08:00:00.000Z",
			"updatedAt": "2026-11-13T12:25:09.189Z",
			"completedAt": "2026-11-13T12:25:09.189Z"
		},
		"history": []
	}`))

	// 6. Archived quest.
	mustWriteFile(t, filepath.Join(questDir, "record%3A66666666-6666-6666-6666-666666666666.json"), []byte(`{
		"quest": {
			"id": "q-archived",
			"kind": "side",
			"title": "旧计划",
			"status": "archived",
			"chapters": [
				{
					"id": "ch-a1",
					"title": "",
					"objectives": [
						{"id": "obj-a1", "text": "未完成子项"}
					]
				}
			],
			"order": 9,
			"createdAt": "2026-09-01T08:00:00.000Z",
			"updatedAt": "2026-09-10T08:00:00.000Z"
		},
		"history": []
	}`))

	// 7. Daily quest with stale completed cycle from earlier period.
	mustWriteFile(t, filepath.Join(questDir, "record%3A77777777-7777-7777-7777-777777777777.json"), []byte(`{
		"quest": {
			"id": "q-daily-stale",
			"kind": "daily",
			"title": "早起拉伸",
			"status": "active",
			"chapters": [],
			"recurrence": {"freq": "daily"},
			"quota": {"target": 2},
			"cycle": {"periodKey": "2026-11-20", "current": 2, "done": true},
			"order": 2,
			"createdAt": "2026-11-01T08:00:00.000Z",
			"updatedAt": "2026-11-20T07:00:00.000Z"
		},
		"history": ["2026-11-19"]
	}`))

	pluginsBefore := snapshotDir(t, filepath.Join(dir, "plugins"))

	report, err := Run(st, clk)
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	if report.TasksMigrated != 7 || report.TasksSkipped != 0 {
		t.Fatalf("unexpected report: %+v", report)
	}

	// Non-destructive guarantee: plugins/ must be byte-for-byte identical.
	assertSnapshotsEqual(t, pluginsBefore, snapshotDir(t, filepath.Join(dir, "plugins")))

	// Verify tasks.Open validates 100% cleanly against every tasks.validatePersisted invariant!
	taskSvc, err := tasks.Open(st, clk, tasks.WithDayStartHour(4))
	if err != nil {
		t.Fatalf("tasks.Open failed on migrated tasks.json: %v", err)
	}
	defer taskSvc.Close()

	listRes, err := taskSvc.List()
	if err != nil {
		t.Fatalf("tasks.List: %v", err)
	}
	if listRes.PeriodKey != "2026-11-25" {
		t.Fatalf("PeriodKey = %q, want 2026-11-25", listRes.PeriodKey)
	}
	if len(listRes.Tasks) != 7 {
		t.Fatalf("len(tasks) = %d, want 7", len(listRes.Tasks))
	}

	// Verify sequential Order 0..6 and active-first ordering (main -> side -> daily).
	for i, task := range listRes.Tasks {
		if task.Order != i {
			t.Fatalf("task[%d] (%s) Order = %d, want %d", i, task.ID, task.Order, i)
		}
	}
	if listRes.Tasks[0].ID != "q-main-active" || listRes.Tasks[1].ID != "q-side-active" {
		t.Fatalf("unexpected active ordering: [0]=%s [1]=%s", listRes.Tasks[0].ID, listRes.Tasks[1].ID)
	}

	byID := make(map[string]tasks.Task, len(listRes.Tasks))
	for _, tk := range listRes.Tasks {
		byID[tk.ID] = tk
	}

	// Check main quest items & smart chapter-title merges.
	mainTask := byID["q-main-active"]
	if mainTask.Kind != tasks.KindSide || mainTask.Status != tasks.StatusActive {
		t.Fatalf("mainTask kind/status = %s/%s, want side/active", mainTask.Kind, mainTask.Status)
	}
	wantCreatedMs, _ := time.Parse(time.RFC3339Nano, "2026-10-29T16:24:45.897Z")
	if mainTask.CreatedAt != wantCreatedMs.UnixMilli() {
		t.Fatalf("mainTask.CreatedAt = %d, want %d", mainTask.CreatedAt, wantCreatedMs.UnixMilli())
	}
	if len(mainTask.Items) != 5 {
		t.Fatalf("len(mainTask.Items) = %d, want 5: %+v", len(mainTask.Items), mainTask.Items)
	}
	// Item 0: dummy "1" -> "简历"
	if mainTask.Items[0].Text != "简历" || mainTask.Items[0].Done {
		t.Fatalf("item[0] = %+v, want text=简历 done=false", mainTask.Items[0])
	}
	// Item 1: identical chapter & objective text -> "完成实习项目包装", done=true
	if mainTask.Items[1].Text != "完成实习项目包装" || !mainTask.Items[1].Done {
		t.Fatalf("item[1] = %+v, want text=完成实习项目包装 done=true", mainTask.Items[1])
	}
	// Item 2: chapter title + distinct objective -> "经典书籍 · 读完人月神话", 4/19
	if mainTask.Items[2].Text != "经典书籍 · 读完人月神话" || mainTask.Items[2].Done ||
		mainTask.Items[2].Current == nil || *mainTask.Items[2].Current != 4 ||
		mainTask.Items[2].Target == nil || *mainTask.Items[2].Target != 19 {
		t.Fatalf("item[2] = %+v, want 经典书籍 · 读完人月神话 4/19 done=false", mainTask.Items[2])
	}
	// Item 3: obj.Text already contains ch.Title -> "精读人月神话", done=true forces current=target=10
	if mainTask.Items[3].Text != "精读人月神话" || !mainTask.Items[3].Done ||
		mainTask.Items[3].Current == nil || *mainTask.Items[3].Current != 10 ||
		mainTask.Items[3].Target == nil || *mainTask.Items[3].Target != 10 {
		t.Fatalf("item[3] = %+v, want 精读人月神话 10/10 done=true", mainTask.Items[3])
	}
	// Item 4: current > target (8/5) clamped to 5/5 and done=true
	if mainTask.Items[4].Text != "刷题 · Hot 100" || !mainTask.Items[4].Done ||
		mainTask.Items[4].Current == nil || *mainTask.Items[4].Current != 5 ||
		mainTask.Items[4].Target == nil || *mainTask.Items[4].Target != 5 {
		t.Fatalf("item[4] = %+v, want 刷题 · Hot 100 5/5 done=true", mainTask.Items[4])
	}

	// Check side quest.
	sideTask := byID["q-side-active"]
	if sideTask.Deadline != "2026-11-30" || sideTask.ScheduledFor != "2026-11-25" || !sideTask.DueToday {
		t.Fatalf("unexpected sideTask dates: %+v", sideTask)
	}
	if len(sideTask.Items) != 2 || !sideTask.Items[0].Done || sideTask.Items[1].Done {
		t.Fatalf("unexpected sideTask items: %+v", sideTask.Items)
	}

	// Check weekly daily quest in progress.
	dailyProg := byID["q-daily-progress"]
	if dailyProg.Kind != tasks.KindDaily || dailyProg.Status != tasks.StatusActive || !dailyProg.DueToday {
		t.Fatalf("unexpected dailyProg state: %+v", dailyProg)
	}
	if dailyProg.Recurrence == nil || dailyProg.Recurrence.Freq != tasks.FreqWeekly || len(dailyProg.Recurrence.Weekdays) != 3 {
		t.Fatalf("unexpected dailyProg recurrence: %+v", dailyProg.Recurrence)
	}
	if dailyProg.Quota == nil || dailyProg.Quota.Current != 2 || dailyProg.Quota.Target != 5 {
		t.Fatalf("unexpected dailyProg quota: %+v", dailyProg.Quota)
	}
	if dailyProg.Streak == nil || *dailyProg.Streak != 2 {
		t.Fatalf("expected dailyProg streak=2 (Fri 11-20 & Mon 11-23), got %v", dailyProg.Streak)
	}

	// Check daily quest completed today.
	dailyDone := byID["q-daily-done"]
	if dailyDone.Kind != tasks.KindDaily || dailyDone.Status != tasks.StatusCompleted || !dailyDone.DueToday {
		t.Fatalf("unexpected dailyDone state: %+v", dailyDone)
	}
	if dailyDone.Quota == nil || dailyDone.Quota.Current != 3 || dailyDone.Quota.Target != 3 {
		t.Fatalf("unexpected dailyDone quota: %+v", dailyDone.Quota)
	}
	if dailyDone.CompletedAt == nil {
		t.Fatalf("expected dailyDone CompletedAt != nil")
	}
	if dailyDone.Streak == nil || *dailyDone.Streak != 2 {
		t.Fatalf("expected dailyDone streak=2 (11-24 + 11-25), got %v", dailyDone.Streak)
	}

	// Check completed quest.
	compTask := byID["q-completed"]
	wantCompMs, _ := time.Parse(time.RFC3339Nano, "2026-11-13T12:25:09.189Z")
	if compTask.Status != tasks.StatusCompleted || compTask.CompletedAt == nil || *compTask.CompletedAt != wantCompMs.UnixMilli() {
		t.Fatalf("unexpected compTask: %+v", compTask)
	}
	if len(compTask.Items) != 1 || !compTask.Items[0].Done || *compTask.Items[0].Current != 3 || *compTask.Items[0].Target != 3 {
		t.Fatalf("completed quest counted item must have done=true current=target: %+v", compTask.Items)
	}

	// Check archived quest.
	archTask := byID["q-archived"]
	if archTask.Status != tasks.StatusArchived || len(archTask.Items) != 1 || archTask.Items[0].Done {
		t.Fatalf("unexpected archTask: %+v", archTask)
	}

	// Check stale daily quest: stale cycle period added to history, active & reset for 2026-11-25.
	staleTask := byID["q-daily-stale"]
	if staleTask.Status != tasks.StatusActive || staleTask.Quota == nil || staleTask.Quota.Current != 0 || staleTask.Quota.Target != 2 {
		t.Fatalf("unexpected staleTask: %+v", staleTask)
	}
	var rawTasksDoc v2TasksPersistedState
	if found, err := st.ReadJSON(tasks.FileName, &rawTasksDoc); err != nil || !found {
		t.Fatalf("read migrated tasks.json: found=%v err=%v", found, err)
	}
	staleHist := rawTasksDoc.History["q-daily-stale"]
	if len(staleHist) != 2 || staleHist[0] != "2026-11-19" || staleHist[1] != "2026-11-20" {
		t.Fatalf("staleTask history = %v, want [2026-11-19 2026-11-20]", staleHist)
	}

	// Advance clock to next day and re-open tasks.Open: dailyDone must roll over to active
	// while keeping streak=2 from migrated history!
	nextDayClk := clock.NewFake(time.Date(2026, 11, 26, 10, 0, 0, 0, time.UTC))
	taskSvcNext, err := tasks.Open(st, nextDayClk, tasks.WithDayStartHour(4))
	if err != nil {
		t.Fatalf("tasks.Open next day: %v", err)
	}
	defer taskSvcNext.Close()
	rolledDone, err := taskSvcNext.Get("q-daily-done")
	if err != nil {
		t.Fatalf("Get q-daily-done next day: %v", err)
	}
	if rolledDone.Status != tasks.StatusActive || rolledDone.Quota.Current != 0 || rolledDone.Streak == nil || *rolledDone.Streak != 2 {
		t.Fatalf("expected rolled dailyDone active with current=0 streak=2, got %+v", rolledDone)
	}

	// Idempotency: re-running Run when tasks.json already exists must not overwrite it.
	report2, err := Run(st, nextDayClk)
	if err != nil {
		t.Fatalf("second Run: %v", err)
	}
	if report2.TasksMigrated != 0 {
		t.Fatalf("expected TasksMigrated=0 on second run, got %d", report2.TasksMigrated)
	}
	assertSnapshotsEqual(t, pluginsBefore, snapshotDir(t, filepath.Join(dir, "plugins")))
}

func TestMigrateQuestsSchemaVersion1AndCorruptHandling(t *testing.T) {
	clk := clock.NewFake(time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC))

	t.Run("schemaVersion 1 inline quests", func(t *testing.T) {
		dir := t.TempDir()
		st := store.New(dir)
		mustWriteFile(t, filepath.Join(dir, "plugins", "quest", "state.json"), []byte(`{
			"schemaVersion": 1,
			"quests": [
				{
					"id": "q-v1-inline",
					"kind": "side",
					"title": "旧版内联任务",
					"status": "active",
					"chapters": [{"id": "c1", "title": "", "objectives": [{"id": "o1", "text": "完成测试"}]}],
					"order": 0,
					"createdAt": "2026-10-01T10:00:00Z",
					"updatedAt": "2026-10-01T10:00:00Z"
				}
			],
			"history": {},
			"meta": {"lastPeriodKey": "2026-11-25"}
		}`))

		report, err := Run(st, clk)
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		if report.TasksMigrated != 1 {
			t.Fatalf("TasksMigrated = %d, want 1", report.TasksMigrated)
		}
		svc, err := tasks.Open(st, clk)
		if err != nil {
			t.Fatalf("tasks.Open: %v", err)
		}
		defer svc.Close()
		tk, err := svc.Get("q-v1-inline")
		if err != nil || tk.Title != "旧版内联任务" {
			t.Fatalf("Get inline quest: %+v err=%v", tk, err)
		}
	})

	t.Run("skips missing or corrupt individual record files", func(t *testing.T) {
		dir := t.TempDir()
		st := store.New(dir)
		questDir := filepath.Join(dir, "plugins", "quest")
		mustWriteFile(t, filepath.Join(questDir, "state.json"), []byte(`{
			"schemaVersion": 2,
			"quests": [
				{"id": "q-ok", "key": "record:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"},
				{"id": "q-missing", "key": "record:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"},
				{"id": "q-corrupt", "key": "record:cccccccc-cccc-cccc-cccc-cccccccccccc"}
			],
			"meta": {"lastPeriodKey": "2026-11-25"}
		}`))
		mustWriteFile(t, filepath.Join(questDir, "record%3Aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json"), []byte(`{
			"quest": {
				"id": "q-ok",
				"kind": "side",
				"title": "可用任务",
				"status": "active",
				"chapters": [],
				"order": 0,
				"createdAt": "2026-11-20T08:00:00Z",
				"updatedAt": "2026-11-20T08:00:00Z"
			},
			"history": []
		}`))
		mustWriteFile(t, filepath.Join(questDir, "record%3Acccccccc-cccc-cccc-cccc-cccccccccccc.json"), []byte(`{corrupt`))

		report, err := Run(st, clk)
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		if report.TasksMigrated != 1 || report.TasksSkipped != 2 {
			t.Fatalf("report = %+v, want migrated=1 skipped=2", report)
		}
		svc, err := tasks.Open(st, clk)
		if err != nil {
			t.Fatalf("tasks.Open: %v", err)
		}
		defer svc.Close()
		res, err := svc.List()
		if err != nil || len(res.Tasks) != 1 || res.Tasks[0].ID != "q-ok" {
			t.Fatalf("unexpected tasks: %+v err=%v", res, err)
		}
	})

	t.Run("corrupt state.json returns migrate/corrupt error", func(t *testing.T) {
		dir := t.TempDir()
		st := store.New(dir)
		mustWriteFile(t, filepath.Join(dir, "plugins", "quest", "state.json"), []byte(`not-json`))

		_, err := Run(st, clk)
		if err == nil || !store.IsCode(err, ErrCodeCorrupt) {
			t.Fatalf("expected %s error, got %v", ErrCodeCorrupt, err)
		}
	})
}

func TestMigrateNotesV1ToV2AndNotesOpen(t *testing.T) {
	dir := t.TempDir()
	st := store.New(dir)
	clk := clock.NewFake(time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC))

	// Populate one quest so we can verify linked vs dangling questId filtering.
	questDir := filepath.Join(dir, "plugins", "quest")
	mustWriteFile(t, filepath.Join(questDir, "state.json"), []byte(`{
		"schemaVersion": 2,
		"quests": [{"id": "q-linked", "key": "record:11111111-2222-3333-4444-555555555555"}],
		"meta": {"lastPeriodKey": "2026-11-25"}
	}`))
	mustWriteFile(t, filepath.Join(questDir, "record%3A11111111-2222-3333-4444-555555555555.json"), []byte(`{
		"quest": {
			"id": "q-linked",
			"kind": "side",
			"title": "关联任务",
			"status": "active",
			"chapters": [],
			"order": 0,
			"createdAt": "2026-11-20T08:00:00Z",
			"updatedAt": "2026-11-20T08:00:00Z"
		},
		"history": []
	}`))

	notesDir := filepath.Join(dir, "plugins", "notes")
	// 1. Older note linked to valid migrated quest.
	mustWriteFile(t, filepath.Join(notesDir, "note%3An1.json"), []byte(`{
		"schemaVersion": 1,
		"note": {
			"id": "n1",
			"text": "关于关联任务的手记",
			"questId": "q-linked",
			"createdAt": "2026-11-23T08:00:00.000Z",
			"updatedAt": "2026-11-23T09:00:00.000Z"
		}
	}`))
	// 2. Newest standalone note (questId: null).
	mustWriteFile(t, filepath.Join(notesDir, "note%3An2.json"), []byte(`{
		"schemaVersion": 1,
		"note": {
			"id": "n2",
			"text": "最新随笔",
			"questId": null,
			"createdAt": "2026-11-24T08:45:07.118Z",
			"updatedAt": "2026-11-24T08:45:07.118Z"
		}
	}`))
	// 3. Middle note (literal colon filename) referencing non-existent quest -> detached to nil.
	mustWriteFile(t, filepath.Join(notesDir, "note:n3.json"), []byte(`{
		"schemaVersion": 1,
		"note": {
			"id": "n3",
			"text": "已删除任务的手记",
			"questId": "q-deleted",
			"createdAt": "2026-11-24T01:00:00.000Z",
			"updatedAt": "2026-11-24T01:00:00.000Z"
		}
	}`))
	// 4. Empty text note (skipped) and unrelated/tmp files (ignored).
	mustWriteFile(t, filepath.Join(notesDir, "note%3Aempty.json"), []byte(`{
		"schemaVersion": 1,
		"note": {
			"id": "n-empty",
			"text": "   ",
			"questId": null,
			"createdAt": "2026-11-24T02:00:00.000Z",
			"updatedAt": "2026-11-24T02:00:00.000Z"
		}
	}`))
	mustWriteFile(t, filepath.Join(notesDir, "note%3Atemp.json.tmp"), []byte(`{partial`))
	mustWriteFile(t, filepath.Join(notesDir, "README.txt"), []byte(`ignore me`))

	pluginsBefore := snapshotDir(t, filepath.Join(dir, "plugins"))

	report, err := Run(st, clk)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if report.TasksMigrated != 1 || report.NotesMigrated != 3 || report.NotesSkipped != 1 {
		t.Fatalf("unexpected report: %+v", report)
	}
	assertSnapshotsEqual(t, pluginsBefore, snapshotDir(t, filepath.Join(dir, "plugins")))

	// Verify raw notes.json is sorted newest createdAt first.
	var doc v2NotesPersistedState
	if found, err := st.ReadJSON(notes.FileName, &doc); err != nil || !found {
		t.Fatalf("read notes.json: found=%v err=%v", found, err)
	}
	if len(doc.Notes) != 3 || doc.Notes[0].ID != "n2" || doc.Notes[1].ID != "n3" || doc.Notes[2].ID != "n1" {
		t.Fatalf("unexpected notes.json order: %+v", doc.Notes)
	}

	// Verify notes.Open loads cleanly.
	noteSvc, err := notes.Open(st, clk)
	if err != nil {
		t.Fatalf("notes.Open: %v", err)
	}
	got, err := noteSvc.List(notes.ListInput{})
	if err != nil {
		t.Fatalf("notes.List: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("len(notes) = %d, want 3", len(got))
	}
	if got[0].ID != "n2" || got[0].Content != "最新随笔" || got[0].TaskID != nil {
		t.Fatalf("got[0] = %+v", got[0])
	}
	if got[1].ID != "n3" || got[1].Content != "已删除任务的手记" || got[1].TaskID != nil {
		t.Fatalf("got[1] should detach missing questId to nil: %+v", got[1])
	}
	if got[2].ID != "n1" || got[2].Content != "关于关联任务的手记" || got[2].TaskID == nil || *got[2].TaskID != "q-linked" {
		t.Fatalf("got[2] should keep valid questId: %+v", got[2])
	}
	wantN2Ms, _ := time.Parse(time.RFC3339Nano, "2026-11-24T08:45:07.118Z")
	if got[0].CreatedAt != wantN2Ms.UnixMilli() {
		t.Fatalf("n2 CreatedAt = %d, want %d", got[0].CreatedAt, wantN2Ms.UnixMilli())
	}

	// Idempotency: second Run must not touch notes.json.
	report2, err := Run(st, clk)
	if err != nil {
		t.Fatalf("second Run: %v", err)
	}
	if report2.Migrated() {
		t.Fatalf("expected second Run to be no-op, got %+v", report2)
	}
}

func TestMigrateNotesResolvesLinksAgainstExistingTasksJSON(t *testing.T) {
	dir := t.TempDir()
	st := store.New(dir)
	clk := clock.NewFake(time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC))

	// Pre-create v2 tasks.json via tasks.Service (simulating already-migrated tasks.json).
	taskSvc, err := tasks.Open(st, clk)
	if err != nil {
		t.Fatalf("tasks.Open: %v", err)
	}
	existingTask, err := taskSvc.Create(tasks.CreateInput{Title: "已有任务"})
	if err != nil {
		t.Fatalf("tasks.Create: %v", err)
	}
	taskSvc.Close()

	notePayload, _ := json.Marshal(map[string]any{
		"schemaVersion": 1,
		"note": map[string]any{
			"id":        "n-existing",
			"text":      "关联到已有 tasks.json 的任务",
			"questId":   existingTask.ID,
			"createdAt": "2026-11-25T05:00:00Z",
			"updatedAt": "2026-11-25T05:00:00Z",
		},
	})
	mustWriteFile(t, filepath.Join(dir, "plugins", "notes", "note%3An-existing.json"), notePayload)

	report, err := Run(st, clk)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if report.TasksMigrated != 0 || report.NotesMigrated != 1 {
		t.Fatalf("unexpected report: %+v", report)
	}

	noteSvc, err := notes.Open(st, clk)
	if err != nil {
		t.Fatalf("notes.Open: %v", err)
	}
	n, err := noteSvc.Get("n-existing")
	if err != nil {
		t.Fatalf("notes.Get: %v", err)
	}
	if n.TaskID == nil || *n.TaskID != existingTask.ID {
		t.Fatalf("expected TaskID=%q, got %v", existingTask.ID, n.TaskID)
	}
}

func TestMigrateDefensiveInvariants(t *testing.T) {
	clk := clock.NewFake(time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC))

	t.Run("nil store returns migrate/invalid-input", func(t *testing.T) {
		if _, err := Run(nil, clk); !store.IsCode(err, ErrCodeInvalidInput) {
			t.Fatalf("expected %s, got %v", ErrCodeInvalidInput, err)
		}
	})

	t.Run("empty directory is a clean no-op", func(t *testing.T) {
		st := store.New(t.TempDir())
		report, err := Run(st, clk)
		if err != nil {
			t.Fatalf("Run empty: %v", err)
		}
		if report.Migrated() {
			t.Fatalf("expected no-op report, got %+v", report)
		}
	})

	t.Run("normalizes duplicate item IDs, invalid weekdays, invalid dates, and path-traversal keys", func(t *testing.T) {
		dir := t.TempDir()
		st := store.New(dir)
		questDir := filepath.Join(dir, "plugins", "quest")
		mustWriteFile(t, filepath.Join(questDir, "state.json"), []byte(`{
			"schemaVersion": 2,
			"quests": [
				{"id": "q-weird", "key": "record:11111111-1111-1111-1111-111111111111"},
				{"id": "q-bad-daily", "key": "record:22222222-2222-2222-2222-222222222222"},
				{"id": "q-escape", "key": "../escape"}
			],
			"meta": {"lastPeriodKey": "not-a-date"}
		}`))
		mustWriteFile(t, filepath.Join(questDir, "record%3a11111111-1111-1111-1111-111111111111.json"), []byte(`{
			"quest": {
				"id": "q-weird",
				"kind": "main",
				"title": "边界测试",
				"status": "active",
				"deadline": "2026-02-30",
				"scheduledFor": "bad",
				"chapters": [
					{"id": "c1", "title": "甲", "objectives": [{"id": "dup", "text": "第一步"}]},
					{"id": "c2", "title": "乙", "objectives": [{"id": "dup", "text": "第二步"}]}
				],
				"order": 0,
				"createdAt": "bad-timestamp",
				"updatedAt": "2026-11-25T05:00:00Z"
			},
			"history": ["not-a-date"]
		}`))
		mustWriteFile(t, filepath.Join(questDir, "record%3A22222222-2222-2222-2222-222222222222.json"), []byte(`{
			"quest": {
				"id": "q-bad-daily",
				"kind": "daily",
				"title": "坏循环日历",
				"status": "active",
				"recurrence": {"freq": "weekly", "weekdays": [9, -1]},
				"order": 1,
				"createdAt": "2026-11-20T05:00:00Z",
				"updatedAt": "2026-11-20T05:00:00Z"
			},
			"history": ["2026-11-24", "2026-11-24", "invalid"]
		}`))

		report, err := Run(st, clk)
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		if report.TasksMigrated != 2 || report.TasksSkipped != 1 {
			t.Fatalf("report = %+v, want migrated=2 skipped=1", report)
		}

		// Must open cleanly with zero validation errors.
		taskSvc, err := tasks.Open(st, clk)
		if err != nil {
			t.Fatalf("tasks.Open failed: %v", err)
		}
		defer taskSvc.Close()

		weird, err := taskSvc.Get("q-weird")
		if err != nil {
			t.Fatalf("Get q-weird: %v", err)
		}
		if len(weird.Items) != 2 || weird.Items[0].ID == weird.Items[1].ID {
			t.Fatalf("duplicate item IDs were not deduplicated: %+v", weird.Items)
		}
		if weird.Deadline != "" || weird.ScheduledFor != "" {
			t.Fatalf("invalid dates should be cleared: deadline=%q scheduledFor=%q", weird.Deadline, weird.ScheduledFor)
		}

		badDaily, err := taskSvc.Get("q-bad-daily")
		if err != nil {
			t.Fatalf("Get q-bad-daily: %v", err)
		}
		if badDaily.Recurrence == nil || badDaily.Recurrence.Freq != tasks.FreqDaily {
			t.Fatalf("empty/invalid weekly weekdays should fall back to daily: %+v", badDaily.Recurrence)
		}
	})
}

package settings

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/muyuzhong/featherlog/internal/clock"
	"github.com/muyuzhong/featherlog/internal/store"
)

func ptr[T any](v T) *T { return &v }

func TestDefaultsAndPersistence(t *testing.T) {
	dir := t.TempDir()
	st := store.New(dir)
	clk := clock.NewFake(time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC))

	svc, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Open fresh failed: %v", err)
	}
	got := svc.Get()
	want := Default()
	if got != want {
		t.Fatalf("default settings = %+v, want %+v", got, want)
	}
	if got.Theme != ThemeStone || got.DayStartHour != 4 || !got.Sound || got.Volume != 5 || got.Pinned {
		t.Fatalf("unexpected default fields: %+v", got)
	}

	var events []Settings
	unsub := svc.OnChange(func(s Settings) { events = append(events, s) })

	updated, err := svc.Update(Patch{
		Theme:        ptr(ThemeGraphite),
		DayStartHour: ptr(6),
		Sound:        ptr(false),
		Volume:       ptr(10),
		Pinned:       ptr(true),
	})
	if err != nil {
		t.Fatalf("Update failed: %v", err)
	}
	if updated.Theme != ThemeGraphite || updated.DayStartHour != 6 || updated.Sound || updated.Volume != 10 || !updated.Pinned {
		t.Fatalf("updated settings = %+v", updated)
	}
	if len(events) != 1 || events[0] != updated {
		t.Fatalf("expected 1 change event, got %+v", events)
	}

	// No-op update must not trigger another event.
	if _, err := svc.Update(Patch{Theme: ptr(ThemeGraphite)}); err != nil {
		t.Fatalf("no-op Update failed: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("no-op Update should not notify listeners; got %d events", len(events))
	}

	unsub()
	if _, err := svc.Update(Patch{Volume: ptr(0)}); err != nil {
		t.Fatalf("Update volume=0 failed: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("unsubscribed listener should not fire")
	}

	// Reopen from disk and verify persistence.
	reopened, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Reopen failed: %v", err)
	}
	if reopened.Get() != svc.Get() {
		t.Fatalf("reopened = %+v, want %+v", reopened.Get(), svc.Get())
	}
}

func TestValidationBoundaries(t *testing.T) {
	st := store.New(t.TempDir())
	clk := clock.NewFake(time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC))
	svc, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}

	// Valid boundary values.
	for _, p := range []Patch{
		{DayStartHour: ptr(0)},
		{DayStartHour: ptr(23)},
		{Volume: ptr(0)},
		{Volume: ptr(10)},
		{Theme: ptr(ThemeStone)},
		{Theme: ptr(ThemeGraphite)},
	} {
		if _, err := svc.Update(p); err != nil {
			t.Fatalf("expected valid patch %+v to succeed, got %v", p, err)
		}
	}

	// Invalid values must return settings/invalid and keep prior state intact.
	before := svc.Get()
	invalidPatches := []Patch{
		{Theme: ptr(ThemeMode(""))},
		{Theme: ptr(ThemeMode("vellum"))},
		{DayStartHour: ptr(-1)},
		{DayStartHour: ptr(24)},
		{Volume: ptr(-1)},
		{Volume: ptr(11)},
	}
	for _, p := range invalidPatches {
		if _, err := svc.Update(p); !store.IsCode(err, ErrCodeInvalid) {
			t.Fatalf("patch %+v: expected %q, got %v", p, ErrCodeInvalid, err)
		}
		if svc.Get() != before {
			t.Fatalf("invalid patch mutated settings")
		}
	}
}

func TestPartialAndForwardCompatibleJSON(t *testing.T) {
	dir := t.TempDir()
	st := store.New(dir)
	clk := clock.NewFake(time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC))

	// Partial settings + unknown future field should load cleanly without backup.
	raw := `{"theme": "graphite", "unknownFutureOption": 123}`
	if err := os.WriteFile(filepath.Join(dir, FileName), []byte(raw), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	svc, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	if svc.BackupPath() != "" {
		t.Fatalf("did not expect backup for valid partial JSON, got %q", svc.BackupPath())
	}
	got := svc.Get()
	want := Default()
	want.Theme = ThemeGraphite
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestCorruptSettingsBackupAndFallback(t *testing.T) {
	cases := []struct {
		name string
		raw  string
	}{
		{"invalid_json", `{"theme": "stone"`},
		{"empty_file", ""},
		{"top_level_null", "null"},
		{"top_level_array", `["stone"]`},
		{"invalid_theme", `{"theme": "neon"}`},
		{"null_theme", `{"theme": null}`},
		{"float_dayStartHour", `{"dayStartHour": 4.5}`},
		{"oob_dayStartHour", `{"dayStartHour": 24}`},
		{"string_volume", `{"volume": "5"}`},
		{"oob_volume", `{"volume": 11}`},
		{"wrong_sound_type", `{"sound": "true"}`},
		{"null_pinned", `{"pinned": null}`},
	}

	now := time.Date(2026, 5, 10, 12, 34, 56, 789_000_000, time.UTC)

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			st := store.New(dir)
			clk := clock.NewFake(now)
			orig := filepath.Join(dir, FileName)
			if err := os.WriteFile(orig, []byte(tc.raw), 0o600); err != nil {
				t.Fatalf("write fixture: %v", err)
			}

			var hookedBackup string
			var hookedErr error
			svc, err := Open(st, clk,
				WithIDGenerator(func() string { return "fixed-id" }),
				WithCorruptBackupHook(func(backupPath string, cause error) {
					hookedBackup = backupPath
					hookedErr = cause
				}),
			)
			if err != nil {
				t.Fatalf("Open should recover with backup, got error: %v", err)
			}
			if svc.Get() != Default() {
				t.Fatalf("expected fallback to Default(), got %+v", svc.Get())
			}

			wantBase := "settings.json.corrupt-1778416496789-fixed-id"
			if filepath.Base(svc.BackupPath()) != wantBase {
				t.Fatalf("backup base = %q, want %q", filepath.Base(svc.BackupPath()), wantBase)
			}
			if hookedBackup != svc.BackupPath() || hookedErr == nil {
				t.Fatalf("corrupt backup hook not invoked properly: path=%q err=%v", hookedBackup, hookedErr)
			}
			if _, err := os.Stat(orig); !os.IsNotExist(err) {
				t.Fatalf("original corrupt settings.json should have been renamed away")
			}
			saved, err := os.ReadFile(svc.BackupPath())
			if err != nil {
				t.Fatalf("read backup: %v", err)
			}
			if string(saved) != tc.raw {
				t.Fatalf("backup contents = %q, want %q", string(saved), tc.raw)
			}
		})
	}
}

package settings

import (
	"encoding/json"
	jsonv2 "encoding/json/v2"
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
	if got.Theme != ThemeStone || got.Language != LangZH || got.DayStartHour != 4 || !got.Sound || got.Volume != 5 || got.Pinned ||
		got.BarX != nil || got.BarY != nil {
		t.Fatalf("unexpected default fields: %+v", got)
	}

	var events []Settings
	unsub := svc.OnChange(func(s Settings) { events = append(events, s) })

	updated, err := svc.Update(Patch{
		Theme:        ptr(ThemeGraphite),
		Language:     ptr(LangEN),
		DayStartHour: ptr(6),
		Sound:        ptr(false),
		Volume:       ptr(10),
		Pinned:       ptr(true),
	})
	if err != nil {
		t.Fatalf("Update failed: %v", err)
	}
	if updated.Theme != ThemeGraphite || updated.Language != LangEN || updated.DayStartHour != 6 || updated.Sound || updated.Volume != 10 || !updated.Pinned {
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
		{Language: ptr(LangZH)},
		{Language: ptr(LangEN)},
		{Language: ptr(LanguageMode("zh-CN"))},
		{Language: ptr(LanguageMode("zh-Hans"))},
		{Language: ptr(LanguageMode("zh-TW"))},
		{Language: ptr(LanguageMode("en-US"))},
		{Language: ptr(LanguageMode("en-GB"))},
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
		{Language: ptr(LanguageMode(""))},
		{Language: ptr(LanguageMode("fr"))},
		{Language: ptr(LanguageMode("ja-JP"))},
		{Language: ptr(LanguageMode("english"))},
		{Language: ptr(LanguageMode("zh-"))},
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
		{"invalid_language", `{"language": "fr"}`},
		{"empty_language", `{"language": ""}`},
		{"null_language", `{"language": null}`},
		{"int_language", `{"language": 42}`},
		{"float_dayStartHour", `{"dayStartHour": 4.5}`},
		{"oob_dayStartHour", `{"dayStartHour": 24}`},
		{"string_volume", `{"volume": "5"}`},
		{"oob_volume", `{"volume": 11}`},
		{"wrong_sound_type", `{"sound": "true"}`},
		{"null_pinned", `{"pinned": null}`},
		{"only_barX", `{"barX": 420}`},
		{"only_barY", `{"barY": 980}`},
		{"barX_set_barY_null", `{"barX": 420, "barY": null}`},
		{"barX_out_of_range", `{"barX": 32768, "barY": 100}`},
		{"barY_out_of_range", `{"barX": 100, "barY": -32769}`},
		{"barX_float", `{"barX": 420.5, "barY": 980}`},
		{"barX_string", `{"barX": "420", "barY": 980}`},
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

func TestLanguageAndCoordinatesPersistenceAndNoOpEquality(t *testing.T) {
	dir := t.TempDir()
	st := store.New(dir)
	clk := clock.NewFake(time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC))

	svc, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	var events []Settings
	unsub := svc.OnChange(func(s Settings) { events = append(events, s) })
	defer unsub()

	// Set language (normalized from locale) and custom coordinates.
	got, err := svc.Update(Patch{
		Language: ptr(LanguageMode("en-US")),
		BarX:     ptr(420),
		BarY:     ptr(980),
	})
	if err != nil {
		t.Fatalf("Update language + coords: %v", err)
	}
	if got.Language != LangEN || got.BarX == nil || *got.BarX != 420 || got.BarY == nil || *got.BarY != 980 {
		t.Fatalf("unexpected updated settings: %+v", got)
	}
	if len(events) != 1 {
		t.Fatalf("events = %d, want 1", len(events))
	}

	// Mutating the returned pointer must not corrupt internal state.
	*got.BarX = -999
	if cur := svc.Get(); cur.BarX == nil || *cur.BarX != 420 {
		t.Fatalf("caller mutation leaked into Service state: %+v", cur)
	}

	// Re-applying identical coordinate values & normalized language with distinct pointers must be a no-op!
	if _, err := svc.Update(Patch{
		Language: ptr(LanguageMode("en-GB")),
		BarX:     ptr(420),
		BarY:     ptr(980),
	}); err != nil {
		t.Fatalf("no-op coords Update: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("no-op coords Update fired OnChange; got %d events, want 1", len(events))
	}

	// Reopen from disk and verify persistence.
	reopened, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Reopen: %v", err)
	}
	if !settingsEqual(reopened.Get(), svc.Get()) {
		t.Fatalf("reopened = %+v, want %+v", reopened.Get(), svc.Get())
	}

	// JSON RPC null patch clears barX and barY back to nil (both json v1 and json/v2).
	var clearPatch Patch
	if err := json.Unmarshal([]byte(`{"barX": null, "barY": null}`), &clearPatch); err != nil {
		t.Fatalf("json.Unmarshal clearPatch: %v", err)
	}
	cleared, err := svc.Update(clearPatch)
	if err != nil {
		t.Fatalf("Update clearPatch: %v", err)
	}
	if cleared.BarX != nil || cleared.BarY != nil || cleared.Language != LangEN {
		t.Fatalf("cleared settings = %+v, want BarX=nil BarY=nil Language=en", cleared)
	}
	if len(events) != 2 {
		t.Fatalf("events = %d, want 2", len(events))
	}

	// Clearing already-nil coordinates is a no-op.
	if _, err := svc.Update(Patch{ClearBarX: true, ClearBarY: true}); err != nil {
		t.Fatalf("second clear Update: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("second clear should be a no-op; events = %d, want 2", len(events))
	}

	// JSON/v2 set & clear roundtrip (matches MyGo RPC argument decoder), including language normalization.
	var v2Set Patch
	if err := jsonv2.Unmarshal([]byte(`{"language":"zh-Hans","barX":-1200,"barY":1040}`), &v2Set); err != nil {
		t.Fatalf("json/v2 set patch: %v", err)
	}
	if v2Set.Language == nil || *v2Set.Language != LangZH {
		t.Fatalf("v2Set.Language = %v, want zh", v2Set.Language)
	}
	gotV2, err := svc.Update(v2Set)
	if err != nil {
		t.Fatalf("Update v2Set: %v", err)
	}
	if gotV2.Language != LangZH || gotV2.BarX == nil || *gotV2.BarX != -1200 || gotV2.BarY == nil || *gotV2.BarY != 1040 {
		t.Fatalf("gotV2 = %+v", gotV2)
	}

	var v2Clear Patch
	if err := jsonv2.Unmarshal([]byte(`{"barX":null,"barY":null}`), &v2Clear); err != nil {
		t.Fatalf("json/v2 clear patch: %v", err)
	}
	if !v2Clear.ClearBarX || !v2Clear.ClearBarY || v2Clear.BarX != nil || v2Clear.BarY != nil {
		t.Fatalf("v2Clear flags wrong: %+v", v2Clear)
	}
	gotV2Cleared, err := svc.Update(v2Clear)
	if err != nil {
		t.Fatalf("Update v2Clear: %v", err)
	}
	if gotV2Cleared.BarX != nil || gotV2Cleared.BarY != nil {
		t.Fatalf("expected cleared coords, got %+v", gotV2Cleared)
	}

	// Invalid language in Patch JSON (both v1 and v2) returns settings/invalid.
	for _, raw := range []string{`{"language":"fr"}`, `{"language":""}`, `{"language":null}`} {
		var p1 Patch
		if err := json.Unmarshal([]byte(raw), &p1); !store.IsCode(err, ErrCodeInvalid) {
			t.Fatalf("json.Unmarshal(%s): expected %q, got %v", raw, ErrCodeInvalid, err)
		}
		var p2 Patch
		if err := jsonv2.Unmarshal([]byte(raw), &p2); !store.IsCode(err, ErrCodeInvalid) {
			t.Fatalf("jsonv2.Unmarshal(%s): expected %q, got %v", raw, ErrCodeInvalid, err)
		}
	}
}

func TestBarValidationLanguageNormalizationAndLegacyBarModeCompat(t *testing.T) {
	clk := clock.NewFake(time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC))

	// Legacy settings.json containing "barMode": "standalone" (and missing "language")
	// must load cleanly without error or corrupt backup.
	legacyCases := []struct {
		name     string
		raw      string
		wantLang LanguageMode
	}{
		{"legacy_barMode_standalone_default_lang", `{"theme":"graphite","barMode":"standalone","barX":null,"barY":null}`, LangZH},
		{"legacy_barMode_tray_only_en_us", `{"theme":"stone","barMode":"tray-only","language":"en-US"}`, LangEN},
		{"legacy_barMode_null_zh_tw", `{"theme":"stone","barMode":null,"language":"zh-TW"}`, LangZH},
		{"locale_zh_cn", `{"language":"zh-CN"}`, LangZH},
		{"locale_zh_hans_uppercase", `{"language":"ZH-HANS"}`, LangZH},
		{"locale_en_gb", `{"language":"en-GB"}`, LangEN},
		{"locale_en_underscore", `{"language":"en_US"}`, LangEN},
	}
	for _, tc := range legacyCases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			st := store.New(dir)
			if err := os.WriteFile(filepath.Join(dir, FileName), []byte(tc.raw), 0o600); err != nil {
				t.Fatalf("write fixture: %v", err)
			}
			svc, err := Open(st, clk)
			if err != nil {
				t.Fatalf("Open(%s): %v", tc.raw, err)
			}
			if svc.BackupPath() != "" {
				t.Fatalf("unexpected corrupt backup %q for %s", svc.BackupPath(), tc.raw)
			}
			if got := svc.Get(); got.Language != tc.wantLang {
				t.Fatalf("Language = %q, want %q (settings=%+v)", got.Language, tc.wantLang, got)
			}
		})
	}

	// Valid boundary coordinates (-32768..32767).
	dir := t.TempDir()
	st := store.New(dir)
	svc, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	for _, p := range []Patch{
		{BarX: ptr(MinBarCoord), BarY: ptr(MaxBarCoord)},
		{BarX: ptr(MaxBarCoord), BarY: ptr(MinBarCoord)},
		{ClearBarX: true, ClearBarY: true},
	} {
		if _, err := svc.Update(p); err != nil {
			t.Fatalf("expected valid patch %+v to succeed, got %v", p, err)
		}
	}

	// Mismatched/out-of-range coordinates return settings/invalid.
	before := svc.Get()
	for _, p := range []Patch{
		{BarX: ptr(100)},
		{BarY: ptr(200)},
		{BarX: ptr(MinBarCoord - 1), BarY: ptr(0)},
		{BarX: ptr(0), BarY: ptr(MaxBarCoord + 1)},
	} {
		if _, err := svc.Update(p); !store.IsCode(err, ErrCodeInvalid) {
			t.Fatalf("patch %+v: expected %q, got %v", p, ErrCodeInvalid, err)
		}
		if !settingsEqual(svc.Get(), before) {
			t.Fatalf("invalid patch mutated settings")
		}
	}

	// Partial clear (clearing only barX while barY stays set) must fail validation.
	if _, err := svc.Update(Patch{BarX: ptr(100), BarY: ptr(200)}); err != nil {
		t.Fatalf("set coords: %v", err)
	}
	if _, err := svc.Update(Patch{ClearBarX: true}); !store.IsCode(err, ErrCodeInvalid) {
		t.Fatalf("clearing only barX: expected %q, got %v", ErrCodeInvalid, err)
	}
}

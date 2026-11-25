package notes

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/muyuzhong/featherlog/internal/clock"
	"github.com/muyuzhong/featherlog/internal/store"
)

func ptr[T any](v T) *T { return &v }

func TestCreateUpdateDeleteAndValidation(t *testing.T) {
	st := store.New(t.TempDir())
	base := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFake(base)

	svc, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}

	var reasons []string
	svc.OnChange(func(reason string) { reasons = append(reasons, reason) })

	// Validation: empty / whitespace-only / >20000 runes / blank taskId rejected.
	if _, err := svc.Create(CreateInput{Content: "   \n\t  "}); !store.IsCode(err, ErrCodeInvalidInput) {
		t.Fatalf("expected invalid-input for blank note, got %v", err)
	}
	if _, err := svc.Create(CreateInput{Content: strings.Repeat("羽", 20001)}); !store.IsCode(err, ErrCodeInvalidInput) {
		t.Fatalf("expected invalid-input for 20001 runes, got %v", err)
	}
	if _, err := svc.Create(CreateInput{Content: "ok", TaskID: ptr("   ")}); !store.IsCode(err, ErrCodeInvalidInput) {
		t.Fatalf("expected invalid-input for blank taskId, got %v", err)
	}

	// Exact boundary: 20000 runes (with surrounding whitespace trimmed) succeeds.
	maxNote, err := svc.Create(CreateInput{Content: "  " + strings.Repeat("羽", 20000) + "\n"})
	if err != nil {
		t.Fatalf("expected 20000-rune note to succeed, got %v", err)
	}
	if maxNote.TaskID != nil {
		t.Fatalf("expected standalone note TaskID == nil")
	}

	// JSON marshaling must serialize standalone taskId as explicit JSON null.
	raw, err := json.Marshal(maxNote)
	if err != nil {
		t.Fatalf("Marshal note failed: %v", err)
	}
	if !strings.Contains(string(raw), `"taskId":null`) {
		t.Fatalf("expected explicit taskId:null in JSON, got %s", string(raw))
	}

	// Update note content.
	clk.Advance(2 * time.Minute)
	updated, err := svc.Update(UpdateInput{ID: maxNote.ID, Content: "  Updated note\nline 2  "})
	if err != nil {
		t.Fatalf("Update failed: %v", err)
	}
	if updated.Content != "Updated note\nline 2" || updated.UpdatedAt != base.Add(2*time.Minute).UnixMilli() {
		t.Fatalf("unexpected updated note: %+v", updated)
	}

	// No-op update must not bump UpdatedAt or notify.
	clk.Advance(5 * time.Minute)
	same, err := svc.Update(UpdateInput{ID: maxNote.ID, Content: "Updated note\nline 2"})
	if err != nil {
		t.Fatalf("no-op Update failed: %v", err)
	}
	if same.UpdatedAt != updated.UpdatedAt {
		t.Fatalf("no-op update changed UpdatedAt")
	}

	// Delete note.
	if err := svc.Delete(maxNote.ID); err != nil {
		t.Fatalf("Delete failed: %v", err)
	}
	if err := svc.Delete(maxNote.ID); !store.IsCode(err, ErrCodeNotFound) {
		t.Fatalf("expected not-found on second delete, got %v", err)
	}

	wantReasons := []string{"created", "updated", "deleted"}
	if len(reasons) != len(wantReasons) {
		t.Fatalf("reasons = %v, want %v", reasons, wantReasons)
	}
	for i := range wantReasons {
		if reasons[i] != wantReasons[i] {
			t.Fatalf("reasons[%d] = %q, want %q", i, reasons[i], wantReasons[i])
		}
	}
}

func TestListFilteringAndDetachTask(t *testing.T) {
	st := store.New(t.TempDir())
	base := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFake(base)

	svc, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}

	n1, _ := svc.Create(CreateInput{Content: "Standalone Kafka tuning note"})
	clk.Advance(time.Second)
	n2, _ := svc.Create(CreateInput{Content: "Task A: check Wayland layer-shell", TaskID: ptr("task-A")})
	clk.Advance(time.Second)
	n3, _ := svc.Create(CreateInput{Content: "Task A: verify KAFKA consumer lag", TaskID: ptr("task-A")})
	clk.Advance(time.Second)
	n4, _ := svc.Create(CreateInput{Content: "Task B: write unit tests", TaskID: ptr("task-B")})

	// 1. All notes (newest first).
	all, err := svc.List(ListInput{})
	if err != nil || len(all) != 4 {
		t.Fatalf("List all = %d, err=%v", len(all), err)
	}
	if all[0].ID != n4.ID || all[1].ID != n3.ID || all[2].ID != n2.ID || all[3].ID != n1.ID {
		t.Fatalf("expected newest-first ordering, got %+v", all)
	}

	// 2. Standalone only via JSON `"taskId": null`.
	var standaloneIn ListInput
	if err := json.Unmarshal([]byte(`{"taskId":null}`), &standaloneIn); err != nil {
		t.Fatalf("Unmarshal ListInput failed: %v", err)
	}
	standalone, err := svc.List(standaloneIn)
	if err != nil || len(standalone) != 1 || standalone[0].ID != n1.ID {
		t.Fatalf("standalone filter = %+v, err=%v", standalone, err)
	}

	// 3. Task filter + case-insensitive query.
	filtered, err := svc.List(ListInput{TaskID: ptr("task-A"), Query: "kafka"})
	if err != nil || len(filtered) != 1 || filtered[0].ID != n3.ID {
		t.Fatalf("task+query filter = %+v, err=%v", filtered, err)
	}

	// 4. Case-insensitive query across all notes + limit.
	qAll, err := svc.List(ListInput{Query: "kAfKa", Limit: 1})
	if err != nil || len(qAll) != 1 || qAll[0].ID != n3.ID {
		t.Fatalf("query+limit = %+v, err=%v", qAll, err)
	}

	// 5. DetachTask converts task-A notes into standalone 随笔 without deleting them!
	clk.Advance(time.Minute)
	detachedCount, err := svc.DetachTask("task-A")
	if err != nil {
		t.Fatalf("DetachTask failed: %v", err)
	}
	if detachedCount != 2 {
		t.Fatalf("detachedCount = %d, want 2", detachedCount)
	}

	// Total note count must remain 4!
	allAfter, _ := svc.List(ListInput{})
	if len(allAfter) != 4 {
		t.Fatalf("DetachTask must not delete notes: len = %d, want 4", len(allAfter))
	}
	// Standalone count is now 3 (n1, n2, n3).
	standaloneAfter, _ := svc.List(ListInput{FilterByTask: true, TaskID: nil})
	if len(standaloneAfter) != 3 {
		t.Fatalf("expected 3 standalone notes after detach, got %d", len(standaloneAfter))
	}
	// Task-A has 0 notes, Task-B still has 1 note.
	taskAAfter, _ := svc.List(ListInput{TaskID: ptr("task-A")})
	taskBAfter, _ := svc.List(ListInput{TaskID: ptr("task-B")})
	if len(taskAAfter) != 0 || len(taskBAfter) != 1 || taskBAfter[0].ID != n4.ID {
		t.Fatalf("unexpected task notes after detach: A=%d B=%d", len(taskAAfter), len(taskBAfter))
	}

	// Reopen from disk to verify persistence of detached notes.
	reopened, err := Open(st, clk)
	if err != nil {
		t.Fatalf("Reopen failed: %v", err)
	}
	gotN2, err := reopened.Get(n2.ID)
	if err != nil || gotN2.TaskID != nil || gotN2.UpdatedAt != clk.Now().UnixMilli() {
		t.Fatalf("reopened detached note = %+v, err=%v", gotN2, err)
	}
}

func TestCorruptNotesPreserved(t *testing.T) {
	dir := t.TempDir()
	raw := `{"schemaVersion":1,"notes":[broken`
	file := filepath.Join(dir, FileName)
	if err := os.WriteFile(file, []byte(raw), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	clk := clock.NewFake(time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC))
	if _, err := Open(store.New(dir), clk); !store.IsCode(err, store.ErrCodeCorrupt) {
		t.Fatalf("expected store/corrupt, got %v", err)
	}
	after, err := os.ReadFile(file)
	if err != nil || string(after) != raw {
		t.Fatalf("corrupt notes file must stay untouched")
	}
}

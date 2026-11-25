package store

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type sampleDoc struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

func TestDirScoping(t *testing.T) {
	if got := DirName(false); got != "Featherlog" {
		t.Fatalf("prod DirName = %q, want Featherlog", got)
	}
	if got := DirName(true); got != "Featherlog-dev" {
		t.Fatalf("dev DirName = %q, want Featherlog-dev", got)
	}

	root := filepath.Join("/tmp", "cfg")
	if got := DataDirIn(root, false); got != filepath.Join(root, "Featherlog") {
		t.Fatalf("prod DataDirIn = %q", got)
	}
	if got := DataDirIn(root, true); got != filepath.Join(root, "Featherlog-dev") {
		t.Fatalf("dev DataDirIn = %q", got)
	}

	prodDir, err := DataDir(false)
	if err != nil {
		t.Fatalf("DataDir(false) error: %v", err)
	}
	devDir, err := DataDir(true)
	if err != nil {
		t.Fatalf("DataDir(true) error: %v", err)
	}
	if filepath.Base(prodDir) != "Featherlog" {
		t.Fatalf("prodDir base = %q, want Featherlog", filepath.Base(prodDir))
	}
	if filepath.Base(devDir) != "Featherlog-dev" {
		t.Fatalf("devDir base = %q, want Featherlog-dev", filepath.Base(devDir))
	}
	if filepath.Dir(prodDir) != filepath.Dir(devDir) {
		t.Fatalf("expected same parent config dir: %q vs %q", prodDir, devDir)
	}
}

func TestAtomicWriteAndReadJSON(t *testing.T) {
	dir := t.TempDir()
	st := New(dir)

	var out sampleDoc
	found, err := st.ReadJSON("data.json", &out)
	if err != nil || found {
		t.Fatalf("missing file: got found=%v err=%v, want false, nil", found, err)
	}

	want := sampleDoc{Name: "alpha", Count: 42}
	if err := st.WriteJSON("data.json", want); err != nil {
		t.Fatalf("WriteJSON failed: %v", err)
	}

	found, err = st.ReadJSON("data.json", &out)
	if err != nil || !found {
		t.Fatalf("ReadJSON failed: found=%v err=%v", found, err)
	}
	if out != want {
		t.Fatalf("got %+v, want %+v", out, want)
	}

	// Ensure no leftover .tmp files remain after atomic rename.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir failed: %v", err)
	}
	if len(entries) != 1 || entries[0].Name() != "data.json" {
		t.Fatalf("unexpected files in dir: %v", entries)
	}

	// Check permissions (0600 on Unix).
	info, err := os.Stat(filepath.Join(dir, "data.json"))
	if err != nil {
		t.Fatalf("Stat failed: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("file perm = %o, want 0600", perm)
	}
}

func TestCorruptJSONPreserved(t *testing.T) {
	cases := []struct {
		name    string
		payload string
	}{
		{"invalid_syntax", `{"name": "broken"`},
		{"empty_file", ""},
		{"whitespace_only", "   \n\t  "},
		{"top_level_null", "null"},
		{"trailing_garbage", `{"name":"ok","count":1}{"extra":2}`},
		{"wrong_type", `{"name": 123, "count": "bad"}`},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			st := New(dir)
			file := filepath.Join(dir, "broken.json")
			if err := os.WriteFile(file, []byte(tc.payload), 0o600); err != nil {
				t.Fatalf("write fixture: %v", err)
			}

			var out sampleDoc
			found, err := st.ReadJSON("broken.json", &out)
			if found {
				t.Fatalf("expected found=false for corrupt file")
			}
			if !IsCode(err, ErrCodeCorrupt) {
				t.Fatalf("expected error code %q, got %q (%v)", ErrCodeCorrupt, CodeOf(err), err)
			}

			// Critical invariant: corrupt file must remain untouched on disk!
			after, readErr := os.ReadFile(file)
			if readErr != nil {
				t.Fatalf("corrupt file disappeared or unreadable: %v", readErr)
			}
			if string(after) != tc.payload {
				t.Fatalf("corrupt file was modified: got %q, want %q", string(after), tc.payload)
			}
		})
	}
}

func TestBackupCorrupt(t *testing.T) {
	dir := t.TempDir()
	st := New(dir)
	raw := "{bad json"
	orig := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(orig, []byte(raw), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	backup, err := st.BackupCorrupt("settings.json", 1700000000123, "id-1")
	if err != nil {
		t.Fatalf("BackupCorrupt failed: %v", err)
	}
	wantSuffix := "settings.json.corrupt-1700000000123-id-1"
	if filepath.Base(backup) != wantSuffix {
		t.Fatalf("backup base = %q, want %q", filepath.Base(backup), wantSuffix)
	}
	if _, err := os.Stat(orig); !os.IsNotExist(err) {
		t.Fatalf("original file should have been moved")
	}
	got, err := os.ReadFile(backup)
	if err != nil {
		t.Fatalf("read backup: %v", err)
	}
	if string(got) != raw {
		t.Fatalf("backup contents = %q, want %q", string(got), raw)
	}
}

func TestPathValidation(t *testing.T) {
	st := New(t.TempDir())
	badNames := []string{"", "   ", "../escape.json", "/abs/path.json", "a/../../escape.json", "."}
	for _, name := range badNames {
		if _, err := st.Path(name); !IsCode(err, ErrCodeInvalid) {
			t.Fatalf("Path(%q): expected %q, got %v", name, ErrCodeInvalid, err)
		}
	}
	good, err := st.Path("sub/file.json")
	if err != nil || !strings.HasSuffix(good, filepath.Join("sub", "file.json")) {
		t.Fatalf("Path(sub/file.json) failed: %q, %v", good, err)
	}
}

func TestDeleteAndConcurrentWrites(t *testing.T) {
	st := New(t.TempDir())

	// Delete missing file is a no-op.
	if err := st.Delete("nope.json"); err != nil {
		t.Fatalf("Delete missing failed: %v", err)
	}

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			doc := sampleDoc{Name: fmt.Sprintf("v-%d", i), Count: i}
			if err := st.WriteJSON("concurrent.json", doc); err != nil {
				t.Errorf("WriteJSON %d failed: %v", i, err)
			}
			var got sampleDoc
			if _, err := st.ReadJSON("concurrent.json", &got); err != nil {
				t.Errorf("ReadJSON %d failed: %v", i, err)
			}
		}(i)
	}
	wg.Wait()

	var final sampleDoc
	found, err := st.ReadJSON("concurrent.json", &final)
	if err != nil || !found {
		t.Fatalf("final ReadJSON failed: found=%v err=%v", found, err)
	}

	if err := st.Delete("concurrent.json"); err != nil {
		t.Fatalf("Delete failed: %v", err)
	}
	found, err = st.ReadJSON("concurrent.json", &final)
	if err != nil || found {
		t.Fatalf("expected deleted file to be absent: found=%v err=%v", found, err)
	}
}

func TestNewIDUnique(t *testing.T) {
	seen := make(map[string]struct{}, 100)
	for i := 0; i < 100; i++ {
		id := NewID()
		if len(id) != 36 {
			t.Fatalf("unexpected UUID length %d: %q", len(id), id)
		}
		if _, dup := seen[id]; dup {
			t.Fatalf("duplicate ID generated: %q", id)
		}
		seen[id] = struct{}{}
	}
}

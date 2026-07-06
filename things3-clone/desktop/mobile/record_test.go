package mobile

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

// TestRecordWrapper exercises the exact gomobile-bound API the iOS app calls
// (RecordOpen/Hydrate/QueryList/ToggleComplete), running the same Go code that is
// compiled into RecordMobile.xcframework — so it verifies the native record path
// without an iOS build.
func TestRecordWrapper(t *testing.T) {
	if err := RecordOpen(filepath.Join(t.TempDir(), "rec.db")); err != nil {
		t.Fatalf("open: %v", err)
	}

	// Hydrate the app's task shape (status + numeric order): two Today tasks and a
	// future one that must NOT be in Today.
	tasks := `[
	  {"id":"a","title":"Buy milk","when":"today","status":"open","order":1},
	  {"id":"b","title":"Reply to Sam","when":"evening","status":"open","order":2},
	  {"id":"c","title":"Book flights","when":"2999-01-01","status":"open","order":3}
	]`
	if err := RecordHydrate(tasks); err != nil {
		t.Fatalf("hydrate: %v", err)
	}
	if has, err := RecordHasData(); err != nil || !has {
		t.Fatalf("hasData = %v, %v", has, err)
	}

	todayRows := func() []map[string]any {
		s, err := RecordQueryList("today", "2026-07-06")
		if err != nil {
			t.Fatalf("queryList: %v", err)
		}
		var rows []map[string]any
		if err := json.Unmarshal([]byte(s), &rows); err != nil {
			t.Fatalf("bad rows json %q: %v", s, err)
		}
		return rows
	}

	// Today = a (today) + b (evening), not c (future).
	if rows := todayRows(); len(rows) != 2 {
		t.Fatalf("today = %d rows, want 2: %+v", len(rows), rows)
	}

	// Complete a via the native toggle → it leaves Today.
	if err := RecordToggleComplete("a", true); err != nil {
		t.Fatalf("toggle: %v", err)
	}
	rows := todayRows()
	if len(rows) != 1 || rows[0]["id"] != "b" {
		t.Fatalf("after toggle, today = %+v (want just b)", rows)
	}

	// A title FTS search hits through the wrapper too.
	s, err := RecordSearchTasks("book", "{}")
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	var found []map[string]any
	_ = json.Unmarshal([]byte(s), &found)
	if len(found) != 1 || found[0]["id"] != "c" {
		t.Fatalf("search 'book' = %s", s)
	}
}

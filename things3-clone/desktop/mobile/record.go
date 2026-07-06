// gomobile bindings for the query-oriented record layer (core/record) — the native
// RecordStore adapter for iOS/Android. Mirrors the web adapter (public/record.worker.js)
// method-for-method, so the React Native RecordStore port has the same API on every
// platform. Like the rest of this package, every method speaks JSON strings (the only
// shape gomobile carries across the language boundary) — the RN native module bridges
// these to JS. See docs/architecture-1m.md §5.
package mobile

import (
	"encoding/json"
	"errors"
	"sync"

	"things3-clone-desktop/core/record"
)

var (
	recMu sync.Mutex
	rec   *record.Store
)

var errRecNotOpen = errors.New("record: store not open (call RecordOpen first)")

// RecordOpen opens/creates the record-layer SQLite database at path (the app's
// writable files dir + a filename, supplied by the native side).
func RecordOpen(path string) error {
	recMu.Lock()
	defer recMu.Unlock()
	r, err := record.Open(path)
	if err != nil {
		return err
	}
	rec = r
	return nil
}

// RecordHasData reports whether the store holds any task.
func RecordHasData() (bool, error) {
	recMu.Lock()
	defer recMu.Unlock()
	if rec == nil {
		return false, errRecNotOpen
	}
	n, err := rec.CountTasks(record.Query{})
	return n > 0, err
}

// RecordHydrate imports the app's current tasks (a JSON array of the mapped task
// shape) into the store — the initial-sync/seed path.
func RecordHydrate(tasksJSON string) error {
	recMu.Lock()
	defer recMu.Unlock()
	if rec == nil {
		return errRecNotOpen
	}
	var tasks []record.TaskInput
	if err := json.Unmarshal([]byte(tasksJSON), &tasks); err != nil {
		return err
	}
	return rec.BulkLoad(tasks, 5000)
}

// RecordQueryList runs a smart-list query (e.g. "today") and returns JSON rows.
func RecordQueryList(listID, todayKey string) (string, error) {
	recMu.Lock()
	defer recMu.Unlock()
	if rec == nil {
		return "", errRecNotOpen
	}
	rows, err := rec.QueryList(listID, todayKey)
	return marshalRows(rows, err)
}

// RecordQueryTasks runs a paged/filtered query (JSON-encoded record.Query) and
// returns JSON rows.
func RecordQueryTasks(queryJSON string) (string, error) {
	recMu.Lock()
	defer recMu.Unlock()
	if rec == nil {
		return "", errRecNotOpen
	}
	q, err := parseQuery(queryJSON)
	if err != nil {
		return "", err
	}
	rows, err := rec.QueryTasks(q)
	return marshalRows(rows, err)
}

// RecordSearchTasks runs a title FTS query intersected with the JSON query filters.
func RecordSearchTasks(text, queryJSON string) (string, error) {
	recMu.Lock()
	defer recMu.Unlock()
	if rec == nil {
		return "", errRecNotOpen
	}
	q, err := parseQuery(queryJSON)
	if err != nil {
		return "", err
	}
	rows, err := rec.SearchTasks(text, q)
	return marshalRows(rows, err)
}

// RecordCountTasks returns the count matching the JSON query.
func RecordCountTasks(queryJSON string) (int, error) {
	recMu.Lock()
	defer recMu.Unlock()
	if rec == nil {
		return 0, errRecNotOpen
	}
	q, err := parseQuery(queryJSON)
	if err != nil {
		return 0, err
	}
	return rec.CountTasks(q)
}

// RecordGetTask returns the full task object as JSON, or "" if absent.
func RecordGetTask(id string) (string, error) {
	recMu.Lock()
	defer recMu.Unlock()
	if rec == nil {
		return "", errRecNotOpen
	}
	obj, err := rec.GetTask(id)
	if err != nil || obj == nil {
		return "", err
	}
	b, err := json.Marshal(obj)
	return string(b), err
}

// RecordCreateTask inserts one task (JSON of the mapped task shape); returns its id.
func RecordCreateTask(taskJSON string) (string, error) {
	recMu.Lock()
	defer recMu.Unlock()
	if rec == nil {
		return "", errRecNotOpen
	}
	var t record.TaskInput
	if err := json.Unmarshal([]byte(taskJSON), &t); err != nil {
		return "", err
	}
	return rec.CreateTask(t)
}

// RecordToggleComplete sets a task's completion (status).
func RecordToggleComplete(id string, completed bool) error {
	recMu.Lock()
	defer recMu.Unlock()
	if rec == nil {
		return errRecNotOpen
	}
	return rec.ToggleComplete(id, completed)
}

// RecordMoveTask reorders a task between beforeID and afterID (fractional rank).
func RecordMoveTask(id, beforeID, afterID string) error {
	recMu.Lock()
	defer recMu.Unlock()
	if rec == nil {
		return errRecNotOpen
	}
	return rec.MoveTask(id, beforeID, afterID)
}

// RecordSetTaskField sets one scalar field (valueJSON is the JSON-encoded value).
func RecordSetTaskField(id, field, valueJSON string) error {
	recMu.Lock()
	defer recMu.Unlock()
	if rec == nil {
		return errRecNotOpen
	}
	var v any
	if err := json.Unmarshal([]byte(valueJSON), &v); err != nil {
		return err
	}
	return rec.SetTaskField(id, field, v)
}

// RecordDeleteTask tombstones a task.
func RecordDeleteTask(id string) error {
	recMu.Lock()
	defer recMu.Unlock()
	if rec == nil {
		return errRecNotOpen
	}
	return rec.DeleteTask(id)
}

// ---- helpers ----

func parseQuery(queryJSON string) (record.Query, error) {
	var q record.Query
	if queryJSON == "" {
		return q, nil
	}
	err := json.Unmarshal([]byte(queryJSON), &q)
	return q, err
}

func marshalRows(rows []record.TaskRow, err error) (string, error) {
	if err != nil {
		return "", err
	}
	if rows == nil {
		return "[]", nil
	}
	b, err := json.Marshal(rows)
	return string(b), err
}

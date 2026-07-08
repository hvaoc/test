package record

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"testing"
	"time"
)

// TestPerf1M measures that, with N (default 1,000,000) tasks already loaded, the
// interactive operations a real app performs — smart-list queries, custom-view filters
// with every operator, full-text search, counts, and point writes — stay snappy. It is
// NOT a bulk-seed benchmark: seeding is a one-time import; what must not be sluggish is
// everything you do AFTER the data is there.
//
// Gated behind RECORD_PERF=1 so a normal `go test ./...` never pays the multi-minute
// load. Tunables: RECORD_PERF_N (rows), RECORD_PERF_ITERS (samples per op).
//
//	RECORD_PERF=1 go test ./core/record -run TestPerf1M -timeout 30m -v
//
// Pass bar (median, tunable via env): interactive queries < 100ms, point writes < 20ms.
// A FAIL means an operation regressed past the ceiling — i.e. it would feel sluggish.
func TestPerf1M(t *testing.T) {
	if os.Getenv("RECORD_PERF") == "" {
		t.Skip("perf test: set RECORD_PERF=1 to run (multi-minute; not for normal CI)")
	}
	n := envInt("RECORD_PERF_N", 1_000_000)
	iters := envInt("RECORD_PERF_ITERS", 30)
	// Ceilings (median). Generous so a shared CI box doesn't flake, but tight enough to
	// catch a full-table-scan regression at 1M rows.
	const queryCeilMs = 100.0
	const writeCeilMs = 20.0

	dir := t.TempDir()
	s, err := Open(filepath.Join(dir, "perf.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	today := time.Now().UTC().Format("2006-01-02")

	// ---- load (timed, but NOT part of the pass bar) ----
	t.Logf("building %d task inputs…", n)
	tasks := makePerfTasks(n, today)
	loadStart := time.Now()
	if err := s.BulkLoad(tasks, 50000); err != nil {
		t.Fatalf("bulk load: %v", err)
	}
	if err := s.Checkpoint(); err != nil {
		t.Fatalf("checkpoint: %v", err)
	}
	loadDur := time.Since(loadStart)
	t.Logf("loaded %d tasks in %s (%.0f rows/sec)", n, loadDur.Round(time.Millisecond), float64(n)/loadDur.Seconds())

	if got, _ := s.CountTasks(Query{}); got != n {
		t.Fatalf("expected %d rows loaded, got %d", n, got)
	}

	// projectIds we spread across, for realistic IN / = filters.
	projMid := "proj-" + strconv.Itoa(nProjects/2)
	projIn := []any{"proj-1", "proj-2", "proj-3", "proj-7", "proj-42"}

	type bench struct {
		group string
		name  string
		write bool // point write (different ceiling); measured with a fresh id each iter
		run   func(i int) error
	}
	benches := []bench{
		// ---- Smart Lists (the built-in views) ----
		{group: "Smart Lists", name: "Today list", run: func(int) error { _, e := s.QueryList("today", today); return e }},
		{group: "Smart Lists", name: "Anytime/Inbox list (open, ranked)", run: func(int) error {
			_, e := s.QueryTasks(Query{OnlyOpen: true, Limit: 200})
			return e
		}},
		{group: "Smart Lists", name: "Logbook list (completed)", run: func(int) error {
			_, e := s.QueryTasks(Query{OnlyComplete: true, Limit: 200})
			return e
		}},
		// ---- Custom Views & Filters (every operator on task fields) ----
		{group: "Custom Views & Filters", name: "priority >= 2 (open)", run: func(int) error {
			_, e := s.QueryTasks(Query{OnlyOpen: true, Conditions: []Cond{{"priority", ">=", []any{2}}}, Limit: 200})
			return e
		}},
		{group: "Custom Views & Filters", name: "when = today", run: func(int) error {
			_, e := s.QueryTasks(Query{Conditions: []Cond{{"when", "=", []any{"today"}}}, Limit: 200})
			return e
		}},
		{group: "Custom Views & Filters", name: "deadline <= today", run: func(int) error {
			_, e := s.QueryTasks(Query{Conditions: []Cond{{"deadline", "<=", []any{today}}}, Limit: 200})
			return e
		}},
		{group: "Custom Views & Filters", name: "projectId IN [5]", run: func(int) error {
			_, e := s.QueryTasks(Query{Conditions: []Cond{{"projectId", "in", projIn}}, Limit: 200})
			return e
		}},
		{group: "Custom Views & Filters", name: "projectId = one", run: func(int) error {
			_, e := s.QueryTasks(Query{ProjectID: projMid, Limit: 200})
			return e
		}},
		{group: "Custom Views & Filters", name: "priority IN [2,3] AND open", run: func(int) error {
			_, e := s.QueryTasks(Query{OnlyOpen: true, Conditions: []Cond{{"priority", "in", []any{2, 3}}}, Limit: 200})
			return e
		}},
		{group: "Custom Views & Filters", name: "priority != 0", run: func(int) error {
			_, e := s.QueryTasks(Query{Conditions: []Cond{{"priority", "!=", []any{0}}}, Limit: 200})
			return e
		}},
		// ---- Search (offline FTS over titles) ----
		{group: "Search", name: "full-text search", run: func(int) error { _, e := s.SearchTasks("alpha", Query{Limit: 200}); return e }},
		{group: "Search", name: "search + open filter", run: func(int) error {
			_, e := s.SearchTasks("bravo", Query{OnlyOpen: true, Limit: 200})
			return e
		}},
		// ---- Counts (view badges) ----
		{group: "Counts (badges)", name: "count open", run: func(int) error { _, e := s.CountTasks(Query{OnlyOpen: true}); return e }},
		{group: "Counts (badges)", name: "count priority >= 2", run: func(int) error {
			_, e := s.CountTasks(Query{Conditions: []Cond{{"priority", ">=", []any{2}}}})
			return e
		}},
		// ---- Task CRUD & Fields (point reads/writes) ----
		{group: "Task CRUD & Fields", name: "open task (read all fields)", run: func(i int) error { _, e := s.GetTask(taskID(i % n)); return e }},
		{group: "Task CRUD & Fields", name: "edit title", write: true, run: func(i int) error {
			return s.SetTaskField(taskID(i%n), "title", "edited "+strconv.Itoa(i))
		}},
		{group: "Task CRUD & Fields", name: "set when=today", write: true, run: func(i int) error {
			return s.SetTaskField(taskID(i%n), "when", "today")
		}},
		{group: "Task CRUD & Fields", name: "set priority", write: true, run: func(i int) error {
			return s.SetTaskField(taskID(i%n), "priority", (i%3)+1)
		}},
		{group: "Task CRUD & Fields", name: "complete / reopen", write: true, run: func(i int) error { return s.ToggleComplete(taskID(i%n), i%2 == 0) }},
		{group: "Task CRUD & Fields", name: "add tag", write: true, run: func(i int) error { return s.AddTag(taskID(i%n), "perf-tag") }},
		{group: "Task CRUD & Fields", name: "create task", write: true, run: func(i int) error {
			_, e := s.CreateTask(TaskInput{Title: "new perf task", ProjectID: "proj-1", Priority: 1})
			return e
		}},
		// ---- Reorder (drag-to-reorder = fractional rank between neighbours) ----
		{group: "Reorder / Move", name: "reorder task (rank between)", write: true, run: func(i int) error {
			return s.MoveTask(taskID(i%n), taskID((i+1)%n), taskID((i+2)%n))
		}},
		// ---- Delete (destructive — kept last so it doesn't shrink the set mid-run) ----
		{group: "Delete", name: "delete task (→ trash)", write: true, run: func(i int) error { return s.DeleteTask(taskID(i % n)) }},
	}

	type opResult struct {
		Group             string  `json:"group"`
		Name              string  `json:"name"`
		Write             bool    `json:"write"`
		P50               float64 `json:"p50"`
		P95               float64 `json:"p95"`
		Max               float64 `json:"max"`
		Min               float64 `json:"min"`
		Status            string  `json:"status"` // pass | slow
		p50, p95, max, mn float64
	}
	results := make([]opResult, 0, len(benches))
	for _, b := range benches {
		samples := make([]float64, 0, iters)
		for i := 0; i < iters; i++ {
			start := time.Now()
			if err := b.run(i); err != nil {
				t.Fatalf("%s: %v", b.name, err)
			}
			samples = append(samples, float64(time.Since(start).Microseconds())/1000.0)
		}
		p50, p95, mx, mn := stats(samples)
		ceil := queryCeilMs
		if b.write {
			ceil = writeCeilMs
		}
		status := "pass"
		if p50 > ceil {
			status = "slow"
		}
		results = append(results, opResult{b.group, b.name, b.write, p50, p95, mx, mn, status, p50, p95, mx, mn})
	}

	// ---- report (log + optional JSON for the test-report matrix) ----
	t.Logf("=== record engine perf (N=%d, iters=%d) — milliseconds ===", n, iters)
	t.Logf("%-40s %8s %8s %8s %8s  %s", "operation", "min", "p50", "p95", "max", "status")
	var failures []string
	for _, r := range results {
		t.Logf("%-40s %8.2f %8.2f %8.2f %8.2f  %s", r.Group+" / "+r.Name, r.mn, r.p50, r.p95, r.max, r.Status)
		if r.Status == "slow" {
			failures = append(failures, fmt.Sprintf("%s: p50 %.1fms", r.Name, r.p50))
		}
	}

	if out := os.Getenv("RECORD_PERF_JSON"); out != "" {
		rep := map[string]any{
			"platform":    "record-engine (Go core/record, SQLite)",
			"represents":  []string{"desktop", "ios", "android"},
			"size":        n,
			"iters":       iters,
			"setupLoadMs": float64(loadDur.Microseconds()) / 1000.0,
			"results":     results,
		}
		b, _ := json.MarshalIndent(rep, "", "  ")
		if err := os.WriteFile(out, b, 0o644); err != nil {
			t.Fatalf("write report json: %v", err)
		}
		t.Logf("wrote report JSON: %s", out)
	}

	// In report mode (RECORD_PERF_JSON set) we don't fail on slow ops — we record their
	// status. In gating mode we fail so a regression breaks CI.
	if os.Getenv("RECORD_PERF_JSON") == "" {
		for _, f := range failures {
			t.Errorf("SLUGGISH: %s", f)
		}
	}
}

// ---- helpers ----

const nProjects = 1000

func taskID(i int) string { return fmt.Sprintf("t-%08d", i) }

// makePerfTasks builds N tasks with a REALISTIC distribution — the point of a 1M test is
// realistic scale, not a pathological one. A real 1M-task workspace has dozens (not
// hundreds of thousands) of tasks due today, most tasks undated (anytime/someday/inbox),
// diverse titles, and priority skewed to "none". Deterministic (index-derived, no RNG):
//   - titles: pseudo-words for diversity, with the known search terms "alpha"/"bravo"
//     injected sparsely (~1 in ~1010) so a search matches a realistic ~1k rows, not 1/10.
//   - when: ~0.05% today, ~0.05% evening, ~0.1% overdue-dated, ~0.2% upcoming, ~1/3
//     someday, rest undated.
//   - deadline: a small % dated (mostly empty → "deadline<=today" is a non-selective
//     range that must fall back to the rank-walk, which the partial index allows).
//   - priority: ~70% none(0), ~30% 1..3.  completed: ~1/7.
func makePerfTasks(n int, today string) []TaskInput {
	out := make([]TaskInput, n)
	pastDates := []string{"2025-01-01", "2026-06-01", "2026-07-01"}    // <= today (2026-07-06)
	futureDates := []string{"2026-08-15", "2026-12-31", "2027-03-10"}  // > today
	for i := 0; i < n; i++ {
		title := fmt.Sprintf("w%d w%d task %d", i%1000, (i/1000)%1000, i)
		if i%1009 == 0 {
			title = "alpha " + title // ~n/1009 rows carry the search term "alpha"
		}
		if i%1013 == 0 {
			title = "bravo " + title
		}
		when, deadline := "", ""
		switch {
		case i%2000 == 0:
			when = "today" // ~0.05%
		case i%2000 == 1:
			when = "evening" // ~0.05%
		case i%1000 == 5:
			when = pastDates[i%len(pastDates)] // overdue when ~0.1%
		case i%500 == 7:
			when = futureDates[i%len(futureDates)] // upcoming ~0.2%
		case i%3 == 0:
			when = "someday" // ~1/3
		}
		if i%700 == 3 {
			deadline = pastDates[i%len(pastDates)] // overdue deadline
		} else if i%400 == 9 {
			deadline = futureDates[i%len(futureDates)]
		}
		priority := 0
		if i%10 < 3 {
			priority = 1 + i%3 // ~30% carry a priority; ~a third of those are >=2
		}
		status, completed := "open", false
		if i%7 == 0 {
			status, completed = "completed", true // ~14%
		}
		out[i] = TaskInput{
			ID:        taskID(i),
			Title:     title,
			ProjectID: fmt.Sprintf("proj-%d", i%nProjects),
			When:      when,
			Deadline:  deadline,
			Priority:  priority,
			Status:    status,
			Completed: completed,
			Order:     float64(i),
			Rank:      fmt.Sprintf("%012d", i), // pre-assigned so BulkLoad skips MAX() lookups
		}
	}
	return out
}

func stats(s []float64) (p50, p95, mx, mn float64) {
	if len(s) == 0 {
		return
	}
	sort.Float64s(s)
	mn, mx = s[0], s[len(s)-1]
	p50 = s[len(s)*50/100]
	p95 = s[min(len(s)*95/100, len(s)-1)]
	return
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}

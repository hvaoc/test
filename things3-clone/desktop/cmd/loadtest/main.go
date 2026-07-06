// Command loadtest is the "prove-the-wall" harness from docs/architecture-1m.md.
//
// It drives the LIVE ygo whole-document engine (core/ydoc) at increasing task
// counts and reports the numbers that decide the 1M re-architecture:
//
//   - heap:      resident Go heap after the whole workspace is loaded (the CRDT
//     holds every entity's root map + notes YText + tag map in memory)
//   - snapshot:  bytes of EncodeAll (the persisted blob / first-sync payload)
//   - load:      ApplyLocalSnapshot time (decode the app's whole-state snapshot)
//   - material:  Materialize time (rebuild the whole-state JSON the UI consumes)
//   - fulldiff:  EncodeDiff(nil) time — first-sync / full push cost
//   - editdiff:  cost of ApplyLocalSnapshot for a ONE-field edit — this is the
//     per-keystroke/per-save cost, and it is O(dataset) today because
//     the snapshot bridge re-reads every entity to find what changed
//
// The Go heap is a proxy for the browser WASM heap (wasm32 caps at ~4 GB address
// space, so the web platform hits the wall first). Run:
//
//	go run ./cmd/loadtest -n 10000,100000,500000,1000000
//
// Large counts are memory-heavy by design — that is the point being measured.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"runtime"
	"strconv"
	"strings"
	"time"

	"things3-clone-desktop/core/ydoc"
)

func main() {
	nflag := flag.String("n", "10000,100000", "comma-separated task counts to measure")
	notesLen := flag.Int("notes", 40, "approx characters of notes per task")
	flag.Parse()

	counts := parseCounts(*nflag)
	fmt.Printf("loadtest — live core/ydoc engine, notes≈%d chars/task\n\n", *notesLen)
	fmt.Printf("%10s %10s %11s %10s %10s %10s %10s\n",
		"tasks", "heap", "snapshot", "load", "material", "fulldiff", "editdiff")
	fmt.Printf("%10s %10s %11s %10s %10s %10s %10s\n",
		"-----", "----", "--------", "----", "--------", "--------", "--------")

	for _, n := range counts {
		measure(n, *notesLen)
	}
}

func measure(n, notesLen int) {
	snapJSON := buildSnapshot(n, notesLen)

	eng := ydoc.New()

	t0 := time.Now()
	if err := eng.ApplyLocalSnapshot(snapJSON); err != nil {
		fmt.Printf("%10d  ERROR ApplyLocalSnapshot: %v\n", n, err)
		return
	}
	loadDur := time.Since(t0)

	// Let the snapshot JSON be collected so `heap` reflects the CRDT, not the input.
	snapJSON = ""
	runtime.GC()
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	heap := ms.HeapAlloc

	all := eng.EncodeAll()
	snapBytes := len(all)

	t1 := time.Now()
	if _, err := eng.Materialize(); err != nil {
		fmt.Printf("%10d  ERROR Materialize: %v\n", n, err)
		return
	}
	matDur := time.Since(t1)

	t2 := time.Now()
	if _, err := eng.EncodeDiff(nil); err != nil {
		fmt.Printf("%10d  ERROR EncodeDiff: %v\n", n, err)
		return
	}
	fullDiffDur := time.Since(t2)

	// One-field edit: flip a single task's priority and re-apply the whole-state
	// snapshot. This is the realistic per-save cost under the current bridge.
	editJSON := buildEdit(n, notesLen)
	t3 := time.Now()
	if err := eng.ApplyLocalSnapshot(editJSON); err != nil {
		fmt.Printf("%10d  ERROR edit ApplyLocalSnapshot: %v\n", n, err)
		return
	}
	editDur := time.Since(t3)

	fmt.Printf("%10d %10s %11s %10s %10s %10s %10s\n",
		n, human(heap), humanBytes(snapBytes),
		ms3(loadDur), ms3(matDur), ms3(fullDiffDur), ms3(editDur))

	runtime.KeepAlive(all)
}

// ---- synthetic data ----------------------------------------------------------

// buildSnapshot builds a whole-state snapshot JSON with n tasks spread across a
// realistic number of projects and areas.
func buildSnapshot(n, notesLen int) string {
	areas := max(1, n/5000)
	projects := max(1, n/200)

	snap := map[string]any{
		"areas":       makeAreas(areas),
		"projects":    makeProjects(projects, areas),
		"headings":    []any{},
		"tasks":       makeTasks(n, projects, notesLen, -1, 0),
		"customViews": []any{},
		"tags":        []string{"work", "home", "urgent", "someday", "waiting"},
		"settings":    map[string]any{"theme": "auto", "startView": "today"},
	}
	b, _ := json.Marshal(snap)
	return string(b)
}

// buildEdit rebuilds the same snapshot but bumps ONE task's priority, so the diff
// has exactly one field to apply — measuring the fixed per-save overhead.
func buildEdit(n, notesLen int) string {
	areas := max(1, n/5000)
	projects := max(1, n/200)
	snap := map[string]any{
		"areas":       makeAreas(areas),
		"projects":    makeProjects(projects, areas),
		"headings":    []any{},
		"tasks":       makeTasks(n, projects, notesLen, n/2, 3), // task n/2 -> priority 3
		"customViews": []any{},
		"tags":        []string{"work", "home", "urgent", "someday", "waiting"},
		"settings":    map[string]any{"theme": "auto", "startView": "today"},
	}
	b, _ := json.Marshal(snap)
	return string(b)
}

func makeAreas(count int) []any {
	out := make([]any, count)
	for i := 0; i < count; i++ {
		out[i] = map[string]any{
			"id":    "area-" + strconv.Itoa(i),
			"title": "Area " + strconv.Itoa(i),
			"order": float64(i),
		}
	}
	return out
}

func makeProjects(count, areas int) []any {
	out := make([]any, count)
	for i := 0; i < count; i++ {
		out[i] = map[string]any{
			"id":     "proj-" + strconv.Itoa(i),
			"title":  "Project " + strconv.Itoa(i),
			"areaId": "area-" + strconv.Itoa(i%areas),
			"order":  float64(i),
		}
	}
	return out
}

// makeTasks builds n tasks. If editIdx >= 0, that task's priority is set to
// editPri (used to synthesize a one-field change vs the base snapshot).
func makeTasks(n, projects, notesLen, editIdx, editPri int) []any {
	notes := strings.Repeat("lorem ipsum dolor ", 1+notesLen/18)
	if len(notes) > notesLen {
		notes = notes[:notesLen]
	}
	out := make([]any, n)
	for i := 0; i < n; i++ {
		pri := i % 4
		if i == editIdx {
			pri = editPri
		}
		out[i] = map[string]any{
			"id":        "task-" + strconv.Itoa(i),
			"title":     "Task number " + strconv.Itoa(i) + " do the thing",
			"projectId": "proj-" + strconv.Itoa(i%projects),
			"when":      "2026-07-05",
			"deadline":  "",
			"priority":  pri,
			"order":     float64(i),
			"completed": i%3 == 0,
			"notes":     notes,
			"tags":      []string{"work"},
			"checklist": []any{},
		}
	}
	return out
}

// ---- formatting --------------------------------------------------------------

func parseCounts(s string) []int {
	var out []int
	for _, p := range strings.Split(s, ",") {
		if v, err := strconv.Atoi(strings.TrimSpace(p)); err == nil && v > 0 {
			out = append(out, v)
		}
	}
	if len(out) == 0 {
		out = []int{10000}
	}
	return out
}

func human(b uint64) string { return humanBytes(int(b)) }

func humanBytes(b int) string {
	const u = 1024
	if b < u {
		return fmt.Sprintf("%dB", b)
	}
	div, exp := int64(u), 0
	for v := b / u; v >= u; v /= u {
		div *= u
		exp++
	}
	return fmt.Sprintf("%.1f%cB", float64(b)/float64(div), "KMGT"[exp])
}

func ms3(d time.Duration) string { return fmt.Sprintf("%.1fms", float64(d.Microseconds())/1000) }

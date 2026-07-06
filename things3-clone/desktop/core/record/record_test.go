package record

import (
	"sort"
	"testing"
)

func open(t *testing.T) *Store {
	t.Helper()
	s, err := Open(":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestCreateQueryGet(t *testing.T) {
	s := open(t)
	id, err := s.CreateTask(TaskInput{Title: "Buy milk", ProjectID: "p1", When: "2026-07-05", Priority: 2, Notes: "from the corner shop", Tags: []string{"home"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateTask(TaskInput{Title: "Ship release", ProjectID: "p2", Priority: 1}); err != nil {
		t.Fatal(err)
	}

	rows, err := s.QueryTasks(Query{ProjectID: "p1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Title != "Buy milk" {
		t.Fatalf("QueryTasks(p1) = %+v", rows)
	}

	obj, err := s.GetTask(id)
	if err != nil || obj == nil {
		t.Fatalf("GetTask: %v %v", obj, err)
	}
	if obj["notes"] != "from the corner shop" {
		t.Fatalf("notes = %v", obj["notes"])
	}
	tags, _ := obj["tags"].([]any)
	if len(tags) != 1 || tags[0] != "home" {
		t.Fatalf("tags = %v", obj["tags"])
	}
}

func TestToggleCompleteAndCount(t *testing.T) {
	s := open(t)
	id, _ := s.CreateTask(TaskInput{Title: "A", ProjectID: "p"})
	s.CreateTask(TaskInput{Title: "B", ProjectID: "p"})

	if n, _ := s.CountTasks(Query{ProjectID: "p", OnlyOpen: true}); n != 2 {
		t.Fatalf("open before = %d, want 2", n)
	}
	if err := s.ToggleComplete(id, true); err != nil {
		t.Fatal(err)
	}
	if n, _ := s.CountTasks(Query{ProjectID: "p", OnlyOpen: true}); n != 1 {
		t.Fatalf("open after = %d, want 1", n)
	}
	if n, _ := s.CountTasks(Query{ProjectID: "p", OnlyComplete: true}); n != 1 {
		t.Fatalf("complete after = %d, want 1", n)
	}
}

func TestSearch(t *testing.T) {
	s := open(t)
	s.CreateTask(TaskInput{Title: "Quarterly report", Notes: "finish the numbers"})
	s.CreateTask(TaskInput{Title: "Water the plants", Notes: "living room"})

	rows, err := s.SearchTasks("quarter", Query{})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Title != "Quarterly report" {
		t.Fatalf("search 'quarter' = %+v", rows)
	}
	// match on notes body too
	rows, _ = s.SearchTasks("numbers", Query{})
	if len(rows) != 1 {
		t.Fatalf("search 'numbers' = %+v", rows)
	}
	// filters intersect with FTS
	rows, _ = s.SearchTasks("the", Query{OnlyOpen: true})
	if len(rows) != 2 {
		t.Fatalf("search 'the' open = %+v", rows)
	}
}

func TestOrderingFractional(t *testing.T) {
	s := open(t)
	a, _ := s.CreateTask(TaskInput{Title: "A"})
	b, _ := s.CreateTask(TaskInput{Title: "B"})
	c, _ := s.CreateTask(TaskInput{Title: "C"})

	// initial order A,B,C by append rank
	if got := titles(t, s); got != "A,B,C" {
		t.Fatalf("append order = %s", got)
	}
	// move C between A and B
	if err := s.MoveTask(c, a, b); err != nil {
		t.Fatal(err)
	}
	if got := titles(t, s); got != "A,C,B" {
		t.Fatalf("after move = %s", got)
	}
	// repeatedly move a task into the SAME gap; string ranks must never collide
	x, _ := s.CreateTask(TaskInput{Title: "X"})
	for i := 0; i < 500; i++ {
		if err := s.MoveTask(x, a, c); err != nil {
			t.Fatalf("move %d: %v", i, err)
		}
	}
	rows, _ := s.QueryTasks(Query{})
	ranks := map[string]bool{}
	for _, r := range rows {
		if ranks[r.Rank] {
			t.Fatalf("duplicate rank %q after repeated subdivision", r.Rank)
		}
		ranks[r.Rank] = true
	}
	if got := titles(t, s); got != "A,X,C,B" {
		t.Fatalf("after 500 subdivisions = %s", got)
	}
}

// TestConvergence: two replicas make concurrent edits, exchange ops both ways, and
// must end byte-identical — the no-user-conflict guarantee.
func TestConvergence(t *testing.T) {
	s1 := open(t)
	s2 := open(t)

	// same task exists on both (created on s1, synced to s2)
	id, _ := s1.CreateTask(TaskInput{Title: "shared", ProjectID: "p", Priority: 1})
	pull(t, s1, s2) // s2 learns the task

	// concurrent: s1 sets priority 3, s2 sets title "renamed" + completes
	s1.SetTaskField(id, "priority", 3)
	s2.SetTaskField(id, "title", "renamed")
	s2.ToggleComplete(id, true)

	// exchange both ways
	pull(t, s1, s2)
	pull(t, s2, s1)

	o1, _ := s1.GetTask(id)
	o2, _ := s2.GetTask(id)
	if o1["title"] != o2["title"] || o1["priority"] != o2["priority"] || o1["completed"] != o2["completed"] {
		t.Fatalf("diverged:\n s1=%v\n s2=%v", o1, o2)
	}
	// different-field edits both survive; same-field LWW is deterministic
	if o1["title"] != "renamed" || o1["priority"] != float64(3) || o1["completed"] != true {
		t.Fatalf("unexpected merge: %v", o1)
	}
}

// ---- helpers ----

func titles(t *testing.T, s *Store) string {
	t.Helper()
	rows, err := s.QueryTasks(Query{})
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, r := range rows {
		out = append(out, r.Title)
	}
	return join(out)
}

// pull copies src's pending ops into dst (one-way sync), then marks them synced.
func pull(t *testing.T, src, dst *Store) {
	t.Helper()
	pend, err := src.PendingOps(0)
	if err != nil {
		t.Fatal(err)
	}
	ops := make([]Op, len(pend))
	seqs := make([]int64, len(pend))
	for i, so := range pend {
		ops[i] = so.Op
		seqs[i] = so.Seq
	}
	if err := dst.ApplyRemote(ops); err != nil {
		t.Fatal(err)
	}
	if err := src.MarkSynced(seqs); err != nil {
		t.Fatal(err)
	}
}

func join(ss []string) string {
	sort.SliceStable(ss, func(i, j int) bool { return false }) // keep query order
	out := ""
	for i, s := range ss {
		if i > 0 {
			out += ","
		}
		out += s
	}
	return out
}

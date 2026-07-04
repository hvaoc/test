package crdt

import (
	"encoding/json"
	"sort"
	"testing"
)

func seq(base int64) func() int64 {
	n := base - 1
	return func() int64 { n++; return n }
}

func materialize(t *testing.T, e *Engine) map[string]interface{} {
	t.Helper()
	js, err := e.Materialize()
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]interface{}
	if err := json.Unmarshal([]byte(js), &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func task(t *testing.T, m map[string]interface{}, id string) map[string]interface{} {
	t.Helper()
	for _, r := range m["tasks"].([]interface{}) {
		tk := r.(map[string]interface{})
		if tk["id"] == id {
			return tk
		}
	}
	return nil
}

// Simulate a server relay: A's pending → B.
func relay(t *testing.T, from, to *Engine) {
	t.Helper()
	ops, _ := from.TakePending()
	if _, err := to.ApplyRemote(ops); err != nil {
		t.Fatal(err)
	}
}

func TestCanonContract(t *testing.T) {
	// MUST match core.TestCanonCompat and the JS mirror.
	cases := []struct{ in, want string }{
		{`"hello"`, `"hello"`},
		{`"a<b>&c"`, `"a<b>&c"`},
		{`1751000000000`, `1751000000000`},
		{`{"b":1,"a":2}`, `{"a":2,"b":1}`},
		{`{"z":{"y":1,"x":2},"a":[1,2]}`, `{"a":[1,2],"z":{"x":2,"y":1}}`},
	}
	for _, c := range cases {
		if got := canon(json.RawMessage(c.in)); got != c.want {
			t.Errorf("canon(%s) = %q want %q", c.in, got, c.want)
		}
	}
}

func TestConcurrentDifferentFields(t *testing.T) {
	a, b := New("A"), New("B")
	a.now, b.now = seq(1000), seq(1000)
	_, _ = a.ApplyLocalSnapshot(`{"tasks":[{"id":"t1","title":"Orig","deadline":null}],"tags":[],"settings":{}}`)
	relay(t, a, b)
	a.now, b.now = seq(2000), seq(2000)
	_, _ = a.ApplyLocalSnapshot(`{"tasks":[{"id":"t1","title":"A's","deadline":null}],"tags":[],"settings":{}}`)
	_, _ = b.ApplyLocalSnapshot(`{"tasks":[{"id":"t1","title":"Orig","deadline":"2026-08-01"}],"tags":[],"settings":{}}`)
	relay(t, a, b)
	relay(t, b, a)
	for _, e := range []*Engine{a, b} {
		tk := task(t, materialize(t, e), "t1")
		if tk["title"] != "A's" || tk["deadline"] != "2026-08-01" {
			t.Fatalf("did not merge different fields: %v", tk)
		}
	}
}

func TestConcurrentTagAdds(t *testing.T) {
	a, b := New("A"), New("B")
	a.now, b.now = seq(1000), seq(1000)
	_, _ = a.ApplyLocalSnapshot(`{"tasks":[{"id":"t1","title":"T","tags":["Base"]}],"tags":["Base"],"settings":{}}`)
	relay(t, a, b)
	a.now, b.now = seq(3000), seq(3000)
	_, _ = a.ApplyLocalSnapshot(`{"tasks":[{"id":"t1","title":"T","tags":["Base","FromA"]}],"tags":["Base","FromA"],"settings":{}}`)
	_, _ = b.ApplyLocalSnapshot(`{"tasks":[{"id":"t1","title":"T","tags":["Base","FromB"]}],"tags":["Base","FromB"],"settings":{}}`)
	relay(t, a, b)
	relay(t, b, a)
	tk := task(t, materialize(t, a), "t1")
	var got []string
	for _, v := range tk["tags"].([]interface{}) {
		got = append(got, v.(string))
	}
	sort.Strings(got)
	if len(got) != 3 || got[0] != "Base" || got[1] != "FromA" || got[2] != "FromB" {
		t.Fatalf("tags did not merge add-wins: %v", got)
	}
}

func TestSameFieldLWW(t *testing.T) {
	a, b := New("A"), New("B")
	a.now, b.now = seq(1000), seq(1000)
	_, _ = a.ApplyLocalSnapshot(`{"tasks":[{"id":"t1","title":"base"}],"tags":[],"settings":{}}`)
	relay(t, a, b)
	a.now, b.now = seq(4000), seq(9000)
	_, _ = a.ApplyLocalSnapshot(`{"tasks":[{"id":"t1","title":"edit-A"}],"tags":[],"settings":{}}`)
	_, _ = b.ApplyLocalSnapshot(`{"tasks":[{"id":"t1","title":"edit-B"}],"tags":[],"settings":{}}`)
	relay(t, a, b)
	relay(t, b, a)
	if task(t, materialize(t, a), "t1")["title"] != "edit-B" || task(t, materialize(t, b), "t1")["title"] != "edit-B" {
		t.Fatal("same-field LWW not deterministic")
	}
}

// The Apply* methods must report the exact register rows they changed, so the
// SQLite persistence layer can upsert only the delta.
func TestChangeRowsDelta(t *testing.T) {
	e := New("A")
	e.now = seq(1000)
	js, err := e.ApplyLocalSnapshot(`{"tasks":[{"id":"t1","title":"Hi","tags":["Q"]}],"tags":["Q"],"settings":{"showCompleted":true}}`)
	if err != nil {
		t.Fatal(err)
	}
	var res struct {
		Rows struct {
			Fields   []map[string]interface{} `json:"fields"`
			Sets     []map[string]interface{} `json:"sets"`
			Presence []map[string]interface{} `json:"presence"`
		} `json:"rows"`
		Count int `json:"count"`
	}
	if err := json.Unmarshal([]byte(js), &res); err != nil {
		t.Fatal(err)
	}
	// task t1: presence + title field + tag set-elem; tag entity presence;
	// setting presence + showCompleted field.
	if len(res.Rows.Presence) < 3 || len(res.Rows.Fields) < 2 || len(res.Rows.Sets) != 1 {
		t.Fatalf("unexpected delta: presence=%d fields=%d sets=%d",
			len(res.Rows.Presence), len(res.Rows.Fields), len(res.Rows.Sets))
	}
	// A no-op re-apply of the same snapshot yields an empty delta.
	js2, _ := e.ApplyLocalSnapshot(`{"tasks":[{"id":"t1","title":"Hi","tags":["Q"]}],"tags":["Q"],"settings":{"showCompleted":true}}`)
	var res2 struct {
		Count int `json:"count"`
	}
	_ = json.Unmarshal([]byte(js2), &res2)
	if res2.Count != 0 {
		t.Fatalf("re-applying identical snapshot should be a no-op, got %d ops", res2.Count)
	}
}

func TestSerializeRoundTrip(t *testing.T) {
	a := New("A")
	a.now = seq(1000)
	_, _ = a.ApplyLocalSnapshot(`{"tasks":[{"id":"t1","title":"x","tags":["Q"]}],"tags":["Q"],"settings":{"showCompleted":true}}`)
	blob, err := a.Serialize()
	if err != nil {
		t.Fatal(err)
	}
	b, err := Load(blob)
	if err != nil {
		t.Fatal(err)
	}
	m := materialize(t, b)
	if len(m["tasks"].([]interface{})) != 1 {
		t.Fatal("round-trip lost the task")
	}
	if b.Node() != "A" {
		t.Fatalf("round-trip lost node id: %q", b.Node())
	}
}

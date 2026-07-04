// Package crdt is the SQLite-free, pure-Go field-level CRDT engine. It holds all
// state in memory (register maps) and speaks JSON at its edges, so it compiles
// to js/wasm and runs in the browser — replacing the previous hand-written JS
// CRDT. The same package could back the desktop SQLite store too; today the
// store keeps its own SQL-native copy (SQLite can't target wasm), and a shared
// canonical-JSON + op-format contract keeps the two byte-compatible.
//
// Everything here mirrors the semantics of desktop/core (store.go/sync.go):
// scalar fields are LWW registers, `tags` is an add-wins set CRDT, existence is
// an LWW tombstone, and Hybrid Logical Clocks give a deterministic, skew-
// tolerant total order. See engine_test.go.
package crdt

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"
	"time"
)

const us = "\x1f" // entity-key separator (matches Go core + JS)

func ekey(kind, id string) string { return kind + us + id }

var objectKinds = []string{"area", "project", "heading", "task", "customView"}
var setFields = map[string]map[string]bool{"task": {"tags": true}}

func isSetField(kind, field string) bool { return setFields[kind] != nil && setFields[kind][field] }

// canon: canonical JSON identical to core.canon and crdt.js canon — sorted keys,
// NO HTML escaping — so a value written on any platform compares equal on the
// others.
func canon(raw json.RawMessage) string {
	var v interface{}
	if err := json.Unmarshal(raw, &v); err != nil {
		return string(raw)
	}
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return string(raw)
	}
	return strings.TrimRight(b.String(), "\n")
}

// ---- Op (wire format shared with the server + Go store) ----

type Op struct {
	Type    string          `json:"t"`
	Kind    string          `json:"k"`
	ID      string          `json:"i"`
	Field   string          `json:"f,omitempty"`
	Elem    string          `json:"e,omitempty"`
	Value   json.RawMessage `json:"v,omitempty"`
	Present bool            `json:"p,omitempty"`
	Wall    int64           `json:"w"`
	Ctr     int64           `json:"c"`
	Node    string          `json:"n"`
}

func (o Op) hlc() HLC { return HLC{Wall: o.Wall, Ctr: o.Ctr, Node: o.Node} }

// ---- registers ----

type fieldReg struct {
	Value string `json:"v"`
	HLC   HLC    `json:"h"`
}
type setReg struct {
	Present bool `json:"p"`
	HLC     HLC  `json:"h"`
}
type presReg struct {
	Present bool `json:"p"`
	HLC     HLC  `json:"h"`
}

// Engine is one CRDT replica.
type Engine struct {
	node     string
	last     HLC
	presence map[string]presReg
	fields   map[string]map[string]fieldReg
	sets     map[string]map[string]map[string]setReg
	pending  []Op
	cursor   string
	now      func() int64
}

func New(node string) *Engine {
	if node == "" {
		var b [6]byte
		_, _ = rand.Read(b[:])
		node = "web-" + hex.EncodeToString(b[:])
	}
	return &Engine{
		node:     node,
		last:     HLC{Node: node},
		presence: map[string]presReg{},
		fields:   map[string]map[string]fieldReg{},
		sets:     map[string]map[string]map[string]setReg{},
		now:      func() int64 { return time.Now().UnixMilli() },
	}
}

func (e *Engine) Node() string       { return e.node }
func (e *Engine) Cursor() string     { return e.cursor }
func (e *Engine) SetCursor(c string) { e.cursor = c }

// ---- clock ----

func (e *Engine) localStamp() HLC {
	wall := e.now()
	if wall > e.last.Wall {
		e.last = HLC{Wall: wall, Ctr: 0, Node: e.node}
	} else {
		e.last = HLC{Wall: e.last.Wall, Ctr: e.last.Ctr + 1, Node: e.node}
	}
	return e.last
}
func (e *Engine) witness(r HLC) {
	wall := e.now()
	max := e.last.Wall
	if r.Wall > max {
		max = r.Wall
	}
	if wall > max {
		max = wall
	}
	switch {
	case max == e.last.Wall && max == r.Wall:
		c := e.last.Ctr
		if r.Ctr > c {
			c = r.Ctr
		}
		e.last = HLC{Wall: max, Ctr: c + 1, Node: e.node}
	case max == e.last.Wall:
		e.last = HLC{Wall: max, Ctr: e.last.Ctr + 1, Node: e.node}
	case max == r.Wall:
		e.last = HLC{Wall: max, Ctr: r.Ctr + 1, Node: e.node}
	default:
		e.last = HLC{Wall: max, Ctr: 0, Node: e.node}
	}
}

// ---- apply one op ----

func (e *Engine) applyOp(op Op, local bool) bool {
	h := op.hlc()
	k := ekey(op.Kind, op.ID)
	applied := false
	switch op.Type {
	case "presence":
		cur, ok := e.presence[k]
		if !ok || h.After(cur.HLC) {
			e.presence[k] = presReg{Present: op.Present, HLC: h}
			applied = true
		}
	case "field":
		if e.fields[k] == nil {
			e.fields[k] = map[string]fieldReg{}
		}
		cur, ok := e.fields[k][op.Field]
		if !ok || h.After(cur.HLC) {
			e.fields[k][op.Field] = fieldReg{Value: canon(op.Value), HLC: h}
			applied = true
		}
	case "set":
		if e.sets[k] == nil {
			e.sets[k] = map[string]map[string]setReg{}
		}
		if e.sets[k][op.Field] == nil {
			e.sets[k][op.Field] = map[string]setReg{}
		}
		cur, ok := e.sets[k][op.Field][op.Elem]
		if !ok || h.After(cur.HLC) {
			e.sets[k][op.Field][op.Elem] = setReg{Present: op.Present, HLC: h}
			applied = true
		}
	}
	if local && applied {
		e.pending = append(e.pending, op)
	}
	return applied
}

// ---- snapshot diff ----

type snapshot struct {
	Areas       []map[string]json.RawMessage `json:"areas"`
	Projects    []map[string]json.RawMessage `json:"projects"`
	Headings    []map[string]json.RawMessage `json:"headings"`
	Tasks       []map[string]json.RawMessage `json:"tasks"`
	CustomViews []map[string]json.RawMessage `json:"customViews"`
	Tags        []string                     `json:"tags"`
	Settings    map[string]json.RawMessage   `json:"settings"`
}

func (s *snapshot) collection(kind string) []map[string]json.RawMessage {
	switch kind {
	case "area":
		return s.Areas
	case "project":
		return s.Projects
	case "heading":
		return s.Headings
	case "task":
		return s.Tasks
	case "customView":
		return s.CustomViews
	}
	return nil
}

func rawString(raw json.RawMessage) string {
	var s string
	_ = json.Unmarshal(raw, &s)
	return s
}

func (e *Engine) diff(snap *snapshot) []Op {
	var ops []Op
	seen := map[string]bool{}

	emit := func(kind, id string, obj map[string]json.RawMessage) {
		k := ekey(kind, id)
		if p, ok := e.presence[k]; !ok || !p.Present {
			ops = append(ops, Op{Type: "presence", Kind: kind, ID: id, Present: true})
		}
		for field, raw := range obj {
			if field == "id" {
				continue
			}
			if isSetField(kind, field) {
				ops = append(ops, e.diffSet(kind, id, field, raw)...)
				continue
			}
			nv := canon(raw)
			if cur, ok := e.fields[k][field]; !ok || cur.Value != nv {
				ops = append(ops, Op{Type: "field", Kind: kind, ID: id, Field: field, Value: raw})
			}
		}
	}

	for _, kind := range objectKinds {
		for _, obj := range snap.collection(kind) {
			id := rawString(obj["id"])
			if id == "" {
				continue
			}
			seen[ekey(kind, id)] = true
			emit(kind, id, obj)
		}
	}
	for _, name := range snap.Tags {
		k := ekey("tag", name)
		seen[k] = true
		if p, ok := e.presence[k]; !ok || !p.Present {
			ops = append(ops, Op{Type: "presence", Kind: "tag", ID: name, Present: true})
		}
	}
	if snap.Settings != nil {
		k := ekey("setting", "app")
		seen[k] = true
		if p, ok := e.presence[k]; !ok || !p.Present {
			ops = append(ops, Op{Type: "presence", Kind: "setting", ID: "app", Present: true})
		}
		for field, raw := range snap.Settings {
			nv := canon(raw)
			if cur, ok := e.fields[k][field]; !ok || cur.Value != nv {
				ops = append(ops, Op{Type: "field", Kind: "setting", ID: "app", Field: field, Value: raw})
			}
		}
	}
	for k, p := range e.presence {
		if p.Present && !seen[k] {
			parts := strings.SplitN(k, us, 2)
			ops = append(ops, Op{Type: "presence", Kind: parts[0], ID: parts[1], Present: false})
		}
	}
	return ops
}

func (e *Engine) diffSet(kind, id, field string, raw json.RawMessage) []Op {
	var elems []json.RawMessage
	_ = json.Unmarshal(raw, &elems)
	want := map[string]bool{}
	for _, el := range elems {
		want[canon(el)] = true
	}
	var ops []Op
	k := ekey(kind, id)
	existing := e.sets[k][field]
	for elem := range want {
		if cur, ok := existing[elem]; !ok || !cur.Present {
			ops = append(ops, Op{Type: "set", Kind: kind, ID: id, Field: field, Elem: elem, Present: true})
		}
	}
	for elem, cur := range existing {
		if cur.Present && !want[elem] {
			ops = append(ops, Op{Type: "set", Kind: kind, ID: id, Field: field, Elem: elem, Present: false})
		}
	}
	return ops
}

// ---- public JSON API (the wasm/worker boundary) ----

// ApplyLocalSnapshot diffs a frontend state snapshot into ops, stamps them, and
// applies + queues them for push. Returns the number of ops produced.
func (e *Engine) ApplyLocalSnapshot(stateJSON string) (int, error) {
	var snap snapshot
	if err := json.Unmarshal([]byte(stateJSON), &snap); err != nil {
		return 0, err
	}
	ops := e.diff(&snap)
	for i := range ops {
		h := e.localStamp()
		ops[i].Wall, ops[i].Ctr, ops[i].Node = h.Wall, h.Ctr, h.Node
		e.applyOp(ops[i], true)
	}
	return len(ops), nil
}

// ApplyRemote merges pulled ops (LWW). Returns applied, skipped.
func (e *Engine) ApplyRemote(opsJSON string) (int, int, error) {
	var ops []Op
	if err := json.Unmarshal([]byte(opsJSON), &ops); err != nil {
		return 0, 0, err
	}
	applied, skipped := 0, 0
	for _, op := range ops {
		e.witness(op.hlc())
		if op.Node == e.node {
			skipped++
			continue
		}
		if e.applyOp(op, false) {
			applied++
		} else {
			skipped++
		}
	}
	return applied, skipped, nil
}

// TakePending returns the queued ops JSON and clears the queue.
func (e *Engine) TakePending() (string, error) {
	b, err := json.Marshal(e.pending)
	e.pending = nil
	return string(b), err
}

// PeekPending returns the queued ops without clearing them. The caller pushes
// them and then DropPending(n)s exactly the peeked count — so a crash between
// push and drop only re-pushes (ops are idempotent by HLC), never loses.
func (e *Engine) PeekPending() (string, error) {
	if e.pending == nil {
		return "[]", nil
	}
	b, err := json.Marshal(e.pending)
	return string(b), err
}

// DropPending removes the first n pending ops (those already pushed), keeping
// any newer local ops queued behind them.
func (e *Engine) DropPending(n int) {
	if n <= 0 {
		return
	}
	if n >= len(e.pending) {
		e.pending = nil
	} else {
		e.pending = e.pending[n:]
	}
}

func (e *Engine) PendingCount() int { return len(e.pending) }

// Requeue prepends ops back (used when a push fails).
func (e *Engine) Requeue(opsJSON string) error {
	var ops []Op
	if err := json.Unmarshal([]byte(opsJSON), &ops); err != nil {
		return err
	}
	e.pending = append(ops, e.pending...)
	return nil
}

func (e *Engine) HasData() bool {
	for _, p := range e.presence {
		if p.Present {
			return true
		}
	}
	return false
}

// Materialize rebuilds the frontend state JSON from the merged registers.
func (e *Engine) Materialize() (string, error) {
	out := map[string]interface{}{}
	for _, kind := range objectKinds {
		out[pluralOf(kind)] = e.materializeKind(kind)
	}
	tags := []string{}
	for k, p := range e.presence {
		if !p.Present {
			continue
		}
		parts := strings.SplitN(k, us, 2)
		if parts[0] == "tag" {
			tags = append(tags, parts[1])
		}
	}
	sort.Strings(tags)
	out["tags"] = tags
	if s := e.materializeOne("setting", "app"); s != nil {
		delete(s, "id")
		out["settings"] = s
	}
	b, err := json.Marshal(out)
	return string(b), err
}

func (e *Engine) materializeKind(kind string) []map[string]interface{} {
	out := []map[string]interface{}{}
	for k, p := range e.presence {
		if !p.Present {
			continue
		}
		parts := strings.SplitN(k, us, 2)
		if parts[0] != kind {
			continue
		}
		if obj := e.materializeOne(kind, parts[1]); obj != nil {
			out = append(out, obj)
		}
	}
	return out
}

func (e *Engine) materializeOne(kind, id string) map[string]interface{} {
	k := ekey(kind, id)
	if p, ok := e.presence[k]; !ok || !p.Present {
		return nil
	}
	obj := map[string]interface{}{"id": id}
	for field, fr := range e.fields[k] {
		var v interface{}
		if json.Unmarshal([]byte(fr.Value), &v) == nil {
			obj[field] = v
		}
	}
	for field, elems := range e.sets[k] {
		names := make([]string, 0, len(elems))
		for elem, r := range elems {
			if r.Present {
				names = append(names, elem)
			}
		}
		sort.Strings(names)
		arr := make([]interface{}, 0, len(names))
		for _, elem := range names {
			var v interface{}
			if json.Unmarshal([]byte(elem), &v) == nil {
				arr = append(arr, v)
			}
		}
		obj[field] = arr
	}
	return obj
}

// ---- serialize / load (persisted to IndexedDB by the worker) ----

type persisted struct {
	Node     string                                  `json:"node"`
	Last     HLC                                     `json:"last"`
	Presence map[string]presReg                      `json:"presence"`
	Fields   map[string]map[string]fieldReg          `json:"fields"`
	Sets     map[string]map[string]map[string]setReg `json:"sets"`
	Pending  []Op                                    `json:"pending"`
	Cursor   string                                  `json:"cursor"`
}

func (e *Engine) Serialize() (string, error) {
	b, err := json.Marshal(persisted{
		Node: e.node, Last: e.last, Presence: e.presence,
		Fields: e.fields, Sets: e.sets, Pending: e.pending, Cursor: e.cursor,
	})
	return string(b), err
}

func Load(serialized string) (*Engine, error) {
	var p persisted
	if err := json.Unmarshal([]byte(serialized), &p); err != nil {
		return nil, err
	}
	e := New(p.Node)
	e.last = p.Last
	if e.last.Node == "" {
		e.last.Node = e.node
	}
	if p.Presence != nil {
		e.presence = p.Presence
	}
	if p.Fields != nil {
		e.fields = p.Fields
	}
	if p.Sets != nil {
		e.sets = p.Sets
	}
	e.pending = p.Pending
	e.cursor = p.Cursor
	return e, nil
}

func pluralOf(kind string) string {
	switch kind {
	case "area":
		return "areas"
	case "project":
		return "projects"
	case "heading":
		return "headings"
	case "task":
		return "tasks"
	case "customView":
		return "customViews"
	default:
		return kind + "s"
	}
}

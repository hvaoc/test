//go:build js && wasm

// Command wasm exposes the pure-Go CRDT engine (core/crdt) to the browser via
// syscall/js. It's compiled to crdt.wasm and run inside a Web Worker (see
// public/crdt.worker.js), so all CRDT work — diffing 2400+ tasks, merging tens
// of thousands of ops — happens off the main thread.
//
// One engine instance per worker. Every exported function takes/returns JSON
// strings so the JS <-> Go boundary stays trivial, and returns
// { ok, result?, error? } for uniform handling on the JS side.
//
// Build: GOOS=js GOARCH=wasm go build -o ../../../public/crdt.wasm ./core/wasm
package main

import (
	"syscall/js"

	"things3-clone-desktop/core/crdt"
)

var eng *crdt.Engine

func ok(result string) map[string]any { return map[string]any{"ok": true, "result": result} }
func fail(err error) map[string]any   { return map[string]any{"ok": false, "error": err.Error()} }
func need() (*crdt.Engine, map[string]any) {
	if eng == nil {
		return nil, map[string]any{"ok": false, "error": "engine not initialised"}
	}
	return eng, nil
}

func fn(f func(args []js.Value) any) js.Func {
	return js.FuncOf(func(_ js.Value, args []js.Value) any { return f(args) })
}

func register() {
	g := js.Global()

	g.Set("__crdtNew", fn(func(args []js.Value) any {
		node := ""
		if len(args) > 0 && args[0].Type() == js.TypeString {
			node = args[0].String()
		}
		eng = crdt.New(node)
		return ok(eng.Node())
	}))

	g.Set("__crdtLoad", fn(func(args []js.Value) any {
		e, err := crdt.Load(args[0].String())
		if err != nil {
			return fail(err)
		}
		eng = e
		return ok(eng.Node())
	}))

	// Returns JSON { rows, ops, count } — see crdt.Engine.ApplyLocalSnapshot.
	g.Set("__crdtApplyLocalSnapshot", fn(func(args []js.Value) any {
		e, bad := need()
		if bad != nil {
			return bad
		}
		s, err := e.ApplyLocalSnapshot(args[0].String())
		if err != nil {
			return fail(err)
		}
		return ok(s)
	}))

	// Returns JSON { rows, applied, skipped } — see crdt.Engine.ApplyRemote.
	g.Set("__crdtApplyRemote", fn(func(args []js.Value) any {
		e, bad := need()
		if bad != nil {
			return bad
		}
		s, err := e.ApplyRemote(args[0].String())
		if err != nil {
			return fail(err)
		}
		return ok(s)
	}))

	g.Set("__crdtMeta", fn(func(args []js.Value) any {
		e, bad := need()
		if bad != nil {
			return bad
		}
		s, err := e.Meta()
		if err != nil {
			return fail(err)
		}
		return ok(s)
	}))

	g.Set("__crdtMaterialize", fn(func(args []js.Value) any {
		e, bad := need()
		if bad != nil {
			return bad
		}
		s, err := e.Materialize()
		if err != nil {
			return fail(err)
		}
		return ok(s)
	}))

	g.Set("__crdtTakePending", fn(func(args []js.Value) any {
		e, bad := need()
		if bad != nil {
			return bad
		}
		s, err := e.TakePending()
		if err != nil {
			return fail(err)
		}
		return ok(s)
	}))

	g.Set("__crdtPeekPending", fn(func(args []js.Value) any {
		e, bad := need()
		if bad != nil {
			return bad
		}
		s, err := e.PeekPending()
		if err != nil {
			return fail(err)
		}
		return ok(s)
	}))

	g.Set("__crdtDropPending", fn(func(args []js.Value) any {
		e, bad := need()
		if bad != nil {
			return bad
		}
		e.DropPending(args[0].Int())
		return map[string]any{"ok": true, "count": e.PendingCount()}
	}))

	g.Set("__crdtRequeue", fn(func(args []js.Value) any {
		e, bad := need()
		if bad != nil {
			return bad
		}
		if err := e.Requeue(args[0].String()); err != nil {
			return fail(err)
		}
		return ok("")
	}))

	g.Set("__crdtSerialize", fn(func(args []js.Value) any {
		e, bad := need()
		if bad != nil {
			return bad
		}
		s, err := e.Serialize()
		if err != nil {
			return fail(err)
		}
		return ok(s)
	}))

	g.Set("__crdtHasData", fn(func(args []js.Value) any {
		e, bad := need()
		if bad != nil {
			return bad
		}
		return map[string]any{"ok": true, "result": e.HasData()}
	}))

	g.Set("__crdtNode", fn(func(args []js.Value) any {
		e, bad := need()
		if bad != nil {
			return bad
		}
		return ok(e.Node())
	}))

	g.Set("__crdtCursor", fn(func(args []js.Value) any {
		e, bad := need()
		if bad != nil {
			return bad
		}
		return ok(e.Cursor())
	}))

	g.Set("__crdtSetCursor", fn(func(args []js.Value) any {
		e, bad := need()
		if bad != nil {
			return bad
		}
		e.SetCursor(args[0].String())
		return ok("")
	}))
}

func main() {
	register()
	registerYdoc() // Phase 1: ygo/ydoc engine exports (__ydoc*)
	// Signal the worker that the exported functions are ready.
	if cb := js.Global().Get("__onCrdtReady"); cb.Type() == js.TypeFunction {
		cb.Invoke()
	}
	select {} // keep the Go runtime (and the js.Funcs) alive
}

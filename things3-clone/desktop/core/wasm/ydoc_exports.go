//go:build js && wasm

// Phase 1 of the ygo migration: expose the shared ydoc engine (core/ydoc, our
// wrapper over reearth/ygo) to the browser worker alongside the legacy __crdt*
// exports. The worker persists an opaque Yjs snapshot blob instead of register
// rows, so the boundary is deliberately tiny: JSON in/out for snapshots, base64
// for binary Yjs updates / state vectors, and a decimal-string client id (a Yjs
// ClientID is a uint64 and must never round-trip through a JS number).
//
// See docs/crdt-ygo.md. Built into the same crdt.wasm by desktop/build-wasm.sh.
package main

import (
	"encoding/base64"
	"strconv"
	"syscall/js"

	"things3-clone-desktop/core/ydoc"
)

var yeng *ydoc.Engine

func needY() (*ydoc.Engine, map[string]any) {
	if yeng == nil {
		return nil, map[string]any{"ok": false, "error": "ydoc engine not initialised"}
	}
	return yeng, nil
}

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }
func unb64(s string) ([]byte, error) {
	if s == "" {
		return nil, nil
	}
	return base64.StdEncoding.DecodeString(s)
}

func registerYdoc() {
	g := js.Global()

	// __ydocNew([clientID?]) -> clientID (decimal string)
	g.Set("__ydocNew", fn(func(args []js.Value) any {
		if len(args) > 0 && args[0].Type() == js.TypeString && args[0].String() != "" {
			id, err := strconv.ParseUint(args[0].String(), 10, 64)
			if err != nil {
				return fail(err)
			}
			yeng = ydoc.NewWithClientID(id)
		} else {
			yeng = ydoc.New()
		}
		return ok(strconv.FormatUint(yeng.ClientID(), 10))
	}))

	// __ydocLoad(clientID, base64Snapshot) -> clientID
	g.Set("__ydocLoad", fn(func(args []js.Value) any {
		id, err := strconv.ParseUint(args[0].String(), 10, 64)
		if err != nil {
			return fail(err)
		}
		snap, err := unb64(args[1].String())
		if err != nil {
			return fail(err)
		}
		e, err := ydoc.Load(id, snap)
		if err != nil {
			return fail(err)
		}
		yeng = e
		return ok(strconv.FormatUint(yeng.ClientID(), 10))
	}))

	// __ydocApplyLocalSnapshot(stateJSON) -> ""
	g.Set("__ydocApplyLocalSnapshot", fn(func(args []js.Value) any {
		e, bad := needY()
		if bad != nil {
			return bad
		}
		if err := e.ApplyLocalSnapshot(args[0].String()); err != nil {
			return fail(err)
		}
		return ok("")
	}))

	// __ydocMaterialize() -> stateJSON
	g.Set("__ydocMaterialize", fn(func(args []js.Value) any {
		e, bad := needY()
		if bad != nil {
			return bad
		}
		s, err := e.Materialize()
		if err != nil {
			return fail(err)
		}
		return ok(s)
	}))

	// __ydocEncodeAll() -> base64 full-state update (persistence snapshot)
	g.Set("__ydocEncodeAll", fn(func(args []js.Value) any {
		e, bad := needY()
		if bad != nil {
			return bad
		}
		return ok(b64(e.EncodeAll()))
	}))

	// __ydocStateVector() -> base64 state vector
	g.Set("__ydocStateVector", fn(func(args []js.Value) any {
		e, bad := needY()
		if bad != nil {
			return bad
		}
		return ok(b64(e.StateVector()))
	}))

	// __ydocEncodeDiff(base64SV) -> base64 update the holder of SV is missing
	g.Set("__ydocEncodeDiff", fn(func(args []js.Value) any {
		e, bad := needY()
		if bad != nil {
			return bad
		}
		sv, err := unb64(args[0].String())
		if err != nil {
			return fail(err)
		}
		diff, err := e.EncodeDiff(sv)
		if err != nil {
			return fail(err)
		}
		return ok(b64(diff))
	}))

	// __ydocApplyUpdate(base64Update) -> ""
	g.Set("__ydocApplyUpdate", fn(func(args []js.Value) any {
		e, bad := needY()
		if bad != nil {
			return bad
		}
		upd, err := unb64(args[0].String())
		if err != nil {
			return fail(err)
		}
		if err := e.ApplyUpdate(upd); err != nil {
			return fail(err)
		}
		return ok("")
	}))

	// __ydocClientID() -> decimal string
	g.Set("__ydocClientID", fn(func(args []js.Value) any {
		e, bad := needY()
		if bad != nil {
			return bad
		}
		return ok(strconv.FormatUint(e.ClientID(), 10))
	}))

	// __ydocHasData() -> bool
	g.Set("__ydocHasData", fn(func(args []js.Value) any {
		e, bad := needY()
		if bad != nil {
			return bad
		}
		return map[string]any{"ok": true, "result": e.HasData()}
	}))
}

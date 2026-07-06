//go:build js && wasm

// ygo migration: expose the shared ydoc engine (core/ydoc, our wrapper over
// reearth/ygo) to the browser worker as __ydoc* globals. Sync + persistence are now
// PER-SCOPE (docs/architecture-1m.md §2.2): every sync primitive takes a scope
// string ("shared", "settings", or "note:<taskId>"), and __ydocScopes enumerates the
// scopes the worker must persist. The boundary stays tiny: JSON in/out for whole-
// state snapshots, base64 for binary Yjs updates / state vectors, and a decimal-
// string client id (a Yjs ClientID is a uint64 and must never round-trip through a
// JS number).
//
// See docs/crdt-ygo.md + docs/architecture-1m.md. Built into crdt.wasm by
// desktop/build-wasm.sh.
package main

import (
	"encoding/base64"
	"encoding/json"
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

	// __ydocNew([clientID?]) -> device clientID (decimal string). Creates a fresh
	// three-scope replica.
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

	// __ydocLoadScope(scope, base64Snapshot) -> "" — restore one scope's persisted blob.
	g.Set("__ydocLoadScope", fn(func(args []js.Value) any {
		e, bad := needY()
		if bad != nil {
			return bad
		}
		snap, err := unb64(args[1].String())
		if err != nil {
			return fail(err)
		}
		if err := e.LoadScope(args[0].String(), snap); err != nil {
			return fail(err)
		}
		return ok("")
	}))

	// __ydocMigrateLegacy() -> "" — one-time: lift settings + notes out of a legacy
	// single-doc blob (loaded into the shared scope) into their own scopes.
	g.Set("__ydocMigrateLegacy", fn(func(args []js.Value) any {
		e, bad := needY()
		if bad != nil {
			return bad
		}
		e.MigrateLegacy()
		return ok("")
	}))

	// __ydocScopes() -> JSON array of scope strings to persist.
	g.Set("__ydocScopes", fn(func(args []js.Value) any {
		e, bad := needY()
		if bad != nil {
			return bad
		}
		b, _ := json.Marshal(e.Scopes())
		return ok(string(b))
	}))

	// __ydocApplyLocalSnapshot(stateJSON) -> "" — whole-state local write (routed to scopes).
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

	// __ydocMaterialize() -> stateJSON (whole-state read across scopes).
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

	// __ydocEncodeAll(scope) -> base64 full-state update (persistence snapshot).
	g.Set("__ydocEncodeAll", fn(func(args []js.Value) any {
		e, bad := needY()
		if bad != nil {
			return bad
		}
		upd, err := e.EncodeAll(args[0].String())
		if err != nil {
			return fail(err)
		}
		return ok(b64(upd))
	}))

	// __ydocStateVector(scope) -> base64 state vector.
	g.Set("__ydocStateVector", fn(func(args []js.Value) any {
		e, bad := needY()
		if bad != nil {
			return bad
		}
		sv, err := e.StateVector(args[0].String())
		if err != nil {
			return fail(err)
		}
		return ok(b64(sv))
	}))

	// __ydocEncodeDiff(scope, base64SV) -> base64 update the holder of SV is missing.
	g.Set("__ydocEncodeDiff", fn(func(args []js.Value) any {
		e, bad := needY()
		if bad != nil {
			return bad
		}
		sv, err := unb64(args[1].String())
		if err != nil {
			return fail(err)
		}
		diff, err := e.EncodeDiff(args[0].String(), sv)
		if err != nil {
			return fail(err)
		}
		return ok(b64(diff))
	}))

	// __ydocApplyUpdate(scope, base64Update) -> "".
	g.Set("__ydocApplyUpdate", fn(func(args []js.Value) any {
		e, bad := needY()
		if bad != nil {
			return bad
		}
		upd, err := unb64(args[1].String())
		if err != nil {
			return fail(err)
		}
		if err := e.ApplyUpdate(args[0].String(), upd); err != nil {
			return fail(err)
		}
		return ok("")
	}))

	// __ydocClientID() -> decimal string (device id).
	g.Set("__ydocClientID", fn(func(args []js.Value) any {
		e, bad := needY()
		if bad != nil {
			return bad
		}
		return ok(strconv.FormatUint(e.ClientID(), 10))
	}))

	// __ydocHasData() -> bool.
	g.Set("__ydocHasData", fn(func(args []js.Value) any {
		e, bad := needY()
		if bad != nil {
			return bad
		}
		return map[string]any{"ok": true, "result": e.HasData()}
	}))
}

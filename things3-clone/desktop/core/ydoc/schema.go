// Package ydoc maps the Things-clone domain (areas, projects, headings, tasks,
// tags, settings) onto ygo (Yjs-in-Go) documents, and bridges the app's whole-state
// snapshots to/from them. It is the one shared CRDT core for every platform —
// compiled to WASM for the web worker, linked natively into the Wails desktop
// store, and gomobile-bound for iOS/Android — replacing the hand-written
// field-level engine in core/crdt.
//
// The domain is split across THREE sync scopes (docs/architecture-1m.md §2.2), each
// its own ygo document so it syncs independently to the right audience:
//
//   SHARED doc (scope "shared", -> every tenant member):
//     root YMap  "index"          key "<kind>:<id>" -> true     (existence)
//     root YMap  "<kind>:<id>"    one key per scalar field      (per-field LWW)
//     root YMap  "tags:<taskId>"  key "<tag>" -> true           (per-task tag set)
//     index key  "tag:<name>"                                   (global tag list)
//
//   NOTE docs (scope "note:<taskId>", one per task, -> members who open the task):
//     root YText "b"              that task's notes             (char-level merge)
//
//   SETTINGS doc (scope "settings", -> this user's own devices only):
//     root YMap  "settings"       one key per setting           (per-key LWW)
//
// noteTextName/"note:<taskId>" (below) is the LEGACY location of notes inside the
// shared doc, kept only so MigrateLegacy can lift them out into their own docs.
//
// Nested shared types are intentionally avoided: ygo v1.30.0 only exposes root
// accessors (doc.GetMap/GetText/GetArray) as stable public API, so every entity is
// a namespaced *root* type.
package ydoc

import "strings"

// objectKinds are the entity collections that carry per-field maps. Order is the
// materialization order; it does not affect merge.
var objectKinds = []string{"area", "project", "heading", "task", "customView"}

// pluralOf maps a kind to its snapshot collection key.
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

// indexKey is the "index" YMap key marking an entity (or global tag) as present.
func indexKey(kind, id string) string { return kind + ":" + id }

// entityMapName is the root YMap holding one entity's scalar fields.
func entityMapName(kind, id string) string { return kind + ":" + id }

// noteTextName is the LEGACY root-YText name for a task's notes inside the shared
// doc (pre-scopes). Notes now live in their own per-task doc; this remains only for
// MigrateLegacy to read the old location.
func noteTextName(taskID string) string { return "note:" + taskID }

// tagsMapName is the root YMap holding a task's tag set.
func tagsMapName(taskID string) string { return "tags:" + taskID }

const (
	indexRoot    = "index"
	settingsRoot = "settings"
)

// splitIndexKey parses "<kind>:<id>" back into (kind, id). ids may contain ':'
// so we split on the first separator only.
func splitIndexKey(k string) (kind, id string) {
	if i := strings.IndexByte(k, ':'); i >= 0 {
		return k[:i], k[i+1:]
	}
	return k, ""
}

// fieldIsSpecial reports fields on a task that are stored outside its scalar map
// (notes -> YText, tags -> tags map). Everything else (title, when, deadline,
// priority, order, checklist, projectId, …) rides the generic per-field path.
func fieldIsSpecial(kind, field string) bool {
	return kind == "task" && (field == "notes" || field == "tags")
}

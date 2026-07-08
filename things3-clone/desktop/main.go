package main

import (
	"context"
	"embed"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"

	"things3-clone-desktop/core/coordinator"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/menu/keys"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// The Expo web export (static SPA) is embedded and served by Wails from the
// app root, so the app runs fully offline in a native WKWebView window.
// `all:` is required so files under `_expo/` (leading underscore) are included.
//
//go:embed all:frontend/dist
var assets embed.FS

const (
	defaultWidth  = 1200
	defaultHeight = 800
)

// windowPrefs persists how the window should open. It lives in a small JSON file
// (not the frontend store) so the Go side can read it at startup, before the
// webview loads. `mode` is "maximized" (default) or "remember".
type windowPrefs struct {
	Mode      string `json:"mode"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	X         int    `json:"x"`
	Y         int    `json:"y"`
	Maximized bool   `json:"maximized"`
}

func prefsPath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = os.TempDir()
	}
	d := filepath.Join(dir, "ThingsClone")
	_ = os.MkdirAll(d, 0o755)
	return filepath.Join(d, "window.json")
}

func loadPrefs() windowPrefs {
	p := windowPrefs{Mode: "maximized"}
	if b, err := os.ReadFile(prefsPath()); err == nil {
		_ = json.Unmarshal(b, &p)
	}
	if p.Mode != "remember" {
		p.Mode = "maximized"
	}
	return p
}

func savePrefs(p windowPrefs) {
	if b, err := json.MarshalIndent(p, "", "  "); err == nil {
		_ = os.WriteFile(prefsPath(), b, 0o644)
	}
}

// App is bound to the frontend: it exposes the startup-window mode AND the
// offline-first data store (embedded SQLite + cloud sync) so the JS layer can
// persist and sync through the same Go engine the mobile apps use.
type App struct {
	ctx   context.Context
	store *coordinator.Coordinator
}

// dataDir is the per-user writable directory for the database + mock cloud file.
func dataDir() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = os.TempDir()
	}
	d := filepath.Join(dir, "ThingsClone")
	_ = os.MkdirAll(d, 0o755)
	return d
}

// --- Data store, callable from JS as window.go.main.App.<Method>() ----------

// LoadSnapshot returns the persisted state as a JSON string ("" if the DB is
// empty, so the frontend falls back to its seed data).
func (a *App) LoadSnapshot() string {
	if a.store == nil {
		return ""
	}
	snap, err := a.store.LoadSnapshot()
	if err != nil {
		return ""
	}
	return snap
}

// SaveSnapshot persists the full frontend state (debounced on the JS side). The
// store diffs it and records an oplog entry per change for sync.
func (a *App) SaveSnapshot(state string) {
	if a.store != nil {
		_ = a.store.SaveSnapshot(state)
	}
}

// Sync runs one push/pull cycle against the configured cloud adapter and returns
// a JSON SyncResult (including the merged snapshot).
func (a *App) Sync() string {
	if a.store == nil {
		return `{"adapter":"none"}`
	}
	res, err := a.store.Sync()
	if err != nil {
		b, _ := json.Marshal(map[string]string{"error": err.Error()})
		return string(b)
	}
	return res
}

// SyncNote syncs one task's note scope on demand (call when its detail view opens)
// and returns a JSON SyncResult-shaped payload whose snapshot has the merged note.
func (a *App) SyncNote(taskID string) string {
	if a.store == nil {
		return `{"adapter":"none"}`
	}
	snap, err := a.store.SyncNote(taskID)
	if err != nil {
		b, _ := json.Marshal(map[string]string{"error": err.Error()})
		return string(b)
	}
	b, _ := json.Marshal(map[string]string{"adapter": "server", "snapshot": snap})
	return string(b)
}

// CloseNote stops syncing a task's note scope (call when its detail view closes).
func (a *App) CloseNote(taskID string) {
	if a.store != nil {
		a.store.CloseNote(taskID)
	}
}

// syncPrefs persists the sync-server connection so a desktop sign-in survives
// restarts — mirroring what the web app keeps in localStorage.
type syncPrefs struct {
	URL   string `json:"url"`
	Token string `json:"token"`
}

func syncPrefsPath() string { return filepath.Join(dataDir(), "sync.json") }

func loadSyncPrefs() syncPrefs {
	var p syncPrefs
	if b, err := os.ReadFile(syncPrefsPath()); err == nil {
		_ = json.Unmarshal(b, &p)
	}
	return p
}

func saveSyncPrefs(p syncPrefs) {
	if b, err := json.Marshal(p); err == nil {
		_ = os.WriteFile(syncPrefsPath(), b, 0o600)
	}
}

// SetSyncServer points the store's cloud adapter at a real server and persists
// the connection, so the desktop app signs in with the same username/password
// as the web app: the JS layer authenticates, then hands us the URL + token.
func (a *App) SetSyncServer(url, token string) {
	if a.store == nil || url == "" || token == "" {
		return
	}
	saveSyncPrefs(syncPrefs{URL: url, Token: token})
	a.store.SetServer(url, token)
}

// ClearSyncServer signs out: drop the connection. The ygo replica keeps working
// fully offline with no server attached.
func (a *App) ClearSyncServer() {
	saveSyncPrefs(syncPrefs{})
	if a.store != nil {
		a.store.ClearServer()
	}
}

// ResetStore wipes all local data (backs the app's "Delete all data" action).
func (a *App) ResetStore() {
	if a.store != nil {
		_ = a.store.Reset()
	}
}

// GetWindowMode / SetWindowMode are callable from JS as
// window.go.main.App.GetWindowMode() / .SetWindowMode("maximized"|"remember").
func (a *App) GetWindowMode() string { return loadPrefs().Mode }

func (a *App) SetWindowMode(mode string) {
	p := loadPrefs()
	if mode != "remember" {
		mode = "maximized"
	}
	p.Mode = mode
	savePrefs(p)
}

// startup applies the saved window state, then reveals the (StartHidden) window
// so it appears already in the right size/state — no resize flash.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	// Open the offline-first ygo replica and connect it to a sync server if one is
	// configured. Precedence:
	//   1. THINGS_SYNC_URL env (power users / CI)
	//   2. a persisted sign-in (Settings → Sync in the app)
	//   3. none — the replica works fully offline until a server is set.
	// Failure is non-fatal: the frontend keeps working from its in-memory seed.
	if store, err := coordinator.Open(dataDir()); err == nil {
		a.store = store
		if url := os.Getenv("THINGS_SYNC_URL"); url != "" {
			store.SetServer(url, os.Getenv("THINGS_SYNC_TOKEN"))
		} else if sp := loadSyncPrefs(); sp.URL != "" && sp.Token != "" {
			store.SetServer(sp.URL, sp.Token)
		}
	}
	p := loadPrefs()
	if p.Mode == "remember" && p.Width > 0 && p.Height > 0 {
		if p.Maximized {
			runtime.WindowMaximise(ctx)
		} else {
			runtime.WindowSetSize(ctx, p.Width, p.Height)
			runtime.WindowSetPosition(ctx, p.X, p.Y)
		}
	} else {
		runtime.WindowMaximise(ctx)
	}
	runtime.WindowShow(ctx)
}

// beforeClose records the current window geometry when in "remember" mode.
func (a *App) beforeClose(ctx context.Context) bool {
	p := loadPrefs()
	if p.Mode == "remember" {
		p.Maximized = runtime.WindowIsMaximised(ctx)
		if !p.Maximized {
			p.Width, p.Height = runtime.WindowGetSize(ctx)
			p.X, p.Y = runtime.WindowGetPosition(ctx)
		}
		savePrefs(p)
	}
	return false // allow the window to close
}

func main() {
	// Root the embedded FS at frontend/dist so index.html is served at "/".
	dist, err := fs.Sub(assets, "frontend/dist")
	if err != nil {
		panic(err)
	}

	app := &App{}

	// Menu callbacks run JS in the webview (browser-style zoom).
	zoom := func(cmd string) {
		if app.ctx != nil {
			runtime.WindowExecJS(app.ctx, "window.__appZoom && window.__appZoom('"+cmd+"')")
		}
	}

	// Custom menu = standard app + edit menus (so Quit, Copy/Paste/Undo etc.
	// keep working) plus a browser-style View menu whose items drive the
	// frontend zoom. Accelerators use the unshifted "=" / "-" / "0" keys.
	appMenu := menu.NewMenu()
	appMenu.Append(menu.AppMenu())
	appMenu.Append(menu.EditMenu())
	viewMenu := appMenu.AddSubmenu("View")
	viewMenu.AddText("Zoom In", keys.CmdOrCtrl("="), func(_ *menu.CallbackData) { zoom("in") })
	viewMenu.AddText("Zoom Out", keys.CmdOrCtrl("-"), func(_ *menu.CallbackData) { zoom("out") })
	viewMenu.AddText("Actual Size", keys.CmdOrCtrl("0"), func(_ *menu.CallbackData) { zoom("reset") })

	err = wails.Run(&options.App{
		Title:            "Things Clone",
		Width:            defaultWidth,
		Height:           defaultHeight,
		MinWidth:         720,
		MinHeight:        480,
		BackgroundColour: &options.RGBA{R: 255, G: 255, B: 255, A: 1},
		Menu:             appMenu,
		// Start hidden; `startup` sizes/maximises the window and then shows it,
		// so it never flashes at the wrong size.
		StartHidden:   true,
		OnStartup:     app.startup,
		OnBeforeClose: app.beforeClose,
		Bind:          []interface{}{app},
		AssetServer: &assetserver.Options{
			Assets: dist,
		},
		Mac: &mac.Options{
			// Hidden title bar (no toolbar) keeps the traffic lights at the
			// standard, higher top-left position — like VS Code. (HiddenInset
			// uses a toolbar that pushes them lower.)
			TitleBar: mac.TitleBarHidden(),
			About: &mac.AboutInfo{
				Title:   "Things Clone",
				Message: "A Things 3 / Todoist-style to-do app.",
			},
		},
	})
	if err != nil {
		println("Error:", err.Error())
	}
}

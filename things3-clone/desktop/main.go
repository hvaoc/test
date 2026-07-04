package main

import (
	"context"
	"embed"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"

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

// App is bound to the frontend so the Settings screen can read/change the
// startup-window mode.
type App struct {
	ctx context.Context
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

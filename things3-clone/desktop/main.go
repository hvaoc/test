package main

import (
	"context"
	"embed"
	"io/fs"

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

func main() {
	// Root the embedded FS at frontend/dist so index.html is served at "/".
	dist, err := fs.Sub(assets, "frontend/dist")
	if err != nil {
		panic(err)
	}

	// Captured on startup so the menu callbacks can run JS in the webview.
	var appCtx context.Context
	zoom := func(cmd string) {
		if appCtx != nil {
			runtime.WindowExecJS(appCtx, "window.__appZoom && window.__appZoom('"+cmd+"')")
		}
	}

	// Custom menu = standard app + edit menus (so Quit, Copy/Paste/Undo etc.
	// keep working) plus a browser-style View menu whose items drive the
	// frontend zoom. Accelerators use the unshifted "=" / "-" / "0" keys so
	// Cmd+= / Cmd+- / Cmd+0 zoom like a browser; the JS keydown handler also
	// covers Cmd++ and the numpad keys.
	appMenu := menu.NewMenu()
	appMenu.Append(menu.AppMenu())
	appMenu.Append(menu.EditMenu())
	viewMenu := appMenu.AddSubmenu("View")
	viewMenu.AddText("Zoom In", keys.CmdOrCtrl("="), func(_ *menu.CallbackData) { zoom("in") })
	viewMenu.AddText("Zoom Out", keys.CmdOrCtrl("-"), func(_ *menu.CallbackData) { zoom("out") })
	viewMenu.AddText("Actual Size", keys.CmdOrCtrl("0"), func(_ *menu.CallbackData) { zoom("reset") })

	err = wails.Run(&options.App{
		Title:            "Things Clone",
		Width:            1200,
		Height:           800,
		MinWidth:         720,
		MinHeight:        480,
		BackgroundColour: &options.RGBA{R: 255, G: 255, B: 255, A: 1},
		Menu:             appMenu,
		OnStartup:        func(ctx context.Context) { appCtx = ctx },
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

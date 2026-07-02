package main

import (
	"embed"
	"io/fs"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
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

	err = wails.Run(&options.App{
		Title:            "Things Clone",
		Width:            1200,
		Height:           800,
		MinWidth:         720,
		MinHeight:        480,
		BackgroundColour: &options.RGBA{R: 255, G: 255, B: 255, A: 1},
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

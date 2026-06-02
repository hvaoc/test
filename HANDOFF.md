# 🤝 Handoff — PlayMap

Snapshot of where this prototype stands so it can be picked up locally (by you
or by a fresh local Claude Code session).

## What this is
A prototype that posts **local events & user activities on a map in real time**,
where the map looks like a **kids' game map** but is derived from a **real
OpenStreetMap**. The cartoon look is achieved by rendering genuine OSM raster
tiles (Leaflet) and running them through CSS filters, plus bouncy emoji pins
and a chunky game-style HUD.

## Status: ✅ working prototype
- Backend serves and streams real-time events correctly (verified).
- Frontend renders the cartoon map, live feed, and post-an-activity flow.
- Falls back to a client-side simulator if the backend isn't reachable.

## Branch
All work is on `claude/realtime-events-map-prototype-0F69Y` (not `main`).

## Run it
```bash
npm install
npm start          # → http://localhost:4173
# different port?  PORT=8080 npm start
```
Open in **two tabs** to see activities you post broadcast live between them.

## Architecture / where things live
| File | Responsibility |
| --- | --- |
| `server.js` | Express + Socket.IO. Per-player event simulator (`makeEvent`, `EVENT_TYPES`), broadcasts posted activities. In-memory only, no DB. Default port **4173** (`PORT` env overrides). |
| `public/index.html` | Page shell. Loads Leaflet + Socket.IO client from CDN. |
| `public/style.css` | **The "real map → kids game map" magic** — CSS filters on `.leaflet-tile-pane`, bouncy `.pin` markers, game HUD. |
| `public/app.js` | Leaflet map setup (real OSM tiles), Socket.IO client + local-simulator fallback, live feed, geolocation, post-activity flow. |

Key shared concept: `EVENT_TYPES` (emoji + label per event kind) is defined in
**both** `server.js` and `public/app.js` — keep them in sync if you add types.

## Known limitations (prototype-level)
- Events are **simulated**, not real local data.
- No persistence (in-memory) and no user accounts.
- Cartoon look is a CSS filter over raster tiles, not a true vector style.
- Phone browsers need HTTPS for geolocation, so on mobile it defaults to London.

## Suggested next steps
1. **True vector cartoon style** — swap raster+CSS for MapLibre GL with a custom
   style over free vector tiles (OpenFreeMap / OpenMapTiles).
2. **Persistence** — store events/activities in a DB; add expiry so they fade.
3. **Real event sources** — council feeds, Eventbrite, transport alerts.
4. **Gamification** — XP/quests for visiting events, leaning into the "game".
5. **Accounts & moderation** for user-posted activities.

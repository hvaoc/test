# 🗺️ PlayMap

A prototype that posts **local events and user activities on a map in real time** —
where the map looks like a **kids' game map**, but is actually derived from a
**real OpenStreetMap**.

![concept](https://img.shields.io/badge/map-OpenStreetMap-7be08a) ![realtime](https://img.shields.io/badge/realtime-Socket.IO-6ad7e5)

## How it works

| Goal | How |
| --- | --- |
| **Real map from OpenStreetMap** | [Leaflet](https://leafletjs.com/) renders genuine OSM raster tiles. |
| **Kids-game look** | The real tiles are run through CSS filters (boosted saturation, soft contrast, gentle blur) so the streets read as a candy-coloured cartoon. Big bouncy emoji pins + a chunky game-style HUD finish the look. See `public/style.css`. |
| **Real-time events** | A Node + Socket.IO backend (`server.js`) streams simulated *local events* happening around each player and broadcasts activities players post. |
| **User activities** | "➕ Post an activity" → pick a vibe → tap the map. It appears instantly for everyone connected. |
| **Local** | Uses browser geolocation to centre on you and generate nearby events (falls back to London if denied). |

> The cartoon styling is pure CSS over the **real** map, so every street, park
> and label is exactly where it is in the real world — just drawn like a toy.

## Run it

```bash
npm install
npm start
# open http://localhost:4173
```

> Runs on port **4173** by default (chosen to avoid the common `3000` clash).
> Need a different one? `PORT=8080 npm start`.

No backend? No problem — the frontend has a **built-in demo simulator**, so if
Socket.IO can't connect it keeps generating events client-side (you'll see a
yellow `● demo mode` badge instead of the green `● live` one).

## Project layout

```
server.js            Express + Socket.IO server & event simulator
public/index.html    Page shell + CDN scripts (Leaflet, Socket.IO client)
public/style.css     The "real map → kids game map" cartoon styling
public/app.js        Map, real-time stream, feed, and the post-activity flow
```

## Ideas to take it further

- Swap the CSS-filter look for a true cartoon **vector** style (MapLibre GL +
  a custom style over OpenFreeMap / OpenMapTiles).
- Persist events in a database and add real user accounts.
- Plug in real local-event sources (council feeds, Eventbrite, transport alerts).
- Add XP / quests so visiting events earns points — leaning fully into the game.

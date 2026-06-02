# CLAUDE.md

Guidance for Claude Code working in this repo.

## Project
**PlayMap** — a prototype that shows local events & user activities on a map in
real time, where the map looks like a kids' game map but is derived from a real
OpenStreetMap. See `HANDOFF.md` for full status and `README.md` for the pitch.

## Stack
- **Backend:** Node.js (ES modules) + Express + Socket.IO (`server.js`).
- **Frontend:** vanilla JS + Leaflet, served statically from `public/`.
- No build step, no framework, no database (in-memory prototype).

## Run / test
```bash
npm install
npm start          # http://localhost:4173  (PORT env overrides)
```
Open two browser tabs to verify real-time broadcast of posted activities.

## Conventions
- Frontend is dependency-light on purpose: Leaflet + Socket.IO load from CDN in
  `public/index.html`. Keep it framework-free unless there's a strong reason.
- The cartoon map look lives entirely in `public/style.css` (CSS filters over
  real OSM tiles + emoji `.pin` markers). Preserve the "real map underneath"
  property — don't replace tiles with fake/drawn imagery.
- `EVENT_TYPES` exists in **both** `server.js` and `public/app.js`; if you add
  or rename an event type, update both.
- `public/app.js` must keep working **without** a backend (client-side
  simulator fallback) so the prototype is always demoable.

## Don't
- Don't add a heavy frontend build/framework without discussing first.
- Don't introduce a database/secrets for the prototype unless asked.

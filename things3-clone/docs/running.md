# Running & testing (web + macOS desktop + sync server)

Everything below is run from the repo. Paths are relative to the app root
`things3-clone/`. The sync server is a Go program under `things3-clone/desktop/`.

```
things3-clone/            # the Expo / React Native app (web + native shells)
  desktop/                # Go: Wails desktop app, gomobile, and the sync server
    cmd/ysync-server/     # ← the sync server to run (Phase 2, real accounts)
```

## 0. Prerequisites
- **Node** (18+) and **npm** — for the web app and desktop bundling.
- **Go** (1.23+) — for the sync server and the desktop/WASM build.
- **Xcode + a signing identity** — only needed to *build* the desktop app.
- First time: `cd things3-clone && npm install`.

---

## 1. Sync server (run this first)

The server is multi-tenant with **real accounts** (bcrypt users, tenants/teams,
roles). Run it from the `desktop/` module:

```bash
cd things3-clone/desktop
go run ./cmd/ysync-server -addr :8090 -data ./ysync-data
```

- `-addr :8090` — listen address (clients point at `http://localhost:8090`).
- `-data ./ysync-data` — directory for persistence. **Accounts + all data live
  here** and survive restarts. Omit `-data` for an in-memory server (everything
  is lost on restart — handy for a clean slate).

Health check (in another terminal):
```bash
curl -s localhost:8090/v1/health      # -> {"status":"ok"}
```

> The old `cmd/server` (pre-ygo op-relay) is superseded — use `cmd/ysync-server`.

---

## 2. Web app

```bash
cd things3-clone
npm run web        # expo start --web
```

Open the URL Expo prints (typically **http://localhost:8081**). The web app is a
full offline-first replica: it works with no server; sign in to sync.

---

## 3. macOS desktop app

Build (bundles the current web code + the Go engine, signs, and notarizes):
```bash
cd things3-clone
npm run desktop           # darwin/arm64; use desktop:intel / desktop:universal for others
```

Launch the built app:
```bash
npm run desktop:run       # opens desktop/build/bin/things3-clone.app
```

The desktop app embeds the web frontend, so **a rebuild is required to pick up
frontend changes** — running an old `.app` will not show new UI.

> After a rebuild, if the desktop app shows stale content, quit it fully and
> relaunch (WKWebView can hold a cached bundle).

---

## 4. Sign in (same on web and desktop)

In the app: **profile (bottom-left "…") → Settings → Sync**, then:
- **Server URL:** `http://localhost:8090`
- **Username / Password:** anything you like — the account is **created on first
  sign-in** (no separate registration). **The password must be at least 6
  characters.** Signing in again with the same username uses a *wrong* password
  reports "Wrong password for that account".

The client logs you in, opens your workspace (tenant), and mints a tenant-scoped
sync token. Data then syncs automatically (auto-push + realtime pull over a
WebSocket).

---

## 5. What to test, and how

### A) Sync between web and desktop  ✅ easiest
Sign in with the **same username + password** on **both** web and the desktop
app. Add/edit/reorder a task on one — it appears on the other within ~1s. This
exercises the ygo engine, persistence, ordering, and the sync server end to end.

### B) Live collaboration (presence, "editing…", remote carets, "added by")
These need **two _different_ users in the _same_ workspace**. Signing into the
*same* account on two devices won't show presence (they're the same person). The
quickest way to see it today is to **simulate a teammate** with the included
script, which connects a second identity to your workspace over the realtime
channel:

```bash
cd things3-clone/desktop

# 1) Get a sync token for your workspace (use the SAME username/password you
#    signed in with in the app):
bash scripts/get-sync-token.sh me secret1
# -> prints  SYNC_TOKEN=<...>

# 2) Run the simulated teammate (needs Node 22+ for global WebSocket):
node scripts/sim-teammate.mjs <SYNC_TOKEN> Robin
```

Then, in the app, **open a task**. You'll see **"Robin is here"**, a **"Robin
editing…"** hint, and a **coloured caret with a "Robin" flag** move inside the
note; adding a task flashes an ephemeral **"added by Robin"** on its row. The
script prints what it's doing and moves Robin's cursor around every second.

> Real two-account collaboration in the UI needs a workspace picker (a user is
> auto-placed in their personal workspace today). That's a small follow-up — ask
> and it's a quick add.

---

## 6. Reset / start fresh
- **In-app:** Settings → Backups → **Delete all data** (wipes this device's local
  store; also signs out).
- **Server:** stop it and delete the `-data` directory (removes all accounts +
  data), or run without `-data` for an ephemeral server.
- **Sample data:** Settings → Backups → **Load sample data**.

---

## Quick reference

| Task | Command |
|---|---|
| Sync server | `cd things3-clone/desktop && go run ./cmd/ysync-server -addr :8090 -data ./ysync-data` |
| Web app | `cd things3-clone && npm run web` |
| Build desktop | `cd things3-clone && npm run desktop` |
| Launch desktop | `cd things3-clone && npm run desktop:run` |
| Server health | `curl -s localhost:8090/v1/health` |
| Get a sync token | `cd things3-clone/desktop && bash scripts/get-sync-token.sh me secret1` |
| Simulate a teammate | `cd things3-clone/desktop && node scripts/sim-teammate.mjs <SYNC_TOKEN> Robin` |
| Go tests | `cd things3-clone/desktop && go test ./...` |

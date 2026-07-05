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

### B) Two real users collaborating (presence, "editing…", carets, "added by")
Collaboration happens inside a **shared workspace**. Two _different_ accounts that
sign in with the **same Workspace code** land in one workspace and collaborate
live. (Signing into the *same account* on two devices only syncs data — it's one
person, so there's no presence.)

**Setup — two users, one workspace:**
1. **User 1** — e.g. the web app (http://localhost:8081): Settings → Sync →
   Username `alice`, Password `alicepw`, **Workspace `team1`** → Sign in.
2. **User 2** — a *separate* session so it's a different login: the **desktop
   app**, a **second browser**, or a **private/incognito window** (a second tab
   in the same browser shares the login, so it won't work): Username `bob`,
   Password `bobpw12`, **Workspace `team1`** → Sign in.

Now add/edit tasks on either side — they converge live. **Open the same task on
both** to see each other's **presence dot ("bob is here"), the "editing…" hint,
and a coloured remote caret with a name flag** move inside the note; adding a task
flashes an ephemeral **"added by …"** on its row.

The first person to use a workspace code owns it; anyone else who enters the same
code joins as an editor. Leave Workspace blank to use your private workspace.

### C) Or simulate a teammate (no second account needed)
Connect a fake teammate to your workspace over the realtime channel:
```bash
cd things3-clone/desktop
bash scripts/get-sync-token.sh alice alicepw team1   # workspace as 3rd arg
node scripts/sim-teammate.mjs <SYNC_TOKEN> Robin      # Node 22+
```
Open a task in the app and you'll see "Robin is here", "Robin editing…", a moving
caret, and periodic "added by Robin" flashes.

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

# HANDOFF — things3-clone

A Things‑3/Todoist‑style task app that is **offline‑first** on every platform and
now a **real‑time collaborative, multi‑tenant product** with accounts, teams, and
invitations. This doc is the entry point for continuing the work in a fresh
session.

> Note: the repo root `CLAUDE.md` describes an unrelated "PlayMap" project. **The
> real app is this `things3-clone/` directory.** Work here.

---

## 1. What it is

- **Frontend:** Expo / React Native (+ react‑native‑web). One codebase → web,
  macOS desktop (Wails/WKWebView), and iOS/Android (gomobile).
- **Data layer:** a **CRDT** so every device is a full replica that works offline
  and merges automatically — the user is never asked to resolve a conflict.
- **Engine:** **ygo** (`github.com/reearth/ygo`) — a pure‑Go, Yjs‑binary‑compatible
  CRDT (YATA). One Go core compiled/embedded four ways (see §3).
- **Server:** a Go **multi‑tenant Yjs sync server** with real accounts, roles,
  workspaces, and email invitations.

## 2. Current status (all done + verified)

- ✅ **ygo migration** (Phase 0/1): engine + persistence + sync moved from a
  hand‑written LWW/HLC CRDT to ygo, across web (WASM+Worker), desktop, mobile.
- ✅ **Sync server** (`server/ysync`): per‑tenant authoritative `crdt.Doc`,
  state‑vector push/pull, realtime WebSocket (nudge **+** presence/awareness).
- ✅ **Auth & teams** (`server/auth`): bcrypt users, tenants/workspaces,
  roles (owner/editor/viewer), tenant‑scoped sync tokens.
- ✅ **Real‑time collaboration:** presence, remote carets in notes, "editing…",
  ephemeral "added by X" flash. Sync latency ~0.5s.
- ✅ **Concurrent‑safe ordering:** fractional index keys (`store/ordering.js`).
- ✅ **Shared workspaces + multi‑workspace membership;** each workspace has its own
  local replica (web worker DB per workspace) so switching never mixes data.
- ✅ **User/team management UI** (`WorkspaceSheet`): switch/create/rename/delete/
  leave, members (roles/remove), **invitations by email / link / QR (app logo
  centred)**, revoke.
- ✅ **First‑class auth** (`AuthSheet`): Login / Sign Up / **email‑verified** sign
  up (`VerifyBanner`, `/v1/verify`), opened from the sidebar (not buried in
  Settings). `JoinInvite` handles `?invite=CODE`.
- ✅ **Email in dev via MailPit.**

Milestone tags: `pre-ygo-crdt`, `ygo-realtime-collab`, `pre-user-management`.

## 3. Architecture map (the DRY spine)

```
core/ydoc            the ONE engine: domain <-> ygo Doc (schema, snapshot bridge, sync prims)
  ├─ core/wasm       -> crdt.wasm (js/wasm), driven by public/crdt.worker.js (SQLite/OPFS, DB per workspace)
  ├─ core/ydstore    native store (Wails desktop + gomobile) — Yjs blob file + state-vector sync
server/ysync         multi-tenant sync relay: /v1/push, /v1/pull, /v1/stream (WS: nudge + presence + activity)
server/auth          accounts, workspaces, roles, invites, email verification; implements ysync.Authenticator
server/mail          SMTP (MailPit in dev) + email templates
cmd/ysync-server     wires auth + sync + mail on one mux
```

Frontend data flow: React `TasksContext` ⇄ `store/backend.js` (routes to the
right platform store) ⇄ `store/crdtClient.js` (web worker RPC). Team/account calls
go through `store/teamApi.js` using the **session token**; data sync uses the
**tenant‑scoped sync token**.

### Two token kinds (important)
- **Session token** — identity; used for `/v1/profile`, workspaces, invites, minting sync tokens.
- **Sync token** — scoped to (user, tenant, role); stored by the client and sent to `/v1/push` `/v1/pull`. The tenant is baked in, so the data client needs no extra fields.

## 4. How to run

Full runbook: **[docs/running.md](docs/running.md)**. Short version:

```bash
brew install mailpit && mailpit                        # invite/verify emails, inbox at :8025
cd things3-clone/desktop
go run ./cmd/ysync-server -addr :8090 -data ./ysync-data \
  -smtp localhost:1025 -app-url http://localhost:8081   # app-url = where the web app is served

cd things3-clone && npm install && npm run web          # web
# npm run desktop / npm run desktop:run                 # macOS app (rebuild to pick up frontend changes)
```

Sign in / sign up from the **sidebar** ("Sign in or sign up"). Manage teams and
invites from **profile menu → Workspaces & team**. Read emails at
**http://localhost:8025**. To test collaboration, use two *separate* sessions
(desktop + web, or web + incognito) or `desktop/scripts/sim-teammate.mjs`.

## 5. Design docs
- `docs/crdt-ygo.md` — target CRDT architecture + migration plan (why ygo, schema, sync).
- `docs/crdt-current.md` — the previous hand‑written engine (historical).
- `docs/running.md` — run/test everything, including MailPit and two‑user collaboration.

## 6. Known limitations / next steps
- **Desktop/mobile active‑workspace switching:** web keeps one local replica per
  workspace (worker DB per workspace); native (`core/ydstore`) uses one file per
  install, so switching workspaces there needs a per‑workspace file/reopen. (Web
  is fully multi‑workspace; native picks one active workspace per install.)
- **Push‑based realtime:** data still travels **nudge (WS) → pull (HTTP)**.
  Presence/carets already go fully over the WS. Sending the actual Yjs update over
  the WS would remove the pull round‑trip → near‑instant. (Server has the update
  in `Room.Apply`; broadcast it and apply on the client.)
- **Redis fan‑out:** the sync server is single‑instance; multiple instances
  serving one workspace need a pub/sub to fan out updates.
- **Orphaned CRDT data on workspace delete:** `DeleteWorkspace` removes accounts/
  tokens but the ysync `Doc` is left (unreachable). Add a hub hook to drop it.
- **Invites:** currently multi‑use links with a 14‑day expiry; no per‑seat limits.
- **Auth hardening:** rate limiting, password reset, session expiry/rotation, real
  email deliverability (prod SMTP) are not implemented.
- **`server/auth` persistence** is a single JSON file (fine for the prototype);
  move to a DB for scale.

## 7. Where things live (quick index)
- Server: `desktop/server/{ysync,auth,mail}`, `desktop/cmd/ysync-server`, `desktop/core/{ydoc,ydstore,wasm}`.
- Web engine: `public/crdt.worker.js`, `public/crdt.wasm` (built by `desktop/build-wasm.sh`).
- Client stores: `src/store/{backend,teamApi,crdtClient,authModal,ordering}.js`, `src/store/TasksContext.js`.
- Auth/team UI: `src/components/{AuthSheet,WorkspaceSheet,JoinInvite,VerifyBanner,InviteQR}.js`, sidebar in `src/screens/HomeScreen.js`.
- Tests: `go test ./...` in `desktop/` (auth, ydoc, ydstore, ysync all covered).

## 8. Conventions
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- After a desktop build, `git checkout` the regenerated `public/crdt.wasm` and
  `desktop/frontend/wailsjs/` (build churn) to keep the tree clean.
- Verify web changes in the browser preview; verify server changes with
  `go test` + curl (+ MailPit for email).

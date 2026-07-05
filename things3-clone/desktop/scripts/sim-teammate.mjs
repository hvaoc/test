// Simulate a teammate on the realtime channel so you can see live collaboration
// (presence, the "editing…" hint, a moving remote caret, and the ephemeral
// "added by X" flash) WITHOUT a second real account. The simulated user joins
// whatever workspace the SYNC token belongs to.
//
// Requires Node 22+ (built-in global WebSocket).
//
// Usage:
//   node scripts/sim-teammate.mjs <SYNC_TOKEN> [name]
//   SERVER=http://localhost:8090 node scripts/sim-teammate.mjs <SYNC_TOKEN> Robin
//
// Get a SYNC_TOKEN with: bash scripts/get-sync-token.sh <username> <password>

const [, , token, nameArg] = process.argv;
const name = nameArg || 'Robin';
const server = process.env.SERVER || 'http://localhost:8090';

if (!token) {
  console.error('usage: node sim-teammate.mjs <SYNC_TOKEN> [name]');
  process.exit(1);
}

// Deterministic colour from the name.
let h = 7;
for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
const color = '#' + (h % 0xffffff).toString(16).padStart(6, '0');

const wsUrl = server.replace(/^http/, 'ws') + '/v1/stream?token=' + encodeURIComponent(token);
const ws = new WebSocket(wsUrl);

let taskId = null; // the task you currently have open (learned from your presence)
let cursor = 0;
let tick = 0;

ws.onopen = () => console.log(`${name} connected to ${server} — open a task in the app to see me.`);
ws.onerror = () => console.error('connection error — is the server running and the token valid?');
ws.onclose = () => { console.log('disconnected'); process.exit(0); };

ws.onmessage = (ev) => {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  if (m.type === 'presence' && m.state && m.state.taskId && m.state.taskId !== taskId) {
    taskId = m.state.taskId;
    console.log(`${name} is now on task ${taskId}`);
  }
};

// Every second: keep presence alive and drift the caret so it visibly moves.
setInterval(() => {
  if (ws.readyState !== 1) return;
  cursor = (cursor + 3) % 40;
  ws.send(JSON.stringify({
    type: 'presence',
    state: { user: name, userId: 'sim-' + name, color, taskId, cursor },
  }));
  // Every ~8s, flash an ephemeral "added by <name>" on the current task's row
  // (visible in the project/list view).
  if (taskId && ++tick % 8 === 0) {
    ws.send(JSON.stringify({
      type: 'activity',
      state: { kind: 'added', taskId, user: name, color },
    }));
    console.log(`${name} flashed an "added by" on task ${taskId}`);
  }
}, 1000);

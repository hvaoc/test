// Browser CRDT engine — a faithful JS mirror of the Go `core` engine
// (desktop/core). It gives the web build the SAME field-level, Hybrid-Logical-
// Clock conflict resolution as desktop/mobile, so a browser tab is a first-class
// replica: it merges concurrent edits per-field, survives offline periods, and
// converges with every other device through the sync server.
//
// Protocol compatibility with Go is load-bearing: the op wire format
// ({t,k,i,f,e,v,p,w,c,n}), the HLC comparison, the LWW/add-wins rules, and the
// canonical JSON MUST match core/*.go byte-for-byte, or two replicas will emit
// ops back and forth forever. See TestCanonCompat (Go) and the mirror below.
//
// Pure module — no React, no IO. Persistence (IndexedDB) and transport (the
// sync server) live in backend.js; this file only owns the merge semantics.

const US = ''; // entity-key separator (matches Go's \x1f)
const ekey = (kind, id) => kind + US + id;

// Kinds with id-bearing object collections in a snapshot.
const OBJECT_KINDS = ['area', 'project', 'heading', 'task', 'customView'];
// Fields that are add-wins SET CRDTs rather than scalar LWW registers.
const SET_FIELDS = { task: { tags: true } };
const isSetField = (kind, field) => !!(SET_FIELDS[kind] && SET_FIELDS[kind][field]);

// ---------------------------------------------------------------------------
// Canonical JSON — MUST match Go core.canon(): object keys sorted, arrays in
// order, no HTML escaping. JSON.stringify already omits HTML escaping; we add
// recursive key sorting.
// ---------------------------------------------------------------------------

export function canon(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(value[k])).join(',') + '}';
}

// ---------------------------------------------------------------------------
// Hybrid Logical Clock — mirror of hlc.go.
// ---------------------------------------------------------------------------

function hlcCompare(a, b) {
  if (a.w !== b.w) return a.w < b.w ? -1 : 1;
  if (a.c !== b.c) return a.c < b.c ? -1 : 1;
  if (a.n !== b.n) return a.n < b.n ? -1 : 1;
  return 0;
}
const hlcAfter = (a, b) => hlcCompare(a, b) > 0;

// ---------------------------------------------------------------------------
// The engine.
// ---------------------------------------------------------------------------

export class Crdt {
  constructor(node, now) {
    this.node = node || 'web-' + Math.random().toString(16).slice(2, 10);
    this.now = now || (() => Date.now());
    this.last = { w: 0, c: 0, n: this.node }; // clock
    this.presence = {}; // ekey -> { present, hlc }
    this.fields = {}; // ekey -> field -> { value(canonStr), hlc }
    this.sets = {}; // ekey -> field -> elem(canonStr) -> { present, hlc }
    this.pending = []; // local ops not yet pushed
    this.cursor = ''; // server pull cursor
  }

  // --- clock ---
  localStamp() {
    const wall = this.now();
    if (wall > this.last.w) this.last = { w: wall, c: 0, n: this.node };
    else this.last = { w: this.last.w, c: this.last.c + 1, n: this.node };
    return { ...this.last };
  }
  witness(remote) {
    const wall = this.now();
    const max = Math.max(this.last.w, remote.w, wall);
    if (max === this.last.w && max === remote.w) {
      this.last = { w: max, c: Math.max(this.last.c, remote.c) + 1, n: this.node };
    } else if (max === this.last.w) {
      this.last = { w: max, c: this.last.c + 1, n: this.node };
    } else if (max === remote.w) {
      this.last = { w: max, c: remote.c + 1, n: this.node };
    } else {
      this.last = { w: max, c: 0, n: this.node };
    }
  }

  // --- apply one op (LWW). Local ops carry a fresh (greatest) HLC so they
  // always win; remote ops apply only when strictly newer. Returns applied. ---
  applyOp(op, isLocal) {
    const h = { w: op.w, c: op.c, n: op.n };
    const k = ekey(op.k, op.i);
    let applied = false;
    if (op.t === 'presence') {
      const cur = this.presence[k];
      if (!cur || hlcAfter(h, cur.hlc)) {
        this.presence[k] = { present: !!op.p, hlc: h };
        applied = true;
      }
    } else if (op.t === 'field') {
      const f = (this.fields[k] = this.fields[k] || {});
      const cur = f[op.f];
      if (!cur || hlcAfter(h, cur.hlc)) {
        f[op.f] = { value: canon(op.v), hlc: h };
        applied = true;
      }
    } else if (op.t === 'set') {
      const fs = (this.sets[k] = this.sets[k] || {});
      const es = (fs[op.f] = fs[op.f] || {});
      const cur = es[op.e];
      if (!cur || hlcAfter(h, cur.hlc)) {
        es[op.e] = { present: !!op.p, hlc: h };
        applied = true;
      }
    }
    if (isLocal && applied) this.pending.push(op);
    return applied;
  }

  // --- diff a frontend snapshot into CRDT ops (mirror of Go diff) ---
  diff(state) {
    const ops = [];
    const seen = {};

    const emitEntity = (kind, id, obj) => {
      const k = ekey(kind, id);
      const p = this.presence[k];
      if (!p || !p.present) ops.push({ t: 'presence', k: kind, i: id, p: true });
      for (const field of Object.keys(obj)) {
        if (field === 'id') continue;
        if (isSetField(kind, field)) {
          ops.push(...this.diffSet(kind, id, field, obj[field]));
          continue;
        }
        const nv = canon(obj[field]);
        const cur = this.fields[k] && this.fields[k][field];
        if (!cur || cur.value !== nv) ops.push({ t: 'field', k: kind, i: id, f: field, v: obj[field] });
      }
    };

    for (const kind of OBJECT_KINDS) {
      const arr = state[pluralOf(kind)] || [];
      for (const obj of arr) {
        if (!obj || !obj.id) continue;
        seen[ekey(kind, obj.id)] = true;
        emitEntity(kind, obj.id, obj);
      }
    }

    // Tags: existence-only entities.
    for (const name of state.tags || []) {
      const k = ekey('tag', name);
      seen[k] = true;
      const p = this.presence[k];
      if (!p || !p.present) ops.push({ t: 'presence', k: 'tag', i: name, p: true });
    }

    // Settings singleton → scalar fields of ('setting','app').
    if (state.settings && typeof state.settings === 'object') {
      const k = ekey('setting', 'app');
      seen[k] = true;
      const p = this.presence[k];
      if (!p || !p.present) ops.push({ t: 'presence', k: 'setting', i: 'app', p: true });
      for (const field of Object.keys(state.settings)) {
        const nv = canon(state.settings[field]);
        const cur = this.fields[k] && this.fields[k][field];
        if (!cur || cur.value !== nv) ops.push({ t: 'field', k: 'setting', i: 'app', f: field, v: state.settings[field] });
      }
    }

    // Tombstones: present entities gone from the snapshot.
    for (const k of Object.keys(this.presence)) {
      if (this.presence[k].present && !seen[k]) {
        const [kind, id] = k.split(US);
        ops.push({ t: 'presence', k: kind, i: id, p: false });
      }
    }
    return ops;
  }

  diffSet(kind, id, field, arr) {
    const want = {};
    for (const el of arr || []) want[canon(el)] = el;
    const ops = [];
    const k = ekey(kind, id);
    const existing = (this.sets[k] && this.sets[k][field]) || {};
    for (const elemC of Object.keys(want)) {
      const cur = existing[elemC];
      if (!cur || !cur.present) ops.push({ t: 'set', k: kind, i: id, f: field, e: elemC, p: true });
    }
    for (const elemC of Object.keys(existing)) {
      if (existing[elemC].present && !want[elemC]) ops.push({ t: 'set', k: kind, i: id, f: field, e: elemC, p: false });
    }
    return ops;
  }

  // --- persist a local snapshot: diff → stamp → apply → queue for push ---
  applyLocalSnapshot(state) {
    const ops = this.diff(state);
    for (const op of ops) {
      const h = this.localStamp();
      op.w = h.w;
      op.c = h.c;
      op.n = h.n;
      this.applyOp(op, true);
    }
    return ops.length;
  }

  // --- merge remote ops (from the server) ---
  applyRemote(ops) {
    let applied = 0;
    let skipped = 0;
    for (const op of ops) {
      this.witness({ w: op.w, c: op.c, n: op.n });
      if (op.n === this.node) {
        skipped++;
        continue;
      }
      if (this.applyOp(op, false)) applied++;
      else skipped++;
    }
    return { applied, skipped };
  }

  // --- ops queued for push; caller clears after a successful push ---
  takePending() {
    const ops = this.pending;
    this.pending = [];
    return ops;
  }

  // --- materialise merged state back to the frontend shape ---
  materialize() {
    const out = {};
    for (const kind of OBJECT_KINDS) out[pluralOf(kind)] = this.materializeKind(kind);
    const tags = [];
    for (const k of Object.keys(this.presence)) {
      if (!this.presence[k].present) continue;
      const [kind, id] = k.split(US);
      if (kind === 'tag') tags.push(id);
    }
    tags.sort();
    out.tags = tags;
    const settings = this.materializeOne('setting', 'app');
    if (settings) {
      delete settings.id;
      out.settings = settings;
    }
    return out;
  }

  materializeKind(kind) {
    const out = [];
    for (const k of Object.keys(this.presence)) {
      if (!this.presence[k].present) continue;
      const [ekind, id] = k.split(US);
      if (ekind !== kind) continue;
      const obj = this.materializeOne(kind, id);
      if (obj) out.push(obj);
    }
    return out;
  }

  materializeOne(kind, id) {
    const k = ekey(kind, id);
    const p = this.presence[k];
    if (!p || !p.present) return null;
    const obj = { id };
    const f = this.fields[k] || {};
    for (const field of Object.keys(f)) {
      try {
        obj[field] = JSON.parse(f[field].value);
      } catch {
        /* skip unparseable */
      }
    }
    const fs = this.sets[k] || {};
    for (const field of Object.keys(fs)) {
      const elems = Object.keys(fs[field]).filter((e) => fs[field][e].present).sort();
      obj[field] = elems.map((e) => {
        try {
          return JSON.parse(e);
        } catch {
          return e;
        }
      });
    }
    return obj;
  }

  hasData() {
    return Object.keys(this.presence).some((k) => this.presence[k].present);
  }

  // --- serialize for IndexedDB ---
  toJSON() {
    return {
      node: this.node,
      last: this.last,
      presence: this.presence,
      fields: this.fields,
      sets: this.sets,
      pending: this.pending,
      cursor: this.cursor,
    };
  }
  static fromJSON(data, now) {
    const c = new Crdt(data.node, now);
    c.last = data.last || { w: 0, c: 0, n: c.node };
    c.presence = data.presence || {};
    c.fields = data.fields || {};
    c.sets = data.sets || {};
    c.pending = data.pending || [];
    c.cursor = data.cursor || '';
    return c;
  }
}

function pluralOf(kind) {
  switch (kind) {
    case 'area':
      return 'areas';
    case 'project':
      return 'projects';
    case 'heading':
      return 'headings';
    case 'task':
      return 'tasks';
    case 'customView':
      return 'customViews';
    default:
      return kind + 's';
  }
}

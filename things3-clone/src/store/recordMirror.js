// Phase 2 integration glue between the live app (TasksContext) and the web record
// store (recordClient → record.worker.js). It keeps the record store a faithful
// mirror of the app's current tasks, and offers a hook so a view can render from
// the query API instead of the in-memory task array.
//
// This is the incremental cut-over path: the app keeps working on its existing
// in-memory selectors; a view opts in via useRecordList and falls back to the
// selector whenever the record store is unavailable or hasn't answered yet.

import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { recordStore, recordWorkerAvailable } from './recordClient';

// The web record adapter is a Worker + sqlite.wasm; only available on web. Native
// (Wails/gomobile) will bind core/record directly — a separate adapter.
export function recordAvailable() {
  return Platform.OS === 'web' && recordWorkerAvailable();
}

// Generation counter — bumped after each mirror so mounted queries re-run.
let _gen = 0;
const _subs = new Set();
function bump() { _gen += 1; _subs.forEach((fn) => fn(_gen)); }

const PRIORITY = { high: 3, medium: 2, low: 1 };

// mapTask: app task object → the record store's TaskInput shape.
function mapTask(t) {
  return {
    id: t.id,
    title: t.title || '',
    projectId: t.projectId || '',
    when: t.when || '',
    deadline: t.deadline || '',
    priority: PRIORITY[t.priority] || 0,
    status: t.status || 'open',
    parentId: t.parentId || '',
    order: typeof t.order === 'number' ? t.order : 0,
    notes: t.notes || '',
    tags: t.tags || [],
    completed: t.status === 'completed',
  };
}

let _pending = Promise.resolve();

// mirrorTasks upserts the app's current tasks into the record store (hydrate is
// idempotent LWW). Removals from a view are status changes (completed/trashed),
// which upsert naturally — so no reset is needed and the list never flickers empty.
// Coarse (O(current tasks) per call) but fine at present data sizes; the end state
// is per-entity writes. Calls are serialised so they can't interleave.
export function mirrorTasks(tasks) {
  if (!recordAvailable()) return _pending;
  _pending = _pending.then(async () => {
    try {
      await recordStore.hydrate((tasks || []).map(mapTask));
      bump();
    } catch (_) { /* leave the app on its in-memory path */ }
  });
  return _pending;
}

// useRecordList queries a smart list from the record store, re-running whenever the
// mirror updates. Returns an array of row objects, or null until the record store is
// available and has answered (the caller falls back to its in-memory selector then).
export function useRecordList(listId, params) {
  const [rows, setRows] = useState(null);
  const key = listId + '|' + JSON.stringify(params || {});
  useEffect(() => {
    if (!recordAvailable() || !listId) { setRows(null); return undefined; }
    let cancelled = false;
    const load = () => {
      recordStore
        .queryList(listId, params)
        .then((r) => { if (!cancelled) setRows(r); })
        .catch(() => { if (!cancelled) setRows(null); });
    };
    _subs.add(load);
    load();
    return () => { cancelled = true; _subs.delete(load); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return rows;
}

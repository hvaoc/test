// Native RecordStore adapter for iOS/Android — talks to the gomobile-bound Go
// record engine (core/record) through the RecordNative Expo module (see
// modules/record-native). Presents the SAME interface as the web adapter
// (recordClient), so recordMirror can use either behind one port.

import { Platform } from 'react-native';

let native = null;
try {
  // Local Expo module; absent on web/unlinked builds.
  native = require('../../modules/record-native').default;
} catch (_) {
  native = null;
}

export function recordNativeAvailable() {
  return (Platform.OS === 'ios' || Platform.OS === 'android') && !!native;
}

let _open = null;
function ensureOpen() {
  if (_open) return _open;
  _open = Promise.resolve()
    .then(() => native.open('things-record.db'))
    .catch((e) => { _open = null; throw e; });
  return _open;
}
async function withOpen(fn) {
  await ensureOpen();
  return fn();
}

const parseRows = (s) => {
  try { return JSON.parse(s || '[]'); } catch (_) { return []; }
};

// The RecordStore port (native). Query methods parse the JSON the Go side returns.
export const recordStoreNative = {
  init: () => ensureOpen(),
  hydrate: (tasks) => withOpen(() => native.hydrate(JSON.stringify(tasks || []))),
  hasData: () => withOpen(() => native.hasData()),
  queryTasks: (q) => withOpen(() => native.queryTasks(JSON.stringify(q || {})).then(parseRows)),
  queryList: (listId, params) =>
    withOpen(() => native.queryList(listId, (params && params.todayKey) || '').then(parseRows)),
  searchTasks: (text, q) =>
    withOpen(() => native.searchTasks(text, JSON.stringify(q || {})).then(parseRows)),
  countTasks: (q) => withOpen(() => native.countTasks(JSON.stringify(q || {}))),
  getTask: (id) => withOpen(() => native.getTask(id).then((s) => (s ? JSON.parse(s) : null))),
  createTask: (t) => withOpen(() => native.createTask(JSON.stringify(t || {}))),
  setTaskField: (id, field, value) =>
    withOpen(() => native.setTaskField(id, field, JSON.stringify(value))),
  toggleComplete: (id, completed) => withOpen(() => native.toggleComplete(id, !!completed)),
  moveTask: (id, beforeId, afterId) =>
    withOpen(() => native.moveTask(id, beforeId || '', afterId || '')),
  deleteTask: (id) => withOpen(() => native.deleteTask(id)),
};

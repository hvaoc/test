import React, {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useMemo,
  useState,
  useCallback,
} from 'react';
import { uid } from '../utils/id';
import { relabel, orderedItems } from './ordering';
import { mirrorTasks, recordAvailable } from './recordMirror';
import { STATUS } from './constants';
import { buildSampleData } from './sampleData';
import { setTimeZone } from '../utils/date';
import {
  loadSnapshot,
  saveSnapshot,
  sync as backendSync,
  backendName,
  onLocalChange,
  serverConfig,
  openRealtime,
  presenceIdentity,
  resetLocal,
  switchWorkspace,
} from './backend';

const TasksContext = createContext(null);

// User preferences (persisted alongside the data). Keep defaults here so older
// saved payloads that predate a setting still get a sensible value on hydrate.
const defaultSettings = {
  showCompleted: true, // show completed to-dos inside projects
  keepCompletedInPlace: false, // leave completed to-dos in place vs. sinking them to the bottom
  partialExpandCount: 10, // items a section shows in its partially-expanded state before "show more"
  centeredContent: false, // constrain the content pane to a centered column
  dayStartHour: 0, // first hour shown in Calendar Day/Week timelines (0 or 6)
  dateFormat: 'weekday-long', // absolute-date format for Calendar Day headers
  showWeekends: false, // include Sat/Sun in the Calendar Week view
  timezone: '', // IANA zone for "now"/"today"; '' = device local
  // User-arranged order of the reorderable smart lists (Inbox/Logbook/Trash are
  // pinned and never included). Missing/new ids are appended automatically.
  smartListOrder: ['today', 'upcoming', 'overdue', 'anytime', 'someday'],
};

// An explicit empty payload for HYDRATE. (A bare {} won't clear existing state,
// since HYDRATE spreads the payload OVER the current state.)
const EMPTY_DATA = {
  areas: [],
  projects: [],
  headings: [],
  tasks: [],
  tags: [],
  customViews: [],
  settings: {},
};

const initialState = {
  loaded: false,
  version: 1,
  areas: [],
  projects: [],
  headings: [],
  tasks: [],
  tags: [],
  // User-defined "Custom Views": saved queries that appear in the sidebar and
  // render through the shared query engine (see store/query.js). Each is
  // { id, name, icon, color, query } where `query` is a serializable query obj.
  customViews: [],
  settings: defaultSettings,
};

function newTask(partial = {}) {
  return {
    id: uid('t'),
    title: '',
    notes: '',
    checklist: [],
    tags: [],
    when: null,
    deadline: null,
    priority: null,
    location: '',
    projectId: null,
    areaId: null,
    headingId: null,
    // Tasks can nest under another task (unlimited depth). Checklist items are
    // separate lightweight entries and are unaffected by this.
    parentId: null,
    // Time-blocking on the scheduled day (`when`): startMinutes = minutes from
    // midnight for the block start, durationMinutes = its length. When
    // startMinutes is null the task is "all day" for that date.
    startMinutes: null,
    durationMinutes: null,
    // Per-task time zone for the scheduled time; null = "Floating Time" (no zone).
    timezone: null,
    status: STATUS.OPEN,
    createdAt: Date.now(),
    completedAt: null,
    order: Date.now(),
    ...partial,
  };
}

// The CRDT only stores fields that were actually set, so a task with an empty
// checklist / no tags materializes back *without* those keys. Components (e.g.
// the detail modal) read `task.checklist.length` / `task.tags.length` directly,
// which throws on undefined. Guarantee the array fields on every hydrated task.
function normalizeTask(t) {
  if (t.checklist && t.tags) return t;
  return { ...t, checklist: t.checklist || [], tags: t.tags || [] };
}

function reducer(state, action) {
  switch (action.type) {
    case 'HYDRATE':
      return {
        ...state,
        ...action.payload,
        tasks: (action.payload.tasks || []).map(normalizeTask),
        // Merge so a setting added after the user's data was saved still defaults.
        settings: { ...defaultSettings, ...(action.payload.settings || {}) },
        loaded: true,
      };

    case 'SET_SETTING':
      return {
        ...state,
        settings: { ...state.settings, [action.key]: action.value },
      };

    case 'ADD_TASK': {
      const task = newTask(action.payload);
      return { ...state, tasks: [...state.tasks, task] };
    }

    case 'UPDATE_TASK':
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          t.id === action.id ? { ...t, ...action.patch } : t
        ),
      };

    case 'TOGGLE_TASK':
      return {
        ...state,
        tasks: state.tasks.map((t) => {
          if (t.id !== action.id) return t;
          const completing = t.status === STATUS.OPEN;
          return {
            ...t,
            status: completing ? STATUS.COMPLETED : STATUS.OPEN,
            completedAt: completing ? Date.now() : null,
          };
        }),
      };

    case 'SET_STATUS':
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          t.id === action.id
            ? {
                ...t,
                status: action.status,
                completedAt:
                  action.status === STATUS.COMPLETED ||
                  action.status === STATUS.CANCELED
                    ? Date.now()
                    : null,
              }
            : t
        ),
      };

    case 'REORDER_TASKS': {
      // action.ids is the new visual order of a single context's tasks. Rewrite
      // `order` for only the tasks that actually moved (fractional keys), so
      // concurrent reorders don't clobber each other. See store/ordering.js.
      const byId = new Map(state.tasks.map((t) => [t.id, t]));
      const changes = relabel(orderedItems(action.ids, byId));
      if (changes.size === 0) return state;
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          changes.has(t.id) ? { ...t, order: changes.get(t.id) } : t
        ),
      };
    }

    case 'SET_PROJECT_LAYOUT': {
      // payload.tasks is [{ id, headingId }] in the project's new visual order;
      // payload.headings is the heading ids in their new order (block reorder).
      const { tasks: taskLayout, headings: headingOrder } = action.payload;
      const headingOf = new Map(taskLayout.map((x) => [x.id, x.headingId]));
      const parentOf = new Map(taskLayout.map((x) => [x.id, x.parentId ?? null]));
      const inLayout = new Set(taskLayout.map((x) => x.id));
      // Fractional relabel of only the tasks/headings that moved (heading/parent
      // changes still always apply). See store/ordering.js.
      const taskById = new Map(state.tasks.map((t) => [t.id, t]));
      const taskChanges = relabel(orderedItems(taskLayout.map((x) => x.id), taskById));
      const headingById = new Map(state.headings.map((h) => [h.id, h]));
      const headingChanges = relabel(orderedItems(headingOrder || [], headingById));
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          inLayout.has(t.id)
            ? {
                ...t,
                headingId: headingOf.get(t.id),
                parentId: parentOf.get(t.id),
                order: taskChanges.has(t.id) ? taskChanges.get(t.id) : t.order,
              }
            : t
        ),
        headings: state.headings.map((h) =>
          headingChanges.has(h.id) ? { ...h, order: headingChanges.get(h.id) } : h
        ),
      };
    }

    case 'DELETE_TASK':
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          t.id === action.id ? { ...t, status: STATUS.TRASHED } : t
        ),
      };

    case 'RESTORE_TASK':
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          t.id === action.id
            ? { ...t, status: STATUS.OPEN, completedAt: null }
            : t
        ),
      };

    case 'EMPTY_TRASH':
      return {
        ...state,
        tasks: state.tasks.filter((t) => t.status !== STATUS.TRASHED),
      };

    // ---- Checklist ----
    case 'ADD_CHECK':
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          t.id === action.taskId
            ? {
                ...t,
                checklist: [
                  ...t.checklist,
                  { id: uid('chk'), title: action.title, done: false },
                ],
              }
            : t
        ),
      };

    case 'TOGGLE_CHECK':
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          t.id === action.taskId
            ? {
                ...t,
                checklist: t.checklist.map((c) =>
                  c.id === action.checkId ? { ...c, done: !c.done } : c
                ),
              }
            : t
        ),
      };

    case 'UPDATE_CHECK':
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          t.id === action.taskId
            ? {
                ...t,
                checklist: t.checklist.map((c) =>
                  c.id === action.checkId ? { ...c, title: action.title } : c
                ),
              }
            : t
        ),
      };

    case 'DELETE_CHECK':
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          t.id === action.taskId
            ? {
                ...t,
                checklist: t.checklist.filter((c) => c.id !== action.checkId),
              }
            : t
        ),
      };

    // ---- Projects ----
    case 'ADD_PROJECT': {
      const project = {
        id: uid('proj'),
        name: action.payload.name || 'New Project',
        emoji: action.payload.emoji || '',
        notes: '',
        areaId: action.payload.areaId || null,
        color: action.payload.color || '#2b6fff',
        when: null,
        deadline: null,
        status: STATUS.OPEN,
        createdAt: Date.now(),
        completedAt: null,
        // Manual sidebar order within the area (drag-to-reorder writes this).
        // New projects sort to the bottom; existing seeds default to 0.
        order: Date.now(),
      };
      return { ...state, projects: [...state.projects, project] };
    }

    case 'REORDER_PROJECTS': {
      // action.ids is the new order of one area's (or the loose group's)
      // projects. Relabel only the projects that moved (fractional keys) so
      // concurrent reorders don't clobber. See store/ordering.js.
      const byId = new Map(state.projects.map((p) => [p.id, p]));
      const changes = relabel(orderedItems(action.ids, byId));
      if (changes.size === 0) return state;
      return {
        ...state,
        projects: state.projects.map((p) =>
          changes.has(p.id) ? { ...p, order: changes.get(p.id) } : p
        ),
      };
    }

    case 'UPDATE_PROJECT':
      return {
        ...state,
        projects: state.projects.map((p) =>
          p.id === action.id ? { ...p, ...action.patch } : p
        ),
      };

    case 'DELETE_PROJECT':
      return {
        ...state,
        projects: state.projects.filter((p) => p.id !== action.id),
        // Detach tasks from the removed project (send them to Inbox/Area).
        tasks: state.tasks.map((t) =>
          t.projectId === action.id
            ? { ...t, projectId: null, headingId: null }
            : t
        ),
        headings: state.headings.filter((h) => h.projectId !== action.id),
      };

    // ---- Headings ----
    case 'ADD_HEADING':
      return {
        ...state,
        headings: [
          ...state.headings,
          {
            id: uid('head'),
            projectId: action.projectId,
            title: action.title || 'New Heading',
            description: action.description || '',
            // Explicit order inserts between sections; default sorts to the bottom.
            order: action.order != null ? action.order : Date.now(),
          },
        ],
      };

    case 'UPDATE_HEADING':
      return {
        ...state,
        headings: state.headings.map((h) =>
          h.id === action.id ? { ...h, ...action.patch } : h
        ),
      };

    case 'TOGGLE_HEADING_COLLAPSED':
      return {
        ...state,
        headings: state.headings.map((h) =>
          h.id === action.id ? { ...h, collapsed: !h.collapsed } : h
        ),
      };

    case 'DELETE_HEADING':
      return {
        ...state,
        headings: state.headings.filter((h) => h.id !== action.id),
        tasks: state.tasks.map((t) =>
          t.headingId === action.id ? { ...t, headingId: null } : t
        ),
      };

    // ---- Areas ----
    case 'ADD_AREA': {
      const area = {
        id: uid('area'),
        name: action.payload.name || 'New Area',
        emoji: action.payload.emoji || '',
        color: action.payload.color || '#5b6b7b',
      };
      return { ...state, areas: [...state.areas, area] };
    }

    case 'UPDATE_AREA':
      return {
        ...state,
        areas: state.areas.map((a) =>
          a.id === action.id ? { ...a, ...action.patch } : a
        ),
      };

    case 'DELETE_AREA':
      return {
        ...state,
        areas: state.areas.filter((a) => a.id !== action.id),
        projects: state.projects.map((p) =>
          p.areaId === action.id ? { ...p, areaId: null } : p
        ),
        tasks: state.tasks.map((t) =>
          t.areaId === action.id ? { ...t, areaId: null } : t
        ),
      };

    // ---- Tags ----
    case 'ADD_TAG':
      if (state.tags.includes(action.tag)) return state;
      return { ...state, tags: [...state.tags, action.tag] };

    // ---- Custom Views (saved queries) ----
    case 'ADD_CUSTOM_VIEW': {
      const view = {
        id: uid('view'),
        name: action.payload.name || 'New View',
        icon: action.payload.icon || 'funnel-outline',
        color: action.payload.color || '#2b6fff',
        query: action.payload.query || {},
      };
      return { ...state, customViews: [...(state.customViews || []), view] };
    }

    case 'UPDATE_CUSTOM_VIEW':
      return {
        ...state,
        customViews: (state.customViews || []).map((v) =>
          v.id === action.id ? { ...v, ...action.patch } : v
        ),
      };

    case 'DELETE_CUSTOM_VIEW':
      return {
        ...state,
        customViews: (state.customViews || []).filter((v) => v.id !== action.id),
      };

    case 'REORDER_CUSTOM_VIEWS': {
      const byId = new Map((state.customViews || []).map((v) => [v.id, v]));
      const changes = relabel(orderedItems(action.ids, byId));
      const next = (state.customViews || []).map((v) =>
        changes.has(v.id) ? { ...v, order: changes.get(v.id) } : v
      );
      next.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      return { ...state, customViews: next };
    }

    case 'RESET':
      return {
        ...buildSampleData(),
        customViews: [],
        settings: defaultSettings,
        loaded: true,
      };

    default:
      return state;
  }
}

export function TasksProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const saveTimer = useRef(null);
  // Set by structural actions (move Today<->Inbox, change project, complete,
  // reorder, delete) so the very next save flushes immediately (0ms) instead of
  // waiting out the debounce — query-backed views then re-run right away. Rapid
  // edits (typing a title/notes) keep the debounce.
  const flushSaveRef = useRef(false);
  // Bumped after sign-in / sign-out so the realtime effect re-subscribes.
  const [syncGen, setSyncGen] = useState(0);
  // Serialize syncs: a sync in flight coalesces further requests into a single
  // follow-up run, so concurrent triggers (initial sync + WebSocket nudges)
  // can't each push the same backlog and duplicate ops.
  const syncingRef = useRef(false);
  const resyncQueuedRef = useRef(false);
  const pushTimer = useRef(null);
  // Realtime presence: peers keyed by their connection id -> awareness state.
  const [peers, setPeers] = useState({});
  const presenceRef = useRef(() => {});
  const activityRef = useRef(() => {});
  // Ephemeral "just added" marks: taskId -> { user, color, ts }. Never persisted;
  // each entry auto-expires so the UI badge fades and disappears on its own.
  const [recentAdds, setRecentAdds] = useState({});
  const addTimers = useRef(new Map());
  const markAdded = useCallback((taskId, who) => {
    if (!taskId) return;
    setRecentAdds((prev) => ({ ...prev, [taskId]: { ...(who || {}), ts: Date.now() } }));
    const timers = addTimers.current;
    if (timers.has(taskId)) clearTimeout(timers.get(taskId));
    timers.set(
      taskId,
      setTimeout(() => {
        setRecentAdds((prev) => {
          const next = { ...prev };
          delete next[taskId];
          return next;
        });
        timers.delete(taskId);
      }, 4200)
    );
  }, []);

  // Keep the date utils' active timezone in sync before descendants render, so
  // todayKey()/nowMinutes() reflect the setting on the same pass it changes.
  setTimeZone(state.settings?.timezone);

  // Offline-first hydrate: load the persisted snapshot from the platform store
  // (Go SQLite on desktop/mobile, IndexedDB on web). First run — or a store
  // that failed to load — falls back to the rich seed data and immediately
  // persists it, so the very next launch already restores real data.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let payload = null;
      try {
        payload = await loadSnapshot();
      } catch {
        payload = null;
      }
      if (cancelled) return;
      if (payload && Array.isArray(payload.tasks)) {
        dispatch({ type: 'HYDRATE', payload });
      } else {
        // Start fresh/empty — no automatic sample data. The user loads the demo
        // explicitly from Settings → Sample data. (Auto-seeding every device
        // duplicated the sample set when two devices synced to one account.)
        dispatch({ type: 'HYDRATE', payload: EMPTY_DATA });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist on change, debounced, once we've hydrated. The platform store diffs
  // the snapshot and records a per-change oplog entry for cloud sync.
  useEffect(() => {
    if (!state.loaded) return undefined;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    // Structural changes flush right away (0ms) so query-backed views (e.g. Today)
    // re-run and cross-tab/cross-device propagation starts with no perceptible lag;
    // rapid edits (typing) keep the 100ms batch.
    const delay = flushSaveRef.current ? 0 : 100;
    flushSaveRef.current = false;
    saveTimer.current = setTimeout(() => {
      saveSnapshot(state).catch(() => {});
    }, delay);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [state]);

  // Live cross-tab sync (offline): when another tab of the same browser changes the
  // shared record store, the leader broadcasts and we reload our snapshot so this tab
  // updates — no server needed. A no-op save (state already matches) won't
  // re-broadcast, so there's no reload loop.
  useEffect(() => {
    if (!state.loaded) return undefined;
    const unsub = onLocalChange(() => {
      (async () => {
        try {
          const snap = await loadSnapshot();
          if (snap && Array.isArray(snap.tasks)) dispatch({ type: 'HYDRATE', payload: snap });
        } catch {
          /* ignore */
        }
      })();
    });
    return unsub;
  }, [state.loaded]);

  // Keep the record store mirrored from the current tasks so query-backed views
  // (useRecordList) stay in sync — ONLY where the save path doesn't already own the
  // record store. On web the coordinator backend ('record') writes structured data
  // to the record engine via saveSnapshot, so mirroring there would double-write and
  // flood the op-log; skip it. On native (ygo save path today) the mirror still feeds
  // the query store until the native record coordinator lands.
  useEffect(() => {
    if (!state.loaded || !recordAvailable()) return undefined;
    if (backendName() === 'record') return undefined;
    const t = setTimeout(() => {
      mirrorTasks(state.tasks);
    }, 300);
    return () => clearTimeout(t);
  }, [state.loaded, state.tasks]);

  // Stable action creators.
  const actions = useMemo(
    () => ({
      addTask: (payload) => {
        dispatch({ type: 'ADD_TASK', payload });
        // Ephemeral "just added" flash (not persisted) + tell teammates.
        const id = payload && payload.id;
        if (id) {
          const me = presenceIdentity() || { user: 'You' };
          markAdded(id, { user: me.user, color: me.color });
          activityRef.current({ kind: 'added', taskId: id, user: me.user, color: me.color });
        }
      },
      updateTask: (id, patch) => {
        // A move (schedule/project/deadline/priority/parent change) is structural →
        // flush now; a title/notes edit is not → keep the debounce.
        if (patch && ('when' in patch || 'projectId' in patch || 'deadline' in patch || 'priority' in patch || 'parentId' in patch)) {
          flushSaveRef.current = true;
        }
        dispatch({ type: 'UPDATE_TASK', id, patch });
      },
      toggleTask: (id) => { flushSaveRef.current = true; dispatch({ type: 'TOGGLE_TASK', id }); },
      reorderTasks: (ids) => { flushSaveRef.current = true; dispatch({ type: 'REORDER_TASKS', ids }); },
      setProjectLayout: (payload) => dispatch({ type: 'SET_PROJECT_LAYOUT', payload }),
      setStatus: (id, status) => { flushSaveRef.current = true; dispatch({ type: 'SET_STATUS', id, status }); },
      deleteTask: (id) => { flushSaveRef.current = true; dispatch({ type: 'DELETE_TASK', id }); },
      restoreTask: (id) => { flushSaveRef.current = true; dispatch({ type: 'RESTORE_TASK', id }); },
      emptyTrash: () => dispatch({ type: 'EMPTY_TRASH' }),

      addCheck: (taskId, title) => dispatch({ type: 'ADD_CHECK', taskId, title }),
      toggleCheck: (taskId, checkId) =>
        dispatch({ type: 'TOGGLE_CHECK', taskId, checkId }),
      updateCheck: (taskId, checkId, title) =>
        dispatch({ type: 'UPDATE_CHECK', taskId, checkId, title }),
      deleteCheck: (taskId, checkId) =>
        dispatch({ type: 'DELETE_CHECK', taskId, checkId }),

      addProject: (payload) => dispatch({ type: 'ADD_PROJECT', payload }),
      updateProject: (id, patch) => dispatch({ type: 'UPDATE_PROJECT', id, patch }),
      deleteProject: (id) => dispatch({ type: 'DELETE_PROJECT', id }),
      reorderProjects: (ids) => dispatch({ type: 'REORDER_PROJECTS', ids }),

      addHeading: (projectId, opts = {}) =>
        dispatch({
          type: 'ADD_HEADING',
          projectId,
          title: opts.title,
          description: opts.description,
          order: opts.order,
        }),
      updateHeading: (id, patch) => dispatch({ type: 'UPDATE_HEADING', id, patch }),
      toggleHeadingCollapsed: (id) => dispatch({ type: 'TOGGLE_HEADING_COLLAPSED', id }),
      deleteHeading: (id) => dispatch({ type: 'DELETE_HEADING', id }),

      addArea: (payload) => dispatch({ type: 'ADD_AREA', payload }),
      updateArea: (id, patch) => dispatch({ type: 'UPDATE_AREA', id, patch }),
      deleteArea: (id) => dispatch({ type: 'DELETE_AREA', id }),

      addTag: (tag) => dispatch({ type: 'ADD_TAG', tag }),

      addCustomView: (payload) => dispatch({ type: 'ADD_CUSTOM_VIEW', payload }),
      updateCustomView: (id, patch) =>
        dispatch({ type: 'UPDATE_CUSTOM_VIEW', id, patch }),
      deleteCustomView: (id) => dispatch({ type: 'DELETE_CUSTOM_VIEW', id }),
      reorderCustomViews: (ids) => dispatch({ type: 'REORDER_CUSTOM_VIEWS', ids }),

      setSetting: (key, value) => dispatch({ type: 'SET_SETTING', key, value }),
      reset: () => dispatch({ type: 'RESET' }),

      // Broadcast this user's live presence (which task they're on, cursor, name,
      // colour) to teammates over the realtime channel. No-op when offline/solo.
      setPresence: (st) => presenceRef.current(st),

      // Run one cloud-sync cycle. Coalesced: if a sync is already running, the
      // request is deferred and a single follow-up runs after — never two at
      // once (which would double-push the pending backlog). On the Go-backed
      // platforms the merged snapshot comes back in the result; rehydrate from
      // it so pulled remote changes appear immediately.
      syncNow: async () => {
        if (syncingRef.current) {
          resyncQueuedRef.current = true;
          return null;
        }
        syncingRef.current = true;
        let res = null;
        try {
          do {
            resyncQueuedRef.current = false;
            res = await backendSync();
            // Only rehydrate when remote ops actually merged in (applied > 0). A
            // push-only sync returns applied 0 with our own snapshot, so skipping
            // HYDRATE there keeps the auto-push effect below from re-triggering
            // itself into a loop.
            if (res && res.snapshot && (res.applied || 0) > 0) {
              try {
                const payload = JSON.parse(res.snapshot);
                if (payload && Array.isArray(payload.tasks)) {
                  dispatch({ type: 'HYDRATE', payload });
                }
              } catch {
                /* ignore malformed snapshot */
              }
            }
          } while (resyncQueuedRef.current);
        } finally {
          syncingRef.current = false;
        }
        return res;
      },
      // Called by the Settings sign-in/out so the realtime subscription and an
      // immediate sync kick in (or tear down) without a reload.
      reconnectSync: () => setSyncGen((g) => g + 1),

      // Reload app state from the current active workspace's local replica, then
      // resync. Used after sign-in and sign-out (the replica may have changed).
      refreshWorkspace: async () => {
        const snap = await loadSnapshot();
        dispatch({ type: 'HYDRATE', payload: snap || EMPTY_DATA });
        setSyncGen((g) => g + 1);
      },

      // Make an already-joined workspace active: switch sync token + local replica,
      // then reload from it. This is how a user moves between their workspaces.
      activateWorkspace: async (tenant) => {
        await switchWorkspace(tenant);
        const snap = await loadSnapshot();
        dispatch({ type: 'HYDRATE', payload: snap || EMPTY_DATA });
        setSyncGen((g) => g + 1);
      },

      // Wipe ALL local data on this device and start fresh (also signs out, so
      // it doesn't immediately re-pull the account's data). Empties the UI at
      // once; the durable store is cleared by resetLocal().
      resetLocalData: async () => {
        await resetLocal();
        setSyncGen((g) => g + 1); // tear down realtime — we're signed out now
        dispatch({ type: 'HYDRATE', payload: EMPTY_DATA });
      },
      backendName,
    }),
    []
  );

  // Realtime sync: when a server is configured (web sign-in), do an initial
  // sync and open a WebSocket that triggers a sync whenever another device
  // changes this user's data. Re-runs on sign-in/out (syncGen).
  useEffect(() => {
    if (!state.loaded || !serverConfig()) {
      setPeers({});
      return undefined;
    }
    let cancelled = false;
    actions.syncNow().catch(() => {});
    const rt = openRealtime({
      onNudge: () => {
        if (!cancelled) actions.syncNow().catch(() => {});
      },
      onPresence: ({ from, state: st, leave }) => {
        setPeers((prev) => {
          const next = { ...prev };
          if (leave) delete next[from];
          else next[from] = st;
          return next;
        });
      },
      onActivity: ({ state: st }) => {
        // A teammate added a task: flash an ephemeral "added by X" mark.
        if (st && st.kind === 'added' && st.taskId) {
          markAdded(st.taskId, { user: st.user, color: st.color });
        }
      },
    });
    presenceRef.current = rt.sendPresence;
    activityRef.current = rt.sendActivity;
    return () => {
      cancelled = true;
      presenceRef.current = () => {};
      activityRef.current = () => {};
      rt.close();
      setPeers({});
    };
  }, [state.loaded, syncGen, actions]);

  // Auto-push local edits to the server, debounced. The initial sync + realtime
  // nudges above only cover PULLS; without this, a change you make never leaves
  // the device until a manual "Sync now" or an inbound nudge. This depends on
  // `state`, so it fires after every edit — and since syncNow only rehydrates
  // when it actually pulls something (applied > 0), it can't loop.
  //
  // Must fire AFTER the save above (which applies the edit to the engine), so its
  // delay stays > the 250ms save delay; the ~200ms gap is ample for the snapshot
  // to land. Kept low so teammates see changes in ~½s, not ~1s.
  useEffect(() => {
    if (!state.loaded || !serverConfig()) return undefined;
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(() => {
      actions.syncNow().catch(() => {});
    }, 450);
    return () => {
      if (pushTimer.current) clearTimeout(pushTimer.current);
    };
  }, [state, syncGen, actions]);

  const value = useMemo(
    () => ({ state, peers, recentAdds, ...actions }),
    [state, peers, recentAdds, actions]
  );

  return <TasksContext.Provider value={value}>{children}</TasksContext.Provider>;
}

export function useTasks() {
  const ctx = useContext(TasksContext);
  if (!ctx) throw new Error('useTasks must be used within TasksProvider');
  return ctx;
}

// Convenience selector hook for a single task that stays referentially fresh.
export function useTask(id) {
  const { state } = useTasks();
  return useMemo(() => state.tasks.find((t) => t.id === id), [state.tasks, id]);
}

export { newTask };

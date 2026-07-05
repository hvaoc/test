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
import { STATUS } from './constants';
import { buildSampleData } from './sampleData';
import { setTimeZone } from '../utils/date';
import {
  loadSnapshot,
  saveSnapshot,
  sync as backendSync,
  backendName,
  serverConfig,
  openRealtime,
  resetLocal,
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
    id: uid('task'),
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
    status: STATUS.OPEN,
    createdAt: Date.now(),
    completedAt: null,
    order: Date.now(),
    ...partial,
  };
}

function reducer(state, action) {
  switch (action.type) {
    case 'HYDRATE':
      return {
        ...state,
        ...action.payload,
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
      // action.ids is the new visual order of a single context's tasks.
      // Write each task's `order` to its index so the sort reflects the drag.
      const orderOf = new Map(action.ids.map((id, i) => [id, i]));
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          orderOf.has(t.id) ? { ...t, order: orderOf.get(t.id) } : t
        ),
      };
    }

    case 'SET_PROJECT_LAYOUT': {
      // payload.tasks is [{ id, headingId }] in the project's new visual order;
      // payload.headings is the heading ids in their new order (block reorder).
      const { tasks: taskLayout, headings: headingOrder } = action.payload;
      const headingOf = new Map(taskLayout.map((x) => [x.id, x.headingId]));
      const parentOf = new Map(taskLayout.map((x) => [x.id, x.parentId ?? null]));
      const taskOrderOf = new Map(taskLayout.map((x, i) => [x.id, i]));
      const headingOrderOf = new Map((headingOrder || []).map((id, i) => [id, i]));
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          taskOrderOf.has(t.id)
            ? {
                ...t,
                headingId: headingOf.get(t.id),
                parentId: parentOf.get(t.id),
                order: taskOrderOf.get(t.id),
              }
            : t
        ),
        headings: state.headings.map((h) =>
          headingOrderOf.has(h.id) ? { ...h, order: headingOrderOf.get(h.id) } : h
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
      // projects. Write each project's `order` to its index. Orders are only
      // ever compared within a single area, so per-area 0..n indices are fine.
      const orderOf = new Map(action.ids.map((id, i) => [id, i]));
      return {
        ...state,
        projects: state.projects.map((p) =>
          orderOf.has(p.id) ? { ...p, order: orderOf.get(p.id) } : p
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
      const orderOf = new Map(action.ids.map((id, i) => [id, i]));
      return {
        ...state,
        customViews: (state.customViews || [])
          .slice()
          .sort((a, b) => (orderOf.get(a.id) ?? 0) - (orderOf.get(b.id) ?? 0)),
      };
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
  // Bumped after sign-in / sign-out so the realtime effect re-subscribes.
  const [syncGen, setSyncGen] = useState(0);
  // Serialize syncs: a sync in flight coalesces further requests into a single
  // follow-up run, so concurrent triggers (initial sync + WebSocket nudges)
  // can't each push the same backlog and duplicate ops.
  const syncingRef = useRef(false);
  const resyncQueuedRef = useRef(false);

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
    saveTimer.current = setTimeout(() => {
      saveSnapshot(state).catch(() => {});
    }, 500);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [state]);

  // Stable action creators.
  const actions = useMemo(
    () => ({
      addTask: (payload) => dispatch({ type: 'ADD_TASK', payload }),
      updateTask: (id, patch) => dispatch({ type: 'UPDATE_TASK', id, patch }),
      toggleTask: (id) => dispatch({ type: 'TOGGLE_TASK', id }),
      reorderTasks: (ids) => dispatch({ type: 'REORDER_TASKS', ids }),
      setProjectLayout: (payload) => dispatch({ type: 'SET_PROJECT_LAYOUT', payload }),
      setStatus: (id, status) => dispatch({ type: 'SET_STATUS', id, status }),
      deleteTask: (id) => dispatch({ type: 'DELETE_TASK', id }),
      restoreTask: (id) => dispatch({ type: 'RESTORE_TASK', id }),
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
            if (res && res.snapshot) {
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
    if (!state.loaded || !serverConfig()) return undefined;
    let cancelled = false;
    actions.syncNow().catch(() => {});
    const close = openRealtime(() => {
      if (!cancelled) actions.syncNow().catch(() => {});
    });
    return () => {
      cancelled = true;
      close();
    };
  }, [state.loaded, syncGen, actions]);

  const value = useMemo(() => ({ state, ...actions }), [state, actions]);

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

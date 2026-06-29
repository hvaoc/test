import React, {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useMemo,
  useCallback,
} from 'react';
import { uid } from '../utils/id';
import { STATUS } from './constants';
import { loadState, saveState } from './storage';
import { buildSampleData } from './sampleData';

const TasksContext = createContext(null);

const initialState = {
  loaded: false,
  version: 1,
  areas: [],
  projects: [],
  headings: [],
  tasks: [],
  tags: [],
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
    projectId: null,
    areaId: null,
    headingId: null,
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
      return { ...state, ...action.payload, loaded: true };

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
        notes: '',
        areaId: action.payload.areaId || null,
        color: action.payload.color || '#2b6fff',
        when: null,
        deadline: null,
        status: STATUS.OPEN,
        createdAt: Date.now(),
        completedAt: null,
      };
      return { ...state, projects: [...state.projects, project] };
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
          { id: uid('head'), projectId: action.projectId, title: action.title || 'New Heading' },
        ],
      };

    case 'UPDATE_HEADING':
      return {
        ...state,
        headings: state.headings.map((h) =>
          h.id === action.id ? { ...h, title: action.title } : h
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

    case 'RESET':
      return { ...buildSampleData(), loaded: true };

    default:
      return state;
  }
}

export function TasksProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const saveTimer = useRef(null);

  // Hydrate from disk (or seed sample data) on mount.
  useEffect(() => {
    let mounted = true;
    (async () => {
      const persisted = await loadState();
      if (!mounted) return;
      dispatch({
        type: 'HYDRATE',
        payload: persisted || buildSampleData(),
      });
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // Debounced persistence whenever the data changes.
  useEffect(() => {
    if (!state.loaded) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const { loaded, ...persistable } = state;
      saveState(persistable);
    }, 400);
    return () => saveTimer.current && clearTimeout(saveTimer.current);
  }, [state]);

  // Stable action creators.
  const actions = useMemo(
    () => ({
      addTask: (payload) => dispatch({ type: 'ADD_TASK', payload }),
      updateTask: (id, patch) => dispatch({ type: 'UPDATE_TASK', id, patch }),
      toggleTask: (id) => dispatch({ type: 'TOGGLE_TASK', id }),
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

      addHeading: (projectId, title) =>
        dispatch({ type: 'ADD_HEADING', projectId, title }),
      updateHeading: (id, title) => dispatch({ type: 'UPDATE_HEADING', id, title }),
      deleteHeading: (id) => dispatch({ type: 'DELETE_HEADING', id }),

      addArea: (payload) => dispatch({ type: 'ADD_AREA', payload }),
      updateArea: (id, patch) => dispatch({ type: 'UPDATE_AREA', id, patch }),
      deleteArea: (id) => dispatch({ type: 'DELETE_AREA', id }),

      addTag: (tag) => dispatch({ type: 'ADD_TAG', tag }),
      reset: () => dispatch({ type: 'RESET' }),
    }),
    []
  );

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

// Query engine — the shared core behind global/scoped Search and user-defined
// Custom Views. It is intentionally pure (no React, no store access): callers
// pass in the task array + supporting collections and get a filtered, ranked
// list back. Both `SearchScreen` and the custom-view route in `ListScreen` run
// through `runQuery` so the two features can never drift apart.
//
// A query is a plain, serializable object (so it round-trips through the
// embedded DB / sync layer unchanged):
//
//   {
//     text: 'buy milk',            // fuzzy title match (optional)
//     scope: { type, id },         // 'all' | 'area' | 'project' (+ id)
//     match: 'all' | 'any',        // AND / OR across conditions
//     conditions: [ { field, op, value } ],
//     includeCompleted: false,
//     includeTrashed: false,
//   }

import { WHEN } from './constants';
import { todayKey, isPast, keyToDate } from '../utils/date';

// ---------------------------------------------------------------------------
// Fuzzy text matching (title). Space-separated tokens are AND-ed; each token
// must appear as a subsequence of the title. Returns a score (higher = better)
// or null when it doesn't match, so callers can both filter and rank.
// ---------------------------------------------------------------------------

function tokenScore(token, text) {
  let ti = 0;
  let score = 0;
  let streak = 0;
  let firstIdx = -1;
  for (let ci = 0; ci < text.length && ti < token.length; ci++) {
    if (text[ci] === token[ti]) {
      if (firstIdx < 0) firstIdx = ci;
      streak += 1;
      let s = 1 + streak; // reward runs of consecutive matches
      if (ci === 0 || text[ci - 1] === ' ') s += 4; // word-boundary bonus
      score += s;
      ti += 1;
    } else {
      streak = 0;
    }
  }
  if (ti < token.length) return null; // ran out of title before matching token
  score -= firstIdx * 0.1; // prefer earlier matches
  if (text.includes(token)) score += 8; // contiguous substring is a strong hit
  return score;
}

// Public: score a title against a raw search string. null = no match.
export function fuzzyScore(needle, title) {
  const q = (needle || '').trim().toLowerCase();
  if (!q) return 0;
  const text = (title || '').toLowerCase();
  let total = 0;
  for (const token of q.split(/\s+/)) {
    const s = tokenScore(token, text);
    if (s == null) return null;
    total += s;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Field catalog — drives the query-builder UI and the evaluator. Each field
// declares the operators it supports; `value` shape is documented per op below.
// ---------------------------------------------------------------------------

export const QUERY_FIELDS = [
  {
    key: 'label',
    label: 'Label',
    icon: 'pricetag-outline',
    ops: [
      { key: 'hasAny', label: 'is any of', arity: 'tags' },
      { key: 'hasAll', label: 'has all of', arity: 'tags' },
      { key: 'notHas', label: 'has none of', arity: 'tags' },
      { key: 'none', label: 'is untagged', arity: 'none' },
    ],
  },
  {
    key: 'priority',
    label: 'Priority',
    icon: 'flag-outline',
    ops: [
      { key: 'is', label: 'is any of', arity: 'priorities' },
      { key: 'isNot', label: 'is not', arity: 'priorities' },
      { key: 'none', label: 'is unset', arity: 'none' },
    ],
  },
  {
    key: 'when',
    label: 'Date',
    icon: 'calendar-outline',
    ops: [
      { key: 'state', label: 'is', arity: 'whenState' },
      { key: 'on', label: 'on', arity: 'date' },
      { key: 'before', label: 'before', arity: 'date' },
      { key: 'after', label: 'after', arity: 'date' },
      { key: 'between', label: 'between', arity: 'dateRange' },
    ],
  },
  {
    key: 'deadline',
    label: 'Deadline',
    icon: 'flag',
    ops: [
      { key: 'exists', label: 'is set', arity: 'none' },
      { key: 'none', label: 'is not set', arity: 'none' },
      { key: 'overdue', label: 'is overdue', arity: 'none' },
      { key: 'on', label: 'on', arity: 'date' },
      { key: 'before', label: 'before', arity: 'date' },
      { key: 'after', label: 'after', arity: 'date' },
      { key: 'between', label: 'between', arity: 'dateRange' },
    ],
  },
  {
    key: 'time',
    label: 'Time',
    icon: 'time-outline',
    ops: [
      { key: 'exists', label: 'is time-blocked', arity: 'none' },
      { key: 'none', label: 'is all-day', arity: 'none' },
      { key: 'before', label: 'starts before', arity: 'time' },
      { key: 'after', label: 'starts after', arity: 'time' },
      { key: 'between', label: 'starts between', arity: 'timeRange' },
    ],
  },
  {
    key: 'duration',
    label: 'Duration',
    icon: 'hourglass-outline',
    ops: [
      { key: 'exists', label: 'is set', arity: 'none' },
      { key: 'none', label: 'is not set', arity: 'none' },
      { key: 'lt', label: 'shorter than', arity: 'minutes' },
      { key: 'gt', label: 'longer than', arity: 'minutes' },
      { key: 'between', label: 'between', arity: 'minutesRange' },
    ],
  },
];

export const QUERY_FIELD_MAP = QUERY_FIELDS.reduce((acc, f) => {
  acc[f.key] = f;
  return acc;
}, {});

// Special values usable by the "Date is …" (whenState) operator.
export const WHEN_STATES = [
  { key: 'unscheduled', label: 'No date' },
  { key: 'today', label: 'Today' },
  { key: 'evening', label: 'This Evening' },
  { key: 'someday', label: 'Someday' },
  { key: 'scheduled', label: 'A specific date' },
  { key: 'overdue', label: 'Overdue' },
];

// ---------------------------------------------------------------------------
// Per-field value extraction from a task.
// ---------------------------------------------------------------------------

// The concrete calendar date a task is scheduled for, or null when it's a
// special bucket (today/evening/someday) or unscheduled.
function concreteWhen(t) {
  if (!t.when) return null;
  if (t.when === WHEN.TODAY || t.when === WHEN.EVENING || t.when === WHEN.SOMEDAY) {
    return null;
  }
  return t.when;
}

const cmpDate = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const inRange = (v, range) => Array.isArray(range) && v >= range[0] && v <= range[1];

// ---------------------------------------------------------------------------
// Single-condition evaluation.
// ---------------------------------------------------------------------------

export function evalCondition(task, cond) {
  const { field, op, value } = cond || {};
  switch (field) {
    case 'label': {
      const tags = task.tags || [];
      const want = Array.isArray(value) ? value : value != null ? [value] : [];
      if (op === 'none') return tags.length === 0;
      if (op === 'hasAny') return want.some((v) => tags.includes(v));
      if (op === 'hasAll') return want.every((v) => tags.includes(v));
      if (op === 'notHas') return !want.some((v) => tags.includes(v));
      return true;
    }

    case 'priority': {
      const p = task.priority || null;
      const want = Array.isArray(value) ? value : value != null ? [value] : [];
      if (op === 'none') return p == null;
      if (op === 'is') return want.includes(p);
      if (op === 'isNot') return !want.includes(p);
      return true;
    }

    case 'when': {
      if (op === 'state') {
        switch (value) {
          case 'unscheduled':
            return !task.when;
          case 'today':
            return task.when === WHEN.TODAY;
          case 'evening':
            return task.when === WHEN.EVENING;
          case 'someday':
            return task.when === WHEN.SOMEDAY;
          case 'scheduled':
            return concreteWhen(task) != null;
          case 'overdue': {
            const d = concreteWhen(task);
            return d != null && isPast(d);
          }
          default:
            return true;
        }
      }
      const d = concreteWhen(task);
      if (d == null) return false; // date operators only apply to concrete dates
      if (op === 'on') return d === value;
      if (op === 'before') return cmpDate(d, value) < 0;
      if (op === 'after') return cmpDate(d, value) > 0;
      if (op === 'between') return inRange(d, value);
      return true;
    }

    case 'deadline': {
      const d = task.deadline || null;
      if (op === 'exists') return d != null;
      if (op === 'none') return d == null;
      if (op === 'overdue') return d != null && isPast(d);
      if (d == null) return false;
      if (op === 'on') return d === value;
      if (op === 'before') return cmpDate(d, value) < 0;
      if (op === 'after') return cmpDate(d, value) > 0;
      if (op === 'between') return inRange(d, value);
      return true;
    }

    case 'time': {
      const m = task.startMinutes;
      if (op === 'exists') return m != null;
      if (op === 'none') return m == null;
      if (m == null) return false;
      if (op === 'before') return m < value;
      if (op === 'after') return m > value;
      if (op === 'between') return inRange(m, value);
      return true;
    }

    case 'duration': {
      const m = task.durationMinutes;
      if (op === 'exists') return m != null;
      if (op === 'none') return m == null;
      if (m == null) return false;
      if (op === 'lt') return m < value;
      if (op === 'gt') return m > value;
      if (op === 'between') return inRange(m, value);
      return true;
    }

    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// Scope — restrict the candidate task set to a universal / area / project view
// before conditions run. An Area scope includes tasks filed directly under the
// area AND tasks inside any project belonging to that area.
// ---------------------------------------------------------------------------

export function scopeTasks(state, scope) {
  const tasks = state.tasks || [];
  if (!scope || scope.type === 'all' || !scope.id) return tasks;
  if (scope.type === 'project') {
    return tasks.filter((t) => t.projectId === scope.id);
  }
  if (scope.type === 'area') {
    const projectIds = new Set(
      (state.projects || []).filter((p) => p.areaId === scope.id).map((p) => p.id)
    );
    return tasks.filter(
      (t) => t.areaId === scope.id || (t.projectId && projectIds.has(t.projectId))
    );
  }
  return tasks;
}

// ---------------------------------------------------------------------------
// Run a full query. Returns tasks in relevance order when a text term is
// present, otherwise in scheduled-date then manual order.
// ---------------------------------------------------------------------------

export function runQuery(state, query = {}) {
  const {
    text = '',
    scope,
    match = 'all',
    conditions = [],
    includeCompleted = false,
    includeTrashed = false,
  } = query;

  let candidates = scopeTasks(state, scope);

  candidates = candidates.filter((t) => {
    if (t.status === 'trashed') return includeTrashed;
    if ((t.status === 'completed' || t.status === 'canceled') && !includeCompleted) {
      return false;
    }
    return true;
  });

  const active = conditions.filter((c) => c && c.field && c.op);
  if (active.length) {
    candidates = candidates.filter((t) => {
      const results = active.map((c) => evalCondition(t, c));
      return match === 'any' ? results.some(Boolean) : results.every(Boolean);
    });
  }

  const term = (text || '').trim();
  if (term) {
    const scored = [];
    for (const t of candidates) {
      const s = fuzzyScore(term, t.title);
      if (s != null) scored.push({ t, s });
    }
    scored.sort((a, b) => b.s - a.s);
    return scored.map((x) => x.t);
  }

  // No text term: concrete-date ascending (undated last), then manual order.
  return candidates.slice().sort((a, b) => {
    const da = concreteWhen(a);
    const db = concreteWhen(b);
    if (da && db && da !== db) return cmpDate(da, db);
    if (da && !db) return -1;
    if (!da && db) return 1;
    return (a.order ?? 0) - (b.order ?? 0);
  });
}

// True when a query has no term and no conditions (an "empty" search).
export function isEmptyQuery(query = {}) {
  return (
    !(query.text || '').trim() &&
    !(query.conditions || []).some((c) => c && c.field && c.op)
  );
}

// ---------------------------------------------------------------------------
// Human-readable one-liner for a query — used as the subtitle on custom-view
// rows and the search results header.
// ---------------------------------------------------------------------------

export function describeCondition(cond) {
  const field = QUERY_FIELD_MAP[cond.field];
  if (!field) return '';
  const op = field.ops.find((o) => o.key === cond.op);
  const opLabel = op ? op.label : cond.op;
  const val = formatValue(cond, op && op.arity);
  return `${field.label} ${opLabel}${val ? ` ${val}` : ''}`;
}

function formatValue(cond, arity) {
  const v = cond.value;
  switch (arity) {
    case 'tags':
    case 'priorities':
      return Array.isArray(v) ? v.join(', ') : v || '';
    case 'whenState': {
      const s = WHEN_STATES.find((x) => x.key === v);
      return s ? s.label.toLowerCase() : v || '';
    }
    case 'date':
      return v || '';
    case 'dateRange':
      return Array.isArray(v) ? `${v[0]} – ${v[1]}` : '';
    case 'minutes':
      return v != null ? `${v} min` : '';
    case 'minutesRange':
      return Array.isArray(v) ? `${v[0]}–${v[1]} min` : '';
    case 'time':
      return v != null ? minutesToClock(v) : '';
    case 'timeRange':
      return Array.isArray(v) ? `${minutesToClock(v[0])}–${minutesToClock(v[1])}` : '';
    default:
      return '';
  }
}

export function describeQuery(query = {}) {
  const parts = [];
  if ((query.text || '').trim()) parts.push(`“${query.text.trim()}”`);
  const conds = (query.conditions || []).filter((c) => c && c.field && c.op);
  parts.push(...conds.map(describeCondition));
  if (!parts.length) return 'All to-dos';
  const joiner = query.match === 'any' ? ' or ' : ' · ';
  return parts.join(joiner);
}

export function minutesToClock(m) {
  if (m == null) return '';
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  const ap = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${mm} ${ap}`;
}

// A blank query scaffold for a new custom view / fresh search.
export function emptyQuery(overrides = {}) {
  return {
    text: '',
    scope: { type: 'all', id: null },
    match: 'all',
    conditions: [],
    includeCompleted: false,
    includeTrashed: false,
    ...overrides,
  };
}

// re-exported so the query builder can resolve "today" defaults without
// importing date utils separately.
export { todayKey, keyToDate };

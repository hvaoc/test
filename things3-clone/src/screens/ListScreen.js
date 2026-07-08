import React, { useMemo, useState, useRef, useLayoutEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  Platform,
  Modal,
  Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSharedValue } from 'react-native-reanimated';
import { colors, spacing, typography, radius } from '../theme';
import { SMART_LIST_MAP, WHEN, STATUS } from '../store/constants';
import { useTasks, newTask } from '../store/TasksContext';
import {
  selectForList,
  selectProjectTasks,
  selectSubtasks,
  isOpen,
  byOrder,
} from '../store/selectors';
import { relativeLabel, monthTitle, longLabel, todayKey, addDays, formatDayKey } from '../utils/date';
import { useRecordList } from '../store/recordMirror';
import TaskRow from '../components/TaskRow';
import SidebarToggle from '../components/SidebarToggle';
import TaskDetailModal from '../components/TaskDetailModal';
import FloatingAddButton from '../components/FloatingAddButton';
import QuickAddComposer from '../components/QuickAddComposer';
import ProjectHeader from '../components/ProjectHeader';
import AreaHeader from '../components/AreaHeader';
import ReorderableTaskList, { HANDLE_W } from '../components/ReorderableTaskList';
import ProgressPie from '../components/ProgressPie';
import BoardView from '../components/BoardView';
import CalendarView from '../components/CalendarView';
import GanttView from '../components/GanttView';
import DisplayMenu from '../components/DisplayMenu';
import VirtualTaskList from '../components/VirtualTaskList';
import DraggableVirtualTaskList from '../components/DraggableVirtualTaskList';
import StickyTaskSections from '../components/StickyTaskSections';
import SectionEditor from '../components/SectionEditor';
import SearchScreen from './SearchScreen';
import CustomViewScreen from './CustomViewScreen';
import { useIsWide } from '../navigation/responsive';
import { chevronState, chevronRotate } from '../utils/sections';

// Expanded-minimal shows this many items before a "show N more" row.
const MINIMAL_ITEMS = 10;
// Horizontal drag distance (px) per indent level when nesting a task by dragging.
const NEST_STEP = 24;

// A dragged row moves on its own — its subtask rows don't follow in the raw key
// order, so a naive commit would re-parent them to whatever ends up above them
// (leaving the subtree behind). Rebuild the order so the dragged task's ENTIRE
// descendant block — taken from the original nesting in `orderedDepths`
// ([{ key, depth }] in render order) — immediately follows it, preserving the
// subtree as-is. Returns the reordered keys and the set of descendant keys, so
// the caller can shift their depth by the same delta the parent moved.
function carrySubtree(keys, draggedKey, orderedDepths) {
  if (!draggedKey) return { keys, descendants: new Set() };
  const idx = orderedDepths.findIndex((t) => t.key === draggedKey);
  if (idx < 0) return { keys, descendants: new Set() };
  const baseDepth = orderedDepths[idx].depth;
  const block = [];
  for (let i = idx + 1; i < orderedDepths.length; i++) {
    if (orderedDepths[i].depth > baseDepth) block.push(orderedDepths[i].key);
    else break; // first row back at/above the dragged depth ends the subtree
  }
  if (block.length === 0) return { keys, descendants: new Set() };
  const descendants = new Set(block);
  const without = keys.filter((k) => !descendants.has(k));
  const at = without.indexOf(draggedKey);
  if (at < 0) return { keys, descendants };
  const out = [...without.slice(0, at + 1), ...block, ...without.slice(at + 1)];
  return { keys: out, descendants };
}

// Builds the grouped sections shown in a given context. Each section is
// { key, title, subtitle?, color?, data: task[] }.
function useSections(state, route) {
  const { listId, projectId, areaId } = route.params || {};
  // Phase 2: the Today list reads from the record store's query API
  // (sqlite.wasm/OPFS) when available; null until it answers → fall back to the
  // in-memory selector. Rendering still uses the full task objects from state.
  const recordToday = useRecordList(listId === 'today' ? 'today' : null, { todayKey: todayKey() });
  return useMemo(() => {
    // ---- Project view: group by heading ----
    if (projectId) {
      // Only top-level tasks form the rows; subtasks render nested under them.
      const tasks = selectProjectTasks(state.tasks, projectId).filter((t) => !t.parentId);
      const open = tasks.filter(isOpen);
      const done = tasks.filter(
        (t) => t.status === STATUS.COMPLETED || t.status === STATUS.CANCELED
      );
      const showCompleted = state.settings?.showCompleted;
      const keepInPlace = state.settings?.keepCompletedInPlace;
      const headings = state.headings
        .filter((h) => h.projectId === projectId)
        .sort(byOrder);
      const sections = [];

      const inHeading = (t, hid) => (hid ? t.headingId === hid : !t.headingId);
      // A heading's rows: normally open (by manual order) then its completed
      // tasks below; with "keep completed in place" on, a finished to-do stays at
      // its manual position instead of sinking to the bottom of the heading.
      const sectionData = (hid) => {
        if (showCompleted && keepInPlace) {
          return tasks.filter((t) => inHeading(t, hid)).sort(byOrder);
        }
        const rows = open.filter((t) => inHeading(t, hid)).sort(byOrder);
        if (showCompleted) {
          rows.push(...done.filter((t) => inHeading(t, hid)).sort(byOrder));
        }
        return rows;
      };

      const noHeading = sectionData(null);
      if (noHeading.length || headings.length === 0) {
        sections.push({ key: 'main', title: null, data: noHeading, reorderable: true });
      }
      headings.forEach((h) => {
        const openN = open.filter((t) => inHeading(t, h.id)).length;
        const doneN = done.filter((t) => inHeading(t, h.id)).length;
        sections.push({
          key: h.id,
          title: h.title,
          heading: h,
          data: sectionData(h.id),
          reorderable: true,
          total: openN + doneN,
          doneCount: doneN,
        });
      });
      return sections;
    }

    // ---- Area view ----
    // Areas hold no tasks of their own — they surface the *dated* work from every
    // project filed under the area, split into Today / Upcoming / Overdue.
    if (areaId) {
      const today = todayKey();
      const projectIds = new Set(
        state.projects
          .filter((p) => p.areaId === areaId && p.status === 'open')
          .map((p) => p.id)
      );
      const whenKeyOf = (t) => {
        if (t.when === WHEN.TODAY || t.when === WHEN.EVENING) return today;
        if (!t.when || t.when === WHEN.SOMEDAY) return null;
        return t.when;
      };
      const effKey = (t) => whenKeyOf(t) || t.deadline || null;
      const buckets = { today: [], upcoming: [], overdue: [] };
      state.tasks.forEach((t) => {
        if (!t.projectId || !projectIds.has(t.projectId) || !isOpen(t) || t.parentId) return;
        const eff = effKey(t);
        if (!eff) return; // undated work stays inside its project, not the area
        if (eff === today) buckets.today.push(t);
        else if (eff > today) buckets.upcoming.push(t);
        else buckets.overdue.push(t);
      });
      const byDate = (a, b) => (effKey(a) < effKey(b) ? -1 : effKey(a) > effKey(b) ? 1 : 0);
      const sec = (id, title, data) => ({
        key: id,
        title,
        icon: SMART_LIST_MAP[id]?.icon,
        iconColor: SMART_LIST_MAP[id]?.color,
        data: data.sort(byDate),
        showProject: true,
      });
      return [
        sec('today', 'Today', buckets.today),
        sec('upcoming', 'Upcoming', buckets.upcoming),
        sec('overdue', 'Overdue', buckets.overdue),
      ].filter((s) => s.data.length > 0);
    }

    const tasks = selectForList(state.tasks, listId);

    // ---- Today: split into Today + This Evening ----
    if (listId === 'today') {
      // Prefer the record-store query when it has answered: map its ordered ids
      // back to full task objects for rendering; else use the in-memory selector.
      let todayTasks = tasks;
      if (recordToday) {
        const byId = new Map(state.tasks.map((t) => [t.id, t]));
        todayTasks = recordToday.map((r) => byId.get(r.id)).filter(Boolean);
      }
      const evening = todayTasks.filter((t) => t.when === WHEN.EVENING);
      const day = todayTasks.filter((t) => t.when !== WHEN.EVENING);
      const out = [{ key: 'today', title: null, data: day }];
      if (evening.length) {
        out.push({ key: 'evening', title: 'This Evening', icon: 'moon', data: evening });
      }
      return out;
    }

    // ---- Upcoming: group by date ----
    if (listId === 'upcoming') {
      const byDate = {};
      tasks.forEach((t) => {
        (byDate[t.when] = byDate[t.when] || []).push(t);
      });
      return Object.keys(byDate)
        .sort()
        .map((key) => ({
          key,
          title: relativeLabel(key),
          subtitle: longLabel(key),
          data: byDate[key],
        }));
    }

    // ---- Logbook: group by completion month ----
    if (listId === 'logbook') {
      const byMonth = {};
      tasks.forEach((t) => {
        const d = new Date(t.completedAt || Date.now());
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
        (byMonth[key] = byMonth[key] || []).push(t);
      });
      return Object.keys(byMonth)
        .sort((a, b) => (a < b ? 1 : -1))
        .map((key) => ({ key, title: monthTitle(key), data: byMonth[key] }));
    }

    return [{ key: listId, title: null, data: tasks }];
  }, [state, route.params, recordToday]);
}

// Group tasks by their When (scheduled date) field for the date views — the same
// grouped shape the heading list uses, only bucketed by date instead of heading.
// Grouping is by `when` only (never the deadline): Today/This Evening fold into
// today, concrete dates each get their own day (sorted ascending), and
// Someday/undated tasks collect in a "No Date" section at the bottom. Each bucket
// mirrors a heading: open to-dos first (by order), then completed below when the
// setting is on, and a done/total count for the header pie.
function groupByDate(tasks, showCompleted, dateFormat = 'weekday-long', keepInPlace = false) {
  const buckets = {}; // dateKey -> { open: [], done: [] }
  const noDate = { open: [], done: [] };
  const bucketFor = (key) => (buckets[key] = buckets[key] || { open: [], done: [] });
  tasks.forEach((t) => {
    let key;
    if (t.when === WHEN.TODAY || t.when === WHEN.EVENING) key = todayKey();
    else if (t.when === WHEN.SOMEDAY || !t.when) key = null;
    else key = t.when;
    const bucket = key === null ? noDate : bucketFor(key);
    (isOpen(t) ? bucket.open : bucket.done).push(t);
  });
  const today = todayKey();
  const tomorrow = addDays(today, 1);
  const make = (key, b) => {
    const open = b.open.slice().sort(byOrder);
    const done = b.done.slice().sort(byOrder);
    const inPlace = b.open.concat(b.done).sort(byOrder);
    // Header follows the Display/settings date format; "Today"/"Tomorrow" keep
    // their relative word (the formatted date moves to the subtitle) and every
    // other day is just the formatted date (no redundant weekday + long label).
    let title;
    let subtitle = null;
    if (key === null) title = 'No Date';
    else if (key === today) { title = 'Today'; subtitle = formatDayKey(key, dateFormat); }
    else if (key === tomorrow) { title = 'Tomorrow'; subtitle = formatDayKey(key, dateFormat); }
    else title = formatDayKey(key, dateFormat);
    return {
      key: key === null ? 'no-date' : key,
      title,
      subtitle,
      data: showCompleted ? (keepInPlace ? inPlace : [...open, ...done]) : open,
      total: open.length + done.length,
      doneCount: done.length,
    };
  };
  const sections = Object.keys(buckets)
    .sort()
    .map((key) => make(key, buckets[key]));
  if (noDate.open.length || noDate.done.length) sections.push(make(null, noDate));
  // Drop buckets with nothing to show (e.g. an all-completed date while
  // "show completed" is off) — but their counts still fed the pie above.
  return sections.filter((s) => s.data.length > 0);
}

// ---- Display menu: universal filter / sort / grouping --------------------
const PRIO_RANK = { high: 0, medium: 1, low: 2 };

// A task predicate for the Display menu's Filter section (date/priority/label).
function makeFilter(fDate, fPri, fLabel) {
  const today = todayKey();
  return (t) => {
    if (fPri !== 'all' && t.priority !== fPri) return false;
    if (fLabel !== 'all' && !(t.tags || []).includes(fLabel)) return false;
    if (fDate !== 'all') {
      const w = t.when === WHEN.TODAY || t.when === WHEN.EVENING ? today : t.when;
      const dated = !!w && w !== WHEN.SOMEDAY;
      if (fDate === 'none') return !dated;
      if (!dated) return false;
      if (fDate === 'today') return w === today;
      if (fDate === 'overdue') return w < today;
      if (fDate === 'upcoming') return w >= today;
    }
    return true;
  };
}

function sortData(arr, sorting) {
  if (sorting === 'manual') return arr;
  const a = arr.slice();
  if (sorting === 'name') a.sort((x, y) => (x.title || '').localeCompare(y.title || ''));
  else if (sorting === 'date') a.sort((x, y) => String(x.when || '~').localeCompare(String(y.when || '~')));
  else if (sorting === 'priority') a.sort((x, y) => (PRIO_RANK[x.priority] ?? 9) - (PRIO_RANK[y.priority] ?? 9));
  return a;
}

// Regroup a flat task list into { key, title, subtitle, data, total, doneCount }
// sections for grouping modes other than the default heading "Section" view.
function groupTasks(tasks, grouping, showCompleted, sorting, dateFormat, keepInPlace) {
  if (grouping === 'date') return groupByDate(tasks, showCompleted, dateFormat, keepInPlace);
  const open = tasks.filter(isOpen);
  const done = tasks.filter((t) => !isOpen(t));
  // `tasks` is in manual order (completed interleaved). Keep-in-place preserves
  // that; otherwise completed sink below the open ones.
  const src = showCompleted ? (keepInPlace ? tasks : [...open, ...done]) : open;
  const section = (key, title, pred) => {
    const data = sortData(src.filter(pred), sorting);
    return {
      key, title, subtitle: null, data,
      total: open.filter(pred).length + done.filter(pred).length,
      doneCount: done.filter(pred).length,
    };
  };
  let secs = [];
  if (grouping === 'none') {
    secs = [section('all', null, () => true)];
  } else if (grouping === 'priority') {
    secs = [
      section('p:high', 'High', (t) => t.priority === 'high'),
      section('p:medium', 'Medium', (t) => t.priority === 'medium'),
      section('p:low', 'Low', (t) => t.priority === 'low'),
      section('p:none', 'No Priority', (t) => !t.priority),
    ];
  } else if (grouping === 'label') {
    const labels = [...new Set(tasks.flatMap((t) => t.tags || []))].sort();
    secs = labels.map((l) => section(`l:${l}`, l, (t) => (t.tags || []).includes(l)));
    secs.push(section('l:none', 'No Label', (t) => !(t.tags || []).length));
  }
  return secs.filter((s) => s.data.length > 0);
}

export default function ListScreen({
  navigation,
  route,
  embedded,
  onToggleSidebar,
  sidebarVisible,
}) {
  // Search and Custom Views are distinct selections that render their own
  // screens. The detail pane remounts per selection (SplitView keys on the
  // selection), so branching here — before this screen's hooks — keeps hook
  // order stable within any single mount.
  const params = route.params || {};
  if (params.search) {
    return (
      <SearchScreen
        navigation={navigation}
        scope={params.scope}
        scopeTitle={params.scopeTitle}
        embedded={embedded}
        onToggleSidebar={onToggleSidebar}
        sidebarVisible={sidebarVisible}
      />
    );
  }
  if (params.viewId) {
    return (
      <CustomViewScreen
        navigation={navigation}
        viewId={params.viewId}
        embedded={embedded}
        onToggleSidebar={onToggleSidebar}
        sidebarVisible={sidebarVisible}
      />
    );
  }

  const insets = useSafeAreaInsets();
  // Sticky headers for the drag lists: track the page scroll offset and this
  // list's top within the scroll content, both fed to ReorderableTaskList's
  // floating header overlay.
  const scrollY = useSharedValue(0);
  // Starts as a large "not yet measured" sentinel so the sticky bar stays hidden
  // (viewTop = scrollY - listOffsetY is hugely negative) until the list's
  // onLayout reports its real top — otherwise the first header flashes over the
  // title on the first frame. Re-armed on every view change (see below).
  const listOffsetY = useSharedValue(1e6);
  // Plain (non-worklet) scroll handler: writing the shared value from JS drives
  // the sticky-header overlay's reaction reliably on web, where reanimated's
  // useAnimatedScrollHandler can miss/lag scroll events.
  const onScroll = (e) => {
    scrollY.value = e.nativeEvent.contentOffset.y;
  };
  // The active section for the fixed sticky-header bar (drag lists report it up
  // via StickyHeaderTracker). Drawn OUTSIDE the scroll view so it never tears.
  const [stickyHeader, setStickyHeader] = useState(null);
  const { listId, projectId, areaId, title } = route.params || {};
  const {
    state,
    addTask,
    updateTask,
    emptyTrash,
    reorderTasks,
    setProjectLayout,
    deleteHeading,
    updateHeading,
    toggleHeadingCollapsed,
    addHeading,
    setSetting,
  } = useTasks();
  const [openTaskId, setOpenTaskId] = useState(null);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  // Opening a task's detail dismisses the quick-add composer — it's now a non-modal
  // overlay, so without this it would stay open behind the full-screen detail.
  useLayoutEffect(() => {
    if (openTaskId) setQuickAddOpen(false);
  }, [openTaskId]);
  const scrollRef = useRef(null);
  // How much of the screen the open quick-add composer covers (measured by the composer);
  // seeded with a ~half-screen estimate for the first frame before measurement arrives.
  const [composerCovered, setComposerCovered] = useState(Math.round(Dimensions.get('window').height * 0.5));
  // New tasks append to the bottom, so on quick-add (open / add / close) scroll the list
  // to the end to reveal the latest task. NOTE: the reorderable list sets its height via a
  // reanimated animated style, so the ScrollView's JS-side contentSize (what scrollToEnd
  // relies on) is stale — scrollToEnd no-ops. Instead we push a large offset and let the
  // NATIVE scroll view clamp it to the real content bottom. No-op on non-ScrollView surfaces.
  const scrollListToEnd = () =>
    setTimeout(() => scrollRef.current?.scrollTo?.({ y: 1e6, animated: true }), 120);
  const [editSectionId, setEditSectionId] = useState(null);
  // Projects can be viewed as the manual heading list, or grouped by date.
  const [projectView, setProjectView] = useState('list');
  // "Display" popover: universal grouping / sorting / filtering for the project.
  const [displayOpen, setDisplayOpen] = useState(false);
  const [grouping, setGrouping] = useState('section'); // section|none|priority|date|label
  const [sorting, setSorting] = useState('manual'); // manual|name|date|priority
  const [filterDate, setFilterDate] = useState('all'); // all|overdue|today|upcoming|none
  const [filterPriority, setFilterPriority] = useState('all'); // all|high|medium|low
  const [filterLabel, setFilterLabel] = useState('all'); // all|<tag>
  const hasFilter = filterDate !== 'all' || filterPriority !== 'all' || filterLabel !== 'all';
  // Expanded parent tasks (by id) — controls whether their subtasks are shown
  // as nested rows in the project list.
  const [expandedTasks, setExpandedTasks] = useState(() => new Set());
  const toggleTaskExpand = (id) =>
    setExpandedTasks((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  // --- Three-state sections (collapsed / minimal-10 / full) -----------------
  // Every section header cycles: collapsed → expanded-minimal (up to 10 items +
  // a "show N more" row) → expanded-full. Minimal is the default. Kept local
  // (resets on reload like the rest of the testing state). `hiddenBySection`
  // records each section's non-rendered task ids during item-building so a
  // drag-reorder can re-insert them — otherwise the hidden rows keep stale order
  // values and scramble. A section key is 'h:<headingId>' or 'd:<dateKey>' (or a
  // smart-list section's own key), matching its item key.
  const [sectionMode, setSectionMode] = useState({});
  // Today's Morning / This Evening default to fully expanded (show everything);
  // every other section still defaults to the 10-item "minimal" state.
  const modeOf = (key) =>
    sectionMode[key] || (key === 'd:morning' || key === 'd:evening' ? 'full' : 'minimal');
  const setMode = (key, mode) => setSectionMode((m) => ({ ...m, [key]: mode }));
  // Tapping the header/chevron cycles through all three states:
  // collapsed → minimal → full → collapsed. A section with no overflow (≤10
  // items) has no distinct minimal state, so it cycles collapsed ↔ shown.
  const cycleSection = (key) => {
    const mode = modeOf(key);
    const hasOverflow = overflowSections.has(key);
    const next =
      mode === 'collapsed' ? 'minimal'
      : mode === 'minimal' ? (hasOverflow ? 'full' : 'collapsed')
      : 'collapsed';
    setMode(key, next);
  };
  // The more/less row is a direct shortcut between minimal and full.
  const onToggleMore = (key, action) => setMode(key, action === 'more' ? 'full' : 'minimal');
  const onDividerToggle = (dividerKey) => cycleSection(`d:${dividerKey}`);
  const onHeadingToggle = (headingId) => cycleSection(`h:${headingId}`);
  // Populated during item-building each render; read by the commit wrappers /
  // the cycle handler.
  const hiddenBySection = {};
  const overflowSections = new Set();
  // How many rows the "partially expanded" (minimal) state shows — configurable.
  const partialCount = Math.max(1, state.settings?.partialExpandCount ?? MINIMAL_ITEMS);
  // Slice a section's rows for its current mode and record its hidden ids.
  const sliceSection = (key, data) => {
    const mode = modeOf(key);
    const rows = mode === 'collapsed' ? [] : mode === 'full' ? data : data.slice(0, partialCount);
    const hidden = data.slice(rows.length).map((t) => t.id);
    if (hidden.length) hiddenBySection[key] = hidden;
    const overflow = data.length > partialCount;
    if (overflow) overflowSections.add(key);
    const more =
      mode === 'minimal' && overflow ? { action: 'more', hidden: data.length - rows.length }
      : mode === 'full' && overflow ? { action: 'less' }
      : null;
    // Chevron shows three states; a section with a "show more" affordance is the
    // "partial" state, everything else expanded reads as full.
    const chevron = chevronState(mode, !!(more && more.action === 'more'));
    return { rows, more, collapsed: mode === 'collapsed', chevron };
  };
  // Re-insert each section's hidden task ids after its shown rows so a committed
  // reorder covers every task (hidden ones keep their relative order and their
  // heading/date), and drop the non-task "more" markers.
  const reinsertHidden = (keys) => {
    const out = [];
    const done = new Set();
    let cur = null;
    const flush = () => {
      if (cur && !done.has(cur) && hiddenBySection[cur]?.length) {
        out.push(...hiddenBySection[cur]);
        done.add(cur);
      }
    };
    keys.forEach((k) => {
      if (k.startsWith('h:') || k.startsWith('d:')) { flush(); cur = k; out.push(k); }
      else if (k.startsWith('more:')) { flush(); /* drop marker */ }
      else if (k.startsWith('add:') || k.startsWith('sec:')) { flush(); out.push(k); }
      else out.push(k);
    });
    flush();
    return out;
  };

  // Collapsed date sections (by date key) for the date views (project + Upcoming).
  const [collapsedDates, setCollapsedDates] = useState(() => new Set());
  const toggleDate = (key) =>
    setCollapsedDates((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const rawSections = useSections(state, route);
  const dateFormat = state.settings?.dateFormat ?? 'weekday-long';
  const project0 = projectId ? state.projects.find((p) => p.id === projectId) : null;
  const taskFilter = useMemo(
    () => makeFilter(filterDate, filterPriority, filterLabel),
    [filterDate, filterPriority, filterLabel]
  );
  // Universal (all-layout) filter + within-section sort for projects. Heading
  // structure is preserved, so drag-to-reorder in the list stays safe.
  const sections = useMemo(() => {
    if (!project0 || (!hasFilter && sorting === 'manual')) return rawSections;
    return rawSections.map((s) => ({
      ...s,
      data: sortData(hasFilter ? s.data.filter(taskFilter) : s.data, sorting),
    }));
  }, [rawSections, project0, hasFilter, taskFilter, sorting]);
  // Alternate grouping (Priority/Date/Label/None) rebuilds the project's list as
  // collapsible group sections; null when using the default heading "Section".
  const groupedSections = useMemo(() => {
    if (!project0 || grouping === 'section') return null;
    let flat = selectProjectTasks(state.tasks, project0.id).filter((tk) => !tk.parentId);
    if (hasFilter) flat = flat.filter(taskFilter);
    return groupTasks(flat, grouping, state.settings?.showCompleted, sorting, dateFormat, state.settings?.keepCompletedInPlace);
  }, [project0, grouping, state.tasks, hasFilter, taskFilter, sorting, state.settings?.showCompleted, dateFormat, state.settings?.keepCompletedInPlace]);
  const projectLabels = useMemo(
    () => (project0 ? [...new Set(selectProjectTasks(state.tasks, project0.id).flatMap((tk) => tk.tags || []))].sort() : []),
    [project0, state.tasks]
  );
  const isWide = useIsWide();
  const centered = state.settings?.centeredContent;
  const smart = listId ? SMART_LIST_MAP[listId] : null;
  const project = projectId ? state.projects.find((p) => p.id === projectId) : null;
  const area = areaId ? state.areas.find((a) => a.id === areaId) : null;
  const editingHeading = editSectionId
    ? state.headings.find((h) => h.id === editSectionId)
    : null;

  useLayoutEffect(() => {
    navigation.setOptions({ headerShown: false });
  }, [navigation]);

  // On a view change, synchronously (during render, before the new list paints)
  // hide the sticky bar and re-arm the offset sentinel, so it can't flash the
  // previous header or the new list's first header before onLayout re-measures.
  const viewKey = `${listId}|${projectId}|${areaId}|${projectView}|${grouping}`;
  const prevViewKeyRef = useRef(viewKey);
  if (prevViewKeyRef.current !== viewKey) {
    prevViewKeyRef.current = viewKey;
    scrollY.value = 0;
    listOffsetY.value = 1e6;
    setStickyHeader(null);
  }

  const totalTasks = sections.reduce((n, s) => n + s.data.length, 0);
  const isEmpty = totalTasks === 0;

  // The defaults a new task in this list inherits (its schedule / container).
  const addDefaults = () => {
    const defaults = {};
    if (listId === 'today') defaults.when = WHEN.TODAY;
    if (listId === 'someday') defaults.when = WHEN.SOMEDAY;
    if (projectId) {
      defaults.projectId = projectId;
      defaults.areaId = project?.areaId || null;
    }
    // Areas hold no tasks of their own — nothing to file directly into an area.
    return defaults;
  };

  const handleAdd = () => {
    // On phones the FAB opens the low-friction quick-add composer (bottom sheet)
    // rather than the full-screen detail editor. Wide layouts keep the detail editor.
    if (!isWide) {
      setQuickAddOpen(true);
      scrollListToEnd();
      return;
    }
    const task = newTask(addDefaults());
    addTask(task);
    setOpenTaskId(task.id);
  };

  // Create a task from the quick-add composer, merging its picked fields over the
  // list defaults. The composer stays open for the next entry (handled in-component).
  const handleQuickAdd = (fields) => {
    const defaults = addDefaults();
    const task = newTask({
      title: fields.title,
      // Container comes from the composer's picker (seeded from this list).
      projectId: fields.projectId || null,
      areaId: fields.areaId || null,
      headingId: fields.headingId || null,
      when: fields.when || defaults.when || null,
      startMinutes: fields.startMinutes ?? null,
      durationMinutes: fields.durationMinutes ?? null,
      timezone: fields.timezone ?? null,
      deadline: fields.deadline || null,
      priority: fields.priority || null,
      tags: fields.tags || [],
    });
    addTask(task);
    scrollListToEnd();
  };

  // Promote the quick-add entry to the full-screen editor: create the task from
  // whatever's been entered so far (title may be blank), then open it in the
  // detail editor and close the composer.
  const handleQuickAddExpand = (fields) => {
    const defaults = addDefaults();
    const task = newTask({
      title: fields.title || '',
      projectId: fields.projectId || null,
      areaId: fields.areaId || null,
      headingId: fields.headingId || null,
      when: fields.when || defaults.when || null,
      startMinutes: fields.startMinutes ?? null,
      durationMinutes: fields.durationMinutes ?? null,
      timezone: fields.timezone ?? null,
      deadline: fields.deadline || null,
      priority: fields.priority || null,
      tags: fields.tags || [],
    });
    addTask(task);
    setQuickAddOpen(false);
    setOpenTaskId(task.id);
  };

  const headerColor = smart?.color || project?.color || area?.color || colors.text;
  const headerTitle = title || smart?.title || project?.name || area?.name || 'List';

  // Mobile quick-add composer, rendered alongside the FAB on each phone list surface.
  const quickAdd = (
    <QuickAddComposer
      visible={quickAddOpen}
      onClose={() => { setQuickAddOpen(false); scrollListToEnd(); }}
      onCoveredHeight={setComposerCovered}
      onAdd={handleQuickAdd}
      onExpand={handleQuickAddExpand}
      defaultContainer={{ projectId: projectId || null, areaId: project?.areaId || null, headingId: null }}
    />
  );

  // Drag-to-reorder is allowed in contexts whose selector sorts by `order`, so
  // a committed reorder persists across reloads: Inbox, Today, Anytime, Someday,
  // and Areas. (Upcoming/Logbook are date-ordered; Project is handled above.)
  // Today can split into Today + This Evening — each section reorders on its own.
  const REORDERABLE_LISTS = ['inbox', 'today', 'anytime', 'someday'];
  const listReorderable = REORDERABLE_LISTS.includes(listId);

  // The nav bar now sits fixed above the scroll (so sticky section headers can
  // pin to the very top), and the container owns the top safe-area inset — so
  // the scroll content only needs a small top gap.
  // While the quick-add composer is open it overlays the bottom of the screen (composer
  // + keyboard) without resizing the list. Pad the content by exactly the covered area
  // (measured by the composer) plus a small gap, so scrolling to the end lands the last
  // item just ABOVE the composer.
  const contentPad = {
    paddingTop: spacing.sm,
    paddingBottom: quickAddOpen ? Math.max(0, composerCovered - 12) : insets.bottom + 100,
  };

  // Project date view: the project's to-dos regrouped by their When date. Sourced
  // from all project tasks (not the heading sections) so the per-bucket done/total
  // is correct; completed rows show only when the setting is on, like the list.
  const projectDateSections =
    project && projectView === 'date'
      ? groupByDate(
          selectProjectTasks(state.tasks, project.id).filter(hasFilter ? taskFilter : () => true),
          state.settings?.showCompleted,
          dateFormat,
          state.settings?.keepCompletedInPlace
        )
      : [];

  // Board view: the project's shown top-level tasks + its headings; BoardView
  // groups/sorts them itself and re-assigns fields on drag between columns.
  const boardTasks = project && projectView === 'board' ? sections.flatMap((s) => s.data) : [];
  const projectHeadings = project
    ? state.headings.filter((h) => h.projectId === project.id).sort(byOrder)
    : [];

  // --- Shared date-grouped list (project date view + Upcoming) --------------
  // Both render date buckets as collapsible dividers with draggable/reorderable
  // task rows underneath. Dropping a task under a bucket adopts that date; the
  // manual order within a bucket persists via reorderTasks.

  // Turn { key, title, subtitle, data, total, doneCount } date sections into
  // ReorderableTaskList items: a collapsible divider per bucket (carrying its
  // pie/count), then its already-ordered task rows.
  const buildDateItems = (dateSections, color) => {
    const items = [];
    dateSections.forEach((s) => {
      const key = `d:${s.key}`;
      const { rows, more, collapsed, chevron } = sliceSection(key, s.data);
      items.push({
        key,
        kind: 'divider',
        dividerKey: s.key,
        title: s.title,
        subtitle: s.subtitle,
        collapsible: true,
        collapsed,
        chevron,
        total: s.total,
        done: s.doneCount,
        color,
      });
      rows.forEach((t) => items.push({ key: t.id, kind: 'task', task: t }));
      if (more) {
        items.push({ key: `more:${key}`, kind: 'more', sectionKey: key, action: more.action, hidden: more.hidden, color });
      }
    });
    return items;
  };

  // Commit a date-view drag: each task adopts the `when` of the divider above it
  // ('no-date' clears it), then the visible order is persisted.
  const whenForDivider = (dividerKey) => (dividerKey === 'no-date' ? null : dividerKey);
  const commitDateLayout = (rawKeys) => {
    const keys = reinsertHidden(rawKeys); // fold hidden (three-state) tasks back in
    const orderedIds = [];
    const firstDivider = keys.find((k) => k.startsWith('d:'));
    let currentWhen = firstDivider ? whenForDivider(firstDivider.slice(2)) : null;
    keys.forEach((k) => {
      if (k.startsWith('d:')) {
        currentWhen = whenForDivider(k.slice(2));
        return;
      }
      orderedIds.push(k);
      const task = state.tasks.find((t) => t.id === k);
      if (task && task.when !== currentWhen) updateTask(k, { when: currentWhen });
    });
    reorderTasks(orderedIds);
  };

  const renderDateList = (dateSections, emptyKey) => {
    const items = buildDateItems(dateSections, project?.color);
    if (items.length === 0) return <EmptyState listId={emptyKey} />;
    return (
      <ReorderableTaskList
        items={items}
        // Show the project/area label in Upcoming; hide it inside a project.
        showProject={!project}
        onOpenTask={setOpenTaskId}
        onCommitKeys={commitDateLayout}
        onToggleDivider={onDividerToggle}
        onToggleMore={onToggleMore}
        stickyScrollY={scrollY}
        stickyOffsetY={listOffsetY}
        onStickyHeaderChange={setStickyHeader}
      />
    );
  };

  // Render the Display-menu grouping (Priority/Date/Label/None) as collapsible
  // group buckets. Date grouping reschedules on drop; the others only reorder.
  const renderGroupedList = (grpSections) => {
    const items = buildDateItems(grpSections, project?.color);
    if (items.length === 0) return <EmptyState listId="project-date" />;
    const onCommit =
      grouping === 'date'
        ? commitDateLayout
        : (keys) => reorderTasks(keys.filter((k) => !k.startsWith('d:')));
    return (
      <ReorderableTaskList
        items={items}
        showProject={false}
        onOpenTask={setOpenTaskId}
        onCommitKeys={onCommit}
        onToggleDivider={onDividerToggle}
        onToggleMore={onToggleMore}
        stickyScrollY={scrollY}
        stickyOffsetY={listOffsetY}
        onStickyHeaderChange={setStickyHeader}
      />
    );
  };

  // Project view: flatten sections (main tasks + heading dividers + their tasks,
  // including each heading's own completed rows) into one drag surface.
  let projectItems = [];
  if (project) {
    sections.forEach((s) => {
      const hid = s.heading ? s.heading.id : null;
      // Only heading sections are three-state; the headingless "main" group (no
      // header to click) always shows everything.
      const secKey = s.heading ? `h:${s.heading.id}` : 'main';
      const { rows, more, collapsed, chevron } = s.heading
        ? sliceSection(secKey, s.data)
        : { rows: s.data, more: null, collapsed: false, chevron: 'full' };
      if (s.heading) {
        projectItems.push({
          key: secKey,
          kind: 'heading',
          title: s.title,
          description: s.heading.description,
          headingId: s.heading.id,
          collapsed,
          chevron,
          done: s.doneCount,
          total: s.total,
          color: project.color,
        });
      }
      if (!collapsed) {
        // Emit a task and, when expanded, its subtasks nested beneath it — each
        // as its own draggable row carrying a depth (for indentation) so nesting
        // is unlimited.
        const emit = (t, depth) => {
          const kids = selectSubtasks(state.tasks, t.id);
          projectItems.push({
            key: t.id,
            kind: 'task',
            task: t,
            depth,
            hasChildren: kids.length > 0,
            expanded: expandedTasks.has(t.id),
          });
          if (kids.length > 0 && expandedTasks.has(t.id)) kids.forEach((k) => emit(k, depth + 1));
        };
        rows.forEach((t) => emit(t, 0));
        if (more) {
          projectItems.push({ key: `more:${secKey}`, kind: 'more', sectionKey: secKey, action: more.action, hidden: more.hidden, color: project.color });
        }
        // Inline "+ Add task" only on wide layouts — phones use the floating
        // add button to save the vertical space.
        if (isWide) {
          projectItems.push({ key: `add:${hid || 'main'}`, kind: 'addtask', headingId: hid });
        }
      }
      // "Add section" trigger (hover-revealed) only makes sense on wide layouts.
      if (isWide) {
        projectItems.push({ key: `sec:${hid || 'main'}`, kind: 'addsection', afterHeadingId: hid });
      }
    });
  }

  // Create a task inline in a specific section from the compose form (title,
  // description, and the scheduling/priority/location/label fields).
  const handleAddInSection = (headingId, opts = {}) => {
    const task = newTask({
      projectId,
      headingId: headingId || null,
      areaId: project?.areaId || null,
      title: opts.title || '',
      notes: opts.description || '',
      when: opts.when || null,
      deadline: opts.deadline || null,
      priority: opts.priority || null,
      location: opts.location || '',
      tags: opts.tags || [],
    });
    addTask(task);
  };

  // Insert a new heading right after `afterHeadingId` (null = before the first),
  // using the title/description composed in the inline "Add section" form.
  const handleAddSectionAfter = (afterHeadingId, { title, description } = {}) => {
    const hs = state.headings.filter((h) => h.projectId === projectId).sort(byOrder);
    let order;
    if (!afterHeadingId) {
      order = hs.length ? (hs[0].order ?? 0) - 1 : 0;
    } else {
      const i = hs.findIndex((h) => h.id === afterHeadingId);
      const cur = hs[i]?.order ?? 0;
      const next = hs[i + 1];
      order = next ? (cur + (next.order ?? 0)) / 2 : cur + 1;
    }
    addHeading(projectId, { title, description, order });
  };

  // Walk the dropped order. Each task adopts the heading above it; a task keeps
  // its rendered depth, so its parent becomes the nearest preceding task one
  // level up (a subtask stays a sibling of the rows at its indent, and lands
  // top-level when there's no shallower task above it). The static add rows are
  // ignored. Heading dividers record their new block order.
  const depthByKey = new Map(
    projectItems.filter((i) => i.kind === 'task').map((i) => [i.key, i.depth || 0])
  );
  const commitProjectLayout = (rawKeys, meta = {}) => {
    const { draggedKey, dx = 0, depth: metaDepth = null } = meta;
    // Fold each section's hidden (three-state) tasks back in as top-level rows
    // after their shown ones, so every task gets a fresh, non-colliding order.
    // Then carry the dragged task's whole subtree along with it.
    const orderedDepths = projectItems
      .filter((i) => i.kind === 'task')
      .map((i) => ({ key: i.key, depth: i.depth || 0 }));
    const { keys, descendants } = carrySubtree(reinsertHidden(rawKeys), draggedKey, orderedDepths);
    let currentHeading = null;
    const tasks = [];
    const headings = [];
    const stack = []; // stack[d] = last task id seen at depth d
    let draggedDelta = 0; // how far the dragged task changed depth (applied to its subtree)
    keys.forEach((k) => {
      if (k.startsWith('add:') || k.startsWith('sec:')) return;
      if (k.startsWith('h:')) {
        currentHeading = k.slice(2);
        headings.push(currentHeading);
        stack.length = 0;
        return;
      }
      // stack.length-1 is the depth of the task immediately above this one.
      const aboveDepth = stack.length - 1;
      let depth = depthByKey.get(k) || 0;
      if (k === draggedKey) {
        // Horizontal drag sets the target indent in BOTH directions: drag right to
        // nest (child), drag left to un-nest (back to sibling / top level). Clamp so a
        // task is at most one level deeper than the row above it.
        depth = aboveDepth < 0 ? 0 : Math.max(0, Math.min(aboveDepth + 1, metaDepth != null ? metaDepth : depth + Math.round(dx / NEST_STEP)));
        draggedDelta = depth - (depthByKey.get(k) || 0);
      } else if (descendants.has(k)) {
        // Subtree rows keep their internal nesting, shifted by the parent's move.
        depth = Math.max(0, (depthByKey.get(k) || 0) + draggedDelta);
      }
      const parentId = depth > 0 ? stack[depth - 1] || null : null;
      tasks.push({ id: k, parentId, headingId: parentId ? null : currentHeading });
      stack[depth] = k;
      stack.length = depth + 1;
    });
    setProjectLayout({ tasks, headings });
  };

  // Today is one drag surface with a fixed "Morning" header over the daytime
  // to-dos and a "This Evening" divider below, so tasks can be dragged across.
  // Both slots are always present (an empty-drop placeholder when they have no
  // tasks) so tasks can be moved into either.
  // The two slots reuse the three-state collapse infra (keys 'd:morning' /
  // 'd:evening'), so their headers collapse/expand like every other section.
  const MORNING_DIVIDER = 'd:morning';
  const EVENING_DIVIDER = 'd:evening';
  let todayItems = null;
  if (listId === 'today') {
    const dayData = sections.find((s) => s.key === 'today')?.data || [];
    const eveningData = sections.find((s) => s.key === 'evening')?.data || [];
    const morning = sliceSection(MORNING_DIVIDER, dayData);
    const eve = sliceSection(EVENING_DIVIDER, eveningData);
    const slot = (dividerKey, key, title, icon, sliced, data) => {
      // Emit each task and, when expanded, its subtasks nested beneath it — same
      // depth-carrying rows the other lists use, so Today supports drag-nesting.
      const rows = [];
      const emit = (t, depth) => {
        const kids = selectSubtasks(state.tasks, t.id);
        rows.push({ key: t.id, kind: 'task', task: t, depth, hasChildren: kids.length > 0, expanded: expandedTasks.has(t.id) });
        if (kids.length > 0 && expandedTasks.has(t.id)) kids.forEach((k) => emit(k, depth + 1));
      };
      sliced.rows.forEach((t) => emit(t, 0));
      const out = [
        { key, kind: 'divider', dividerKey, title, icon, collapsible: true, collapsed: sliced.collapsed, chevron: sliced.chevron },
        ...rows,
      ];
      if (sliced.more) {
        out.push({ key: `more:${key}`, kind: 'more', sectionKey: key, action: sliced.more.action, hidden: sliced.more.hidden });
      } else if (!sliced.collapsed && data.length === 0) {
        out.push({ key: `${dividerKey}-empty`, kind: 'emptyslot', label: 'No tasks yet' });
      }
      return out;
    };
    todayItems = [
      ...slot('morning', MORNING_DIVIDER, 'Morning', 'sunny-outline', morning, dayData),
      ...slot('evening', EVENING_DIVIDER, 'This Evening', 'moon', eve, eveningData),
    ];
  }
  // Rendered depth of each Today task row (for the nesting commit below).
  const todayDepthByKey = new Map(
    (todayItems || []).filter((i) => i.kind === 'task').map((i) => [i.key, i.depth || 0])
  );

  // Commit a Today reorder: tasks below the Evening divider become "This
  // Evening" (when = EVENING); tasks above (under Morning) revert to Today; then
  // persist the order.
  const commitTodayLayout = (rawKeys, meta = {}) => {
    const { draggedKey, dx = 0, depth: metaDepth = null } = meta;
    // Fold hidden rows back in, then carry the dragged task's whole subtree with it.
    const orderedDepths = (todayItems || [])
      .filter((i) => i.kind === 'task')
      .map((i) => ({ key: i.key, depth: i.depth || 0 }));
    const { keys, descendants } = carrySubtree(reinsertHidden(rawKeys), draggedKey, orderedDepths);
    const eveningIdx = keys.indexOf(EVENING_DIVIDER);
    const taskById = new Map(state.tasks.map((t) => [t.id, t]));
    const stack = []; // stack[d] = last task id at depth d
    const tasks = [];
    let draggedDelta = 0;
    keys.forEach((k, i) => {
      if (k === MORNING_DIVIDER || k === 'morning-empty' || k === EVENING_DIVIDER || k === 'evening-empty' || k.startsWith('more:')) {
        return;
      }
      const aboveDepth = stack.length - 1;
      let depth = todayDepthByKey.get(k) || 0;
      if (k === draggedKey) {
        depth = aboveDepth < 0 ? 0 : Math.max(0, Math.min(aboveDepth + 1, metaDepth != null ? metaDepth : depth + Math.round(dx / NEST_STEP)));
        draggedDelta = depth - (todayDepthByKey.get(k) || 0);
      } else if (descendants.has(k)) {
        depth = Math.max(0, (todayDepthByKey.get(k) || 0) + draggedDelta);
      }
      const parentId = depth > 0 ? stack[depth - 1] || null : null;
      // A subtask belongs to no heading; a top-level task keeps whatever heading it
      // had (a project task scheduled today mustn't be torn out of its section).
      const headingId = parentId ? null : (taskById.get(k)?.headingId ?? null);
      tasks.push({ id: k, parentId, headingId });
      stack[depth] = k;
      stack.length = depth + 1;
      // Only TOP-LEVEL tasks adopt the Morning/Evening slot from their position;
      // subtasks follow their parent (their own `when` is left alone).
      if (depth === 0) {
        const task = state.tasks.find((t) => t.id === k);
        if (task) {
          const isEvening = eveningIdx >= 0 && i > eveningIdx;
          if (isEvening && task.when !== WHEN.EVENING) updateTask(k, { when: WHEN.EVENING });
          else if (!isEvening && task.when === WHEN.EVENING) updateTask(k, { when: WHEN.TODAY });
        }
      }
    });
    setProjectLayout({ tasks, headings: [] });
  };

  // The chevron/sidebar-toggle bar sits above the content and is intentionally
  // NOT constrained by the "Center content" setting — it spans the full pane.
  const navBar = (
    <View style={styles.navBar}>
      {embedded ? (
        // The collapse control now lives in the sidebar header; the detail pane
        // only needs a reopen affordance while the sidebar is hidden.
        sidebarVisible ? (
          <View style={styles.back} />
        ) : (
          <SidebarToggle onPress={onToggleSidebar} color={colors.accent} style={styles.back} />
        )
      ) : (
        <Pressable testID="list-back" hitSlop={10} onPress={() => navigation.goBack()} style={styles.back}>
          <Ionicons name="chevron-back" size={26} color={colors.accent} />
        </Pressable>
      )}
      {listId === 'trash' && totalTasks > 0 && (
        <Pressable hitSlop={10} onPress={emptyTrash}>
          <Text style={styles.emptyTrash}>Empty</Text>
        </Pressable>
      )}
      {project && (
        <Pressable testID="list-display" style={styles.displayBtn} onPress={() => setDisplayOpen(true)}>
          <Ionicons name="options-outline" size={16} color={colors.textSecondary} />
          <Text style={styles.displayText}>Display</Text>
          {hasFilter && <View style={styles.displayDot} />}
        </Pressable>
      )}
      {(project || area) && (
        <>
          <View style={{ flex: 1 }} />
          <Pressable
            style={styles.displayBtn}
            onPress={() =>
              navigation.navigate('List', {
                search: true,
                scope: project
                  ? { type: 'project', id: project.id }
                  : { type: 'area', id: area.id },
                scopeTitle: project ? project.name : area.name,
                title: `Search ${project ? project.name : area.name}`,
              })
            }
          >
            <Ionicons name="search" size={16} color={colors.textSecondary} />
            <Text style={styles.displayText}>Search</Text>
          </Pressable>
        </>
      )}
      {project && (
        <DisplayMenu
          visible={displayOpen}
          onClose={() => setDisplayOpen(false)}
          layout={projectView}
          onLayout={setProjectView}
          layouts={['list', 'board', 'calendar', 'gantt', 'date']}
          showCompleted={!!state.settings?.showCompleted}
          onToggleCompleted={(v) => setSetting('showCompleted', v)}
          grouping={grouping}
          onGrouping={setGrouping}
          sorting={sorting}
          onSorting={setSorting}
          filterDate={filterDate}
          onFilterDate={setFilterDate}
          filterPriority={filterPriority}
          onFilterPriority={setFilterPriority}
          filterLabel={filterLabel}
          onFilterLabel={setFilterLabel}
          labels={projectLabels}
        />
      )}
    </View>
  );

  // The title/project header is part of the content and follows the centering.
  const titleHeader = project ? (
    <ProjectHeader project={project} navigation={navigation} />
  ) : area ? (
    <AreaHeader area={area} navigation={navigation} />
  ) : (
    <View style={styles.titleRow}>
      {smart && (
        <Ionicons name={smart.icon} size={26} color={headerColor} style={{ marginRight: 8 }} />
      )}
      <Text testID="list-title" style={[styles.screenTitle, smart && { color: headerColor }]}>
        {headerTitle}
      </Text>
    </View>
  );

  // The Board, Calendar and Gantt views fill the pane and manage their own
  // scrolling, so they render in a flex column rather than the page ScrollView.
  const isFullPane =
    project && (projectView === 'board' || projectView === 'calendar' || projectView === 'gantt');
  const fullPaneEl =
    projectView === 'board' ? (
      <BoardView
        tasks={boardTasks}
        headings={projectHeadings}
        project={project}
        onOpenTask={setOpenTaskId}
        onUpdateTask={updateTask}
        onReorder={reorderTasks}
        onAddTask={handleAddInSection}
        onAddSection={handleAddSectionAfter}
        onEditSection={setEditSectionId}
        grouping={grouping}
        sorting={sorting}
      />
    ) : projectView === 'gantt' ? (
      <GanttView
        sections={sections}
        project={project}
        onUpdateTask={updateTask}
        onOpenTask={setOpenTaskId}
      />
    ) : (
      <CalendarView
        tasks={sections.flatMap((s) => s.data)}
        project={project}
        onOpenTask={setOpenTaskId}
        onUpdateTask={updateTask}
        onAddTask={(opts) => handleAddInSection(null, opts)}
        fillHeight
      />
    );

  if (isFullPane) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        {navBar}
        {titleHeader}
        <View style={styles.fillCol}>{fullPaneEl}</View>
        <TaskDetailModal
          visible={!!openTaskId}
          taskId={openTaskId}
          onClose={() => setOpenTaskId(null)}
          onOpenTask={setOpenTaskId}
        />
      </View>
    );
  }

  // Plain, non-drag multi-section lists — an Area's Today/Upcoming/Overdue
  // roll-up and the Logbook's by-month groups (plus Overdue/Trash) — render in a
  // SectionList so each group header STAYS PINNED to the top while you scroll its
  // tasks, then gets pushed up by the next group's header. These lists aren't
  // drag-reorderable, so a SectionList (virtualized + sticky) is the clean fit;
  // the drag surfaces (project/Today/Upcoming) keep their own layout.
  // StickyTaskSections is a windowed FlatList (the calendar-views technique), so
  // it scales to any length — no row cap needed.
  const useStickySections =
    !project && !listReorderable && listId !== 'upcoming' && !isEmpty;
  if (useStickySections) {
    // Apply the three-state slicing to each section (collapsed / 10 / full).
    const slicedSections = sections.map((s) => {
      const { rows, more, collapsed, chevron } = sliceSection(s.key, s.data);
      return { ...s, data: rows, more, collapsed, chevron, sectionKey: s.key };
    });
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        {navBar}
        <StickyTaskSections
          sections={slicedSections}
          header={
            <View style={[styles.contentCol, centered && styles.contentColCentered]}>
              {titleHeader}
            </View>
          }
          showProject
          onOpenTask={setOpenTaskId}
          onToggleSection={cycleSection}
          onToggleMore={onToggleMore}
          // Match the project drag list's handle-gutter inset on wide layouts so
          // Area/Logbook rows line up with project rows even without a handle.
          inset={isWide ? HANDLE_W : 0}
          contentPadding={{ paddingBottom: insets.bottom + 100 }}
        />
        {listId !== 'logbook' && listId !== 'trash' && !areaId && (
          <FloatingAddButton onPress={handleAdd} bottom={insets.bottom + 20} />
        )}
        {quickAdd}
        <TaskDetailModal
          visible={!!openTaskId}
          taskId={openTaskId}
          onClose={() => setOpenTaskId(null)}
          onOpenTask={setOpenTaskId}
        />
      </View>
    );
  }

  // Flat items for whichever non-full-pane list surface is active, so any of
  // them can fall back to a virtualized (windowed) list. Only rows near the
  // viewport stay in the DOM, so every list scales to any number of tasks.
  let surfaceItems = null;
  let surfaceShowProject = false;
  // The matching commit handler, so the windowed list can also drag-reorder.
  let surfaceCommit = null;
  if (project) {
    if (projectView === 'list' && !groupedSections) {
      surfaceItems = projectItems;
      surfaceCommit = commitProjectLayout;
    } else if (projectView === 'list' && groupedSections) {
      surfaceItems = buildDateItems(groupedSections, project.color);
      surfaceCommit =
        grouping === 'date'
          ? commitDateLayout
          : (keys) => reorderTasks(keys.filter((k) => !k.startsWith('d:')));
    } else if (projectView === 'date') {
      surfaceItems = buildDateItems(projectDateSections, project.color);
      surfaceCommit = commitDateLayout;
    }
  } else if (listId === 'upcoming') {
    surfaceItems = buildDateItems(
      groupByDate(selectForList(state.tasks, 'upcoming'), state.settings?.showCompleted, dateFormat),
      null
    );
    surfaceShowProject = true;
    surfaceCommit = commitDateLayout;
  } else if (listId === 'today' && listReorderable) {
    surfaceItems = todayItems;
    surfaceShowProject = true;
    surfaceCommit = commitTodayLayout;
  } else if (!isEmpty) {
    // Generic smart list / area: flatten its sections into divider + task rows.
    const flat = [];
    sections.forEach((s) => {
      if (s.title) {
        flat.push({
          key: `d:${s.key}`, kind: 'divider', title: s.title, subtitle: s.subtitle || null,
          icon: s.icon || null, iconColor: s.iconColor || null,
          collapsible: false, total: s.total || 0, done: s.doneCount || 0,
        });
      }
      (s.data || []).forEach((t) => flat.push({ key: t.id, kind: 'task', task: t }));
    });
    surfaceItems = flat;
    surfaceShowProject = true;
    if (listReorderable) surfaceCommit = reorderTasks;
  }

  // Above this many rows, virtualize. Kept generous so normal projects and a
  // full Upcoming still use the rich (absolutely-positioned) drag list below;
  // only genuinely huge lists fall back to the windowed VirtualTaskList, which
  // has its own simpler drag-reorder.
  if (surfaceItems && surfaceItems.length > 400) {
    const virtualHeader = <View style={[styles.contentCol, centered && styles.contentColCentered]}>{titleHeader}</View>;
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        {navBar}
        {surfaceCommit ? (
          // Windowed AND drag-reorderable (uniform-height rows). Used for the
          // huge reorderable lists (e.g. a 2k-task project).
          <DraggableVirtualTaskList
            items={surfaceItems}
            header={virtualHeader}
            inProject={!!project}
            showProject={surfaceShowProject}
            onOpenTask={setOpenTaskId}
            onToggleExpand={toggleTaskExpand}
            onToggleCollapse={onHeadingToggle}
            onToggleDivider={onDividerToggle}
            onToggleMore={onToggleMore}
            onAddTask={handleAddInSection}
            onCommitKeys={surfaceCommit}
          />
        ) : (
          <VirtualTaskList
            items={surfaceItems}
            header={virtualHeader}
            inProject={!!project}
            showProject={surfaceShowProject}
            onOpenTask={setOpenTaskId}
            onToggleExpand={toggleTaskExpand}
            onToggleCollapse={onHeadingToggle}
            onToggleDivider={onDividerToggle}
            onToggleMore={onToggleMore}
            onAddTask={handleAddInSection}
          />
        )}
        {listId !== 'logbook' && listId !== 'trash' && !areaId && !(project && isWide) && (
          <FloatingAddButton onPress={handleAdd} bottom={insets.bottom + 20} />
        )}
        {quickAdd}
        <TaskDetailModal
          visible={!!openTaskId}
          taskId={openTaskId}
          onClose={() => setOpenTaskId(null)}
          onOpenTask={setOpenTaskId}
        />
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {navBar}
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={contentPad}
        keyboardShouldPersistTaps="handled"
        onScroll={onScroll}
        scrollEventThrottle={16}
      >
        <View style={[styles.contentCol, centered && styles.contentColCentered]}>
        {titleHeader}
        {/* Measure the list surface's top within the scroll content so the drag
            lists' sticky header overlay knows where the sections begin. */}
        <View onLayout={(e) => { listOffsetY.value = spacing.sm + e.nativeEvent.layout.y; }}>
        {project ? (
          projectView === 'board' ? (
            // Board view: Kanban with user-changeable grouping/sort and cards
            // draggable between columns.
            <BoardView
              tasks={boardTasks}
              headings={projectHeadings}
              project={project}
              onOpenTask={setOpenTaskId}
              onUpdateTask={updateTask}
              onReorder={reorderTasks}
              onAddTask={handleAddInSection}
              onAddSection={handleAddSectionAfter}
              onEditSection={setEditSectionId}
              grouping={grouping}
              sorting={sorting}
            />
          ) : projectView === 'calendar' ? (
            // Calendar view: Month grid or a Day planner (time-blocking timeline).
            <CalendarView
              tasks={sections.flatMap((s) => s.data)}
              project={project}
              onOpenTask={setOpenTaskId}
              onUpdateTask={updateTask}
              onAddTask={(opts) => handleAddInSection(null, opts)}
            />
          ) : projectView === 'gantt' ? (
            // Gantt view: a timeline bar per task from its Date (start) to its
            // Deadline (end), grouped by section.
            <GanttView sections={sections} project={project} onOpenTask={setOpenTaskId} />
          ) : projectView === 'date' ? (
            // Date view: the project's open to-dos regrouped by scheduled date,
            // as collapsible buckets with draggable/reorderable rows.
            renderDateList(projectDateSections, 'project-date')
          ) : groupedSections ? (
            // Non-default grouping (Priority/Date/Label/None): collapsible group
            // buckets. Reorder persists order only (Date grouping reschedules).
            renderGroupedList(groupedSections)
          ) : (
            // One drag surface for the whole project: heading dividers are fixed,
            // tasks can be dragged within or across them. A per-section "+ Add
            // task" and an "Add section" trigger let you build it out inline.
            <ReorderableTaskList
              items={projectItems}
              showProject={false}
              inProject
              showSubtasks
              onToggleExpand={toggleTaskExpand}
              onOpenTask={setOpenTaskId}
              onCommitKeys={commitProjectLayout}
              onDeleteHeading={deleteHeading}
              onUpdateHeading={updateHeading}
              onToggleCollapse={onHeadingToggle}
              onToggleMore={onToggleMore}
              onAddTask={handleAddInSection}
              onAddSection={handleAddSectionAfter}
              onEditSection={setEditSectionId}
              stickyScrollY={scrollY}
              stickyOffsetY={listOffsetY}
              onStickyHeaderChange={setStickyHeader}
            />
          )
        ) : isEmpty ? (
          <EmptyState listId={listId} />
        ) : listId === 'upcoming' ? (
          // Upcoming is the same date-grouped surface: collapsible date buckets
          // with draggable/reorderable rows (dragging reschedules the task).
          renderDateList(
            groupByDate(selectForList(state.tasks, 'upcoming'), state.settings?.showCompleted, dateFormat),
            'upcoming'
          )
        ) : listId === 'today' && listReorderable ? (
          // Single drag surface: Today + This Evening divider, cross-draggable.
          <ReorderableTaskList
            items={todayItems}
            showProject
            showSubtasks
            onOpenTask={setOpenTaskId}
            onToggleExpand={toggleTaskExpand}
            onCommitKeys={commitTodayLayout}
            onToggleDivider={onDividerToggle}
            onToggleMore={onToggleMore}
            stickyScrollY={scrollY}
            stickyOffsetY={listOffsetY}
            onStickyHeaderChange={setStickyHeader}
          />
        ) : (
          sections.map((section) =>
            listReorderable && section.data.length > 0 ? (
              <ReorderableSection
                key={section.key}
                section={section}
                listId={listId}
                onOpenTask={setOpenTaskId}
              />
            ) : (
              <Section
                key={section.key}
                section={section}
                listId={listId}
                navigation={navigation}
                onOpenTask={setOpenTaskId}
              />
            )
          )
        )}
        </View>
        </View>
      </ScrollView>

      {/* Fixed sticky section header for the drag lists. Drawn OUTSIDE the scroll
          view (pinned just under the nav bar) so it never lags or tears when
          scrolling fast — StickyHeaderTracker only tells it which section to show. */}
      {stickyHeader && (
        <Pressable
          style={[styles.stickyBar, isWide && styles.stickyBarHandled]}
          onPress={() => {
            if (stickyHeader.kind === 'heading') onHeadingToggle(stickyHeader.headingId);
            else if (stickyHeader.collapsible) onDividerToggle(stickyHeader.dividerKey);
          }}
        >
          {/* On wide layouts the real heading rows have a drag-handle gutter
              before the chevron; mirror it so the sticky bar lines up exactly. */}
          {isWide && <View style={{ width: HANDLE_W }} />}
          {stickyHeader.collapsible ? (
            <View style={styles.stickyChevron}>
              <Ionicons
                name="chevron-forward"
                size={16}
                color={colors.textSecondary}
                style={{ transform: [{ rotate: chevronRotate(stickyHeader.chevron) }] }}
              />
            </View>
          ) : stickyHeader.icon ? (
            <Ionicons
              name={stickyHeader.icon}
              size={15}
              color={colors.textTertiary}
              style={{ marginRight: spacing.md }}
            />
          ) : null}
          <View style={styles.stickyTitleWrap}>
            <Text style={styles.stickyBarTitle} numberOfLines={1}>{stickyHeader.title}</Text>
            {stickyHeader.subtitle ? (
              <Text style={styles.stickyBarSubtitle} numberOfLines={1}>{stickyHeader.subtitle}</Text>
            ) : null}
          </View>
          {stickyHeader.total > 0 && (
            <View style={styles.stickyBarProgress}>
              <Text style={styles.stickyBarCount}>
                {stickyHeader.done}/{stickyHeader.total}
              </Text>
              <ProgressPie
                progress={stickyHeader.total ? stickyHeader.done / stickyHeader.total : 0}
                color={stickyHeader.color || colors.accent}
                size={14}
              />
            </View>
          )}
        </Pressable>
      )}

      {listId !== 'logbook' && listId !== 'trash' && !areaId && !(project && isWide) && (
        <FloatingAddButton onPress={handleAdd} bottom={insets.bottom + 20} />
      )}
      {quickAdd}

      <TaskDetailModal
        visible={!!openTaskId}
        taskId={openTaskId}
        onClose={() => setOpenTaskId(null)}
        onOpenTask={setOpenTaskId}
      />

      {/* Mobile: editing a section title/description is a full-page view. */}
      <Modal
        visible={!!editingHeading}
        animationType="slide"
        onRequestClose={() => setEditSectionId(null)}
      >
        <View style={[styles.sectionPage, { paddingTop: insets.top + spacing.lg }]}>
          <Text style={styles.sectionPageTitle}>Edit Section</Text>
          {editingHeading && (
            <SectionEditor
              title={editingHeading.title}
              description={editingHeading.description}
              onSave={(patch) => {
                updateHeading(editingHeading.id, patch);
                setEditSectionId(null);
              }}
              onCancel={() => setEditSectionId(null)}
            />
          )}
        </View>
      </Modal>
    </View>
  );
}

// A smart-list section whose tasks can be dragged to reorder (Inbox, Today,
// Anytime, Someday, Areas). Renders the same header as Section, then a
// ReorderableTaskList; reordering commits this section's ids via onCommitKeys.
function ReorderableSection({ section, listId, onOpenTask }) {
  const { state, setProjectLayout } = useTasks();
  const showProject = section.showProject ?? (!!listId && listId !== 'logbook');
  // Which parents are collapsed (subtasks shown nested + expanded by default, like
  // Todoist — tap the disclosure to collapse).
  const [collapsed, setCollapsed] = useState(() => new Set());
  const toggleExpand = (id) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // Build the draggable rows: each top-level task, then its subtasks nested beneath
  // it (recursively), each carrying a depth so the row indents and can be re-parented.
  const items = [];
  const emit = (t, depth) => {
    const kids = selectSubtasks(state.tasks, t.id);
    const isExpanded = !collapsed.has(t.id);
    items.push({ key: t.id, kind: 'task', task: t, depth, hasChildren: kids.length > 0, expanded: isExpanded });
    if (kids.length > 0 && isExpanded) kids.forEach((k) => emit(k, depth + 1));
  };
  section.data.forEach((t) => emit(t, 0));

  // Drop-as-child: on commit, a task keeps its rendered depth unless it was dragged
  // right past the threshold onto the row above (→ becomes that row's child) — the same
  // rule projects use. parentId falls out of the depth stack.
  const depthByKey = new Map(items.map((i) => [i.key, i.depth || 0]));
  const taskById = new Map(state.tasks.map((t) => [t.id, t]));
  const commit = (rawKeys, meta = {}) => {
    const { draggedKey, dx = 0, depth: metaDepth = null } = meta;
    // Carry the dragged task's whole subtree along with it (its rows don't move
    // in the raw order on their own).
    const orderedDepths = items.map((i) => ({ key: i.key, depth: i.depth || 0 }));
    const { keys, descendants } = carrySubtree(rawKeys, draggedKey, orderedDepths);
    const stack = [];
    const tasks = [];
    let draggedDelta = 0;
    keys.forEach((k) => {
      const aboveDepth = stack.length - 1;
      let depth = depthByKey.get(k) || 0;
      if (k === draggedKey) {
        // Right → nest (child), left → un-nest (sibling), same slot; clamp to one
        // level deeper than the row above.
        depth = aboveDepth < 0 ? 0 : Math.max(0, Math.min(aboveDepth + 1, metaDepth != null ? metaDepth : depth + Math.round(dx / NEST_STEP)));
        draggedDelta = depth - (depthByKey.get(k) || 0);
      } else if (descendants.has(k)) {
        // Subtree rows keep their internal nesting, shifted by the parent's move.
        depth = Math.max(0, (depthByKey.get(k) || 0) + draggedDelta);
      }
      const parentId = depth > 0 ? stack[depth - 1] || null : null;
      // A subtask belongs to no heading; a top-level task keeps whatever heading it had
      // (so project tasks shown in Anytime/Someday aren't torn out of their section).
      const headingId = parentId ? null : taskById.get(k)?.headingId ?? null;
      tasks.push({ id: k, parentId, headingId });
      stack[depth] = k;
      stack.length = depth + 1;
    });
    setProjectLayout({ tasks, headings: [] });
  };

  return (
    <View style={styles.section}>
      {section.title ? (
        <View style={styles.sectionHeader}>
          {section.icon && (
            <Ionicons
              name={section.icon}
              size={14}
              color={colors.textTertiary}
              style={{ marginRight: 6 }}
            />
          )}
          <Text style={styles.sectionTitle}>{section.title}</Text>
          {section.subtitle && (
            <Text style={styles.sectionSubtitle}>{section.subtitle}</Text>
          )}
        </View>
      ) : null}
      <ReorderableTaskList
        items={items}
        showProject={showProject}
        showSubtasks
        onOpenTask={onOpenTask}
        onToggleExpand={toggleExpand}
        onCommitKeys={commit}
      />
    </View>
  );
}

function Section({ section, listId, navigation, onOpenTask }) {
  // Show the project/area label on rows for every smart list (incl. Logbook),
  // matching the Anytime view; sections may also opt in explicitly (Area view).
  const showProject = section.showProject ?? !!listId;

  if (section.data.length === 0 && !section.heading) return null;

  return (
    <View style={styles.section}>
      {section.title ? (
        <View style={styles.sectionHeader}>
          {section.icon && (
            <Ionicons
              name={section.icon}
              size={section.iconColor ? 16 : 14}
              color={section.iconColor || colors.textTertiary}
              style={{ marginRight: 6 }}
            />
          )}
          <Text style={[styles.sectionTitle, section.iconColor && { color: section.iconColor }]}>
            {section.title}
          </Text>
          {section.subtitle && (
            <Text style={styles.sectionSubtitle}>{section.subtitle}</Text>
          )}
        </View>
      ) : null}

      {section.data.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          showProject={showProject}
          onPress={() => onOpenTask(task.id)}
        />
      ))}

      {section.data.length === 0 && section.heading && (
        <Text style={styles.emptyHeading}>No to-dos</Text>
      )}
    </View>
  );
}

function EmptyState({ listId }) {
  const messages = {
    inbox: { icon: 'cafe-outline', text: 'Your Inbox is clear' },
    today: { icon: 'sunny-outline', text: "Nothing planned for today" },
    upcoming: { icon: 'calendar-outline', text: 'Nothing scheduled ahead' },
    anytime: { icon: 'layers-outline', text: 'No available to-dos' },
    someday: { icon: 'archive-outline', text: 'Nothing for someday' },
    logbook: { icon: 'checkmark-done-outline', text: 'Completed to-dos appear here' },
    trash: { icon: 'trash-outline', text: 'Trash is empty' },
    'project-date': { icon: 'calendar-outline', text: 'No scheduled to-dos' },
  };
  const m = messages[listId] || { icon: 'list-outline', text: 'No to-dos yet' };
  return (
    <View style={styles.empty}>
      <Ionicons name={m.icon} size={48} color={colors.separatorStrong} />
      <Text style={styles.emptyText}>{m.text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  // Fixed sticky section-header bar for the drag lists. Pinned just under the
  // 36px nav bar (absolute `top` is measured from the container's padding box,
  // which already starts below the top safe-area inset).
  stickyBar: {
    position: 'absolute',
    top: 36,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
    backgroundColor: colors.background,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
    zIndex: 20,
    ...Platform.select({
      web: { boxShadow: '0 2px 4px rgba(0,0,0,0.05)' },
      default: {
        shadowColor: '#000',
        shadowOpacity: 0.05,
        shadowRadius: 2,
        shadowOffset: { width: 0, height: 1 },
        elevation: 2,
      },
    }),
  },
  // Wide layouts: drop the left padding so the HANDLE_W gutter alone offsets the
  // chevron, matching the drag rows' handle column exactly.
  stickyBarHandled: { paddingLeft: 0 },
  stickyChevron: { paddingRight: spacing.sm },
  stickyTitleWrap: { flex: 1, flexDirection: 'row', alignItems: 'baseline' },
  stickyBarTitle: { ...typography.heading, color: colors.text },
  stickyBarSubtitle: { ...typography.subhead, color: colors.textTertiary, marginLeft: spacing.sm },
  stickyBarProgress: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  stickyBarCount: { ...typography.subhead, color: colors.textTertiary, fontVariant: ['tabular-nums'] },
  contentCol: { width: '100%' },
  contentColCentered: { maxWidth: 1280, alignSelf: 'center' },
  fillCol: { flex: 1, width: '100%' },
  navBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    height: 36,
  },
  back: { flexDirection: 'row', alignItems: 'center' },
  emptyTrash: { ...typography.body, color: colors.deadline, paddingRight: spacing.md },
  // Segmented list/date toggle shown in a project's nav bar.
  viewToggle: {
    flexDirection: 'row',
    backgroundColor: colors.separator,
    borderRadius: 8,
    padding: 2,
    gap: 2,
  },
  viewToggleBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: 6,
  },
  viewToggleBtnActive: { backgroundColor: colors.card || colors.background },
  displayBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separatorStrong,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  displayText: { ...typography.subhead, color: colors.textSecondary, fontWeight: '600' },
  displayDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
  // A notch smaller than largeTitle (34) so the title sits closer in scale to its
  // 26px list icon instead of towering over it.
  screenTitle: { ...typography.largeTitle, fontSize: 28, color: colors.text },
  section: { marginBottom: spacing.lg },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    paddingHorizontal: spacing.lg,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
    paddingBottom: spacing.xs,
  },
  sectionTitle: { ...typography.heading, color: colors.text },
  sectionSubtitle: { ...typography.subhead, color: colors.textTertiary, marginLeft: spacing.sm },
  emptyHeading: {
    ...typography.subhead,
    color: colors.textTertiary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    fontStyle: 'italic',
  },
  empty: { alignItems: 'center', justifyContent: 'center', paddingTop: 80, gap: spacing.md },
  emptyText: { ...typography.body, color: colors.textTertiary },
  sectionPage: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.lg,
  },
  sectionPageTitle: { ...typography.largeTitle, color: colors.text, marginBottom: spacing.md },
});

import React, { useMemo, useState, useLayoutEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  Platform,
  Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, typography, radius } from '../theme';
import { SMART_LIST_MAP, WHEN, STATUS } from '../store/constants';
import { useTasks, newTask } from '../store/TasksContext';
import {
  selectForList,
  selectProjectTasks,
  selectAreaTasks,
  selectSubtasks,
  isOpen,
  byOrder,
} from '../store/selectors';
import { relativeLabel, monthTitle, longLabel, todayKey, addDays, formatDayKey } from '../utils/date';
import TaskRow from '../components/TaskRow';
import TaskDetailModal from '../components/TaskDetailModal';
import FloatingAddButton from '../components/FloatingAddButton';
import ProjectHeader from '../components/ProjectHeader';
import ReorderableTaskList from '../components/ReorderableTaskList';
import BoardView from '../components/BoardView';
import CalendarView from '../components/CalendarView';
import GanttView from '../components/GanttView';
import DisplayMenu from '../components/DisplayMenu';
import VirtualTaskList from '../components/VirtualTaskList';
import SectionEditor from '../components/SectionEditor';
import { useIsWide } from '../navigation/responsive';

// Builds the grouped sections shown in a given context. Each section is
// { key, title, subtitle?, color?, data: task[] }.
function useSections(state, route) {
  const { listId, projectId, areaId } = route.params || {};
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
      const headings = state.headings
        .filter((h) => h.projectId === projectId)
        .sort(byOrder);
      const sections = [];

      const inHeading = (t, hid) => (hid ? t.headingId === hid : !t.headingId);
      // A heading's rows: open (by manual order), then its completed tasks below
      // them — a finished to-do stays under the heading it belonged to.
      const sectionData = (hid) => {
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
    if (areaId) {
      const direct = selectAreaTasks(state.tasks, areaId).filter((t) => isOpen(t) && !t.parentId);
      return [{ key: 'area', title: null, data: direct }];
    }

    const tasks = selectForList(state.tasks, listId);

    // ---- Today: split into Today + This Evening ----
    if (listId === 'today') {
      const evening = tasks.filter((t) => t.when === WHEN.EVENING);
      const day = tasks.filter((t) => t.when !== WHEN.EVENING);
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
  }, [state, route.params]);
}

// Group tasks by their When (scheduled date) field for the date views — the same
// grouped shape the heading list uses, only bucketed by date instead of heading.
// Grouping is by `when` only (never the deadline): Today/This Evening fold into
// today, concrete dates each get their own day (sorted ascending), and
// Someday/undated tasks collect in a "No Date" section at the bottom. Each bucket
// mirrors a heading: open to-dos first (by order), then completed below when the
// setting is on, and a done/total count for the header pie.
function groupByDate(tasks, showCompleted, dateFormat = 'weekday-long') {
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
      data: showCompleted ? [...open, ...done] : open,
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
function groupTasks(tasks, grouping, showCompleted, sorting, dateFormat) {
  if (grouping === 'date') return groupByDate(tasks, showCompleted, dateFormat);
  const open = tasks.filter(isOpen);
  const done = tasks.filter((t) => !isOpen(t));
  const src = showCompleted ? tasks : open;
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
  const insets = useSafeAreaInsets();
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
    return groupTasks(flat, grouping, state.settings?.showCompleted, sorting, dateFormat);
  }, [project0, grouping, state.tasks, hasFilter, taskFilter, sorting, state.settings?.showCompleted, dateFormat]);
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

  const totalTasks = sections.reduce((n, s) => n + s.data.length, 0);
  const isEmpty = totalTasks === 0;

  const handleAdd = () => {
    const defaults = {};
    if (listId === 'today') defaults.when = WHEN.TODAY;
    if (listId === 'someday') defaults.when = WHEN.SOMEDAY;
    if (projectId) {
      defaults.projectId = projectId;
      defaults.areaId = project?.areaId || null;
    }
    if (areaId) defaults.areaId = areaId;

    const task = newTask(defaults);
    addTask(task);
    setOpenTaskId(task.id);
  };

  const headerColor = smart?.color || project?.color || area?.color || colors.text;
  const headerTitle = title || smart?.title || project?.name || area?.name || 'List';

  // Drag-to-reorder is allowed in contexts whose selector sorts by `order`, so
  // a committed reorder persists across reloads: Inbox, Today, Anytime, Someday,
  // and Areas. (Upcoming/Logbook are date-ordered; Project is handled above.)
  // Today can split into Today + This Evening — each section reorders on its own.
  const REORDERABLE_LISTS = ['inbox', 'today', 'anytime', 'someday'];
  const listReorderable = Boolean(areaId) || REORDERABLE_LISTS.includes(listId);

  const contentPad = {
    paddingTop: insets.top + spacing.sm,
    paddingBottom: insets.bottom + 100,
  };

  // Project date view: the project's to-dos regrouped by their When date. Sourced
  // from all project tasks (not the heading sections) so the per-bucket done/total
  // is correct; completed rows show only when the setting is on, like the list.
  const projectDateSections =
    project && projectView === 'date'
      ? groupByDate(
          selectProjectTasks(state.tasks, project.id).filter(hasFilter ? taskFilter : () => true),
          state.settings?.showCompleted,
          dateFormat
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
      const collapsed = collapsedDates.has(s.key);
      items.push({
        key: `d:${s.key}`,
        kind: 'divider',
        dividerKey: s.key,
        title: s.title,
        subtitle: s.subtitle,
        collapsible: true,
        collapsed,
        total: s.total,
        done: s.doneCount,
        color,
      });
      if (!collapsed) {
        s.data.forEach((t) => items.push({ key: t.id, kind: 'task', task: t }));
      }
    });
    return items;
  };

  // Commit a date-view drag: each task adopts the `when` of the divider above it
  // ('no-date' clears it), then the visible order is persisted.
  const whenForDivider = (dividerKey) => (dividerKey === 'no-date' ? null : dividerKey);
  const commitDateLayout = (keys) => {
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
        onToggleDivider={toggleDate}
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
        onToggleDivider={toggleDate}
      />
    );
  };

  // Project view: flatten sections (main tasks + heading dividers + their tasks,
  // including each heading's own completed rows) into one drag surface.
  let projectItems = [];
  if (project) {
    sections.forEach((s) => {
      const hid = s.heading ? s.heading.id : null;
      const collapsed = s.heading && s.heading.collapsed;
      if (s.heading) {
        projectItems.push({
          key: `h:${s.heading.id}`,
          kind: 'heading',
          title: s.title,
          description: s.heading.description,
          headingId: s.heading.id,
          collapsed: !!collapsed,
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
        s.data.forEach((t) => emit(t, 0));
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
  const NEST_THRESHOLD = 18; // drag this far right to nest under the row above
  const commitProjectLayout = (keys, meta = {}) => {
    const { draggedKey, dx = 0 } = meta;
    let currentHeading = null;
    const tasks = [];
    const headings = [];
    const stack = []; // stack[d] = last task id seen at depth d
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
        // Dropped at the top of a section → top level. Dragged rightward onto the
        // row above → become its child. Otherwise keep its level (capped so it
        // can't skip past a valid parent).
        if (aboveDepth < 0) depth = 0;
        else if (dx > NEST_THRESHOLD) depth = aboveDepth + 1;
        else depth = Math.min(depth, aboveDepth + 1);
      }
      const parentId = depth > 0 ? stack[depth - 1] || null : null;
      tasks.push({ id: k, parentId, headingId: parentId ? null : currentHeading });
      stack[depth] = k;
      stack.length = depth + 1;
    });
    setProjectLayout({ tasks, headings });
  };

  // Today is one drag surface with a fixed "This Evening" divider so tasks can
  // be dragged across it. The Evening slot is always present (an empty-drop
  // placeholder when it has no tasks) so tasks can be moved into it.
  const EVENING_DIVIDER = 'evening-divider';
  let todayItems = null;
  if (listId === 'today') {
    const dayData = sections.find((s) => s.key === 'today')?.data || [];
    const eveningData = sections.find((s) => s.key === 'evening')?.data || [];
    todayItems = [
      ...dayData.map((t) => ({ key: t.id, kind: 'task', task: t })),
      { key: EVENING_DIVIDER, kind: 'divider', title: 'This Evening', icon: 'moon' },
      ...eveningData.map((t) => ({ key: t.id, kind: 'task', task: t })),
    ];
    if (eveningData.length === 0) {
      todayItems.push({ key: 'evening-empty', kind: 'emptyslot', label: 'No tasks yet' });
    }
  }

  // Commit a Today reorder: tasks below the divider become "This Evening"
  // (when = EVENING); tasks above revert to Today; then persist the order.
  const commitTodayLayout = (keys) => {
    const dividerIdx = keys.indexOf(EVENING_DIVIDER);
    const orderedIds = [];
    keys.forEach((k, i) => {
      if (k === EVENING_DIVIDER || k === 'evening-empty') return;
      orderedIds.push(k);
      const task = state.tasks.find((t) => t.id === k);
      if (!task) return;
      const isEvening = dividerIdx >= 0 && i > dividerIdx;
      if (isEvening && task.when !== WHEN.EVENING) updateTask(k, { when: WHEN.EVENING });
      else if (!isEvening && task.when === WHEN.EVENING) updateTask(k, { when: WHEN.TODAY });
    });
    reorderTasks(orderedIds);
  };

  // The chevron/sidebar-toggle bar sits above the content and is intentionally
  // NOT constrained by the "Center content" setting — it spans the full pane.
  const navBar = (
    <View style={styles.navBar}>
      {embedded ? (
        <Pressable hitSlop={10} onPress={onToggleSidebar} style={styles.back}>
          <Ionicons
            name={sidebarVisible ? 'chevron-back' : 'menu'}
            size={26}
            color={colors.accent}
          />
        </Pressable>
      ) : (
        <Pressable hitSlop={10} onPress={() => navigation.goBack()} style={styles.back}>
          <Ionicons name="chevron-back" size={26} color={colors.accent} />
        </Pressable>
      )}
      {listId === 'trash' && totalTasks > 0 && (
        <Pressable hitSlop={10} onPress={emptyTrash}>
          <Text style={styles.emptyTrash}>Empty</Text>
        </Pressable>
      )}
      {project && (
        <Pressable style={styles.displayBtn} onPress={() => setDisplayOpen(true)}>
          <Ionicons name="options-outline" size={16} color={colors.textSecondary} />
          <Text style={styles.displayText}>Display</Text>
          {hasFilter && <View style={styles.displayDot} />}
        </Pressable>
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
  ) : (
    <View style={styles.titleRow}>
      {smart && (
        <Ionicons name={smart.icon} size={26} color={headerColor} style={{ marginRight: 8 }} />
      )}
      {area && (
        <Ionicons name="cube-outline" size={24} color={headerColor} style={{ marginRight: 8 }} />
      )}
      <Text style={[styles.screenTitle, smart && { color: headerColor }]}>
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
      <View style={styles.container}>
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

  // Flat items for whichever non-full-pane list surface is active, so any of
  // them can fall back to a virtualized (windowed) list. Only rows near the
  // viewport stay in the DOM, so every list scales to any number of tasks.
  let surfaceItems = null;
  let surfaceShowProject = false;
  if (project) {
    if (projectView === 'list' && !groupedSections) surfaceItems = projectItems;
    else if (projectView === 'list' && groupedSections) surfaceItems = buildDateItems(groupedSections, project.color);
    else if (projectView === 'date') surfaceItems = buildDateItems(projectDateSections, project.color);
  } else if (listId === 'upcoming') {
    surfaceItems = buildDateItems(
      groupByDate(selectForList(state.tasks, 'upcoming'), state.settings?.showCompleted, dateFormat),
      null
    );
    surfaceShowProject = true;
  } else if (listId === 'today' && listReorderable) {
    surfaceItems = todayItems;
    surfaceShowProject = true;
  } else if (!isEmpty) {
    // Generic smart list / area: flatten its sections into divider + task rows.
    const flat = [];
    sections.forEach((s) => {
      if (s.title) {
        flat.push({
          key: `d:${s.key}`, kind: 'divider', title: s.title, subtitle: s.subtitle || null,
          collapsible: false, total: s.total || 0, done: s.doneCount || 0,
        });
      }
      (s.data || []).forEach((t) => flat.push({ key: t.id, kind: 'task', task: t }));
    });
    surfaceItems = flat;
    surfaceShowProject = true;
  }

  // Above ~120 rows, virtualize. Trades rich drag-reorder (impractical at that
  // scale) for a bounded DOM; smaller lists keep the full drag list below.
  if (surfaceItems && surfaceItems.length > 120) {
    return (
      <View style={styles.container}>
        {navBar}
        <VirtualTaskList
          items={surfaceItems}
          header={<View style={[styles.contentCol, centered && styles.contentColCentered]}>{titleHeader}</View>}
          inProject={!!project}
          showProject={surfaceShowProject}
          onOpenTask={setOpenTaskId}
          onToggleExpand={toggleTaskExpand}
          onToggleCollapse={toggleHeadingCollapsed}
          onToggleDivider={toggleDate}
          onAddTask={handleAddInSection}
        />
        {listId !== 'logbook' && listId !== 'trash' && !(project && isWide) && (
          <FloatingAddButton onPress={handleAdd} bottom={insets.bottom + 20} />
        )}
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
    <View style={styles.container}>
      <ScrollView contentContainerStyle={contentPad} keyboardShouldPersistTaps="handled">
        {navBar}
        <View style={[styles.contentCol, centered && styles.contentColCentered]}>
        {titleHeader}
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
              onToggleCollapse={toggleHeadingCollapsed}
              onAddTask={handleAddInSection}
              onAddSection={handleAddSectionAfter}
              onEditSection={setEditSectionId}
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
            onOpenTask={setOpenTaskId}
            onCommitKeys={commitTodayLayout}
          />
        ) : (
          sections.map((section) =>
            listReorderable && section.data.length > 0 ? (
              <ReorderableSection
                key={section.key}
                section={section}
                listId={listId}
                onOpenTask={setOpenTaskId}
                onCommitKeys={reorderTasks}
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
      </ScrollView>

      {listId !== 'logbook' && listId !== 'trash' && !(project && isWide) && (
        <FloatingAddButton onPress={handleAdd} bottom={insets.bottom + 20} />
      )}

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
function ReorderableSection({ section, listId, onOpenTask, onCommitKeys }) {
  const showProject = !!listId && listId !== 'logbook';
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
        items={section.data.map((t) => ({ key: t.id, kind: 'task', task: t }))}
        showProject={showProject}
        onOpenTask={onOpenTask}
        onCommitKeys={onCommitKeys}
      />
    </View>
  );
}

function Section({ section, listId, navigation, onOpenTask }) {
  // Show the project/area label on rows for every smart list (incl. Logbook),
  // matching the Anytime view.
  const showProject = !!listId;

  if (section.data.length === 0 && !section.heading) return null;

  return (
    <View style={styles.section}>
      {section.title ? (
        <View style={styles.sectionHeader}>
          {section.icon && (
            <Ionicons name={section.icon} size={14} color={colors.textTertiary} style={{ marginRight: 6 }} />
          )}
          <Text style={styles.sectionTitle}>{section.title}</Text>
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
  screenTitle: { ...typography.largeTitle, color: colors.text },
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

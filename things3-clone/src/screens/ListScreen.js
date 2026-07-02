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
import { colors, spacing, typography } from '../theme';
import { SMART_LIST_MAP, WHEN, STATUS } from '../store/constants';
import { useTasks, newTask } from '../store/TasksContext';
import {
  selectForList,
  selectProjectTasks,
  selectAreaTasks,
  isOpen,
  byOrder,
} from '../store/selectors';
import { relativeLabel, monthTitle, longLabel, todayKey } from '../utils/date';
import TaskRow from '../components/TaskRow';
import TaskDetailModal from '../components/TaskDetailModal';
import FloatingAddButton from '../components/FloatingAddButton';
import ProjectHeader from '../components/ProjectHeader';
import ReorderableTaskList from '../components/ReorderableTaskList';
import BoardView from '../components/BoardView';
import CalendarView from '../components/CalendarView';
import GanttView from '../components/GanttView';
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
function groupByDate(tasks, showCompleted) {
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
  const make = (key, b) => {
    const open = b.open.slice().sort(byOrder);
    const done = b.done.slice().sort(byOrder);
    return {
      key: key === null ? 'no-date' : key,
      title: key === null ? 'No Date' : relativeLabel(key),
      subtitle: key === null ? null : longLabel(key),
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
  } = useTasks();
  const [openTaskId, setOpenTaskId] = useState(null);
  const [editSectionId, setEditSectionId] = useState(null);
  // Projects can be viewed as the manual heading list, or grouped by date.
  const [projectView, setProjectView] = useState('list');
  // Collapsed date sections (by date key) for the date views (project + Upcoming).
  const [collapsedDates, setCollapsedDates] = useState(() => new Set());
  const toggleDate = (key) =>
    setCollapsedDates((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const sections = useSections(state, route);
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
          selectProjectTasks(state.tasks, project.id),
          state.settings?.showCompleted
        )
      : [];

  // Board view: one column per section. The "(No Section)" column is always
  // present (even when empty), then each heading in order. Cards are the section's
  // shown tasks (open + completed per the setting), same as the list/date views.
  const boardColumns =
    project && projectView === 'board'
      ? (() => {
          const main = sections.find((s) => !s.heading);
          const cols = [
            {
              key: 'main',
              title: '(No Section)',
              headingId: null,
              tasks: main ? main.data : [],
              count: main ? main.data.length : 0,
            },
          ];
          sections
            .filter((s) => s.heading)
            .forEach((s) =>
              cols.push({
                key: s.key,
                title: s.title,
                headingId: s.heading.id,
                tasks: s.data,
                count: s.data.length,
              })
            );
          return cols;
        })()
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
        s.data.forEach((t) => projectItems.push({ key: t.id, kind: 'task', task: t }));
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

  // Walk the dropped order; each task adopts the heading divider above it, and
  // the heading dividers themselves record their new order (block reorder).
  // The static "+ Add task" rows (add:*) are ignored.
  const commitProjectLayout = (keys) => {
    let currentHeading = null;
    const tasks = [];
    const headings = [];
    keys.forEach((k) => {
      if (k.startsWith('add:') || k.startsWith('sec:')) return;
      if (k.startsWith('h:')) {
        currentHeading = k.slice(2);
        headings.push(currentHeading);
      } else {
        tasks.push({ id: k, headingId: currentHeading });
      }
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
        <View style={styles.viewToggle}>
          {[
            { mode: 'list', icon: 'list' },
            { mode: 'board', icon: 'grid-outline' },
            { mode: 'calendar', icon: 'calendar-outline' },
            { mode: 'gantt', icon: 'stats-chart-outline' },
            { mode: 'date', icon: 'calendar-number-outline' },
          ].map(({ mode, icon }) => {
            const active = projectView === mode;
            return (
              <Pressable
                key={mode}
                hitSlop={6}
                onPress={() => setProjectView(mode)}
                style={[styles.viewToggleBtn, active && styles.viewToggleBtnActive]}
              >
                <Ionicons
                  name={icon}
                  size={17}
                  color={active ? colors.accent : colors.textTertiary}
                />
              </Pressable>
            );
          })}
        </View>
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

  // The Calendar view fills the pane and manages its own scrolling (the month
  // grid stretches; the day timeline scrolls internally), so it renders in a
  // flex column rather than inside the page's vertical ScrollView.
  const isCalendar = project && projectView === 'calendar';
  const calendarEl = (
    <CalendarView
      tasks={sections.flatMap((s) => s.data)}
      project={project}
      onOpenTask={setOpenTaskId}
      onUpdateTask={updateTask}
      onAddTask={(opts) => handleAddInSection(null, opts)}
      fillHeight
    />
  );

  if (isCalendar) {
    return (
      <View style={styles.container}>
        {navBar}
        {titleHeader}
        <View style={styles.fillCol}>{calendarEl}</View>
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
            // Board view: a Kanban column per section, cards reuse the task rows.
            <BoardView
              columns={boardColumns}
              onOpenTask={setOpenTaskId}
              onAddTask={handleAddInSection}
              onAddSection={handleAddSectionAfter}
              onEditSection={setEditSectionId}
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
          ) : (
            // One drag surface for the whole project: heading dividers are fixed,
            // tasks can be dragged within or across them. A per-section "+ Add
            // task" and an "Add section" trigger let you build it out inline.
            <ReorderableTaskList
              items={projectItems}
              showProject={false}
              inProject
              showSubtasks
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
            groupByDate(selectForList(state.tasks, 'upcoming'), state.settings?.showCompleted),
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

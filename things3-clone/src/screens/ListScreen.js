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
import { relativeLabel, monthTitle, longLabel } from '../utils/date';
import TaskRow from '../components/TaskRow';
import TaskDetailModal from '../components/TaskDetailModal';
import FloatingAddButton from '../components/FloatingAddButton';
import ProjectHeader from '../components/ProjectHeader';
import ReorderableTaskList from '../components/ReorderableTaskList';
import SectionEditor from '../components/SectionEditor';
import { useIsWide } from '../navigation/responsive';

// Builds the grouped sections shown in a given context. Each section is
// { key, title, subtitle?, color?, data: task[] }.
function useSections(state, route) {
  const { listId, projectId, areaId } = route.params || {};
  return useMemo(() => {
    // ---- Project view: group by heading ----
    if (projectId) {
      const tasks = selectProjectTasks(state.tasks, projectId);
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
      const direct = selectAreaTasks(state.tasks, areaId).filter(isOpen);
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

  // Stage 1 drag-to-reorder: only the contexts whose selector sorts by `order`
  // (Inbox, Anytime, Someday, an Area). Today/Upcoming are schedule-ordered and
  // Project is multi-section — those come in later stages. Restricting to these
  // ensures a committed reorder actually persists across reloads.
  const REORDERABLE_LISTS = ['inbox', 'anytime', 'someday'];
  const canReorder =
    sections.length === 1 &&
    sections[0].data.length > 1 &&
    (Boolean(areaId) || REORDERABLE_LISTS.includes(listId));

  const contentPad = {
    paddingTop: insets.top + spacing.sm,
    paddingBottom: insets.bottom + 100,
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

  // Header (nav bar + title) shared by both the scroll and reorderable paths.
  const header = (
    <>
      {/* Back/sidebar-toggle + (for Trash) the Empty action. In the two-pane
          layout the sidebar is always visible, so the chevron toggles it. */}
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
      </View>

      {project ? (
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
      )}
    </>
  );

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={contentPad} keyboardShouldPersistTaps="handled">
        <View style={[styles.contentCol, centered && styles.contentColCentered]}>
        {header}
        {project ? (
          // One drag surface for the whole project: heading dividers are fixed,
          // tasks can be dragged within or across them. A per-section "+ Add
          // task" and an "Add section" trigger let you build it out inline.
          <ReorderableTaskList
            items={projectItems}
            showProject={false}
            onOpenTask={setOpenTaskId}
            onCommitKeys={commitProjectLayout}
            onDeleteHeading={deleteHeading}
            onUpdateHeading={updateHeading}
            onToggleCollapse={toggleHeadingCollapsed}
            onAddTask={handleAddInSection}
            onAddSection={handleAddSectionAfter}
            onEditSection={setEditSectionId}
          />
        ) : isEmpty ? (
          <EmptyState listId={listId} />
        ) : canReorder ? (
          <ReorderableTaskList
            items={sections[0].data.map((t) => ({ key: t.id, kind: 'task', task: t }))}
            showProject={listId && listId !== 'logbook'}
            onOpenTask={setOpenTaskId}
            onCommitKeys={(keys) => reorderTasks(keys)}
          />
        ) : (
          sections.map((section) => (
            <Section
              key={section.key}
              section={section}
              listId={listId}
              navigation={navigation}
              onOpenTask={setOpenTaskId}
            />
          ))
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
  contentColCentered: { maxWidth: 640, alignSelf: 'center' },
  navBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    height: 36,
  },
  back: { flexDirection: 'row', alignItems: 'center' },
  emptyTrash: { ...typography.body, color: colors.deadline, paddingRight: spacing.md },
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

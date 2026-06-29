import React, { useMemo, useState, useLayoutEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
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
} from '../store/selectors';
import { relativeLabel, monthTitle, longLabel } from '../utils/date';
import TaskRow from '../components/TaskRow';
import TaskDetailModal from '../components/TaskDetailModal';
import FloatingAddButton from '../components/FloatingAddButton';
import ProjectHeader from '../components/ProjectHeader';

// Builds the grouped sections shown in a given context. Each section is
// { key, title, subtitle?, color?, data: task[] }.
function useSections(state, route) {
  const { listId, projectId, areaId } = route.params || {};
  return useMemo(() => {
    // ---- Project view: group by heading ----
    if (projectId) {
      const tasks = selectProjectTasks(state.tasks, projectId);
      const open = tasks.filter(isOpen);
      const completed = tasks.filter(
        (t) => t.status === STATUS.COMPLETED || t.status === STATUS.CANCELED
      );
      const headings = state.headings.filter((h) => h.projectId === projectId);
      const sections = [];

      const noHeading = open.filter((t) => !t.headingId);
      if (noHeading.length || headings.length === 0) {
        sections.push({ key: 'main', title: null, data: noHeading });
      }
      headings.forEach((h) => {
        sections.push({
          key: h.id,
          title: h.title,
          heading: h,
          data: open.filter((t) => t.headingId === h.id),
        });
      });
      if (completed.length) {
        sections.push({
          key: 'logged',
          title: `${completed.length} completed`,
          collapsedDefault: true,
          data: completed,
        });
      }
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

export default function ListScreen({ navigation, route }) {
  const insets = useSafeAreaInsets();
  const { listId, projectId, areaId, title } = route.params || {};
  const { state, addTask, emptyTrash } = useTasks();
  const [openTaskId, setOpenTaskId] = useState(null);

  const sections = useSections(state, route);
  const smart = listId ? SMART_LIST_MAP[listId] : null;
  const project = projectId ? state.projects.find((p) => p.id === projectId) : null;
  const area = areaId ? state.areas.find((a) => a.id === areaId) : null;

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

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + spacing.sm,
          paddingBottom: insets.bottom + 100,
        }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Back + title header */}
        <View style={styles.navBar}>
          <Pressable hitSlop={10} onPress={() => navigation.goBack()} style={styles.back}>
            <Ionicons name="chevron-back" size={26} color={colors.accent} />
          </Pressable>
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

        {isEmpty ? (
          <EmptyState listId={listId} />
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
      </ScrollView>

      {listId !== 'logbook' && listId !== 'trash' && (
        <FloatingAddButton onPress={handleAdd} bottom={insets.bottom + 20} />
      )}

      <TaskDetailModal
        visible={!!openTaskId}
        taskId={openTaskId}
        onClose={() => setOpenTaskId(null)}
      />
    </View>
  );
}

function Section({ section, listId, navigation, onOpenTask }) {
  const showProject = listId && listId !== 'logbook' ? true : false;

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
});

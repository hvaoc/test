import React, { useMemo, useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, typography, radius } from '../theme';
import { SMART_LISTS } from '../store/constants';
import { useTasks } from '../store/TasksContext';
import { counts, selectProjectTasks, isOpen } from '../store/selectors';
import { selectionKey } from '../navigation/responsive';
import NewListSheet from '../components/NewListSheet';
import SettingsSheet from '../components/SettingsSheet';
import ProgressPie from '../components/ProgressPie';
import DropTarget from '../components/DropTarget';
import { useDrag, SIDEBAR_ZONE_KEY } from '../store/DragContext';

// The Things sidebar / home: smart lists at the top, then your Areas and
// Projects. Tapping any entry drills into the matching list.
//
// `embedded` + `selectedKey` are passed by the two-pane SplitView (iPad / web /
// desktop): the sidebar stays mounted and highlights the active row instead of
// pushing a new screen. On phones both are undefined and it behaves as a stack.
export default function HomeScreen({ navigation, selectedKey, embedded }) {
  const insets = useSafeAreaInsets();
  const { state } = useTasks();
  const [sheet, setSheet] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Register the whole sidebar as a drag "zone" so a task drag can tell when
  // the pointer is anywhere over the sidebar (not just over a drop target).
  const drag = useDrag();
  const sidebarRef = useRef(null);
  useEffect(() => {
    if (!drag || !embedded) return undefined;
    drag.register(SIDEBAR_ZONE_KEY, sidebarRef, { kind: 'zone' });
    return () => drag.unregister(SIDEBAR_ZONE_KEY);
  }, [drag, embedded]);

  const badge = useMemo(() => counts(state.tasks), [state.tasks]);

  // Projects grouped under their area, plus any area-less projects.
  const looseProjects = state.projects.filter(
    (p) => !p.areaId && p.status === 'open'
  );

  const openProjectCount = (projectId) =>
    selectProjectTasks(state.tasks, projectId).filter(isOpen).length;

  const projectProgress = (projectId) => {
    const tasks = selectProjectTasks(state.tasks, projectId);
    if (tasks.length === 0) return 0;
    const done = tasks.filter((t) => !isOpen(t)).length;
    return done / tasks.length;
  };

  return (
    <View
      ref={sidebarRef}
      collapsable={false}
      style={[
        styles.container,
        // Two-tone master/detail: a light-gray sidebar against the white detail
        // pane. Only when always-visible (iPad / web / desktop); phones stay white.
        embedded && styles.containerEmbedded,
        { paddingTop: insets.top + spacing.sm },
      ]}
    >
      <View style={styles.headerRow}>
        <Text style={styles.appTitle}>Things</Text>
        <View style={styles.headerActions}>
          <Pressable hitSlop={10} onPress={() => setSettingsOpen(true)}>
            <Ionicons name="settings-outline" size={22} color={colors.textSecondary} />
          </Pressable>
          <Pressable hitSlop={10} onPress={() => setSheet(true)}>
            <Ionicons name="add" size={26} color={colors.accent} />
          </Pressable>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}>
        {/* Smart lists. Only Inbox and Today accept dropped tasks; the rest
            (Upcoming, Anytime, Someday, Logbook, Trash) are not drop targets. */}
        <View style={styles.section}>
          {SMART_LISTS.map((list) => {
            const row = (
              <SidebarRow
                icon={list.icon}
                color={list.color}
                title={list.title}
                badge={badge[list.id]}
                selected={selectedKey === `list:${list.id}`}
                onPress={() =>
                  navigation.navigate('List', { listId: list.id, title: list.title })
                }
              />
            );
            const droppable = list.id === 'inbox' || list.id === 'today';
            return droppable ? (
              <DropTarget
                key={list.id}
                targetKey={`list:${list.id}`}
                meta={{ kind: 'list', id: list.id }}
              >
                {row}
              </DropTarget>
            ) : (
              <React.Fragment key={list.id}>{row}</React.Fragment>
            );
          })}
        </View>

        {/* Areas with their projects */}
        {state.areas.map((area) => {
          const projects = state.projects.filter(
            (p) => p.areaId === area.id && p.status === 'open'
          );
          return (
            <View key={area.id} style={styles.section}>
              <Pressable
                style={[
                  styles.areaHeader,
                  selectedKey === `area:${area.id}` && styles.rowSelected,
                ]}
                onPress={() =>
                  navigation.navigate('List', {
                    areaId: area.id,
                    title: area.name,
                  })
                }
              >
                <Ionicons name="cube-outline" size={16} color={area.color} />
                <Text style={styles.areaTitle}>{area.name}</Text>
              </Pressable>
              {projects.map((p) => (
                <DropTarget
                  key={p.id}
                  targetKey={`project:${p.id}`}
                  meta={{ kind: 'project', id: p.id, areaId: p.areaId }}
                >
                  <ProjectRow
                    project={p}
                    count={openProjectCount(p.id)}
                    progress={projectProgress(p.id)}
                    selected={selectedKey === `project:${p.id}`}
                    onPress={() =>
                      navigation.navigate('List', {
                        projectId: p.id,
                        title: p.name,
                      })
                    }
                  />
                </DropTarget>
              ))}
            </View>
          );
        })}

        {/* Loose projects */}
        {looseProjects.length > 0 && (
          <View style={styles.section}>
            {looseProjects.map((p) => (
              <DropTarget
                key={p.id}
                targetKey={`project:${p.id}`}
                meta={{ kind: 'project', id: p.id, areaId: p.areaId }}
              >
                <ProjectRow
                  project={p}
                  count={openProjectCount(p.id)}
                  progress={projectProgress(p.id)}
                  selected={selectedKey === `project:${p.id}`}
                  onPress={() =>
                    navigation.navigate('List', { projectId: p.id, title: p.name })
                  }
                />
              </DropTarget>
            ))}
          </View>
        )}
      </ScrollView>

      <NewListSheet visible={sheet} onClose={() => setSheet(false)} navigation={navigation} />
      <SettingsSheet visible={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </View>
  );
}

function SidebarRow({ icon, color, title, badge, onPress, selected }) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.row,
        selected && styles.rowSelected,
        pressed && !selected && styles.rowPressed,
      ]}
      onPress={onPress}
    >
      <View style={[styles.iconWrap, { backgroundColor: color }]}>
        <Ionicons name={icon} size={15} color={colors.white} />
      </View>
      <Text style={styles.rowTitle}>{title}</Text>
      {badge > 0 && <Text style={styles.badge}>{badge}</Text>}
    </Pressable>
  );
}

function ProjectRow({ project, count, progress, onPress, selected }) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.row,
        selected && styles.rowSelected,
        pressed && !selected && styles.rowPressed,
      ]}
      onPress={onPress}
    >
      <ProgressPie progress={progress} color={project.color} size={16} />
      <Text style={styles.rowTitle} numberOfLines={1}>
        {project.name}
      </Text>
      {count > 0 && <Text style={styles.badgeMuted}>{count}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  containerEmbedded: { backgroundColor: colors.groupedBackground },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  appTitle: { ...typography.largeTitle, color: colors.text },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  section: {
    marginBottom: spacing.lg,
    paddingHorizontal: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 9,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    gap: spacing.md,
  },
  rowPressed: { backgroundColor: colors.separator },
  rowSelected: { backgroundColor: colors.accentSoft },
  iconWrap: {
    width: 26,
    height: 26,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTitle: { flex: 1, ...typography.body, color: colors.text },
  badge: {
    ...typography.subhead,
    color: colors.textSecondary,
    fontVariant: ['tabular-nums'],
  },
  badgeMuted: { ...typography.subhead, color: colors.textTertiary },
  areaHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  areaTitle: {
    ...typography.subhead,
    fontWeight: '700',
    color: colors.textSecondary,
    textTransform: 'none',
  },
});

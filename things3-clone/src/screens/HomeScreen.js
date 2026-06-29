import React, { useMemo, useState } from 'react';
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
import NewListSheet from '../components/NewListSheet';

// The Things sidebar / home: smart lists at the top, then your Areas and
// Projects. Tapping any entry drills into the matching list.
export default function HomeScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { state } = useTasks();
  const [sheet, setSheet] = useState(false);

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
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.headerRow}>
        <Text style={styles.appTitle}>Things</Text>
        <Pressable hitSlop={10} onPress={() => setSheet(true)}>
          <Ionicons name="add" size={26} color={colors.accent} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}>
        {/* Smart lists */}
        <View style={styles.section}>
          {SMART_LISTS.map((list) => (
            <SidebarRow
              key={list.id}
              icon={list.icon}
              color={list.color}
              title={list.title}
              badge={badge[list.id]}
              onPress={() =>
                navigation.navigate('List', { listId: list.id, title: list.title })
              }
            />
          ))}
        </View>

        {/* Areas with their projects */}
        {state.areas.map((area) => {
          const projects = state.projects.filter(
            (p) => p.areaId === area.id && p.status === 'open'
          );
          return (
            <View key={area.id} style={styles.section}>
              <Pressable
                style={styles.areaHeader}
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
                <ProjectRow
                  key={p.id}
                  project={p}
                  count={openProjectCount(p.id)}
                  progress={projectProgress(p.id)}
                  onPress={() =>
                    navigation.navigate('List', {
                      projectId: p.id,
                      title: p.name,
                    })
                  }
                />
              ))}
            </View>
          );
        })}

        {/* Loose projects */}
        {looseProjects.length > 0 && (
          <View style={styles.section}>
            {looseProjects.map((p) => (
              <ProjectRow
                key={p.id}
                project={p}
                count={openProjectCount(p.id)}
                progress={projectProgress(p.id)}
                onPress={() =>
                  navigation.navigate('List', { projectId: p.id, title: p.name })
                }
              />
            ))}
          </View>
        )}
      </ScrollView>

      <NewListSheet visible={sheet} onClose={() => setSheet(false)} navigation={navigation} />
    </View>
  );
}

function SidebarRow({ icon, color, title, badge, onPress }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
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

function ProjectRow({ project, count, progress, onPress }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={onPress}
    >
      <ProgressRing progress={progress} color={project.color} />
      <Text style={styles.rowTitle} numberOfLines={1}>
        {project.name}
      </Text>
      {count > 0 && <Text style={styles.badgeMuted}>{count}</Text>}
    </Pressable>
  );
}

// A tiny pie-style progress indicator like Things uses next to projects.
function ProgressRing({ progress, color }) {
  return (
    <View style={[styles.ring, { borderColor: color }]}>
      <View
        style={[
          styles.ringFill,
          {
            backgroundColor: color,
            width: 12 * Math.max(progress, 0),
            opacity: progress > 0 ? 1 : 0,
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  appTitle: { ...typography.largeTitle, color: colors.text },
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
  rowPressed: { backgroundColor: colors.groupedBackground },
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
  ring: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  ringFill: { height: 12, borderRadius: 6 },
});

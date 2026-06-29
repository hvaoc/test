import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Checkbox from './Checkbox';
import { colors, spacing, typography } from '../theme';
import { STATUS } from '../store/constants';
import { relativeLabel, isPast, isToday } from '../utils/date';
import { useTasks } from '../store/TasksContext';

// A single to-do row. Shows the checkbox, title, and a set of metadata badges
// (project dot, notes glyph, checklist progress, tags, deadline).
export default function TaskRow({ task, onPress, showProject = false }) {
  const { state, toggleTask } = useTasks();
  const done = task.status !== STATUS.OPEN;

  const project = task.projectId
    ? state.projects.find((p) => p.id === task.projectId)
    : null;
  const area =
    !project && task.areaId
      ? state.areas.find((a) => a.id === task.areaId)
      : null;

  const checkTotal = task.checklist?.length || 0;
  const checkDone = task.checklist?.filter((c) => c.done).length || 0;

  const deadlineOverdue =
    task.deadline && (isPast(task.deadline) || isToday(task.deadline));

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Checkbox
        status={task.status}
        color={project?.color}
        onPress={() => toggleTask(task.id)}
      />

      <View style={styles.body}>
        <Text
          numberOfLines={1}
          style={[styles.title, done && styles.titleDone]}
        >
          {task.title || 'New To-Do'}
        </Text>

        {(showProject && (project || area)) ||
        task.notes ||
        checkTotal > 0 ||
        task.tags?.length > 0 ||
        task.deadline ? (
          <View style={styles.meta}>
            {showProject && project && (
              <View style={styles.metaItem}>
                <View style={[styles.dot, { backgroundColor: project.color }]} />
                <Text style={styles.metaText} numberOfLines={1}>
                  {project.name}
                </Text>
              </View>
            )}
            {showProject && area && (
              <View style={styles.metaItem}>
                <Ionicons name="cube-outline" size={12} color={colors.textTertiary} />
                <Text style={styles.metaText} numberOfLines={1}>
                  {area.name}
                </Text>
              </View>
            )}
            {!!task.notes && (
              <Ionicons name="reorder-four-outline" size={14} color={colors.textTertiary} />
            )}
            {checkTotal > 0 && (
              <View style={styles.metaItem}>
                <Ionicons name="list-outline" size={13} color={colors.textTertiary} />
                <Text style={styles.metaText}>
                  {checkDone}/{checkTotal}
                </Text>
              </View>
            )}
            {task.tags?.map((tag) => (
              <View key={tag} style={styles.tagChip}>
                <Text style={styles.tagText}>{tag}</Text>
              </View>
            ))}
            {!!task.deadline && (
              <View style={styles.metaItem}>
                <Ionicons
                  name="flag"
                  size={12}
                  color={deadlineOverdue ? colors.deadline : colors.textTertiary}
                />
                <Text
                  style={[
                    styles.metaText,
                    deadlineOverdue && { color: colors.deadline },
                  ]}
                >
                  {relativeLabel(task.deadline)}
                </Text>
              </View>
            )}
          </View>
        ) : null}
      </View>

      {task.when === 'evening' && (
        <Ionicons name="moon" size={14} color={colors.textTertiary} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 10,
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
    backgroundColor: colors.background,
  },
  pressed: { backgroundColor: colors.groupedBackground },
  body: { flex: 1, paddingTop: 1 },
  title: { ...typography.body, color: colors.text },
  titleDone: { color: colors.textTertiary, textDecorationLine: 'line-through' },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    marginTop: 3,
    gap: spacing.sm,
  },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  metaText: { ...typography.caption, color: colors.textTertiary },
  dot: { width: 8, height: 8, borderRadius: 4 },
  tagChip: {
    backgroundColor: colors.groupedBackground,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  tagText: { ...typography.caption, color: colors.textSecondary },
});

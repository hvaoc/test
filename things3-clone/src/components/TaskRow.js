import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Checkbox from './Checkbox';
import { colors, spacing, typography } from '../theme';
import { STATUS, PRIORITY_MAP } from '../store/constants';
import { relativeLabel, isPast, isToday } from '../utils/date';
import { useTasks } from '../store/TasksContext';
import { selectSubtasks } from '../store/selectors';
import EphemeralBadge from './EphemeralBadge';

const CHEVRON_W = 20;
const INDENT = 26;

// A single to-do row. Shows the checkbox, title, and metadata badges (project
// dot, notes glyph, checklist progress, subtask progress, tags, deadline).
// When `showSubtasks` is set (the list view), a task with child tasks gets a
// disclosure chevron and renders its subtasks nested underneath — recursively,
// so nesting is unlimited. Checklist items are separate and unaffected.
export default function TaskRow({
  task,
  onPress,
  onOpenTask,
  showProject = false,
  inProject = false,
  showSubtasks = false,
  depth = 0,
  hasChildren = false,
  expanded = false,
  onToggleExpand,
}) {
  const { state, toggleTask, recentAdds } = useTasks();
  const done = task.status !== STATUS.OPEN;
  // Ephemeral, non-persisted "just added" mark for this task (fades on its own).
  const added = recentAdds && recentAdds[task.id];

  const project = task.projectId
    ? state.projects.find((p) => p.id === task.projectId)
    : null;
  const area =
    !project && task.areaId
      ? state.areas.find((a) => a.id === task.areaId)
      : null;

  const checkTotal = task.checklist?.length || 0;
  const checkDone = task.checklist?.filter((c) => c.done).length || 0;

  const subtasks = selectSubtasks(state.tasks, task.id);
  const subTotal = subtasks.length;
  const subDone = subtasks.filter((s) => s.status !== STATUS.OPEN).length;

  const deadlineOverdue =
    task.deadline && (isPast(task.deadline) || isToday(task.deadline));

  const priorityBorder =
    inProject && task.priority ? PRIORITY_MAP[task.priority]?.color : undefined;

  const hasMeta =
    (showProject && (project || area)) ||
    task.notes ||
    checkTotal > 0 ||
    subTotal > 0 ||
    task.tags?.length > 0 ||
    task.deadline;

  return (
    <View style={showSubtasks && depth > 0 ? { marginLeft: depth * INDENT } : null}>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      >
        {showSubtasks &&
          (subTotal > 0 ? (
            <Pressable
              hitSlop={6}
              onPress={() => onToggleExpand && onToggleExpand(task.id)}
              style={styles.chevron}
            >
              <Ionicons
                name={expanded ? 'chevron-down' : 'chevron-forward'}
                size={16}
                color={colors.textSecondary}
              />
            </Pressable>
          ) : (
            <View style={styles.chevron} />
          ))}

        <Checkbox
          status={task.status}
          color={project?.color}
          borderColor={priorityBorder}
          onPress={() => toggleTask(task.id)}
        />

        <View style={styles.body}>
          <Text numberOfLines={1} style={[styles.title, done && styles.titleDone]}>
            {task.title || 'New To-Do'}
          </Text>

          {hasMeta ? (
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
              {subTotal > 0 && (
                <View style={styles.metaItem}>
                  <Ionicons name="git-branch-outline" size={13} color={colors.textTertiary} />
                  <Text style={styles.metaText}>
                    {subDone}/{subTotal}
                  </Text>
                </View>
              )}
              {checkTotal > 0 && (
                <View style={styles.metaItem}>
                  <Ionicons name="list-outline" size={13} color={colors.textTertiary} />
                  <Text style={styles.metaText}>
                    {checkDone}/{checkTotal}
                  </Text>
                </View>
              )}
              {!!task.deadline && (
                <View style={styles.metaItem}>
                  <Ionicons
                    name="flag"
                    size={12}
                    color={deadlineOverdue ? colors.deadline : colors.textTertiary}
                  />
                  <Text
                    style={[styles.metaText, deadlineOverdue && { color: colors.deadline }]}
                  >
                    {relativeLabel(task.deadline)}
                  </Text>
                </View>
              )}
              {/* Labels last — they vary in count, so keeping them at the end
                  leaves the fixed metadata above aligned across rows. */}
              {task.tags?.map((tag) => (
                <View key={tag} style={styles.tagChip}>
                  <Text style={styles.tagText}>{tag}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>

        {added && (
          <View style={styles.addedSlot}>
            <EphemeralBadge
              key={added.ts}
              label={`added by ${added.user || 'someone'}`}
              color={added.color}
            />
          </View>
        )}

        {task.when === 'evening' && (
          <Ionicons name="moon" size={14} color={colors.textTertiary} />
        )}
      </Pressable>
    </View>
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
  pressed: { backgroundColor: colors.surfaceMuted },
  // Disclosure gutter to the left of the checkbox; a bare View keeps checkboxes
  // aligned on rows without subtasks.
  chevron: { width: CHEVRON_W, paddingTop: 2, marginRight: -spacing.sm, alignItems: 'center' },
  // Nested subtasks step in one indent per level (compounds through recursion).
  children: { marginLeft: INDENT },
  body: { flex: 1, paddingTop: 1 },
  addedSlot: { alignSelf: 'center', paddingLeft: spacing.sm },
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
    backgroundColor: colors.surfaceMuted,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  tagText: { ...typography.caption, color: colors.textSecondary },
});

import React from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Checkbox from './Checkbox';
import { colors, spacing, typography } from '../theme';

// Roomier, easier-to-hit task rows on the phone only; desktop/web stay compact
// (both report Platform 'web').
const IS_MOBILE = Platform.OS !== 'web';
import { STATUS, PRIORITY_MAP } from '../store/constants';
import { relativeLabel, isPast, isToday } from '../utils/date';
import { useTasks } from '../store/TasksContext';
import { selectSubtasks } from '../store/selectors';
import EphemeralBadge from './EphemeralBadge';

const CHEVRON_W = 20;
const INDENT = 26;
const CHECKBOX_SIZE = 22;
// Where a mobile task's title starts: row padding + checkbox column + gap. The
// divider begins here — aligned to the title, Todoist-style — and steps in one
// INDENT per nesting level, while bleeding to the right edge.
const DIVIDER_INSET = spacing.lg + CHECKBOX_SIZE + spacing.md;

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
    <View>
      <Pressable
        testID={`task-row-${task.id}`}
        onPress={onPress}
        style={({ pressed }) => [
          styles.row,
          // Indent the CONTENT for nesting (the divider is drawn separately so it
          // can align to the title and reach the right edge).
          showSubtasks && depth > 0 && { paddingLeft: spacing.lg + depth * INDENT },
          pressed && styles.pressed,
        ]}
      >
        {/* Web/desktop keep the Things-style disclosure triangle on the left. */}
        {!IS_MOBILE && showSubtasks &&
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
          testID={`task-checkbox-${task.id}`}
          status={task.status}
          color={project?.color}
          borderColor={priorityBorder}
          onPress={() => toggleTask(task.id)}
          // Generous, symmetric hit target — the chevron now lives on the far
          // right, so there's no neighbor to collide with on the phone.
          hitSlop={IS_MOBILE ? 12 : 10}
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
                    name="hourglass-outline"
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

        {/* On the phone the disclosure chevron sits at the right edge, Todoist-
            style, at the opposite end from the checkbox so the two can never be
            confused for one another. */}
        {IS_MOBILE && showSubtasks && subTotal > 0 && (
          <Pressable
            testID={`task-expand-${task.id}`}
            hitSlop={{ top: 14, bottom: 14, left: 12, right: 12 }}
            onPress={() => onToggleExpand && onToggleExpand(task.id)}
            style={styles.chevronRight}
          >
            <Ionicons
              name={expanded ? 'chevron-down' : 'chevron-forward'}
              size={18}
              color={colors.textSecondary}
            />
          </Pressable>
        )}
      </Pressable>

      {/* Mobile: a title-aligned divider that bleeds to the right edge, matching
          Todoist. A real flow element (not absolute) so it's part of the row's
          measured height — the next row can't paint over it — and steps in one
          INDENT per nesting level. */}
      {IS_MOBILE && (
        <View
          pointerEvents="none"
          style={[styles.divider, { marginLeft: DIVIDER_INSET + (showSubtasks && depth > 0 ? depth * INDENT : 0) }]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: IS_MOBILE ? 15 : 10,
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
    backgroundColor: colors.background,
    // Web/desktop: a simple full-width divider on the row itself. On mobile the
    // divider is drawn separately (styles.divider) so it aligns to the task title
    // and bleeds to the right edge, Todoist-style.
    borderBottomWidth: IS_MOBILE ? 0 : StyleSheet.hairlineWidth,
    borderBottomColor: colors.separatorStrong,
  },
  // Mobile task divider: a flow line under the row (title-aligned via marginLeft,
  // set inline per depth) that stretches to the right edge. Being in-flow, it's
  // included in the row height so the next row never covers it.
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.separatorStrong,
  },
  pressed: { backgroundColor: colors.surfaceMuted },
  // Disclosure gutter to the left of the checkbox; a bare View keeps checkboxes
  // aligned on rows without subtasks.
  // Left disclosure gutter — web/desktop only now (phone uses chevronRight).
  chevron: { width: CHEVRON_W, paddingTop: 2, marginRight: -spacing.sm, alignItems: 'center' },
  // Phone disclosure chevron, pinned to the right edge opposite the checkbox.
  chevronRight: { paddingTop: 2, paddingLeft: spacing.sm, alignSelf: 'flex-start' },
  // Nested subtasks step in one indent per level (compounds through recursion).
  children: { marginLeft: INDENT },
  body: { flex: 1, paddingTop: 1 },
  addedSlot: { alignSelf: 'center', paddingLeft: spacing.sm },
  title: { ...typography.body, ...(IS_MOBILE ? { fontSize: 17 } : null), color: colors.text },
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

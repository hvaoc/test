import React, { useCallback, useMemo } from 'react';
import { FlatList, View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, typography } from '../theme';
import { chevronRotate } from '../utils/sections';
import TaskRow from './TaskRow';
import ProgressPie from './ProgressPie';

// A virtualized (windowed) task list built on RN's FlatList, so only the rows
// near the viewport are in the DOM. Used for large lists where the rich
// drag-reorder list would render thousands of rows at once. It consumes the
// same item shape ({ key, kind: 'heading'|'divider'|'task'|'addtask'|
// 'addsection', ... }) the drag list uses, minus the reordering.
export default function VirtualTaskList({
  items,
  header,
  showProject = false,
  inProject = false,
  onOpenTask,
  onToggleExpand,
  onToggleCollapse, // (headingId)
  onToggleDivider, // (dividerKey)
  onToggleMore, // (sectionKey, 'more'|'less')
  onAddTask, // (headingId)
}) {
  // The page title rides as the first (non-sticky) row instead of
  // ListHeaderComponent, so the section headers (headings + titled dividers) can
  // be sticky by plain data index — the same technique the calendar views use.
  const { data, stickyIndices } = useMemo(() => {
    const rows = header ? [{ kind: '__title', key: '__title__' }] : [];
    const sticky = [];
    items.forEach((it) => {
      if (it.kind === 'heading' || (it.kind === 'divider' && it.title)) sticky.push(rows.length);
      rows.push(it);
    });
    return { data: rows, stickyIndices: sticky };
  }, [items, header]);

  const renderItem = useCallback(
    ({ item }) => {
      if (item.kind === '__title') return header || null;
      if (item.kind === 'task') {
        return (
          <TaskRow
            task={item.task}
            onPress={() => onOpenTask(item.task.id)}
            onOpenTask={onOpenTask}
            showProject={showProject}
            inProject={inProject}
            showSubtasks
            depth={item.depth || 0}
            hasChildren={item.hasChildren}
            expanded={item.expanded}
            onToggleExpand={onToggleExpand}
          />
        );
      }
      if (item.kind === 'heading') {
        return (
          <Pressable
            style={styles.heading}
            onPress={() => onToggleCollapse && onToggleCollapse(item.headingId)}
          >
            <Ionicons
              name="chevron-forward"
              size={16}
              color={colors.textSecondary}
              style={{ transform: [{ rotate: chevronRotate(item.chevron ?? (item.collapsed ? 'collapsed' : 'full')) }] }}
            />
            <Text style={styles.headingText} numberOfLines={1}>{item.title || 'Section'}</Text>
            {item.total > 0 && (
              <View style={styles.count}>
                <Text style={styles.countText}>{item.done}/{item.total}</Text>
                <ProgressPie progress={item.total ? item.done / item.total : 0} color={item.color} size={14} />
              </View>
            )}
          </Pressable>
        );
      }
      if (item.kind === 'divider') {
        return (
          <Pressable
            style={styles.divider}
            onPress={() => item.collapsible && onToggleDivider && onToggleDivider(item.dividerKey)}
          >
            {item.collapsible && (
              <Ionicons
                name="chevron-forward"
                size={16}
                color={colors.textSecondary}
                style={{ transform: [{ rotate: chevronRotate(item.chevron ?? (item.collapsed ? 'collapsed' : 'full')) }] }}
              />
            )}
            {item.icon && (
              <Ionicons
                name={item.icon}
                size={item.iconColor ? 16 : 14}
                color={item.iconColor || colors.textTertiary}
                style={{ marginRight: 6 }}
              />
            )}
            <Text style={[styles.dividerText, item.iconColor && { color: item.iconColor }]} numberOfLines={1}>{item.title}</Text>
            {item.subtitle ? <Text style={styles.dividerSub} numberOfLines={1}>{item.subtitle}</Text> : null}
            {item.total > 0 && (
              <View style={styles.count}>
                <Text style={styles.countText}>{item.done}/{item.total}</Text>
                <ProgressPie progress={item.total ? item.done / item.total : 0} color={item.color} size={14} />
              </View>
            )}
          </Pressable>
        );
      }
      if (item.kind === 'addtask') {
        return (
          <Pressable style={styles.add} onPress={() => onAddTask && onAddTask(item.headingId ?? null)}>
            <Ionicons name="add" size={18} color={colors.textTertiary} />
            <Text style={styles.addText}>Add task</Text>
          </Pressable>
        );
      }
      if (item.kind === 'more') {
        const tint = item.color || colors.accent;
        return (
          <Pressable style={styles.more} onPress={() => onToggleMore && onToggleMore(item.sectionKey, item.action)}>
            {inProject && <View style={styles.moreDisclosure} />}
            <View style={styles.moreCheckCol}>
              <Ionicons name={item.action === 'more' ? 'chevron-down' : 'chevron-up'} size={15} color={tint} />
            </View>
            <Text style={[styles.moreText, { color: tint }]}>
              {item.action === 'more' ? `Show ${item.hidden} more` : 'Show less'}
            </Text>
          </Pressable>
        );
      }
      return null; // addsection etc. omitted in the virtualized list
    },
    [header, onOpenTask, showProject, inProject, onToggleExpand, onToggleCollapse, onToggleDivider, onToggleMore, onAddTask]
  );

  return (
    <FlatList
      style={styles.list}
      data={data}
      keyExtractor={(item) => item.key}
      renderItem={renderItem}
      stickyHeaderIndices={stickyIndices}
      keyboardShouldPersistTaps="handled"
      // Windowing: keep the DOM small regardless of list length.
      initialNumToRender={24}
      maxToRenderPerBatch={24}
      windowSize={11}
      removeClippedSubviews={Platform.OS !== 'web'}
      contentContainerStyle={styles.content}
    />
  );
}

const styles = StyleSheet.create({
  list: { flex: 1 },
  content: { paddingBottom: 120 },
  heading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
    // Opaque so rows scroll *under* the pinned (sticky) header.
    backgroundColor: colors.background,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  headingText: { flex: 1, ...typography.heading, color: colors.text },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
    // Opaque so rows scroll *under* the pinned (sticky) divider.
    backgroundColor: colors.background,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  dividerText: { ...typography.heading, color: colors.text },
  dividerSub: { flex: 1, ...typography.subhead, color: colors.textTertiary },
  count: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  countText: { ...typography.caption, color: colors.textTertiary, fontVariant: ['tabular-nums'] },
  add: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  addText: { ...typography.body, color: colors.textTertiary },
  more: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  moreDisclosure: { width: 20, marginRight: -spacing.sm },
  moreCheckCol: { width: 22, alignItems: 'center' },
  moreText: { ...typography.subhead, fontWeight: '600' },
});

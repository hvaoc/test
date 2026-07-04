import React, { useCallback, useMemo } from 'react';
import { FlatList, View, Text, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, typography } from '../theme';
import TaskRow from './TaskRow';

// A virtualized list of titled sections whose header STAYS PINNED to the top
// while you scroll through that section's tasks, then is pushed up by the next
// section's header (iOS-style sticky headers) — so you always know which group
// the rows on screen belong to. Used for the plain, non-drag multi-section
// lists: an Area's Today / Upcoming / Overdue roll-up and the Logbook's
// by-month groups (also Overdue / Trash).
//
// It uses the same technique as the calendar views (DayPlanner/WeekView/
// MonthCalendar): a single FlatList over a flattened [title, header, ...tasks,
// header, ...tasks] array with `stickyHeaderIndices` on the header rows. That
// works identically on web and native (unlike CSS `position: sticky`, which
// react-native-web only honours outside a virtualized cell) and stays windowed,
// so even a thousands-row Logbook is cheap. The page title rides as the first
// (non-sticky) row instead of ListHeaderComponent, so the sticky indices are
// plain data indices with no header-offset ambiguity.
export default function StickyTaskSections({
  sections,
  header,
  showProject = false,
  onOpenTask,
  contentPadding,
}) {
  const { data, stickyIndices } = useMemo(() => {
    const rows = [];
    const sticky = [];
    if (header) rows.push({ type: 'title', key: '__title__' });
    sections.forEach((section) => {
      if (section.title) {
        sticky.push(rows.length);
        rows.push({ type: 'header', key: `h:${section.key}`, section });
      }
      const sp = section.showProject ?? showProject;
      section.data.forEach((task) => rows.push({ type: 'task', key: task.id, task, showProject: sp }));
    });
    return { data: rows, stickyIndices: sticky };
  }, [sections, showProject, header]);

  const renderItem = useCallback(
    ({ item }) => {
      if (item.type === 'title') return header || null;
      if (item.type === 'header') {
        const s = item.section;
        return (
          <View style={styles.header}>
            {s.icon && (
              <Ionicons
                name={s.icon}
                size={s.iconColor ? 16 : 14}
                color={s.iconColor || colors.textTertiary}
                style={{ marginRight: 6 }}
              />
            )}
            <Text
              style={[styles.title, s.iconColor && { color: s.iconColor }]}
              numberOfLines={1}
            >
              {s.title}
            </Text>
            {s.subtitle ? (
              <Text style={styles.subtitle} numberOfLines={1}>
                {s.subtitle}
              </Text>
            ) : null}
          </View>
        );
      }
      return (
        <TaskRow
          task={item.task}
          showProject={item.showProject}
          onPress={() => onOpenTask(item.task.id)}
        />
      );
    },
    [header, onOpenTask]
  );

  return (
    <FlatList
      style={styles.list}
      data={data}
      keyExtractor={(it) => it.key}
      renderItem={renderItem}
      stickyHeaderIndices={stickyIndices}
      keyboardShouldPersistTaps="handled"
      // Windowing keeps the DOM small so a long Logbook stays smooth.
      initialNumToRender={24}
      maxToRenderPerBatch={24}
      windowSize={11}
      removeClippedSubviews={Platform.OS !== 'web'}
      contentContainerStyle={contentPadding}
    />
  );
}

const styles = StyleSheet.create({
  list: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'baseline',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
    // Opaque so tasks scroll *under* the pinned header, not through it.
    backgroundColor: colors.background,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  title: { ...typography.heading, color: colors.text },
  subtitle: { ...typography.subhead, color: colors.textTertiary, marginLeft: spacing.sm },
});

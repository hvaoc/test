import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, typography, radius } from '../theme';
import { WHEN, STATUS } from '../store/constants';
import { todayKey, keyToDate, MONTHS, WEEKDAYS_SHORT } from '../utils/date';

// The calendar day a task belongs on — its When date. Today/This Evening fold
// into today; Someday/undated tasks aren't placed on the grid.
function taskDateKey(t) {
  if (t.when === WHEN.TODAY || t.when === WHEN.EVENING) return todayKey();
  if (!t.when || t.when === WHEN.SOMEDAY) return null;
  return t.when;
}

function dateKeyOf(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const MAX_CHIPS = 4;

// Month grid for a project: each day cell lists the tasks scheduled that day
// (by their When date). Prev/next/Today navigate the months; tapping a chip
// opens the task. Undated tasks are surfaced in a footer count.
export default function CalendarView({ tasks, project, onOpenTask }) {
  const today = keyToDate(todayKey());
  const [cursor, setCursor] = useState({ y: today.getFullYear(), m: today.getMonth() });

  const byDate = {};
  let undated = 0;
  tasks.forEach((t) => {
    const k = taskDateKey(t);
    if (k) (byDate[k] = byDate[k] || []).push(t);
    else undated += 1;
  });

  // 6-week grid starting on the Sunday on/before the 1st of the month.
  const first = new Date(cursor.y, cursor.m, 1);
  const gridStart = new Date(cursor.y, cursor.m, 1 - first.getDay());
  const weeks = [];
  for (let w = 0; w < 6; w++) {
    const days = [];
    for (let d = 0; d < 7; d++) {
      days.push(new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + w * 7 + d));
    }
    weeks.push(days);
  }

  const prev = () => setCursor(({ y, m }) => (m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 }));
  const next = () => setCursor(({ y, m }) => (m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 }));
  const goToday = () => setCursor({ y: today.getFullYear(), m: today.getMonth() });

  const todayK = todayKey();

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Text style={styles.monthTitle}>
          {MONTHS[cursor.m]} {cursor.y}
        </Text>
        <View style={styles.nav}>
          <Pressable onPress={goToday} style={styles.todayBtn}>
            <Text style={styles.todayText}>Today</Text>
          </Pressable>
          <Pressable onPress={prev} hitSlop={8} style={styles.navBtn}>
            <Ionicons name="chevron-back" size={20} color={colors.textSecondary} />
          </Pressable>
          <Pressable onPress={next} hitSlop={8} style={styles.navBtn}>
            <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
          </Pressable>
        </View>
      </View>

      <View style={styles.weekdays}>
        {WEEKDAYS_SHORT.map((d) => (
          <Text key={d} style={styles.weekday}>
            {d}
          </Text>
        ))}
      </View>

      <View style={styles.grid}>
        {weeks.map((days, wi) => (
          <View key={wi} style={styles.week}>
            {days.map((dt) => {
              const k = dateKeyOf(dt.getFullYear(), dt.getMonth(), dt.getDate());
              const inMonth = dt.getMonth() === cursor.m;
              const isToday = k === todayK;
              const dayTasks = byDate[k] || [];
              return (
                <View key={k} style={[styles.cell, !inMonth && styles.cellDim]}>
                  <View style={[styles.dayBadge, isToday && styles.dayBadgeToday]}>
                    <Text
                      style={[
                        styles.dayNum,
                        isToday && styles.dayNumToday,
                        !inMonth && styles.dayNumDim,
                      ]}
                    >
                      {dt.getDate()}
                    </Text>
                  </View>
                  {dayTasks.slice(0, MAX_CHIPS).map((t) => {
                    const done = t.status !== STATUS.OPEN;
                    return (
                      <Pressable key={t.id} style={styles.chip} onPress={() => onOpenTask(t.id)}>
                        <View style={[styles.chipDot, { backgroundColor: project?.color || colors.accent }]} />
                        <Text style={[styles.chipText, done && styles.chipTextDone]} numberOfLines={1}>
                          {t.title || 'New To-Do'}
                        </Text>
                      </Pressable>
                    );
                  })}
                  {dayTasks.length > MAX_CHIPS && (
                    <Text style={styles.more}>+{dayTasks.length - MAX_CHIPS} more</Text>
                  )}
                </View>
              );
            })}
          </View>
        ))}
      </View>

      {undated > 0 && (
        <Text style={styles.undated}>
          {undated} unscheduled to-do{undated > 1 ? 's' : ''} not shown
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  monthTitle: { ...typography.title, color: colors.text },
  nav: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  todayBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separatorStrong,
    marginRight: spacing.xs,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  todayText: { ...typography.subhead, color: colors.textSecondary, fontWeight: '600' },
  navBtn: { padding: 2, ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null) },
  weekdays: { flexDirection: 'row', marginBottom: 4 },
  weekday: {
    flex: 1,
    textAlign: 'center',
    ...typography.caption,
    color: colors.textTertiary,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  grid: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separator,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  week: { flexDirection: 'row' },
  cell: {
    flex: 1,
    minHeight: 96,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separator,
    padding: 4,
    gap: 2,
  },
  cellDim: { backgroundColor: colors.groupedBackground },
  dayBadge: {
    alignSelf: 'flex-start',
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  dayBadgeToday: { backgroundColor: colors.accent },
  dayNum: { ...typography.caption, color: colors.textSecondary, fontWeight: '600' },
  dayNumToday: { color: colors.white },
  dayNumDim: { color: colors.textTertiary },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.groupedBackground,
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 2,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  chipDot: { width: 6, height: 6, borderRadius: 3 },
  chipText: { ...typography.caption, color: colors.text, flexShrink: 1 },
  chipTextDone: { color: colors.textTertiary, textDecorationLine: 'line-through' },
  more: { ...typography.caption, color: colors.textTertiary, paddingLeft: 4 },
  undated: { ...typography.caption, color: colors.textTertiary, marginTop: spacing.sm },
});

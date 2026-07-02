import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, Platform } from 'react-native';
import { colors, spacing, typography, radius } from '../theme';
import { WHEN, STATUS } from '../store/constants';
import { todayKey, keyToDate, addDays, MONTHS_SHORT, WEEKDAYS_SHORT } from '../utils/date';

const DAY_W = 44;
const LEFT_W = 200;
const HEADER_H = 46;
const TASK_H = 40;
const SECTION_H = 34;

// A concrete calendar day for the task's When (start) / Deadline (end), or null.
function whenKey(t) {
  if (t.when === WHEN.TODAY || t.when === WHEN.EVENING) return todayKey();
  if (!t.when || t.when === WHEN.SOMEDAY) return null;
  return t.when;
}
// A task's [start, end] span: Date = start, Deadline = end. With only one date
// it's a single day; if the deadline precedes the start they're swapped so the
// bar always reads left-to-right.
function span(t) {
  const s = whenKey(t);
  const e = t.deadline || null;
  if (s && e) return s <= e ? [s, e] : [e, s];
  if (s) return [s, s];
  if (e) return [e, e];
  return null;
}

const dayMs = 86400000;
const daysBetween = (aKey, bKey) => Math.round((keyToDate(bKey) - keyToDate(aKey)) / dayMs);

// A self-made Gantt/timeline for a project: one bar per task from its Date
// (start) to its Deadline (end), grouped by section. The task-name column is
// pinned while the dated timeline scrolls horizontally. Tasks with no dates
// can't be plotted and are surfaced as a footer count.
export default function GanttView({ sections, project, onOpenTask }) {
  // Rows: a section header followed by its dated tasks. Sections with no dated
  // task are skipped. Track how many tasks have no dates at all.
  const rows = [];
  let undated = 0;
  const allSpans = [];
  sections.forEach((s) => {
    const dated = [];
    s.data.forEach((t) => {
      const sp = span(t);
      if (sp) dated.push({ task: t, span: sp });
      else undated += 1;
    });
    if (!dated.length) return;
    rows.push({ type: 'section', key: s.key, title: s.heading ? s.title : '(No Section)' });
    dated.forEach(({ task, span: sp }) => {
      rows.push({ type: 'task', key: task.id, task, span: sp });
      allSpans.push(sp);
    });
  });

  if (!allSpans.length) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>No tasks with a Date or Deadline to plot.</Text>
      </View>
    );
  }

  // Overall range, padded a day on each side.
  let minKey = allSpans[0][0];
  let maxKey = allSpans[0][1];
  allSpans.forEach(([s, e]) => {
    if (s < minKey) minKey = s;
    if (e > maxKey) maxKey = e;
  });
  const startKey = addDays(minKey, -1);
  const endKey = addDays(maxKey, 1);
  const numDays = daysBetween(startKey, endKey) + 1;
  const days = Array.from({ length: numDays }, (_, i) => addDays(startKey, i));
  const todayK = todayKey();

  const timelineWidth = numDays * DAY_W;

  const DayGrid = () => (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={{ flexDirection: 'row' }}>
        {days.map((k) => {
          const wd = keyToDate(k).getDay();
          const weekend = wd === 0 || wd === 6;
          return (
            <View
              key={k}
              style={[
                styles.gridCol,
                weekend && styles.gridColWeekend,
                k === todayK && styles.gridColToday,
              ]}
            />
          );
        })}
      </View>
    </View>
  );

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        {/* Pinned task-name column */}
        <View style={styles.leftCol}>
          <View style={[styles.leftHeader, { height: HEADER_H }]}>
            <Text style={styles.leftHeaderText}>Task</Text>
          </View>
          {rows.map((r) =>
            r.type === 'section' ? (
              <View key={r.key} style={[styles.leftSection, { height: SECTION_H }]}>
                <Text style={styles.sectionTitle} numberOfLines={1}>
                  {r.title}
                </Text>
              </View>
            ) : (
              <Pressable
                key={r.key}
                style={[styles.leftTask, { height: TASK_H }]}
                onPress={() => onOpenTask(r.task.id)}
              >
                <Text
                  style={[
                    styles.leftTaskText,
                    r.task.status !== STATUS.OPEN && styles.doneText,
                  ]}
                  numberOfLines={1}
                >
                  {r.task.title || 'New To-Do'}
                </Text>
              </Pressable>
            )
          )}
        </View>

        {/* Scrolling timeline */}
        <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ width: timelineWidth }}>
          <View>
            {/* Date header */}
            <View style={[styles.timelineHeader, { height: HEADER_H, width: timelineWidth }]}>
              {days.map((k, i) => {
                const d = keyToDate(k);
                const showMonth = i === 0 || d.getDate() === 1;
                return (
                  <View key={k} style={[styles.headCol, { width: DAY_W }]}>
                    {showMonth && (
                      <Text style={styles.headMonth}>{MONTHS_SHORT[d.getMonth()]}</Text>
                    )}
                    <Text style={styles.headWeekday}>{WEEKDAYS_SHORT[d.getDay()][0]}</Text>
                    <View style={[styles.headDayBadge, k === todayK && styles.headDayBadgeToday]}>
                      <Text style={[styles.headDay, k === todayK && styles.headDayToday]}>
                        {d.getDate()}
                      </Text>
                    </View>
                  </View>
                );
              })}
            </View>

            {/* Rows */}
            {rows.map((r) => {
              if (r.type === 'section') {
                return (
                  <View key={r.key} style={[styles.timelineSection, { height: SECTION_H, width: timelineWidth }]}>
                    <DayGrid />
                  </View>
                );
              }
              const [s, e] = r.span;
              const left = daysBetween(startKey, s) * DAY_W;
              const width = (daysBetween(s, e) + 1) * DAY_W;
              const done = r.task.status !== STATUS.OPEN;
              return (
                <View key={r.key} style={[styles.timelineRow, { height: TASK_H, width: timelineWidth }]}>
                  <DayGrid />
                  <Pressable
                    onPress={() => onOpenTask(r.task.id)}
                    style={[
                      styles.bar,
                      {
                        left: left + 3,
                        width: Math.max(DAY_W - 6, width - 6),
                        backgroundColor: done ? colors.separatorStrong : project?.color || colors.accent,
                      },
                    ]}
                  >
                    <Text style={styles.barText} numberOfLines={1}>
                      {r.task.title || 'New To-Do'}
                    </Text>
                  </Pressable>
                </View>
              );
            })}
          </View>
        </ScrollView>
      </View>

      {undated > 0 && (
        <Text style={styles.undated}>
          {undated} to-do{undated > 1 ? 's' : ''} with no Date or Deadline not shown
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingLeft: spacing.lg, paddingBottom: spacing.lg },
  row: {
    flexDirection: 'row',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separator,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  leftCol: {
    width: LEFT_W,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.separatorStrong,
    backgroundColor: colors.background,
  },
  leftHeader: {
    justifyContent: 'flex-end',
    paddingBottom: 6,
    paddingHorizontal: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  leftHeaderText: { ...typography.caption, color: colors.textTertiary, fontWeight: '600', textTransform: 'uppercase' },
  leftSection: {
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    backgroundColor: colors.groupedBackground,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  sectionTitle: { ...typography.subhead, color: colors.text, fontWeight: '600' },
  leftTask: {
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  leftTaskText: { ...typography.subhead, color: colors.text },
  doneText: { color: colors.textTertiary, textDecorationLine: 'line-through' },
  timelineHeader: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  headCol: { alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 3, gap: 1 },
  headMonth: { ...typography.caption, color: colors.textSecondary, fontWeight: '600', fontSize: 10 },
  headWeekday: { ...typography.caption, color: colors.textTertiary, fontSize: 10 },
  headDayBadge: { minWidth: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  headDayBadgeToday: { backgroundColor: colors.accent },
  headDay: { ...typography.caption, color: colors.textSecondary, fontWeight: '600' },
  headDayToday: { color: colors.white },
  timelineSection: { backgroundColor: colors.groupedBackground, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator },
  timelineRow: {
    justifyContent: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  gridCol: { width: DAY_W, height: '100%', borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.separator },
  gridColWeekend: { backgroundColor: 'rgba(0,0,0,0.015)' },
  gridColToday: { backgroundColor: colors.accentSoft },
  bar: {
    position: 'absolute',
    height: 24,
    borderRadius: radius.sm,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  barText: { ...typography.caption, color: colors.white, fontWeight: '600' },
  empty: { padding: spacing.xl, alignItems: 'center' },
  emptyText: { ...typography.body, color: colors.textTertiary },
  undated: { ...typography.caption, color: colors.textTertiary, marginTop: spacing.sm },
});

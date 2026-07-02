import React, { useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, typography, radius } from '../theme';
import { WHEN, STATUS } from '../store/constants';
import { todayKey, keyToDate, addDays, MONTHS_SHORT, WEEKDAYS_SHORT } from '../utils/date';

const START_HOUR = 6;
const END_HOUR = 23;
const HOUR_H = 44;
const GUTTER = 46;
const DEFAULT_DUR = 60;
const GRID_H = (END_HOUR - START_HOUR) * HOUR_H;

function whenKey(t) {
  if (t.when === WHEN.TODAY || t.when === WHEN.EVENING) return todayKey();
  if (!t.when || t.when === WHEN.SOMEDAY) return null;
  return t.when;
}
const fmt = (mins) =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
function tint(hex) {
  const h = (hex || '').replace('#', '');
  if (h.length !== 6) return colors.accentSoft;
  return `rgba(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}, 0.16)`;
}

// A 7-day week grid: day columns over a shared hour axis, an all-day row on top,
// and a "now" line on today. Prev/next/Today navigate weeks; tapping a block or
// chip opens the task.
export default function WeekView({ tasks, project, onOpenTask }) {
  const today = keyToDate(todayKey());
  const startOfWeek = (d) => addDays(d, -keyToDate(d).getDay()); // back to Sunday
  const [weekStart, setWeekStart] = useState(startOfWeek(todayKey()));
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const todayK = todayKey();
  const color = project?.color || colors.accent;

  const timedByDay = {};
  const allDayByDay = {};
  tasks.forEach((t) => {
    const k = whenKey(t);
    if (!k || !days.includes(k)) return;
    if (t.startMinutes != null) (timedByDay[k] = timedByDay[k] || []).push(t);
    else (allDayByDay[k] = allDayByDay[k] || []).push(t);
  });

  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const showNow = days.includes(todayK) && nowMins >= START_HOUR * 60 && nowMins <= END_HOUR * 60;
  const nowTop = ((nowMins - START_HOUR * 60) / 60) * HOUR_H;
  const nowCol = days.indexOf(todayK);

  const first = keyToDate(days[0]);
  const last = keyToDate(days[6]);
  const rangeLabel =
    first.getMonth() === last.getMonth()
      ? `${MONTHS_SHORT[first.getMonth()]} ${first.getDate()} – ${last.getDate()}`
      : `${MONTHS_SHORT[first.getMonth()]} ${first.getDate()} – ${MONTHS_SHORT[last.getMonth()]} ${last.getDate()}`;

  return (
    <View style={styles.container}>
      <View style={styles.nav}>
        <Text style={styles.rangeLabel}>{rangeLabel}</Text>
        <View style={styles.navBtns}>
          <Pressable onPress={() => setWeekStart(startOfWeek(todayKey()))} style={styles.todayBtn}>
            <Text style={styles.todayText}>Today</Text>
          </Pressable>
          <Pressable onPress={() => setWeekStart(addDays(weekStart, -7))} hitSlop={8} style={styles.navBtn}>
            <Ionicons name="chevron-back" size={20} color={colors.textSecondary} />
          </Pressable>
          <Pressable onPress={() => setWeekStart(addDays(weekStart, 7))} hitSlop={8} style={styles.navBtn}>
            <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
          </Pressable>
        </View>
      </View>

      {/* Day headers */}
      <View style={styles.headerRow}>
        <View style={{ width: GUTTER }} />
        {days.map((k) => {
          const d = keyToDate(k);
          const isToday = k === todayK;
          return (
            <View key={k} style={styles.headCell}>
              <Text style={[styles.headWeekday, isToday && styles.headToday]}>{WEEKDAYS_SHORT[d.getDay()]}</Text>
              <View style={[styles.headDayBadge, isToday && styles.headDayBadgeToday]}>
                <Text style={[styles.headDay, isToday && styles.headDayNumToday]}>{d.getDate()}</Text>
              </View>
            </View>
          );
        })}
      </View>

      {/* All-day row */}
      <View style={styles.allDayRow}>
        <View style={[styles.allDayGutter, { width: GUTTER }]}>
          <Text style={styles.allDayLabel}>all-day</Text>
        </View>
        {days.map((k) => (
          <View key={k} style={styles.allDayCell}>
            {(allDayByDay[k] || []).slice(0, 3).map((t) => (
              <Pressable key={t.id} style={[styles.allDayChip, { borderColor: color }]} onPress={() => onOpenTask(t.id)}>
                <Text style={styles.allDayChipText} numberOfLines={1}>{t.title || 'New To-Do'}</Text>
              </Pressable>
            ))}
            {(allDayByDay[k] || []).length > 3 && (
              <Text style={styles.moreText}>+{(allDayByDay[k] || []).length - 3}</Text>
            )}
          </View>
        ))}
      </View>

      <ScrollView style={styles.scroll} showsVerticalScrollIndicator>
        <View style={[styles.grid, { height: GRID_H }]}>
          {/* Hour lines + labels */}
          {Array.from({ length: END_HOUR - START_HOUR + 1 }, (_, i) => START_HOUR + i).map((h) => (
            <View key={h} style={[styles.hourRow, { top: (h - START_HOUR) * HOUR_H }]}>
              <Text style={styles.hourLabel}>{fmt(h * 60)}</Text>
              <View style={styles.hourLine} />
            </View>
          ))}
          {/* Day column dividers */}
          <View style={[styles.colLayer, { left: GUTTER }]} pointerEvents="none">
            {days.map((k, i) => (
              <View key={k} style={[styles.colDivider, k === todayK && styles.colToday]} />
            ))}
          </View>

          {/* Blocks + now line, positioned within the columns area */}
          <View style={[styles.blockLayer, { left: GUTTER }]}>
            {showNow && nowCol >= 0 && (
              <View
                style={[styles.nowLine, { top: nowTop, left: `${(nowCol * 100) / 7}%`, width: `${100 / 7}%` }]}
                pointerEvents="none"
              >
                <View style={styles.nowDot} />
              </View>
            )}
            {days.map((k, di) =>
              (timedByDay[k] || []).map((t) => {
                const top = ((t.startMinutes - START_HOUR * 60) / 60) * HOUR_H;
                const height = Math.max(18, ((t.durationMinutes || DEFAULT_DUR) / 60) * HOUR_H - 2);
                const doneT = t.status !== STATUS.OPEN;
                return (
                  <Pressable
                    key={t.id}
                    onPress={() => onOpenTask(t.id)}
                    style={[styles.block, { top, height, left: `${(di * 100) / 7}%`, width: `${100 / 7}%` }]}
                  >
                    <View style={[styles.blockInner, { backgroundColor: tint(color), borderLeftColor: color }]}>
                      <Text style={[styles.blockTitle, doneT && styles.done]} numberOfLines={1}>
                        {t.title || 'New To-Do'}
                      </Text>
                      <Text style={styles.blockTime} numberOfLines={1}>{fmt(t.startMinutes)}</Text>
                    </View>
                  </Pressable>
                );
              })
            )}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: spacing.lg },
  nav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm },
  rangeLabel: { ...typography.heading, color: colors.text },
  navBtns: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  todayBtn: {
    paddingHorizontal: spacing.md, paddingVertical: 4, borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separatorStrong, marginRight: spacing.xs,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  todayText: { ...typography.subhead, color: colors.textSecondary, fontWeight: '600' },
  navBtn: { padding: 2, ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null) },
  headerRow: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator, paddingBottom: 4 },
  headCell: { flex: 1, alignItems: 'center', gap: 2 },
  headWeekday: { ...typography.caption, color: colors.textTertiary, textTransform: 'uppercase' },
  headToday: { color: colors.accent, fontWeight: '700' },
  headDayBadge: { minWidth: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  headDayBadgeToday: { backgroundColor: colors.accent },
  headDay: { ...typography.subhead, color: colors.text, fontWeight: '600' },
  headDayNumToday: { color: colors.white },
  allDayRow: { flexDirection: 'row', minHeight: 26, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separatorStrong, paddingVertical: 3 },
  allDayGutter: { justifyContent: 'center' },
  allDayLabel: { ...typography.caption, color: colors.textTertiary, fontSize: 10 },
  allDayCell: { flex: 1, gap: 2, paddingHorizontal: 2, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.separator },
  allDayChip: { borderLeftWidth: 3, borderRadius: 3, backgroundColor: colors.groupedBackground, paddingHorizontal: 4, paddingVertical: 1 },
  allDayChipText: { ...typography.caption, color: colors.text, fontSize: 10 },
  moreText: { ...typography.caption, color: colors.textTertiary, fontSize: 10, paddingLeft: 4 },
  scroll: { flex: 1 },
  grid: { position: 'relative' },
  hourRow: { position: 'absolute', left: 0, right: 0, height: HOUR_H, flexDirection: 'row', alignItems: 'flex-start' },
  hourLabel: { width: GUTTER, ...typography.caption, color: colors.textTertiary, marginTop: -6, fontSize: 10, textAlign: 'right', paddingRight: 4, fontVariant: ['tabular-nums'] },
  hourLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.separator },
  colLayer: { position: 'absolute', top: 0, bottom: 0, right: 0, flexDirection: 'row' },
  colDivider: { flex: 1, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.separator },
  colToday: { backgroundColor: colors.accentSoft },
  blockLayer: { position: 'absolute', top: 0, bottom: 0, right: 0 },
  nowLine: { position: 'absolute', height: 2, backgroundColor: colors.deadline },
  nowDot: { position: 'absolute', left: -3, top: -3, width: 8, height: 8, borderRadius: 4, backgroundColor: colors.deadline },
  block: { position: 'absolute', paddingHorizontal: 1 },
  blockInner: { flex: 1, borderLeftWidth: 3, borderRadius: 3, paddingHorizontal: 3, paddingVertical: 1, overflow: 'hidden', ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null) },
  blockTitle: { ...typography.caption, color: colors.text, fontWeight: '600', fontSize: 10 },
  blockTime: { ...typography.caption, color: colors.textSecondary, fontSize: 9 },
  done: { color: colors.textTertiary, textDecorationLine: 'line-through' },
});

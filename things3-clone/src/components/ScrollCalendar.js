import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { colors, spacing, typography, radius } from '../theme';
import { todayKey, dateToKey, monthYearTitle } from '../utils/date';

const WEEK = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const CELL = `${100 / 7}%`;
const MONTHS_AHEAD = 15; // ~15 months of runway from the current month

// The weeks of one month, with leading blanks so the 1st lands on its weekday and a
// trailing pad to complete the final week (months flow as their own blocks, not into
// each other — matching the reference's per-month sections).
function monthCells(year, month) {
  const firstDay = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

// A continuously-scrolling month calendar: a fixed weekday header over a vertical list
// of month blocks, each labelled ("Sep 2026"). Scroll to reach further months.
export default function ScrollCalendar({ selected, onSelect, height = 260, fill = false, onScroll }) {
  const today = todayKey();
  const now = new Date();
  const months = Array.from({ length: MONTHS_AHEAD }, (_, i) =>
    new Date(now.getFullYear(), now.getMonth() + i, 1)
  );

  return (
    <View style={fill && { flex: 1 }}>
      <View style={styles.weekRow}>
        {WEEK.map((w, i) => (
          <Text key={i} style={styles.weekday}>{w}</Text>
        ))}
      </View>
      <ScrollView
        style={fill ? { flex: 1 } : { height }}
        showsVerticalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
      >
        {months.map((m) => {
          const year = m.getFullYear();
          const month = m.getMonth();
          const cells = monthCells(year, month);
          return (
            <View key={`${year}-${month}`} style={styles.month}>
              <Text style={styles.monthLabel}>{monthYearTitle(dateToKey(new Date(year, month, 1)))}</Text>
              <View style={styles.grid}>
                {cells.map((d, i) => {
                  if (d === null) return <View key={`e${i}`} style={styles.cell} />;
                  const key = dateToKey(new Date(year, month, d));
                  const isSel = key === selected;
                  const isToday = key === today;
                  return (
                    <Pressable key={key} testID={`cal-day-${key}`} style={styles.cell} onPress={() => onSelect(key)}>
                      <View style={[styles.dayCircle, isSel && styles.selectedCircle]}>
                        <Text
                          style={[
                            styles.dayText,
                            isToday && !isSel && { color: colors.accent, fontWeight: '700' },
                            isSel && { color: colors.white, fontWeight: '700' },
                          ]}
                        >
                          {d}
                        </Text>
                      </View>
                      {isToday && !isSel && <View style={styles.todayDot} />}
                    </Pressable>
                  );
                })}
              </View>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  weekRow: { flexDirection: 'row', paddingBottom: spacing.xs },
  weekday: { width: CELL, textAlign: 'center', ...typography.caption, color: colors.textTertiary },
  // Months flow tightly: no bottom margin, and only a small gap above each label
  // (the partial last/first weeks already leave visual breathing room).
  month: { marginBottom: 0 },
  monthLabel: { ...typography.heading, color: colors.text, marginTop: spacing.xs, marginBottom: spacing.xs, paddingHorizontal: spacing.xs },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: CELL, aspectRatio: 1, alignItems: 'center', justifyContent: 'center' },
  dayCircle: { width: 34, height: 34, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  selectedCircle: { backgroundColor: colors.accent },
  dayText: { ...typography.callout, color: colors.text },
  todayDot: { position: 'absolute', bottom: 3, width: 4, height: 4, borderRadius: 2, backgroundColor: colors.accent },
});

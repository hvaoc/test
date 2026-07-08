import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, typography, radius } from '../theme';
import {
  todayKey,
  keyToDate,
  dateToKey,
  monthTitle,
  WEEKDAYS_SHORT,
} from '../utils/date';

// A compact month-grid calendar. `selected` and `onSelect` use "YYYY-MM-DD".
export default function MiniCalendar({ selected, onSelect }) {
  const base = selected ? keyToDate(selected) : new Date();
  const [cursor, setCursor] = useState(new Date(base.getFullYear(), base.getMonth(), 1));

  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = todayKey();

  // Always lay out a fixed 6-row grid (6 × 7 = 42 cells). A month spans 4–6 weeks
  // depending on where the 1st falls, so padding to the maximum keeps the calendar a
  // constant height — it no longer grows/jumps when you page between months.
  const cells = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length < 42) cells.push(null);

  const monthKey = dateToKey(new Date(year, month, 1));

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Pressable
          hitSlop={10}
          onPress={() => setCursor(new Date(year, month - 1, 1))}
        >
          <Ionicons name="chevron-back" size={20} color={colors.accent} />
        </Pressable>
        <Text style={styles.monthLabel}>
          {monthTitle(monthKey)} {year !== new Date().getFullYear() ? '' : ''}
        </Text>
        <Pressable
          hitSlop={10}
          onPress={() => setCursor(new Date(year, month + 1, 1))}
        >
          <Ionicons name="chevron-forward" size={20} color={colors.accent} />
        </Pressable>
      </View>

      <View style={styles.weekRow}>
        {WEEKDAYS_SHORT.map((w) => (
          <Text key={w} style={styles.weekday}>
            {w[0]}
          </Text>
        ))}
      </View>

      <View style={styles.grid}>
        {cells.map((d, i) => {
          if (d === null) return <View key={`e${i}`} style={styles.cell} />;
          const key = dateToKey(new Date(year, month, d));
          const isSel = key === selected;
          const isToday = key === today;
          return (
            <Pressable
              key={key}
              testID={`cal-day-${key}`}
              style={styles.cell}
              onPress={() => onSelect(key)}
            >
              <View
                style={[
                  styles.dayCircle,
                  isToday && !isSel && styles.todayCircle,
                  isSel && styles.selectedCircle,
                ]}
              >
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
}

const CELL = `${100 / 7}%`;

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: spacing.sm },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  monthLabel: { ...typography.heading, color: colors.text },
  weekRow: { flexDirection: 'row' },
  weekday: {
    width: CELL,
    textAlign: 'center',
    ...typography.caption,
    color: colors.textTertiary,
    marginBottom: spacing.xs,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: {
    width: CELL,
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayCircle: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  todayCircle: { backgroundColor: colors.accentSoft },
  selectedCircle: { backgroundColor: colors.accent },
  todayDot: {
    position: 'absolute',
    bottom: 3,
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.accent,
  },
  dayText: { ...typography.callout, color: colors.text },
});

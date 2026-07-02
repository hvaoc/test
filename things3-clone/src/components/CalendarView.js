import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import { colors, spacing, typography, radius } from '../theme';
import { useTasks } from '../store/TasksContext';
import DayPlanner from './DayPlanner';
import WeekView from './WeekView';
import MonthCalendar from './MonthCalendar';

// The project Calendar. A Month / Week / Day switch delegates to the matching
// view; all three fill the pane and manage their own scrolling.
export default function CalendarView({ tasks, project, onOpenTask, onUpdateTask, onAddTask }) {
  const [mode, setMode] = useState('day');
  const { state } = useTasks();
  const startHour = state.settings.dayStartHour ?? 0;
  const common = { tasks, project, onOpenTask, onUpdateTask, onAddTask };
  return (
    <View style={styles.wrap}>
      <View style={styles.modeRow}>
        {[
          { key: 'month', label: 'Month' },
          { key: 'week', label: 'Week' },
          { key: 'day', label: 'Day' },
        ].map((m) => (
          <Pressable
            key={m.key}
            onPress={() => setMode(m.key)}
            style={[styles.modeBtn, mode === m.key && styles.modeBtnActive]}
          >
            <Text style={[styles.modeText, mode === m.key && styles.modeTextActive]}>{m.label}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.body}>
        {mode === 'day' ? (
          <DayPlanner {...common} startHour={startHour} />
        ) : mode === 'week' ? (
          <WeekView {...common} startHour={startHour} />
        ) : (
          <MonthCalendar {...common} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: 0 },
  body: { flex: 1, marginHorizontal: -spacing.lg },
  modeRow: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    backgroundColor: colors.separator,
    borderRadius: 8,
    padding: 2,
    gap: 2,
    marginBottom: spacing.md,
  },
  modeBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: 6,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  modeBtnActive: { backgroundColor: colors.card },
  modeText: { ...typography.subhead, color: colors.textSecondary },
  modeTextActive: { color: colors.text, fontWeight: '600' },
});

import React, { useState, useRef } from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import { colors, spacing, typography, radius } from '../theme';
import { todayKey } from '../utils/date';
import { useTasks } from '../store/TasksContext';
import DayPlanner from './DayPlanner';
import WeekView from './WeekView';
import MonthCalendar from './MonthCalendar';

// The project Calendar. A Month / Week / Day switch delegates to the matching
// view; all three fill the pane and manage their own scrolling.
export default function CalendarView({ tasks, project, onOpenTask, onUpdateTask, onAddTask }) {
  const [mode, setMode] = useState('day');
  // The date currently in focus, shared across the three views. Held in a ref so
  // a view reporting its scroll position doesn't re-render the calendar; on a
  // view switch we read the latest value and center the newly-shown view on it.
  const focusRef = useRef(todayKey());
  const reportFocus = (d) => { if (d) focusRef.current = d; };
  const { state } = useTasks();
  const startHour = state.settings.dayStartHour ?? 0;
  const dateFormat = state.settings.dateFormat ?? 'weekday-long';
  const showWeekends = state.settings.showWeekends ?? false;
  const common = { tasks, project, onOpenTask, onUpdateTask, onAddTask };

  // Switching views keeps the focused date so the same day stays in view.
  // Tapping a day in Month view jumps to the Day view centered on that date.
  const selectMode = (key) => setMode(key);
  const openDay = (dayKey) => { focusRef.current = dayKey; setMode('day'); };
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
            onPress={() => selectMode(m.key)}
            style={[styles.modeBtn, mode === m.key && styles.modeBtnActive]}
          >
            <Text style={[styles.modeText, mode === m.key && styles.modeTextActive]}>{m.label}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.body}>
        {mode === 'day' ? (
          <DayPlanner {...common} startHour={startHour} focusDate={focusRef.current} onFocusDateChange={reportFocus} dateFormat={dateFormat} />
        ) : mode === 'week' ? (
          <WeekView {...common} startHour={startHour} focusDate={focusRef.current} onFocusDateChange={reportFocus} showWeekends={showWeekends} dateFormat={dateFormat} />
        ) : (
          <MonthCalendar {...common} focusDate={focusRef.current} onFocusDateChange={reportFocus} onOpenDay={openDay} startHour={startHour} dateFormat={dateFormat} />
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

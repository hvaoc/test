import React, { useState, useRef } from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, runOnJS } from 'react-native-reanimated';
import { colors, spacing, typography, radius } from '../theme';
import { WHEN, STATUS } from '../store/constants';
import { todayKey, keyToDate, MONTHS, WEEKDAYS_SHORT } from '../utils/date';
import DayPlanner from './DayPlanner';

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
export default function CalendarView({ tasks, project, onOpenTask, onUpdateTask, onAddTask, fillHeight }) {
  const today = keyToDate(todayKey());
  const [mode, setMode] = useState('day');
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

  // --- Month drag-and-drop: drag a task chip onto another day to reschedule ---
  const rootRef = useRef(null);
  const gridRef = useRef(null);
  const rectsRef = useRef(null);
  const [dragTask, setDragTask] = useState(null);
  const ghostX = useSharedValue(0);
  const ghostY = useSharedValue(0);
  const rootX = useSharedValue(0);
  const rootY = useSharedValue(0);
  const measureOnly = () => {
    const grab = (ref, key, store) =>
      new Promise((res) => {
        const n = ref.current;
        if (n && n.measureInWindow) n.measureInWindow((x, y, w, h) => { store[key] = { x, y, w, h }; res(); });
        else res();
      });
    const store = {};
    Promise.all([grab(rootRef, 'root', store), grab(gridRef, 'grid', store)]).then(() => {
      rectsRef.current = store;
      if (store.root) { rootX.value = store.root.x; rootY.value = store.root.y; }
    });
  };
  const beginDrag = (task) => setDragTask(task);
  const cancelDrag = () => setDragTask(null);
  const endDrag = (taskId, ax, ay) => {
    setDragTask(null);
    const g = rectsRef.current?.grid;
    if (!g || ax < g.x || ax > g.x + g.w || ay < g.y || ay > g.y + g.h) return;
    const col = Math.max(0, Math.min(6, Math.floor(((ax - g.x) / g.w) * 7)));
    const row = Math.max(0, Math.min(weeks.length - 1, Math.floor(((ay - g.y) / g.h) * weeks.length)));
    const dt = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + row * 7 + col);
    onUpdateTask &&
      onUpdateTask(taskId, { when: dateKeyOf(dt.getFullYear(), dt.getMonth(), dt.getDate()) });
  };
  const dragCtx = { ghostX, ghostY, rootX, rootY, measureOnly, beginDrag, cancelDrag, endDrag };
  const ghostStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: ghostX.value }, { translateY: ghostY.value }],
  }));

  return (
    <View ref={rootRef} collapsable={false} style={[styles.wrap, fillHeight && styles.wrapFill]}>
      <View style={styles.modeRow}>
        {[
          { key: 'month', label: 'Month' },
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

      {mode === 'day' ? (
        <DayPlanner
          tasks={tasks}
          project={project}
          onOpenTask={onOpenTask}
          onUpdateTask={onUpdateTask}
          onAddTask={onAddTask}
          fillHeight={fillHeight}
        />
      ) : (
       <>
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

      <View ref={gridRef} collapsable={false} style={[styles.grid, fillHeight && styles.gridFill]}>
        {weeks.map((days, wi) => (
          <View key={wi} style={[styles.week, fillHeight && styles.weekFill]}>
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
                      <MonthDraggable key={t.id} task={t} ctx={dragCtx} onOpen={onOpenTask}>
                        <View style={[styles.chipDot, { backgroundColor: project?.color || colors.accent }]} />
                        <Text style={[styles.chipText, done && styles.chipTextDone]} numberOfLines={1}>
                          {t.title || 'New To-Do'}
                        </Text>
                      </MonthDraggable>
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
       </>
      )}

      {dragTask && (
        <Animated.View pointerEvents="none" style={[styles.ghost, ghostStyle]}>
          <View style={[styles.chipDot, { backgroundColor: project?.color || colors.accent }]} />
          <Text style={styles.ghostText} numberOfLines={1}>
            {dragTask.title || 'New To-Do'}
          </Text>
        </Animated.View>
      )}
    </View>
  );
}

// A month task chip that opens on tap and reschedules on drag (long-press then
// move). Only a real move drags; the ghost tracks the pointer to the drop day.
function MonthDraggable({ task, ctx, onOpen, children }) {
  const dragged = React.useRef(false);
  const moved = useSharedValue(false);
  const markDragged = () => {
    dragged.current = true;
  };
  const handlePress = () => {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    onOpen(task.id);
  };
  const pan = Gesture.Pan()
    .activateAfterLongPress(150)
    .onStart(() => {
      moved.value = false;
      runOnJS(ctx.measureOnly)();
    })
    .onUpdate((e) => {
      const far = Math.abs(e.translationX) + Math.abs(e.translationY) > 6;
      if (far && !moved.value) {
        moved.value = true;
        runOnJS(markDragged)();
        runOnJS(ctx.beginDrag)(task);
      }
      if (!moved.value) return;
      ctx.ghostX.value = e.absoluteX - ctx.rootX.value - 18;
      ctx.ghostY.value = e.absoluteY - ctx.rootY.value - 12;
    })
    .onEnd((e) => {
      if (moved.value) runOnJS(ctx.endDrag)(task.id, e.absoluteX, e.absoluteY);
      else runOnJS(ctx.cancelDrag)();
    });
  return (
    <GestureDetector gesture={pan}>
      <Animated.View>
        <Pressable style={styles.chip} onPress={handlePress}>
          {children}
        </Pressable>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
  wrapFill: { flex: 1, paddingBottom: 0 },
  gridFill: { flex: 1 },
  weekFill: { flex: 1 },
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
  ghost: {
    position: 'absolute',
    top: 0,
    left: 0,
    zIndex: 1000,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: 220,
    paddingVertical: 5,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.background,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separatorStrong,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  ghostText: { ...typography.caption, color: colors.text, flexShrink: 1 },
});

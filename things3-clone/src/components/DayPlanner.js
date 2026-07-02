import React, { useRef, useState } from 'react';
import { View, Text, Pressable, TextInput, ScrollView, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, runOnJS } from 'react-native-reanimated';
import { colors, spacing, typography, radius } from '../theme';
import { WHEN, STATUS } from '../store/constants';
import { todayKey, keyToDate, addDays, MONTHS_SHORT, WEEKDAYS } from '../utils/date';

const START_HOUR = 6;
const END_HOUR = 23;
const HOUR_H = 52;
const SNAP = 15; // minutes
const DEFAULT_DUR = 60;
const PANEL_W = 236;
const GRID_H = (END_HOUR - START_HOUR) * HOUR_H;

// Concrete day a task sits on (its When date), or null if unscheduled/someday.
function whenKey(t) {
  if (t.when === WHEN.TODAY || t.when === WHEN.EVENING) return todayKey();
  if (!t.when || t.when === WHEN.SOMEDAY) return null;
  return t.when;
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmt = (mins) =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

// A day-planner timeline: timed tasks are blocks on an hour grid; untimed tasks
// live in the "All day" strip and the right "Unscheduled" panel. Tasks can be
// dragged (long-press) onto an hour to time-block them, moved between hours, or
// dropped on the all-day/unscheduled zones to clear their time.
export default function DayPlanner({ tasks, project, onOpenTask, onUpdateTask, onAddTask }) {
  const [day, setDay] = useState(todayKey());
  const [dragTask, setDragTask] = useState(null);
  const [newTitle, setNewTitle] = useState('');
  const [showPanel, setShowPanel] = useState(true);

  const rootRef = useRef(null);
  const gridRef = useRef(null);
  const allDayRef = useRef(null);
  const panelRef = useRef(null);
  const rectsRef = useRef(null);

  const ghostX = useSharedValue(0);
  const ghostY = useSharedValue(0);
  const rootX = useSharedValue(0);
  const rootY = useSharedValue(0);

  const dayTasks = tasks.filter((t) => whenKey(t) === day);
  const timed = dayTasks
    .filter((t) => t.startMinutes != null)
    .sort((a, b) => a.startMinutes - b.startMinutes);
  const untimed = dayTasks.filter((t) => t.startMinutes == null);

  const measureAll = () => {
    const grab = (ref, key, store) =>
      new Promise((res) => {
        const n = ref.current;
        if (n && n.measureInWindow) n.measureInWindow((x, y, w, h) => { store[key] = { x, y, w, h }; res(); });
        else res();
      });
    const store = {};
    Promise.all([
      grab(rootRef, 'root', store),
      grab(gridRef, 'grid', store),
      grab(allDayRef, 'allDay', store),
      grab(panelRef, 'panel', store),
    ]).then(() => {
      rectsRef.current = store;
      if (store.root) {
        rootX.value = store.root.x;
        rootY.value = store.root.y;
      }
    });
  };

  const begin = (task) => {
    setDragTask(task);
    measureAll();
  };

  const end = (taskId, ax, ay) => {
    setDragTask(null);
    const r = rectsRef.current;
    const task = tasks.find((t) => t.id === taskId);
    if (!r || !task) return;
    const inside = (rect) => rect && ax >= rect.x && ax <= rect.x + rect.w && ay >= rect.y && ay <= rect.y + rect.h;
    if (inside(r.grid)) {
      const rel = ay - r.grid.y;
      const dur = task.durationMinutes || DEFAULT_DUR;
      let mins = START_HOUR * 60 + Math.round((rel / HOUR_H) * 60 / SNAP) * SNAP;
      mins = clamp(mins, START_HOUR * 60, END_HOUR * 60 - dur);
      onUpdateTask(taskId, { startMinutes: mins, durationMinutes: dur, when: day });
    } else if (inside(r.allDay) || inside(r.panel)) {
      onUpdateTask(taskId, { startMinutes: null, when: day });
    }
  };

  const dragCtx = { ghostX, ghostY, rootX, rootY, begin, end };

  const isToday = day === todayKey();
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const nowTop = ((nowMins - START_HOUR * 60) / 60) * HOUR_H;
  const showNow = isToday && nowMins >= START_HOUR * 60 && nowMins <= END_HOUR * 60;

  const d = keyToDate(day);
  const dayLabel = `${WEEKDAYS[d.getDay()]}, ${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;

  const ghostStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: ghostX.value }, { translateY: ghostY.value }],
  }));

  const submitAdd = () => {
    const title = newTitle.trim();
    if (!title) return;
    onAddTask({ title, when: day });
    setNewTitle('');
  };

  return (
    <View ref={rootRef} style={styles.root} collapsable={false}>
      {/* Day navigation */}
      <View style={styles.dayNav}>
        <Text style={styles.dayLabel}>{dayLabel}</Text>
        <View style={styles.dayNavBtns}>
          <Pressable
            onPress={() => setShowPanel((v) => !v)}
            style={[styles.planBtn, showPanel && styles.planBtnActive]}
          >
            <Ionicons
              name="albums-outline"
              size={15}
              color={showPanel ? colors.accent : colors.textSecondary}
            />
            <Text style={[styles.planText, showPanel && { color: colors.accent }]}>
              Plan {untimed.length}
            </Text>
          </Pressable>
          <Pressable onPress={() => setDay(todayKey())} style={styles.todayBtn}>
            <Text style={styles.todayText}>Today</Text>
          </Pressable>
          <Pressable onPress={() => setDay(addDays(day, -1))} hitSlop={8} style={styles.navBtn}>
            <Ionicons name="chevron-back" size={20} color={colors.textSecondary} />
          </Pressable>
          <Pressable onPress={() => setDay(addDays(day, 1))} hitSlop={8} style={styles.navBtn}>
            <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
          </Pressable>
        </View>
      </View>

      <View style={styles.row}>
        {/* Left: all-day strip + hour grid (only the grid scrolls) */}
        <View style={styles.leftCol}>
          <View ref={allDayRef} collapsable={false} style={styles.allDay}>
            <Text style={styles.allDayLabel}>All day</Text>
            <View style={styles.allDayItems}>
              {untimed.length === 0 ? (
                <Text style={styles.allDayHint}>Drop here for all-day</Text>
              ) : (
                untimed.map((t) => (
                  <Draggable key={t.id} task={t} ctx={dragCtx} onOpen={onOpenTask} style={styles.allDayChipWrap}>
                    <View style={[styles.allDayChip, { borderColor: project?.color || colors.accent }]}>
                      <Text style={styles.allDayChipText} numberOfLines={1}>
                        {t.title || 'New To-Do'}
                      </Text>
                    </View>
                  </Draggable>
                ))
              )}
            </View>
          </View>

          <ScrollView
            style={styles.gridScroll}
            contentContainerStyle={{ height: GRID_H }}
            showsVerticalScrollIndicator={false}
          >
          <View ref={gridRef} collapsable={false} style={[styles.grid, { height: GRID_H }]}>
            {Array.from({ length: END_HOUR - START_HOUR + 1 }, (_, i) => START_HOUR + i).map((h) => (
              <View key={h} style={[styles.hourRow, { top: (h - START_HOUR) * HOUR_H }]}>
                <Text style={styles.hourLabel}>{fmt(h * 60)}</Text>
                <View style={styles.hourLine} />
              </View>
            ))}

            {showNow && (
              <View style={[styles.nowLine, { top: nowTop }]} pointerEvents="none">
                <View style={styles.nowDot} />
              </View>
            )}

            {timed.map((t) => {
              const top = ((t.startMinutes - START_HOUR * 60) / 60) * HOUR_H;
              const height = Math.max(22, ((t.durationMinutes || DEFAULT_DUR) / 60) * HOUR_H - 3);
              const done = t.status !== STATUS.OPEN;
              const color = project?.color || colors.accent;
              return (
                <Draggable
                  key={t.id}
                  task={t}
                  ctx={dragCtx}
                  onOpen={onOpenTask}
                  style={[styles.block, { top, height }]}
                >
                  <View style={[styles.blockInner, { backgroundColor: tint(color), borderLeftColor: color }]}>
                    <Text style={[styles.blockTitle, done && styles.done]} numberOfLines={1}>
                      {t.title || 'New To-Do'}
                    </Text>
                    <Text style={styles.blockTime}>
                      {fmt(t.startMinutes)}–{fmt(t.startMinutes + (t.durationMinutes || DEFAULT_DUR))}
                    </Text>
                  </View>
                </Draggable>
              );
            })}
          </View>
          </ScrollView>
        </View>

        {/* Right: unscheduled panel (toggled by the Plan button) */}
        {showPanel && (
          <View ref={panelRef} collapsable={false} style={styles.panel}>
            <Text style={styles.panelTitle}>
              Unscheduled <Text style={styles.panelCount}>{untimed.length}</Text>
            </Text>
            <ScrollView style={styles.panelScroll} showsVerticalScrollIndicator={false}>
              {untimed.map((t) => (
                <Draggable key={t.id} task={t} ctx={dragCtx} onOpen={onOpenTask} style={styles.panelItemWrap}>
                  <View style={styles.panelItem}>
                    <View style={[styles.panelDot, { borderColor: project?.color || colors.accent }]} />
                    <Text
                      style={[styles.panelItemText, t.status !== STATUS.OPEN && styles.done]}
                      numberOfLines={2}
                    >
                      {t.title || 'New To-Do'}
                    </Text>
                  </View>
                </Draggable>
              ))}
              <View style={styles.addRow}>
                <Ionicons name="add" size={18} color={colors.textTertiary} />
                <TextInput
                  style={styles.addInput}
                  value={newTitle}
                  onChangeText={setNewTitle}
                  onSubmitEditing={submitAdd}
                  blurOnSubmit={false}
                  placeholder="Add task"
                  placeholderTextColor={colors.placeholder}
                  returnKeyType="done"
                />
              </View>
            </ScrollView>
          </View>
        )}
      </View>

      {dragTask && (
        <Animated.View pointerEvents="none" style={[styles.ghost, ghostStyle]}>
          <View style={[styles.ghostDot, { borderColor: project?.color || colors.accent }]} />
          <Text style={styles.ghostText} numberOfLines={1}>
            {dragTask.title || 'New To-Do'}
          </Text>
        </Animated.View>
      )}
    </View>
  );
}

// Long-press to drag; a plain tap still opens the task. The ghost (rendered at
// the planner root) follows the pointer; the original stays put and the store
// update on drop re-places it.
function Draggable({ task, ctx, onOpen, style, children }) {
  const pan = Gesture.Pan()
    .activateAfterLongPress(160)
    .onStart(() => {
      runOnJS(ctx.begin)(task);
    })
    .onUpdate((e) => {
      ctx.ghostX.value = e.absoluteX - ctx.rootX.value - 18;
      ctx.ghostY.value = e.absoluteY - ctx.rootY.value - 14;
    })
    .onEnd((e) => {
      runOnJS(ctx.end)(task.id, e.absoluteX, e.absoluteY);
    });
  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={style}>
        <Pressable onPress={() => onOpen(task.id)} style={styles.fill}>
          {children}
        </Pressable>
      </Animated.View>
    </GestureDetector>
  );
}

// A soft tinted fill from the project color for a block background.
function tint(hex) {
  const h = hex.replace('#', '');
  if (h.length !== 6) return colors.accentSoft;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, 0.14)`;
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingLeft: spacing.lg, paddingRight: spacing.lg },
  fill: { flex: 1, ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null) },
  dayNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
    paddingTop: spacing.xs,
  },
  planBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separatorStrong,
    marginRight: spacing.sm,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  planBtnActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  planText: { ...typography.subhead, color: colors.textSecondary, fontWeight: '600' },
  dayLabel: { ...typography.heading, color: colors.text },
  dayNavBtns: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  todayBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separatorStrong,
    marginRight: spacing.xs,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  todayText: { ...typography.subhead, color: colors.textSecondary, fontWeight: '600' },
  navBtn: { padding: 2, ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null) },
  row: { flex: 1, flexDirection: 'row', gap: spacing.lg },
  leftCol: { flex: 1 },
  gridScroll: { flex: 1 },
  allDay: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    minHeight: 34,
    paddingVertical: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
    marginBottom: spacing.xs,
  },
  allDayLabel: { ...typography.caption, color: colors.textTertiary, width: 44, paddingTop: 4 },
  allDayItems: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  allDayHint: { ...typography.caption, color: colors.separatorStrong, paddingTop: 4, fontStyle: 'italic' },
  allDayChipWrap: { maxWidth: '100%' },
  allDayChip: {
    borderLeftWidth: 3,
    borderRadius: 4,
    backgroundColor: colors.groupedBackground,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  allDayChipText: { ...typography.caption, color: colors.text },
  grid: { position: 'relative', marginTop: spacing.xs },
  hourRow: { position: 'absolute', left: 0, right: 0, height: HOUR_H, flexDirection: 'row', alignItems: 'flex-start' },
  hourLabel: { ...typography.caption, color: colors.textTertiary, width: 44, marginTop: -6, fontVariant: ['tabular-nums'] },
  hourLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.separator, marginTop: 0 },
  nowLine: { position: 'absolute', left: 44, right: 0, height: 2, backgroundColor: colors.deadline },
  nowDot: {
    position: 'absolute',
    left: -4,
    top: -3,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.deadline,
  },
  block: { position: 'absolute', left: 50, right: 4 },
  blockInner: {
    flex: 1,
    borderLeftWidth: 3,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    overflow: 'hidden',
  },
  blockTitle: { ...typography.caption, color: colors.text, fontWeight: '600' },
  blockTime: { ...typography.caption, color: colors.textSecondary, fontSize: 10 },
  done: { color: colors.textTertiary, textDecorationLine: 'line-through' },
  panel: {
    width: PANEL_W,
    backgroundColor: colors.groupedBackground,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.separator,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    // Bleed to the pane's right edge so it reads as a sidebar like the app's.
    marginRight: -spacing.lg,
  },
  panelScroll: { flex: 1 },
  panelTitle: { ...typography.heading, color: colors.text, marginBottom: spacing.xs },
  panelCount: { ...typography.subhead, color: colors.textTertiary },
  panelItemWrap: {},
  panelItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  panelDot: { width: 16, height: 16, borderRadius: 8, borderWidth: 1.5, marginTop: 1 },
  panelItemText: { flex: 1, ...typography.subhead, color: colors.text },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.sm },
  addInput: {
    flex: 1,
    ...typography.subhead,
    color: colors.text,
    padding: 0,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null),
  },
  ghost: {
    position: 'absolute',
    top: 0,
    left: 0,
    zIndex: 1000,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    maxWidth: 240,
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
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
  ghostDot: { width: 14, height: 14, borderRadius: 7, borderWidth: 1.5 },
  ghostText: { ...typography.subhead, color: colors.text, flexShrink: 1 },
});

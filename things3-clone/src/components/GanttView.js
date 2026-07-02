import React, { useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, runOnJS } from 'react-native-reanimated';
import { colors, spacing, typography, radius } from '../theme';
import { WHEN, STATUS } from '../store/constants';
import { useTasks } from '../store/TasksContext';
import { selectSubtasks } from '../store/selectors';
import { todayKey, keyToDate, addDays, MONTHS_SHORT, WEEKDAYS_SHORT } from '../utils/date';

const LEFT_W = 264;
const ROW_H = 40;
const SECTION_H = 32;
const HEADER_H = 52;
const BAR_H = 22;

const dayMs = 86400000;
const daysBetween = (a, b) => Math.round((keyToDate(b) - keyToDate(a)) / dayMs);

function whenKey(t) {
  if (t.when === WHEN.TODAY || t.when === WHEN.EVENING) return todayKey();
  if (!t.when || t.when === WHEN.SOMEDAY) return null;
  return t.when;
}
// [start,end] = [Date, Deadline]; single date → one day; inverted → swapped.
function span(t) {
  const s = whenKey(t);
  const e = t.deadline || null;
  if (s && e) return s <= e ? [s, e] : [e, s];
  if (s) return [s, s];
  if (e) return [e, e];
  return null;
}
function fmtShort(key) {
  const d = keyToDate(key);
  return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
}
function tint(hex, a) {
  const h = (hex || '').replace('#', '');
  if (h.length !== 6) return colors.accentSoft;
  return `rgba(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}, ${a})`;
}

// A self-made Gantt/timeline view for a project. Left: a task grid (name / start
// / duration) grouped by section. Right: a scrolling timeline with a month+day
// header, weekend shading, a "today" line, and a progress bar per task running
// from its Date (start) to its Deadline (end). Bars can be dragged to reschedule
// and resized from either end. Zoom toggles day/week column width.
export default function GanttView({ sections, project, onUpdateTask, onOpenTask }) {
  const { state } = useTasks();
  const [scale, setScale] = useState('day');
  const DAY_W = scale === 'day' ? 38 : 16;

  const color = project?.color || colors.accent;

  // Rows: a section header followed by its tasks (tasks without dates still list,
  // just without a bar).
  const rows = [];
  const allSpans = [];
  sections.forEach((s) => {
    if (!s.data.length) return;
    rows.push({ type: 'section', key: `s:${s.key}`, title: s.heading ? s.title : '(No Section)' });
    s.data.forEach((t) => {
      const sp = span(t);
      if (sp) allSpans.push(sp);
      rows.push({ type: 'task', key: t.id, task: t, span: sp });
    });
  });

  const gridRef = useRef(null);
  const rectRef = useRef(null);

  if (!allSpans.length) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>No tasks with a Date or Deadline to plot.</Text>
      </View>
    );
  }

  let minKey = allSpans[0][0];
  let maxKey = allSpans[0][1];
  allSpans.forEach(([s, e]) => {
    if (s < minKey) minKey = s;
    if (e > maxKey) maxKey = e;
  });
  const startKey = addDays(minKey, -2);
  const endKey = addDays(maxKey, 3);
  const numDays = daysBetween(startKey, endKey) + 1;
  const days = Array.from({ length: numDays }, (_, i) => addDays(startKey, i));
  const todayK = todayKey();
  const timelineWidth = numDays * DAY_W;

  // Month header segments (top row): contiguous runs of the same month.
  const months = [];
  days.forEach((k, i) => {
    const d = keyToDate(k);
    const label = `${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
    const last = months[months.length - 1];
    if (last && last.label === label) last.span += 1;
    else months.push({ label, span: 1, startIdx: i });
  });

  const progressOf = (t) => {
    const kids = selectSubtasks(state.tasks, t.id);
    if (kids.length) return kids.filter((k) => k.status !== STATUS.OPEN).length / kids.length;
    return t.status !== STATUS.OPEN ? 1 : 0;
  };

  const measure = () =>
    new Promise((res) => {
      const n = gridRef.current;
      if (n && n.measureInWindow) n.measureInWindow((x, y, w, h) => { rectRef.current = { x, y, w, h }; res(); });
      else res();
    });

  // Commit a bar drag. mode: 'move' | 'left' | 'right'. deltaDays already rounded.
  const commitBar = (taskId, mode, deltaDays) => {
    if (!deltaDays) return;
    const t = state.tasks.find((x) => x.id === taskId);
    if (!t) return;
    const sp = span(t);
    if (!sp) return;
    const [s, e] = sp;
    if (mode === 'move') {
      const patch = {};
      if (whenKey(t)) patch.when = addDays(whenKey(t), deltaDays);
      if (t.deadline) patch.deadline = addDays(t.deadline, deltaDays);
      if (!whenKey(t) && !t.deadline) return;
      // A single-date task: shift whichever date it has.
      onUpdateTask(taskId, patch);
    } else if (mode === 'left') {
      const ns = addDays(s, deltaDays);
      if (ns <= e) onUpdateTask(taskId, { when: ns });
    } else if (mode === 'right') {
      const ne = addDays(e, deltaDays);
      if (ne >= s) onUpdateTask(taskId, { deadline: ne });
    }
  };

  const dragCtx = { DAY_W, measure, rectRef, commitBar, startKey, timelineWidth };

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <View style={styles.zoomRow}>
          {[
            { k: 'day', label: 'Day' },
            { k: 'week', label: 'Week' },
          ].map((z) => (
            <Pressable
              key={z.k}
              onPress={() => setScale(z.k)}
              style={[styles.zoomBtn, scale === z.k && styles.zoomBtnActive]}
            >
              <Text style={[styles.zoomText, scale === z.k && styles.zoomTextActive]}>{z.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <ScrollView style={styles.body} showsVerticalScrollIndicator contentContainerStyle={{ minHeight: '100%' }}>
        <View style={styles.split}>
          {/* Left grid */}
          <View style={styles.grid}>
            <View style={[styles.gridHeader, { height: HEADER_H }]}>
              <Text style={[styles.gh, styles.ghName]}>Task</Text>
              <Text style={[styles.gh, styles.ghStart]}>Start</Text>
              <Text style={[styles.gh, styles.ghDur]}>Days</Text>
            </View>
            {rows.map((r) =>
              r.type === 'section' ? (
                <View key={r.key} style={[styles.gridSection, { height: SECTION_H }]}>
                  <Text style={styles.gridSectionText} numberOfLines={1}>{r.title}</Text>
                </View>
              ) : (
                <Pressable
                  key={r.key}
                  style={[styles.gridRow, { height: ROW_H }]}
                  onPress={() => onOpenTask(r.task.id)}
                >
                  <Text
                    style={[styles.gName, r.task.status !== STATUS.OPEN && styles.done]}
                    numberOfLines={1}
                  >
                    {r.task.title || 'New To-Do'}
                  </Text>
                  <Text style={styles.gStart}>{r.span ? fmtShort(r.span[0]) : '—'}</Text>
                  <Text style={styles.gDur}>{r.span ? daysBetween(r.span[0], r.span[1]) + 1 : '—'}</Text>
                </Pressable>
              )
            )}
          </View>

          {/* Right timeline */}
          <ScrollView horizontal showsHorizontalScrollIndicator style={styles.tlScroll}>
            <View
              ref={gridRef}
              collapsable={false}
              style={{ width: timelineWidth }}
            >
              {/* header: months + days */}
              <View style={[styles.tlHeader, { height: HEADER_H, width: timelineWidth }]}>
                <View style={styles.tlMonths}>
                  {months.map((m) => (
                    <View key={m.startIdx} style={[styles.tlMonth, { width: m.span * DAY_W }]}>
                      <Text style={styles.tlMonthText} numberOfLines={1}>{m.label}</Text>
                    </View>
                  ))}
                </View>
                <View style={styles.tlDays}>
                  {days.map((k, i) => {
                    const d = keyToDate(k);
                    const wd = d.getDay();
                    const showDay = scale === 'day' || wd === 1; // week scale: Mondays
                    return (
                      <View
                        key={k}
                        style={[
                          styles.tlDay,
                          { width: DAY_W },
                          (wd === 0 || wd === 6) && styles.tlWeekend,
                          k === todayK && styles.tlTodayCol,
                        ]}
                      >
                        {showDay && (
                          <Text style={[styles.tlDayText, k === todayK && styles.tlTodayText]}>
                            {scale === 'day' ? d.getDate() : `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`}
                          </Text>
                        )}
                      </View>
                    );
                  })}
                </View>
              </View>

              {/* rows */}
              {rows.map((r) => {
                if (r.type === 'section') {
                  return (
                    <View key={r.key} style={[styles.tlSection, { height: SECTION_H, width: timelineWidth }]}>
                      <DayGrid days={days} DAY_W={DAY_W} todayK={todayK} />
                    </View>
                  );
                }
                return (
                  <View key={r.key} style={[styles.tlRow, { height: ROW_H, width: timelineWidth }]}>
                    <DayGrid days={days} DAY_W={DAY_W} todayK={todayK} />
                    {r.span && (
                      <Bar
                        task={r.task}
                        span={r.span}
                        color={color}
                        progress={progressOf(r.task)}
                        ctx={dragCtx}
                        onOpen={onOpenTask}
                      />
                    )}
                  </View>
                );
              })}
            </View>
          </ScrollView>
        </View>
      </ScrollView>
    </View>
  );
}

// Faint per-day gridlines + weekend shading + today column, drawn behind bars.
function DayGrid({ days, DAY_W, todayK }) {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={{ flexDirection: 'row' }}>
        {days.map((k) => {
          const wd = keyToDate(k).getDay();
          return (
            <View
              key={k}
              style={[
                { width: DAY_W, height: '100%', borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.separator },
                (wd === 0 || wd === 6) && { backgroundColor: 'rgba(0,0,0,0.02)' },
                k === todayK && { backgroundColor: colors.accentSoft },
              ]}
            />
          );
        })}
      </View>
    </View>
  );
}

// A draggable/resizable task bar. Body drag moves both dates; the end handles
// resize the start (Date) or end (Deadline). Live transform via shared values;
// the store update on release re-lays it out.
function Bar({ task, span, color, progress, ctx, onOpen }) {
  const { DAY_W, startKey } = ctx;
  const left = daysBetween(startKey, span[0]) * DAY_W;
  const width = (daysBetween(span[0], span[1]) + 1) * DAY_W;
  const done = task.status !== STATUS.OPEN;

  const tx = useSharedValue(0);
  const dw = useSharedValue(0);
  const dl = useSharedValue(0);
  const moved = useSharedValue(false);
  const draggedRef = React.useRef(false);

  const barStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: left + tx.value + dl.value }],
    width: Math.max(DAY_W, width + dw.value - dl.value),
  }));

  const markDragged = () => {
    draggedRef.current = true;
  };
  const handlePress = () => {
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    onOpen(task.id);
  };
  const finish = (mode) => (deltaPx) => {
    'worklet';
    const delta = Math.round(deltaPx / DAY_W);
    tx.value = 0;
    dw.value = 0;
    dl.value = 0;
    runOnJS(ctx.commitBar)(task.id, mode, delta);
  };

  const makeDrag = (mode) =>
    Gesture.Pan()
      .activateAfterLongPress(150)
      .onStart(() => {
        moved.value = false;
      })
      .onUpdate((e) => {
        const far = Math.abs(e.translationX) > 4;
        if (far && !moved.value) {
          moved.value = true;
          runOnJS(markDragged)();
        }
        if (!moved.value) return;
        if (mode === 'move') tx.value = e.translationX;
        else if (mode === 'left') dl.value = e.translationX;
        else dw.value = e.translationX;
      })
      .onEnd((e) => {
        if (moved.value) finish(mode)(e.translationX);
        else {
          tx.value = 0;
          dw.value = 0;
          dl.value = 0;
        }
      });

  const moveG = makeDrag('move');
  const leftG = makeDrag('left');
  const rightG = makeDrag('right');
  const narrow = width < 64;

  return (
    <Animated.View style={[styles.bar, barStyle]}>
      <GestureDetector gesture={leftG}>
        <View style={styles.handle} />
      </GestureDetector>
      <GestureDetector gesture={moveG}>
        <Pressable onPress={handlePress} style={[styles.barBody, { backgroundColor: tint(color, 0.28) }]}>
          <View style={[styles.barFill, { width: `${Math.round(progress * 100)}%`, backgroundColor: color }]} />
          {!narrow && (
            <Text style={[styles.barLabel, done && styles.done]} numberOfLines={1}>
              {task.title || 'New To-Do'}
            </Text>
          )}
        </Pressable>
      </GestureDetector>
      <GestureDetector gesture={rightG}>
        <View style={styles.handle} />
      </GestureDetector>
      {narrow && (
        <Text style={[styles.barLabelOutside, done && styles.done]} numberOfLines={1}>
          {task.title || 'New To-Do'}
        </Text>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  toolbar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  zoomRow: { flexDirection: 'row', backgroundColor: colors.separator, borderRadius: 8, padding: 2, gap: 2 },
  zoomBtn: { paddingHorizontal: spacing.md, paddingVertical: 4, borderRadius: 6, ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null) },
  zoomBtnActive: { backgroundColor: colors.card },
  zoomText: { ...typography.subhead, color: colors.textSecondary },
  zoomTextActive: { color: colors.text, fontWeight: '600' },
  body: { flex: 1 },
  split: { flexDirection: 'row', paddingLeft: spacing.lg },
  grid: {
    width: LEFT_W,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.separatorStrong,
    backgroundColor: colors.background,
  },
  gridHeader: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingBottom: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  gh: { ...typography.caption, color: colors.textTertiary, fontWeight: '700', textTransform: 'uppercase' },
  ghName: { flex: 1, paddingLeft: spacing.sm },
  ghStart: { width: 52, textAlign: 'right' },
  ghDur: { width: 40, textAlign: 'right', paddingRight: spacing.sm },
  gridSection: {
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    backgroundColor: colors.groupedBackground,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  gridSectionText: { ...typography.subhead, color: colors.text, fontWeight: '600' },
  gridRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  gName: { flex: 1, ...typography.subhead, color: colors.text, paddingLeft: spacing.sm },
  gStart: { width: 52, textAlign: 'right', ...typography.caption, color: colors.textSecondary },
  gDur: { width: 40, textAlign: 'right', paddingRight: spacing.sm, ...typography.caption, color: colors.textSecondary },
  done: { color: colors.textTertiary, textDecorationLine: 'line-through' },
  tlScroll: { flex: 1 },
  tlHeader: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separatorStrong },
  tlMonths: { flexDirection: 'row', height: 22, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator },
  tlMonth: { justifyContent: 'center', paddingHorizontal: spacing.sm, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.separator },
  tlMonthText: { ...typography.caption, color: colors.textSecondary, fontWeight: '600' },
  tlDays: { flexDirection: 'row', flex: 1 },
  tlDay: { alignItems: 'center', justifyContent: 'center', height: '100%' },
  tlWeekend: { backgroundColor: 'rgba(0,0,0,0.02)' },
  tlTodayCol: { backgroundColor: colors.accentSoft },
  tlDayText: { ...typography.caption, color: colors.textTertiary, fontSize: 10 },
  tlTodayText: { color: colors.accent, fontWeight: '700' },
  tlSection: { backgroundColor: colors.groupedBackground, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator },
  tlRow: { justifyContent: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator },
  bar: {
    position: 'absolute',
    height: BAR_H,
    left: 0,
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  handle: {
    width: 8,
    ...(Platform.OS === 'web' ? { cursor: 'ew-resize' } : null),
  },
  barBody: {
    flex: 1,
    borderRadius: radius.sm,
    justifyContent: 'center',
    overflow: 'hidden',
    ...(Platform.OS === 'web' ? { cursor: 'grab' } : null),
  },
  barFill: { ...StyleSheet.absoluteFillObject, right: undefined, borderRadius: radius.sm },
  barLabel: { ...typography.caption, color: colors.text, fontWeight: '600', paddingHorizontal: spacing.sm },
  barLabelOutside: {
    position: 'absolute',
    left: '100%',
    marginLeft: 6,
    top: 0,
    bottom: 0,
    textAlignVertical: 'center',
    width: 200,
    ...typography.caption,
    color: colors.textSecondary,
    lineHeight: BAR_H,
  },
  empty: { padding: spacing.xl, alignItems: 'center' },
  emptyText: { ...typography.body, color: colors.textTertiary },
});

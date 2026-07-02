import React, { useRef, useState, useEffect } from 'react';
import { View, Text, Pressable, TextInput, ScrollView, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, runOnJS } from 'react-native-reanimated';
import { colors, spacing, typography, radius } from '../theme';
import { WHEN, STATUS } from '../store/constants';
import { todayKey, addDays, formatDayKey } from '../utils/date';

const END_HOUR = 23;
const HOUR_H = 46;
const SNAP = 15;
const DEFAULT_DUR = 60;
const PANEL_W = 236;
const GRID_BOTTOM_PAD = 12; // room below the 23:00 label before the next day header

const DHEADER_H = 34;
const ALLDAY_H = 30;

// Continuous range of days shown in the timeline (past .. future).
const RANGE_PAST = 30;
const RANGE_FUTURE = 60;
const TODAY_INDEX = RANGE_PAST;
const NUM_DAYS = RANGE_PAST + RANGE_FUTURE + 1;

function whenKey(t) {
  if (t.when === WHEN.TODAY || t.when === WHEN.EVENING) return todayKey();
  if (!t.when || t.when === WHEN.SOMEDAY) return null;
  return t.when;
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmt = (mins) =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

// Lay out overlapping blocks side by side (like a calendar): tasks that overlap
// in time form a cluster and are split into equal-width columns. Returns a Map
// of task.id -> { col, count }.
function layoutOverlaps(timed) {
  const items = timed
    .map((t) => ({ id: t.id, s: t.startMinutes, e: t.startMinutes + (t.durationMinutes || DEFAULT_DUR) }))
    .sort((a, b) => a.s - b.s || a.e - b.e);
  const out = new Map();
  let cluster = [];
  let clusterEnd = -1;
  const flush = () => {
    const count = cluster.reduce((m, c) => Math.max(m, c.col + 1), 1);
    cluster.forEach((c) => out.set(c.id, { col: c.col, count }));
    cluster = [];
    clusterEnd = -1;
  };
  items.forEach((it) => {
    if (cluster.length && it.s >= clusterEnd) flush();
    const used = new Set(cluster.filter((c) => c.e > it.s).map((c) => c.col));
    let col = 0;
    while (used.has(col)) col += 1;
    cluster.push({ id: it.id, e: it.e, col });
    clusterEnd = Math.max(clusterEnd, it.e);
  });
  if (cluster.length) flush();
  return out;
}

// A day-planner timeline that scrolls continuously across many dates (past and
// future). Each day is a fixed-height section: an all-day strip over an hour
// grid. Timed tasks are blocks; undated tasks live in the right "Unscheduled"
// panel. Tasks drag (long-press) onto any day's hour to time-block them, onto a
// day's all-day strip to clear the time, or back to the panel to unschedule.
export default function DayPlanner({ tasks, project, onOpenTask, onUpdateTask, onAddTask, startHour = 0, focusDate = null, dateFormat = 'weekday-long' }) {
  const HOURS = END_HOUR - startHour;
  const GRID_H = HOURS * HOUR_H + GRID_BOTTOM_PAD;
  const DAY_H = DHEADER_H + ALLDAY_H + GRID_H;

  // The timeline window is centered on an anchor date (today by default, or a
  // date tapped in the Month view). Tapping "Today" re-centers on today.
  const [anchor, setAnchor] = useState(focusDate || todayKey());
  useEffect(() => { if (focusDate) setAnchor(focusDate); }, [focusDate]);

  const [dragTask, setDragTask] = useState(null);
  const [dropInfo, setDropInfo] = useState(null); // { dayKey, top }
  const [showPanel, setShowPanel] = useState(true);
  const [newTitle, setNewTitle] = useState('');

  const rootRef = useRef(null);
  const panelRef = useRef(null);
  const scrollRef = useRef(null);
  const scrollYRef = useRef(0);
  const rectsRef = useRef(null);
  const scrolledRef = useRef(false);

  const ghostX = useSharedValue(0);
  const ghostY = useSharedValue(0);
  const rootX = useSharedValue(0);
  const rootY = useSharedValue(0);

  const startKey = addDays(anchor, -RANGE_PAST);
  const days = Array.from({ length: NUM_DAYS }, (_, i) => addDays(startKey, i));
  const todayK = todayKey();

  // Bucket tasks: by day for scheduled ones, split timed vs all-day; undated go
  // to the panel.
  const timedByDay = {};
  const allDayByDay = {};
  const unscheduled = [];
  tasks.forEach((t) => {
    const k = whenKey(t);
    if (!k) { unscheduled.push(t); return; }
    if (t.startMinutes != null) (timedByDay[k] = timedByDay[k] || []).push(t);
    else (allDayByDay[k] = allDayByDay[k] || []).push(t);
  });

  const measureOnly = () => {
    const grab = (ref, key, store) =>
      new Promise((res) => {
        const n = ref.current;
        if (n && n.measureInWindow) n.measureInWindow((x, y, w, h) => { store[key] = { x, y, w, h }; res(); });
        else res();
      });
    const store = {};
    Promise.all([grab(scrollRef, 'view', store), grab(panelRef, 'panel', store), grab(rootRef, 'root', store)]).then(() => {
      rectsRef.current = store;
      if (store.root) { rootX.value = store.root.x; rootY.value = store.root.y; }
    });
  };

  // Resolve a pointer to a drop: which day, and grid time vs all-day vs panel.
  // The scroll viewport is measured once; the day is derived analytically from
  // the current scroll offset (each day is a fixed DAY_H).
  const computeDrop = (ax, ay) => {
    const c = rectsRef.current || {};
    if (c.panel) {
      const p = c.panel;
      if (ax >= p.x && ax <= p.x + p.w && ay >= p.y && ay <= p.y + p.h) return { mode: 'panel' };
    }
    const view = c.view;
    if (!view || ax < view.x || ax > view.x + view.w || ay < view.y || ay > view.y + view.h) return null;
    const rel = ay - view.y + scrollYRef.current;
    if (rel < 0 || rel >= NUM_DAYS * DAY_H) return null;
    const di = Math.floor(rel / DAY_H);
    const dayKey = days[di];
    const within = rel - di * DAY_H;
    if (within < DHEADER_H + ALLDAY_H) return { mode: 'allday', dayKey };
    const gy = within - (DHEADER_H + ALLDAY_H);
    let mins = startHour * 60 + Math.round((gy / HOUR_H) * 60 / SNAP) * SNAP;
    mins = clamp(mins, startHour * 60, END_HOUR * 60 - SNAP);
    return { mode: 'grid', dayKey, mins, top: ((mins - startHour * 60) / 60) * HOUR_H };
  };

  const begin = (task) => setDragTask(task);
  const cancelDrag = () => { setDragTask(null); setDropInfo(null); };
  const updateDrop = (ax, ay) => {
    const d = computeDrop(ax, ay);
    if (d && d.mode === 'grid') {
      setDropInfo((prev) => (prev && prev.dayKey === d.dayKey && prev.top === d.top ? prev : { dayKey: d.dayKey, top: d.top }));
    } else {
      setDropInfo((prev) => (prev ? null : prev));
    }
  };
  const end = (taskId, ax, ay) => {
    setDragTask(null);
    setDropInfo(null);
    const d = computeDrop(ax, ay);
    const task = tasks.find((t) => t.id === taskId);
    if (!d || !task) return;
    if (d.mode === 'grid') {
      onUpdateTask(taskId, { when: d.dayKey, startMinutes: d.mins, durationMinutes: task.durationMinutes || DEFAULT_DUR });
    } else if (d.mode === 'allday') {
      onUpdateTask(taskId, { when: d.dayKey, startMinutes: null });
    } else if (d.mode === 'panel') {
      onUpdateTask(taskId, { when: null, startMinutes: null });
    }
  };

  const dragCtx = { ghostX, ghostY, rootX, rootY, measureOnly, begin, cancelDrag, updateDrop, end };
  const ghostStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: ghostX.value }, { translateY: ghostY.value }],
  }));

  // The anchor day always sits at index RANGE_PAST in the window.
  const scrollToToday = () => {
    const ti = days.indexOf(todayK);
    if (ti >= 0) scrollRef.current?.scrollTo({ y: ti * DAY_H, animated: true });
    else setAnchor(todayKey()); // today is outside the window — recenter on it
  };
  const onContentReady = () => {
    if (scrolledRef.current) return;
    scrolledRef.current = true;
    scrollRef.current?.scrollTo({ y: RANGE_PAST * DAY_H, animated: false });
  };
  // Recenter when the anchor changes (Today from out-of-range, or a tapped date).
  useEffect(() => {
    if (!scrolledRef.current) return; // initial position handled by onContentReady
    scrollRef.current?.scrollTo({ y: RANGE_PAST * DAY_H, animated: false });
  }, [anchor]);

  const submitAdd = () => {
    const title = newTitle.trim();
    if (!title) return;
    onAddTask({ title });
    setNewTitle('');
  };

  const dropH = ((dragTask?.durationMinutes || DEFAULT_DUR) / 60) * HOUR_H;
  const color = project?.color || colors.accent;

  // Flatten days into [header, body, header, body, ...] so each date header can
  // be a sticky section header (scrolls with its day, pins while it's in view).
  const items = [];
  const stickyIndices = [];
  days.forEach((k) => {
    stickyIndices.push(items.length);
    items.push(
      <DayHeader key={`h${k}`} dayKey={k} isToday={k === todayK} height={DHEADER_H} dateFormat={dateFormat} />
    );
    items.push(
      <DayBody
        key={`b${k}`}
        dayKey={k}
        isToday={k === todayK}
        timed={timedByDay[k] || []}
        allDay={allDayByDay[k] || []}
        color={color}
        ctx={dragCtx}
        onOpen={onOpenTask}
        startHour={startHour}
        gridH={GRID_H}
        bodyH={ALLDAY_H + GRID_H}
        placeholder={dropInfo && dropInfo.dayKey === k ? { top: dropInfo.top, h: dropH } : null}
      />
    );
  });

  return (
    <View ref={rootRef} collapsable={false} style={styles.root}>
      <View style={styles.toolbar}>
        <Text style={styles.title}>Timeline</Text>
        <View style={styles.toolBtns}>
          <Pressable
            onPress={() => setShowPanel((v) => !v)}
            style={[styles.planBtn, showPanel && styles.planBtnActive]}
          >
            <Ionicons name="albums-outline" size={15} color={showPanel ? colors.accent : colors.textSecondary} />
            <Text style={[styles.planText, showPanel && { color: colors.accent }]}>Plan {unscheduled.length}</Text>
          </Pressable>
          <Pressable onPress={scrollToToday} style={styles.todayBtn}>
            <Text style={styles.todayText}>Today</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.row}>
        <ScrollView
          ref={scrollRef}
          style={styles.scroll}
          showsVerticalScrollIndicator={false}
          stickyHeaderIndices={stickyIndices}
          scrollEventThrottle={16}
          onScroll={(e) => { scrollYRef.current = e.nativeEvent.contentOffset.y; }}
          onContentSizeChange={onContentReady}
        >
          {items}
        </ScrollView>

        {showPanel && (
          <View ref={panelRef} collapsable={false} style={styles.panel}>
            <Text style={styles.panelTitle}>
              Unscheduled <Text style={styles.panelCount}>{unscheduled.length}</Text>
            </Text>
            <ScrollView style={styles.panelScroll} showsVerticalScrollIndicator={false}>
              {unscheduled.map((t) => (
                <Draggable key={t.id} task={t} ctx={dragCtx} onOpen={onOpenTask} style={styles.panelItemWrap}>
                  <View style={styles.panelItem}>
                    <View style={[styles.panelDot, { borderColor: color }]} />
                    <Text style={[styles.panelItemText, t.status !== STATUS.OPEN && styles.done]} numberOfLines={2}>
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
          <View style={[styles.ghostDot, { borderColor: color }]} />
          <Text style={styles.ghostText} numberOfLines={1}>{dragTask.title || 'New To-Do'}</Text>
        </Animated.View>
      )}
    </View>
  );
}

// The sticky per-day date header. Pins to the top while its day is in view,
// then the next day's header pushes it up (mirrors the Month view).
function DayHeader({ dayKey, isToday, height, dateFormat }) {
  return (
    <View style={[styles.dayHeader, { height }, isToday && styles.dayHeaderToday]}>
      <Text style={[styles.dayHeaderText, isToday && styles.dayHeaderTextToday]}>
        {formatDayKey(dayKey, dateFormat)}
      </Text>
    </View>
  );
}

// One day's body: the all-day strip over the hour grid with its blocks.
function DayBody({ dayKey, isToday, timed, allDay, color, ctx, onOpen, placeholder, startHour, gridH, bodyH }) {
  const layout = layoutOverlaps(timed);
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const showNow = isToday && nowMins >= startHour * 60 && nowMins <= END_HOUR * 60;
  const nowTop = ((nowMins - startHour * 60) / 60) * HOUR_H;

  return (
    <View style={{ height: bodyH }}>
      <View style={[styles.allDay, { height: ALLDAY_H }]}>
        {allDay.slice(0, 8).map((t) => (
          <Draggable key={t.id} task={t} ctx={ctx} onOpen={onOpen} style={styles.allDayChipWrap}>
            <View style={[styles.allDayChip, { borderColor: color }]}>
              <Text style={styles.allDayChipText} numberOfLines={1}>{t.title || 'New To-Do'}</Text>
            </View>
          </Draggable>
        ))}
        {allDay.length > 8 && <Text style={styles.moreText}>+{allDay.length - 8}</Text>}
      </View>

      <View style={[styles.grid, { height: gridH }]}>
        {Array.from({ length: END_HOUR - startHour + 1 }, (_, i) => startHour + i).map((h) => (
          <View key={h} style={[styles.hourRow, { top: (h - startHour) * HOUR_H }]}>
            <Text style={styles.hourLabel}>{fmt(h * 60)}</Text>
            <View style={styles.hourLine} />
          </View>
        ))}
        {showNow && (
          <View style={[styles.nowLine, { top: nowTop }]} pointerEvents="none">
            <View style={styles.nowDot} />
          </View>
        )}
        {placeholder && (
          <View style={[styles.dropPlaceholder, { top: placeholder.top, height: placeholder.h }]} pointerEvents="none" />
        )}
        <View style={styles.blockLayer}>
          {timed.map((t) => {
            const top = ((t.startMinutes - startHour * 60) / 60) * HOUR_H;
            const height = Math.max(18, ((t.durationMinutes || DEFAULT_DUR) / 60) * HOUR_H - 2);
            const done = t.status !== STATUS.OPEN;
            const { col = 0, count = 1 } = layout.get(t.id) || {};
            const left = `${(col / count) * 100}%`;
            const width = `${(1 / count) * 100}%`;
            return (
              <Draggable key={t.id} task={t} ctx={ctx} onOpen={onOpen} style={[styles.block, { top, height, left, width }]}>
                <View style={[styles.blockInner, { backgroundColor: tint(color), borderLeftColor: color }]}>
                  <Text style={[styles.blockTitle, done && styles.done]} numberOfLines={1}>{t.title || 'New To-Do'}</Text>
                  {count < 3 && (
                    <Text style={styles.blockTime} numberOfLines={1}>
                      {fmt(t.startMinutes)}–{fmt(t.startMinutes + (t.durationMinutes || DEFAULT_DUR))}
                    </Text>
                  )}
                </View>
              </Draggable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

// Long-press to drag; a plain tap opens. Only a real move starts a drag.
function Draggable({ task, ctx, onOpen, style, children }) {
  const dragged = React.useRef(false);
  const moved = useSharedValue(false);
  const markDragged = () => { dragged.current = true; };
  const handlePress = () => {
    if (dragged.current) { dragged.current = false; return; }
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
        runOnJS(ctx.begin)(task);
      }
      if (!moved.value) return;
      ctx.ghostX.value = e.absoluteX - ctx.rootX.value - 18;
      ctx.ghostY.value = e.absoluteY - ctx.rootY.value - 14;
      runOnJS(ctx.updateDrop)(e.absoluteX, e.absoluteY);
    })
    .onEnd((e) => {
      if (moved.value) runOnJS(ctx.end)(task.id, e.absoluteX, e.absoluteY);
      else runOnJS(ctx.cancelDrag)();
    });
  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={style}>
        <Pressable onPress={handlePress} style={styles.fill}>{children}</Pressable>
      </Animated.View>
    </GestureDetector>
  );
}

function tint(hex) {
  const h = (hex || '').replace('#', '');
  if (h.length !== 6) return colors.accentSoft;
  return `rgba(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}, 0.14)`;
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingLeft: spacing.lg },
  fill: { flex: 1, ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null) },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingRight: spacing.lg,
    paddingTop: spacing.xs,
    marginBottom: spacing.sm,
  },
  title: { ...typography.heading, color: colors.text },
  toolBtns: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  planBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separatorStrong,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  planBtnActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  planText: { ...typography.subhead, color: colors.textSecondary, fontWeight: '600' },
  todayBtn: {
    paddingHorizontal: spacing.md, paddingVertical: 4, borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separatorStrong,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  todayText: { ...typography.subhead, color: colors.textSecondary, fontWeight: '600' },
  row: { flex: 1, flexDirection: 'row' },
  scroll: { flex: 1 },
  dayHeader: {
    justifyContent: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separatorStrong,
    backgroundColor: colors.groupedBackground,
    paddingLeft: 4,
  },
  dayHeaderToday: { backgroundColor: colors.accentSoft },
  dayHeaderText: { ...typography.subhead, color: colors.textSecondary, fontWeight: '600' },
  dayHeaderTextToday: { color: colors.accent },
  allDay: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingLeft: 48,
    paddingRight: 4,
    overflow: 'hidden',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  allDayChipWrap: { maxWidth: 180 },
  allDayChip: {
    borderLeftWidth: 3, borderRadius: 4, backgroundColor: colors.groupedBackground,
    paddingHorizontal: spacing.sm, paddingVertical: 3,
  },
  allDayChipText: { ...typography.caption, color: colors.text },
  moreText: { ...typography.caption, color: colors.textTertiary },
  grid: { position: 'relative' },
  hourRow: { position: 'absolute', left: 0, right: 0, height: HOUR_H, flexDirection: 'row', alignItems: 'flex-start' },
  hourLabel: { ...typography.caption, color: colors.textTertiary, width: 44, marginTop: -6, fontVariant: ['tabular-nums'] },
  hourLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.separator },
  nowLine: { position: 'absolute', left: 44, right: 0, height: 2, backgroundColor: colors.deadline },
  nowDot: { position: 'absolute', left: -4, top: -3, width: 8, height: 8, borderRadius: 4, backgroundColor: colors.deadline },
  dropPlaceholder: {
    position: 'absolute', left: 50, right: 4,
    borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.accent,
    backgroundColor: colors.accentSoft, borderRadius: radius.sm,
  },
  // Blocks live in a layer that starts after the hour labels; each block's
  // left/width is a % of the layer so overlapping ones sit side by side.
  blockLayer: { position: 'absolute', left: 50, right: 4, top: 0, bottom: 0 },
  block: { position: 'absolute', paddingRight: 2 },
  blockInner: {
    flex: 1, borderLeftWidth: 3, borderRadius: radius.sm,
    paddingHorizontal: spacing.sm, paddingVertical: 3, overflow: 'hidden',
  },
  blockTitle: { ...typography.caption, color: colors.text, fontWeight: '600' },
  blockTime: { ...typography.caption, color: colors.textSecondary, fontSize: 10 },
  done: { color: colors.textTertiary, textDecorationLine: 'line-through' },
  panel: {
    width: PANEL_W, backgroundColor: colors.groupedBackground,
    borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.separator,
    paddingHorizontal: spacing.md, paddingTop: spacing.sm, marginRight: -spacing.lg,
  },
  panelScroll: { flex: 1 },
  panelTitle: { ...typography.heading, color: colors.text, marginBottom: spacing.xs },
  panelCount: { ...typography.subhead, color: colors.textTertiary },
  panelItemWrap: {},
  panelItem: {
    flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator,
  },
  panelDot: { width: 16, height: 16, borderRadius: 8, borderWidth: 1.5, marginTop: 1 },
  panelItemText: { flex: 1, ...typography.subhead, color: colors.text },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.sm },
  addInput: { flex: 1, ...typography.subhead, color: colors.text, padding: 0, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null) },
  ghost: {
    position: 'absolute', top: 0, left: 0, zIndex: 1000, flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    maxWidth: 240, paddingVertical: 6, paddingHorizontal: spacing.md, borderRadius: radius.sm,
    backgroundColor: colors.background, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separatorStrong,
    shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 6,
  },
  ghostDot: { width: 14, height: 14, borderRadius: 7, borderWidth: 1.5 },
  ghostText: { ...typography.subhead, color: colors.text, flexShrink: 1 },
});

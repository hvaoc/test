import React, { useRef, useState, useEffect } from 'react';
import { View, Text, Pressable, TextInput, ScrollView, FlatList, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, runOnJS } from 'react-native-reanimated';
import { colors, spacing, typography, radius } from '../theme';
import { WHEN, STATUS } from '../store/constants';
import { todayKey, addDays, formatDayKey, keyToDate, WEEKDAYS, nowMinutes } from '../utils/date';
import { layoutOverlaps } from '../utils/overlap';

const END_HOUR = 23;
const HOUR_H = 46;
const SNAP = 15;
const DEFAULT_DUR = 60;
const PANEL_W = 272;
const GRID_BOTTOM_PAD = 12; // room below the 23:00 label before the next day header

const DHEADER_H = 46; // tall sticky date header (matches the Month title band)
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

// A day-planner timeline that scrolls continuously across many dates (past and
// future). Each day is a fixed-height section: an all-day strip over an hour
// grid. Timed tasks are blocks; undated tasks live in the right "Unscheduled"
// panel. Tasks drag (long-press) onto any day's hour to time-block them, onto a
// day's all-day strip to clear the time, or back to the panel to unschedule.
export default function DayPlanner({ tasks, project, onOpenTask, onUpdateTask, onAddTask, startHour = 0, focusDate = null, onFocusDateChange, dateFormat = 'weekday-long' }) {
  const HOURS = END_HOUR - startHour;
  // Include the final 23:00 → 24:00 slot (one hour past the last hour label) so
  // the last hour is fully visible before the next day's header.
  const GRID_H = (HOURS + 1) * HOUR_H + GRID_BOTTOM_PAD;
  const DAY_H = DHEADER_H + ALLDAY_H + GRID_H;

  // The timeline window is centered on an anchor date — the focused date when
  // this view opened (today by default). We deliberately don't re-center on
  // later focusDate changes: as the user scrolls we *report* the top-visible
  // day upward instead, so switching to Week/Month keeps that day in view.
  const [anchor, setAnchor] = useState(focusDate || todayKey());
  const lastReportRef = useRef(focusDate || todayKey());

  const [dragTask, setDragTask] = useState(null);
  const [dropInfo, setDropInfo] = useState(null); // { dayKey, top }
  const [showPanel, setShowPanel] = useState(true);
  const [newTitle, setNewTitle] = useState('');

  const rootRef = useRef(null);
  const panelRef = useRef(null);
  const scrollRef = useRef(null); // FlatList (scrollToOffset only — no measureInWindow)
  const viewRef = useRef(null); // wrapper View around the list, used to measure the drop viewport
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
    Promise.all([grab(viewRef, 'view', store), grab(panelRef, 'panel', store), grab(rootRef, 'root', store)]).then(() => {
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
      setDropInfo((prev) => (prev && prev.dayKey === d.dayKey && prev.top === d.top ? prev : { dayKey: d.dayKey, top: d.top, mins: d.mins }));
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
    if (ti >= 0) scrollRef.current?.scrollToOffset({ offset: ti * DAY_H, animated: true });
    else setAnchor(todayKey()); // today is outside the window — recenter on it
  };
  const onContentReady = () => {
    if (scrolledRef.current) return;
    scrolledRef.current = true;
    scrollRef.current?.scrollToOffset({ offset: RANGE_PAST * DAY_H, animated: false });
  };
  // Recenter when the anchor changes (Today from out-of-range, or a tapped date).
  useEffect(() => {
    if (!scrolledRef.current) return; // initial position handled by onContentReady
    scrollRef.current?.scrollToOffset({ offset: RANGE_PAST * DAY_H, animated: false });
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
  // This drives a virtualized FlatList: only the on-screen days mount, so the
  // 91-day window stays cheap even with many timed tasks.
  const dayData = [];
  const stickyIndices = [];
  days.forEach((k) => {
    stickyIndices.push(dayData.length);
    dayData.push({ type: 'header', k, key: `h${k}` });
    dayData.push({ type: 'body', k, key: `b${k}` });
  });
  // Each day shares the DAY_H stride; header at the top, body (all-day + grid)
  // below — exact offsets keep scroll and the analytic drop math correct.
  const dayLayout = (_d, index) => {
    const dayIdx = Math.floor(index / 2);
    const isHeader = index % 2 === 0;
    return {
      length: isHeader ? DHEADER_H : ALLDAY_H + GRID_H,
      offset: dayIdx * DAY_H + (isHeader ? 0 : DHEADER_H),
      index,
    };
  };
  const renderDayItem = ({ item }) =>
    item.type === 'header' ? (
      <DayHeader dayKey={item.k} isToday={item.k === todayK} height={DHEADER_H} dateFormat={dateFormat} />
    ) : (
      <DayBody
        dayKey={item.k}
        isToday={item.k === todayK}
        timed={timedByDay[item.k] || []}
        allDay={allDayByDay[item.k] || []}
        color={color}
        ctx={dragCtx}
        onOpen={onOpenTask}
        startHour={startHour}
        gridH={GRID_H}
        bodyH={ALLDAY_H + GRID_H}
        placeholder={dropInfo && dropInfo.dayKey === item.k ? { top: dropInfo.top, h: dropH, mins: dropInfo.mins } : null}
      />
    );

  return (
    <View ref={rootRef} collapsable={false} style={styles.root}>
      <View style={styles.toolbar}>
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
        <View ref={viewRef} collapsable={false} style={styles.scroll}>
          <FlatList
            ref={scrollRef}
            data={dayData}
            keyExtractor={(it) => it.key}
            renderItem={renderDayItem}
            extraData={`${dropInfo?.dayKey}|${dropInfo?.top}|${DAY_H}`}
            getItemLayout={dayLayout}
            style={styles.scroll}
            showsVerticalScrollIndicator={false}
            stickyHeaderIndices={stickyIndices}
            scrollEventThrottle={16}
            onScroll={(e) => {
              const y = e.nativeEvent.contentOffset.y;
              scrollYRef.current = y;
              if (onFocusDateChange) {
                const idx = Math.max(0, Math.min(NUM_DAYS - 1, Math.round(y / DAY_H)));
                const d = days[idx];
                if (d && d !== lastReportRef.current) { lastReportRef.current = d; onFocusDateChange(d); }
              }
            }}
            onContentSizeChange={onContentReady}
            initialNumToRender={4}
            maxToRenderPerBatch={4}
            windowSize={5}
            removeClippedSubviews={false}
          />
        </View>

        {showPanel && (
          <View ref={panelRef} collapsable={false} style={styles.panel}>
            <Text style={styles.panelTitle}>
              Unscheduled <Text style={styles.panelCount}>{unscheduled.length}</Text>
            </Text>
            <FlatList
              style={styles.panelScroll}
              showsVerticalScrollIndicator={false}
              data={unscheduled}
              keyExtractor={(t) => t.id}
              extraData={dropInfo}
              initialNumToRender={20}
              maxToRenderPerBatch={20}
              windowSize={7}
              removeClippedSubviews={false}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item: t }) => (
                <Draggable task={t} ctx={dragCtx} onOpen={onOpenTask} style={styles.panelItemWrap}>
                  <View style={styles.panelItem}>
                    <View style={[styles.panelDot, { borderColor: color }]} />
                    <Text style={[styles.panelItemText, t.status !== STATUS.OPEN && styles.done]} numberOfLines={2}>
                      {t.title || 'New To-Do'}
                    </Text>
                  </View>
                </Draggable>
              )}
              ListFooterComponent={
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
              }
            />
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
function DayHeader({ dayKey, height, dateFormat }) {
  // Show the weekday subtly, right after the date title — but only when the
  // chosen date format doesn't already spell it out (weekday-long/short).
  const showWeekday = dateFormat !== 'weekday-long' && dateFormat !== 'weekday-short';
  return (
    <View style={[styles.dayHeader, { height }]}>
      <Text style={styles.dayHeaderText}>{formatDayKey(dayKey, dateFormat)}</Text>
      {showWeekday && (
        <Text style={styles.dayHeaderWeekday}>{WEEKDAYS[keyToDate(dayKey).getDay()]}</Text>
      )}
    </View>
  );
}

// One day's body: the all-day strip over the hour grid with its blocks.
function DayBody({ dayKey, isToday, timed, allDay, color, ctx, onOpen, placeholder, startHour, gridH, bodyH }) {
  const layout = layoutOverlaps(timed);
  const nowMins = nowMinutes();
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
        {Array.from({ length: END_HOUR - startHour + 2 }, (_, i) => startHour + i).map((h) => (
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
          <View style={[styles.dropLine, { top: placeholder.top }]} pointerEvents="none">
            <View style={styles.dropDot} />
            <View style={styles.dropRule} />
            <Text style={styles.dropTime}>{fmt(placeholder.mins)}</Text>
          </View>
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
                  <Text style={[styles.blockTitle, done && styles.done]} numberOfLines={2}>{t.title || 'New To-Do'}</Text>
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
    justifyContent: 'flex-end',
    paddingRight: spacing.lg,
    paddingTop: spacing.xs,
    marginBottom: spacing.sm,
  },
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separatorStrong,
    backgroundColor: colors.background,
    paddingLeft: 2,
  },
  dayHeaderText: { ...typography.title, color: colors.text },
  dayHeaderWeekday: { ...typography.subhead, color: colors.textTertiary },
  allDay: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingLeft: 48,
    paddingRight: 4,
    overflow: 'hidden',
  },
  allDayChipWrap: { maxWidth: 180 },
  allDayChip: {
    borderLeftWidth: 3, borderRadius: 4, backgroundColor: colors.surfaceMuted,
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
  // Line drop indicator: a dot + rule + snapped time, matching the day-peek.
  dropLine: { position: 'absolute', left: 50, right: 4, height: 0, flexDirection: 'row', alignItems: 'center' },
  dropDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent, marginLeft: -4 },
  dropRule: { flex: 1, height: 2, backgroundColor: colors.accent, borderRadius: 1 },
  dropTime: { ...typography.caption, color: colors.accent, fontWeight: '700', fontSize: 10, marginLeft: 4, marginRight: 4 },
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
    width: PANEL_W, backgroundColor: colors.surfaceMuted,
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

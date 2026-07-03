import React, { useRef, useState, useEffect } from 'react';
import { View, Text, Pressable, TextInput, ScrollView, FlatList, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, runOnJS } from 'react-native-reanimated';
import { colors, spacing, typography, radius } from '../theme';
import { WHEN, STATUS } from '../store/constants';
import { todayKey, keyToDate, MONTHS, WEEKDAYS_SHORT } from '../utils/date';
import DayPeekModal from './DayPeekModal';

const TITLE_H = 46; // month title band
const WEEKDAY_H = 24; // SUN–SAT row, sits under the title
const HEADER_H = TITLE_H + WEEKDAY_H; // sticky per-month header (title + weekdays)
const WEEKS = 6;
const FALLBACK_H = 640; // used until the viewport height is measured
const PANEL_W = 272;
const MAX_CHIPS = 5;
const RANGE_BACK = 6;
const RANGE_FWD = 12;
const NUM_MONTHS = RANGE_BACK + RANGE_FWD + 1;

function whenKey(t) {
  if (t.when === WHEN.TODAY || t.when === WHEN.EVENING) return todayKey();
  if (!t.when || t.when === WHEN.SOMEDAY) return null;
  return t.when;
}
const keyOf = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// Continuous month calendar: month grids stack vertically and scroll across many
// months (past + future), starting on the current month. The weekday row is
// fixed; each month's title is a sticky section header that scrolls with its
// month and pins to the top while that month is the one in view. Task chips drag
// between days (across months) to reschedule; the right "Unscheduled" panel holds
// undated tasks that can be dragged onto a day.
export default function MonthCalendar({ tasks, project, onOpenTask, onUpdateTask, onAddTask, onOpenDay, focusDate = null, onFocusDateChange, startHour = 0, dateFormat = 'weekday-long' }) {
  const today = keyToDate(todayKey());
  const startY = today.getFullYear();
  const startM = today.getMonth() - RANGE_BACK; // may be negative; Date normalizes
  const months = Array.from({ length: NUM_MONTHS }, (_, i) => {
    const d = new Date(startY, startM + i, 1);
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  // Which month index holds the focused date (so we open there, not on today),
  // and its day-of-month, preserved when reporting the scrolled-to month upward.
  const focusDt = focusDate ? keyToDate(focusDate) : today;
  const focusDay = focusDt.getDate();
  const focusIndex = Math.max(0, Math.min(NUM_MONTHS - 1,
    (focusDt.getFullYear() - startY) * 12 + (focusDt.getMonth() - startM)));

  const byDate = {};
  const unscheduled = [];
  tasks.forEach((t) => {
    const k = whenKey(t);
    if (k) (byDate[k] = byDate[k] || []).push(t);
    else unscheduled.push(t);
  });

  const [showPanel, setShowPanel] = useState(true);
  const [dragTask, setDragTask] = useState(null);
  const [dropKey, setDropKey] = useState(null); // day being hovered
  const [newTitle, setNewTitle] = useState('');
  const [peekDay, setPeekDay] = useState(null); // date tapped -> inline day dialog
  const [viewH, setViewH] = useState(0);
  const [ready, setReady] = useState(false); // hide the grid until it lands on the current month

  // Each month fills the full viewport height (title + weekday row + weeks), so
  // the list pages one month at a time. The title + weekday row form the sticky
  // header, so together they take HEADER_H off a month's grid space.
  const monthH = viewH > 0 ? viewH : FALLBACK_H;
  const weekH = (monthH - HEADER_H) / WEEKS;

  const rootRef = useRef(null);
  const panelRef = useRef(null);
  const scrollRef = useRef(null); // FlatList (scrollToOffset only — no measureInWindow)
  const viewRef = useRef(null); // wrapper View around the list, used to measure the drop viewport
  const scrollYRef = useRef(0);
  const monthReportRef = useRef(focusDate || todayKey());
  const rectsRef = useRef(null);

  const ghostX = useSharedValue(0);
  const ghostY = useSharedValue(0);
  const rootX = useSharedValue(0);
  const rootY = useSharedValue(0);

  const todayK = todayKey();

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

  // Resolve pointer -> a day key (grid), 'panel', or null. The scroll viewport is
  // measured once at drag start; the day is computed analytically from the scroll
  // offset (each month is TITLE_H + WEEKS*weekH tall).
  const computeDrop = (ax, ay) => {
    const c = rectsRef.current || {};
    if (c.panel) {
      const p = c.panel;
      if (ax >= p.x && ax <= p.x + p.w && ay >= p.y && ay <= p.y + p.h) return { mode: 'panel' };
    }
    const view = c.view;
    if (!view || ax < view.x || ax > view.x + view.w) return null;
    if (ay < view.y || ay > view.y + view.h) return null;
    const rel = ay - view.y + scrollYRef.current;
    if (rel < 0 || rel >= NUM_MONTHS * monthH) return null;
    const mi = Math.floor(rel / monthH);
    const within = rel - mi * monthH - HEADER_H;
    if (within < 0) return null;
    const row = Math.min(WEEKS - 1, Math.floor(within / weekH));
    const col = Math.max(0, Math.min(6, Math.floor(((ax - view.x) / view.w) * 7)));
    const { y, m } = months[mi];
    const gridStart = new Date(y, m, 1 - new Date(y, m, 1).getDay());
    const dt = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + row * 7 + col);
    return { mode: 'day', dayKey: keyOf(dt.getFullYear(), dt.getMonth(), dt.getDate()) };
  };

  const begin = (task) => setDragTask(task);
  const cancelDrag = () => { setDragTask(null); setDropKey(null); };
  const updateDrop = (ax, ay) => {
    const d = computeDrop(ax, ay);
    setDropKey((prev) => {
      const nk = d && d.mode === 'day' ? d.dayKey : null;
      return nk === prev ? prev : nk;
    });
  };
  const end = (taskId, ax, ay) => {
    setDragTask(null);
    setDropKey(null);
    const d = computeDrop(ax, ay);
    if (!d) return;
    if (d.mode === 'day') onUpdateTask(taskId, { when: d.dayKey });
    else if (d.mode === 'panel') onUpdateTask(taskId, { when: null });
  };

  const dragCtx = { ghostX, ghostY, rootX, rootY, measureOnly, begin, cancelDrag, updateDrop, end };
  const ghostStyle = useAnimatedStyle(() => ({ transform: [{ translateX: ghostX.value }, { translateY: ghostY.value }] }));

  const scrollToMonth = (i, animated) => scrollRef.current?.scrollToOffset({ offset: i * monthH, animated });
  // Land on the focused date's month once the viewport height is known (and keep
  // it in view if the height changes, e.g. a resize).
  useEffect(() => {
    if (viewH > 0) {
      scrollRef.current?.scrollToOffset({ offset: focusIndex * monthH, animated: false });
      setReady(true);
    }
  }, [viewH]);
  const submitAdd = () => {
    const title = newTitle.trim();
    if (!title) return;
    onAddTask({ title });
    setNewTitle('');
  };

  const color = project?.color || colors.accent;

  // Flatten months into [title, weeks, title, weeks, ...] so each title can be a
  // sticky header (sticky indices are the even positions). This drives a
  // virtualized FlatList: only the on-screen months mount, so the 19-month span
  // stays cheap even when every day carries tasks.
  const monthData = [];
  const stickyIndices = [];
  months.forEach(({ y, m }) => {
    stickyIndices.push(monthData.length);
    monthData.push({ type: 'title', y, m, key: `t${y}-${m}` });
    monthData.push({ type: 'weeks', y, m, key: `w${y}-${m}` });
  });
  // Both items of a month share the monthH stride; title sits at the top,
  // weeks below the header — exact offsets keep scroll/snap/drag math correct.
  const monthLayout = (_d, index) => {
    const monthIdx = Math.floor(index / 2);
    const isTitle = index % 2 === 0;
    return {
      length: isTitle ? HEADER_H : monthH - HEADER_H,
      offset: monthIdx * monthH + (isTitle ? 0 : HEADER_H),
      index,
    };
  };
  const renderMonthItem = ({ item }) =>
    item.type === 'title' ? (
      <View style={[styles.monthHeader, { height: HEADER_H }]}>
        <View style={[styles.monthTitleWrap, { height: TITLE_H }]}>
          <Text style={styles.monthTitle}>{MONTHS[item.m]} {item.y}</Text>
        </View>
        <View style={[styles.weekdays, { height: WEEKDAY_H }]}>
          {WEEKDAYS_SHORT.map((d) => (
            <Text key={d} style={styles.weekday}>{d}</Text>
          ))}
        </View>
      </View>
    ) : (
      <MonthWeeks
        y={item.y}
        m={item.m}
        height={monthH - HEADER_H}
        weekH={weekH}
        byDate={byDate}
        todayK={todayK}
        color={color}
        dropKey={dropKey}
        ctx={dragCtx}
        onOpen={onOpenTask}
        onDayPress={setPeekDay}
      />
    );

  return (
    <View ref={rootRef} collapsable={false} style={styles.root}>
      <View style={styles.toolbar}>
        <View style={styles.toolBtns}>
          <Pressable onPress={() => setShowPanel((v) => !v)} style={[styles.planBtn, showPanel && styles.planBtnActive]}>
            <Ionicons name="albums-outline" size={15} color={showPanel ? colors.accent : colors.textSecondary} />
            <Text style={[styles.planText, showPanel && { color: colors.accent }]}>Plan {unscheduled.length}</Text>
          </Pressable>
          <Pressable
            onPress={() => { scrollToMonth(RANGE_BACK, true); onFocusDateChange && onFocusDateChange(todayKey()); }}
            style={styles.todayBtn}
          >
            <Text style={styles.todayText}>Today</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.row}>
        <View ref={viewRef} collapsable={false} style={styles.leftCol}>
          <FlatList
            ref={scrollRef}
            data={monthData}
            keyExtractor={(it) => it.key}
            renderItem={renderMonthItem}
            extraData={`${dropKey}|${monthH}`}
            getItemLayout={monthLayout}
            style={[styles.scroll, !ready && styles.hidden]}
            showsVerticalScrollIndicator={false}
            stickyHeaderIndices={stickyIndices}
            onLayout={(e) => setViewH(e.nativeEvent.layout.height)}
            scrollEventThrottle={16}
            onScroll={(e) => {
              const y = e.nativeEvent.contentOffset.y;
              scrollYRef.current = y;
              if (onFocusDateChange && ready && monthH > 0) {
                const mi = Math.max(0, Math.min(NUM_MONTHS - 1, Math.round(y / monthH)));
                const { y: my, m: mm } = months[mi];
                const day = Math.min(focusDay, new Date(my, mm + 1, 0).getDate());
                const d = keyOf(my, mm, day);
                if (d !== monthReportRef.current) { monthReportRef.current = d; onFocusDateChange(d); }
              }
            }}
            snapToInterval={monthH}
            decelerationRate="fast"
            snapToAlignment="start"
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
              extraData={dropKey}
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
          <View style={[styles.ghostDot, { backgroundColor: color }]} />
          <Text style={styles.ghostText} numberOfLines={1}>{dragTask.title || 'New To-Do'}</Text>
        </Animated.View>
      )}

      <DayPeekModal
        visible={!!peekDay}
        dayKey={peekDay}
        dayTasks={peekDay ? byDate[peekDay] || [] : []}
        color={color}
        startHour={startHour}
        dateFormat={dateFormat}
        onClose={() => setPeekDay(null)}
        onOpenTask={(id) => { setPeekDay(null); onOpenTask(id); }}
        onOpenFull={onOpenDay ? () => { const k = peekDay; setPeekDay(null); onOpenDay(k); } : null}
        onUpdateTask={onUpdateTask}
      />
    </View>
  );
}

function MonthWeeks({ y, m, height, weekH, byDate, todayK, color, dropKey, ctx, onOpen, onDayPress }) {
  const first = new Date(y, m, 1);
  const gridStart = new Date(y, m, 1 - first.getDay());
  const weeks = [];
  for (let w = 0; w < WEEKS; w++) {
    const days = [];
    for (let d = 0; d < 7; d++) days.push(new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + w * 7 + d));
    weeks.push(days);
  }
  return (
    <View style={{ height }}>
      {weeks.map((days, wi) => (
        <View key={wi} style={[styles.week, { height: weekH }]}>
          {days.map((dt) => {
            const k = keyOf(dt.getFullYear(), dt.getMonth(), dt.getDate());
            const inMonth = dt.getMonth() === m;
            const isToday = k === todayK;
            const dayTasks = byDate[k] || [];
            const isDrop = dropKey === k;
            return (
              <Pressable
                key={k}
                onPress={() => onDayPress && onDayPress(k)}
                style={[styles.cell, !inMonth && styles.cellDim, isDrop && styles.cellDrop]}
              >
                <View style={[styles.dayBadge, isToday && styles.dayBadgeToday]}>
                  <Text style={[styles.dayNum, isToday && styles.dayNumToday, !inMonth && styles.dayNumDim]}>{dt.getDate()}</Text>
                </View>
                {dayTasks.slice(0, MAX_CHIPS).map((t) => (
                  <Draggable key={t.id} task={t} ctx={ctx} onOpen={onOpen} style={styles.chipWrap}>
                    <View style={styles.chip}>
                      <View style={[styles.chipDot, { backgroundColor: color }]} />
                      <Text style={[styles.chipText, t.status !== STATUS.OPEN && styles.done]} numberOfLines={1}>
                        {t.title || 'New To-Do'}
                      </Text>
                    </View>
                  </Draggable>
                ))}
                {dayTasks.length > MAX_CHIPS && <Text style={styles.more}>+{dayTasks.length - MAX_CHIPS}</Text>}
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

// Long-press to drag; tap opens. Only a real move drags.
function Draggable({ task, ctx, onOpen, style, children }) {
  const dragged = React.useRef(false);
  const moved = useSharedValue(false);
  const markDragged = () => { dragged.current = true; };
  const handlePress = (e) => {
    e?.stopPropagation?.(); // don't also trigger the day cell's open-day
    if (dragged.current) { dragged.current = false; return; }
    onOpen(task.id);
  };
  const pan = Gesture.Pan()
    .activateAfterLongPress(150)
    .onStart(() => { moved.value = false; runOnJS(ctx.measureOnly)(); })
    .onUpdate((e) => {
      const far = Math.abs(e.translationX) + Math.abs(e.translationY) > 6;
      if (far && !moved.value) { moved.value = true; runOnJS(markDragged)(); runOnJS(ctx.begin)(task); }
      if (!moved.value) return;
      ctx.ghostX.value = e.absoluteX - ctx.rootX.value - 16;
      ctx.ghostY.value = e.absoluteY - ctx.rootY.value - 12;
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

const styles = StyleSheet.create({
  root: { flex: 1, paddingLeft: spacing.lg },
  fill: { ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null) },
  toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', paddingRight: spacing.lg, paddingTop: spacing.xs, marginBottom: spacing.sm },
  toolBtns: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  planBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separatorStrong, ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null) },
  planBtnActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  planText: { ...typography.subhead, color: colors.textSecondary, fontWeight: '600' },
  todayBtn: { paddingHorizontal: spacing.md, paddingVertical: 4, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separatorStrong, ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null) },
  todayText: { ...typography.subhead, color: colors.textSecondary, fontWeight: '600' },
  row: { flex: 1, flexDirection: 'row' },
  leftCol: { flex: 1, paddingRight: spacing.lg },
  scroll: { flex: 1 },
  hidden: { opacity: 0 },
  monthHeader: { backgroundColor: colors.background },
  monthTitleWrap: { justifyContent: 'center', paddingLeft: 2 },
  monthTitle: { ...typography.title, color: colors.text },
  weekdays: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separatorStrong,
    backgroundColor: colors.background,
  },
  weekday: { flex: 1, textAlign: 'center', ...typography.caption, color: colors.textTertiary, fontWeight: '600', textTransform: 'uppercase' },
  week: { flexDirection: 'row' },
  cell: { flex: 1, borderTopWidth: StyleSheet.hairlineWidth, borderRightWidth: StyleSheet.hairlineWidth, borderColor: colors.separator, padding: 3, gap: 2, ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null) },
  cellDim: { backgroundColor: colors.groupedBackground },
  cellDrop: { backgroundColor: colors.accentSoft },
  dayBadge: { alignSelf: 'flex-start', minWidth: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 },
  dayBadgeToday: { backgroundColor: colors.accent },
  dayNum: { ...typography.caption, color: colors.textSecondary, fontWeight: '600' },
  dayNumToday: { color: colors.white },
  dayNumDim: { color: colors.textTertiary },
  chipWrap: { width: '100%' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.groupedBackground, borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1 },
  chipDot: { width: 6, height: 6, borderRadius: 3 },
  chipText: { ...typography.caption, color: colors.text, flexShrink: 1, fontSize: 11 },
  more: { ...typography.caption, color: colors.textTertiary, paddingLeft: 4, fontSize: 10 },
  done: { color: colors.textTertiary, textDecorationLine: 'line-through' },
  panel: { width: PANEL_W, backgroundColor: colors.groupedBackground, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.separator, paddingHorizontal: spacing.md, paddingTop: spacing.sm, marginRight: -spacing.lg },
  panelScroll: { flex: 1 },
  panelTitle: { ...typography.heading, color: colors.text, marginBottom: spacing.xs },
  panelCount: { ...typography.subhead, color: colors.textTertiary },
  panelItemWrap: {},
  panelItem: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator },
  panelDot: { width: 16, height: 16, borderRadius: 8, borderWidth: 1.5, marginTop: 1 },
  panelItemText: { flex: 1, ...typography.subhead, color: colors.text },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.sm },
  addInput: { flex: 1, ...typography.subhead, color: colors.text, padding: 0, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null) },
  ghost: { position: 'absolute', top: 0, left: 0, zIndex: 1000, flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 220, paddingVertical: 5, paddingHorizontal: spacing.sm, borderRadius: radius.sm, backgroundColor: colors.background, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separatorStrong, shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 6 },
  ghostDot: { width: 8, height: 8, borderRadius: 4 },
  ghostText: { ...typography.caption, color: colors.text, flexShrink: 1 },
});

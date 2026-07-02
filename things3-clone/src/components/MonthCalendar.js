import React, { useRef, useState, useEffect } from 'react';
import { View, Text, Pressable, TextInput, ScrollView, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, runOnJS } from 'react-native-reanimated';
import { colors, spacing, typography, radius } from '../theme';
import { WHEN, STATUS } from '../store/constants';
import { todayKey, keyToDate, MONTHS, WEEKDAYS_SHORT } from '../utils/date';

const HEADER_H = 40;
const WEEKDAY_H = 22;
const WEEKS = 6;
const FALLBACK_H = 640; // used until the viewport height is measured
const PANEL_W = 236;
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
// months (past + future), starting on the current month. Task chips drag between
// days (across months) to reschedule; the right "Unscheduled" panel holds undated
// tasks that can be dragged onto a day.
export default function MonthCalendar({ tasks, project, onOpenTask, onUpdateTask, onAddTask }) {
  const today = keyToDate(todayKey());
  const startY = today.getFullYear();
  const startM = today.getMonth() - RANGE_BACK; // may be negative; Date normalizes
  const months = Array.from({ length: NUM_MONTHS }, (_, i) => {
    const d = new Date(startY, startM + i, 1);
    return { y: d.getFullYear(), m: d.getMonth() };
  });

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
  const [viewH, setViewH] = useState(0);
  const [curIdx, setCurIdx] = useState(RANGE_BACK); // month currently in view

  // Each month fills the full viewport height (like a single-month view); the
  // list scrolls/pages between months. The month's own title lives in the fixed
  // header, so a month section is just the weekday row + weeks.
  const monthH = viewH > 0 ? viewH : FALLBACK_H;
  const weekH = (monthH - WEEKDAY_H) / WEEKS;

  const rootRef = useRef(null);
  const contentRef = useRef(null);
  const panelRef = useRef(null);
  const scrollRef = useRef(null);
  const rectsRef = useRef(null);
  const scrolledRef = useRef(false);

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
    Promise.all([grab(contentRef, 'content', store), grab(panelRef, 'panel', store), grab(rootRef, 'root', store)]).then(() => {
      rectsRef.current = store;
      if (store.root) { rootX.value = store.root.x; rootY.value = store.root.y; }
    });
  };

  // Resolve pointer -> a day key (grid), 'panel', or null.
  const computeDrop = (ax, ay) => {
    const c = rectsRef.current || {};
    if (c.panel) {
      const p = c.panel;
      if (ax >= p.x && ax <= p.x + p.w && ay >= p.y && ay <= p.y + p.h) return { mode: 'panel' };
    }
    const content = c.content;
    if (!content || ax < content.x || ax > content.x + content.w) return null;
    const rel = ay - content.y;
    if (rel < 0 || rel >= NUM_MONTHS * monthH) return null;
    const mi = Math.floor(rel / monthH);
    const within = rel - mi * monthH - WEEKDAY_H;
    if (within < 0) return null;
    const row = Math.min(WEEKS - 1, Math.floor(within / weekH));
    const col = Math.max(0, Math.min(6, Math.floor(((ax - content.x) / content.w) * 7)));
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

  const scrollToMonth = (i, animated) => scrollRef.current?.scrollTo({ y: i * monthH, animated });
  // Land on the current month once the viewport height is known (and keep it in
  // view if the height changes, e.g. a resize).
  useEffect(() => {
    if (viewH > 0) scrollRef.current?.scrollTo({ y: RANGE_BACK * viewH, animated: false });
  }, [viewH]);
  const submitAdd = () => {
    const title = newTitle.trim();
    if (!title) return;
    onAddTask({ title });
    setNewTitle('');
  };

  const color = project?.color || colors.accent;

  return (
    <View ref={rootRef} collapsable={false} style={styles.root}>
      <View style={styles.toolbar}>
        {/* The month currently in view sits here (in place of a "Calendar"
            title), updating as you scroll between months. */}
        <Text style={styles.title}>
          {MONTHS[months[curIdx].m]} {months[curIdx].y}
        </Text>
        <View style={styles.toolBtns}>
          <Pressable onPress={() => setShowPanel((v) => !v)} style={[styles.planBtn, showPanel && styles.planBtnActive]}>
            <Ionicons name="albums-outline" size={15} color={showPanel ? colors.accent : colors.textSecondary} />
            <Text style={[styles.planText, showPanel && { color: colors.accent }]}>Plan {unscheduled.length}</Text>
          </Pressable>
          <Pressable onPress={() => scrollToMonth(RANGE_BACK, true)} style={styles.todayBtn}>
            <Text style={styles.todayText}>Today</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.row}>
        <ScrollView
          ref={scrollRef}
          style={styles.scroll}
          showsVerticalScrollIndicator
          onLayout={(e) => setViewH(e.nativeEvent.layout.height)}
          scrollEventThrottle={16}
          onScroll={(e) => {
            const i = Math.max(0, Math.min(NUM_MONTHS - 1, Math.round(e.nativeEvent.contentOffset.y / monthH)));
            setCurIdx((prev) => (prev === i ? prev : i));
          }}
          snapToInterval={monthH}
          decelerationRate="fast"
          snapToAlignment="start"
        >
          <View ref={contentRef} collapsable={false}>
            {months.map(({ y, m }) => (
              <MonthGrid
                key={`${y}-${m}`}
                y={y}
                m={m}
                monthH={monthH}
                weekH={weekH}
                byDate={byDate}
                todayK={todayK}
                color={color}
                dropKey={dropKey}
                ctx={dragCtx}
                onOpen={onOpenTask}
              />
            ))}
          </View>
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
          <View style={[styles.ghostDot, { backgroundColor: color }]} />
          <Text style={styles.ghostText} numberOfLines={1}>{dragTask.title || 'New To-Do'}</Text>
        </Animated.View>
      )}
    </View>
  );
}

function MonthGrid({ y, m, monthH, weekH, byDate, todayK, color, dropKey, ctx, onOpen }) {
  const first = new Date(y, m, 1);
  const gridStart = new Date(y, m, 1 - first.getDay());
  const weeks = [];
  for (let w = 0; w < WEEKS; w++) {
    const days = [];
    for (let d = 0; d < 7; d++) days.push(new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + w * 7 + d));
    weeks.push(days);
  }
  return (
    <View style={{ height: monthH }}>
      <View style={[styles.weekdays, { height: WEEKDAY_H }]}>
        {WEEKDAYS_SHORT.map((d) => (
          <Text key={d} style={styles.weekday}>{d}</Text>
        ))}
      </View>
      {weeks.map((days, wi) => (
        <View key={wi} style={[styles.week, { height: weekH }]}>
          {days.map((dt) => {
            const k = keyOf(dt.getFullYear(), dt.getMonth(), dt.getDate());
            const inMonth = dt.getMonth() === m;
            const isToday = k === todayK;
            const dayTasks = byDate[k] || [];
            const isDrop = dropKey === k;
            return (
              <View key={k} style={[styles.cell, !inMonth && styles.cellDim, isDrop && styles.cellDrop]}>
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
              </View>
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
  const handlePress = () => {
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
  toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingRight: spacing.lg, paddingTop: spacing.xs, marginBottom: spacing.sm },
  title: { ...typography.heading, color: colors.text },
  toolBtns: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  planBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separatorStrong, ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null) },
  planBtnActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  planText: { ...typography.subhead, color: colors.textSecondary, fontWeight: '600' },
  todayBtn: { paddingHorizontal: spacing.md, paddingVertical: 4, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separatorStrong, ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null) },
  todayText: { ...typography.subhead, color: colors.textSecondary, fontWeight: '600' },
  row: { flex: 1, flexDirection: 'row' },
  scroll: { flex: 1, paddingRight: spacing.lg },
  monthHeader: { justifyContent: 'flex-end', paddingBottom: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separatorStrong },
  monthTitle: { ...typography.title, color: colors.text },
  weekdays: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separatorStrong,
    backgroundColor: colors.background,
  },
  weekday: { flex: 1, textAlign: 'center', ...typography.caption, color: colors.textTertiary, fontWeight: '600', textTransform: 'uppercase' },
  week: { flexDirection: 'row' },
  cell: { flex: 1, borderTopWidth: StyleSheet.hairlineWidth, borderRightWidth: StyleSheet.hairlineWidth, borderColor: colors.separator, padding: 3, gap: 2 },
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

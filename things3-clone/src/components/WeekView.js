import React, { useRef, useState, useEffect } from 'react';
import { View, Text, Pressable, TextInput, ScrollView, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, runOnJS } from 'react-native-reanimated';
import { colors, spacing, typography, radius } from '../theme';
import { WHEN, STATUS } from '../store/constants';
import { todayKey, keyToDate, addDays, WEEKDAYS_SHORT, formatDayKey, nowMinutes } from '../utils/date';
import { layoutOverlaps } from '../utils/overlap';

const END_HOUR = 23;
const DEFAULT_SCROLL_HOUR = 6; // open on the morning; user can scroll up to the day start
const BASE_HOUR_H = 44; // minimum row height; grows to fill a tall viewport
const TOP_PAD = 10; // breathing room so the first hour label isn't clipped
const BOTTOM_PAD = 12;
const GUTTER = 46;
const SNAP = 15;
const DEFAULT_DUR = 60;
const PANEL_W = 272;

function whenKey(t) {
  if (t.when === WHEN.TODAY || t.when === WHEN.EVENING) return todayKey();
  if (!t.when || t.when === WHEN.SOMEDAY) return null;
  return t.when;
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmt = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
function tint(hex) {
  const h = (hex || '').replace('#', '');
  if (h.length !== 6) return colors.accentSoft;
  return `rgba(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}, 0.16)`;
}

// A 7-day week grid with a shared hour axis, an all-day row, and a now line.
// Tasks drag (long-press) between days and times; the right "Unscheduled" Plan
// panel holds undated tasks that can be dragged onto a day/time.
export default function WeekView({ tasks, project, onOpenTask, onUpdateTask, onAddTask, startHour = 0, showWeekends = false, dateFormat = 'weekday-long' }) {
  const HOURS = END_HOUR - startHour;
  const startOfWeek = (d) => addDays(d, -keyToDate(d).getDay());
  const [weekStart, setWeekStart] = useState(startOfWeek(todayKey()));
  const [showPanel, setShowPanel] = useState(true);
  const [dragTask, setDragTask] = useState(null);
  const [newTitle, setNewTitle] = useState('');
  const [gridViewH, setGridViewH] = useState(0);
  // Optionally drop Sat/Sun so weekdays get wider, cleaner columns.
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)).filter(
    (k) => showWeekends || (keyToDate(k).getDay() % 6 !== 0)
  );
  const N = days.length; // number of day columns (7 or 5)
  const todayK = todayKey();
  const color = project?.color || colors.accent;

  // Hours grow to fill the viewport when it's tall (no wasted space at the
  // bottom), and fall back to a scrollable base height when it's short.
  const hourH = gridViewH > 0 ? Math.max(BASE_HOUR_H, (gridViewH - TOP_PAD - BOTTOM_PAD) / HOURS) : BASE_HOUR_H;
  const gridH = TOP_PAD + HOURS * hourH + BOTTOM_PAD;

  // Open scrolled to the morning (early hours stay reachable by scrolling up).
  useEffect(() => {
    if (gridViewH > 0 && !didInitScroll.current) {
      didInitScroll.current = true;
      scrollRef.current?.scrollTo({ y: TOP_PAD + Math.max(0, DEFAULT_SCROLL_HOUR - startHour) * hourH, animated: false });
    }
  }, [gridViewH, hourH]);

  const timedByDay = {};
  const allDayByDay = {};
  const unscheduled = [];
  tasks.forEach((t) => {
    const k = whenKey(t);
    if (!k) { unscheduled.push(t); return; }
    if (!days.includes(k)) return;
    if (t.startMinutes != null) (timedByDay[k] = timedByDay[k] || []).push(t);
    else (allDayByDay[k] = allDayByDay[k] || []).push(t);
  });

  const rootRef = useRef(null);
  const scrollRef = useRef(null);
  const didInitScroll = useRef(false);
  const layerRef = useRef(null);
  const allDayRef = useRef(null);
  const panelRef = useRef(null);
  const rectsRef = useRef(null);
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
    Promise.all([grab(layerRef, 'layer', store), grab(allDayRef, 'allday', store), grab(panelRef, 'panel', store), grab(rootRef, 'root', store)]).then(() => {
      rectsRef.current = store;
      if (store.root) { rootX.value = store.root.x; rootY.value = store.root.y; }
    });
  };
  const dayFromX = (rect, ax) => clamp(Math.floor(((ax - rect.x) / rect.w) * N), 0, N - 1);
  const computeDrop = (ax, ay) => {
    const c = rectsRef.current || {};
    if (c.panel) { const p = c.panel; if (ax >= p.x && ax <= p.x + p.w && ay >= p.y && ay <= p.y + p.h) return { mode: 'panel' }; }
    if (c.allday) { const a = c.allday; if (ax >= a.x && ax <= a.x + a.w && ay >= a.y && ay <= a.y + a.h) return { mode: 'allday', dayKey: days[dayFromX(a, ax)] }; }
    const l = c.layer;
    if (!l || ax < l.x || ax > l.x + l.w || ay < l.y || ay > l.y + l.h) return null;
    let mins = startHour * 60 + Math.round(((ay - l.y) / hourH) * 60 / SNAP) * SNAP;
    mins = clamp(mins, startHour * 60, END_HOUR * 60 - SNAP);
    return { mode: 'grid', dayKey: days[dayFromX(l, ax)], mins };
  };
  const begin = (task) => setDragTask(task);
  const cancelDrag = () => setDragTask(null);
  const end = (taskId, ax, ay) => {
    setDragTask(null);
    const d = computeDrop(ax, ay);
    const task = tasks.find((x) => x.id === taskId);
    if (!d || !task) return;
    if (d.mode === 'grid') onUpdateTask(taskId, { when: d.dayKey, startMinutes: d.mins, durationMinutes: task.durationMinutes || DEFAULT_DUR });
    else if (d.mode === 'allday') onUpdateTask(taskId, { when: d.dayKey, startMinutes: null });
    else if (d.mode === 'panel') onUpdateTask(taskId, { when: null, startMinutes: null });
  };
  const ctx = { ghostX, ghostY, rootX, rootY, measureOnly, begin, cancelDrag, end };
  const ghostStyle = useAnimatedStyle(() => ({ transform: [{ translateX: ghostX.value }, { translateY: ghostY.value }] }));

  const nowMins = nowMinutes();
  const showNow = days.includes(todayK) && nowMins >= startHour * 60 && nowMins <= END_HOUR * 60;
  const nowTop = ((nowMins - startHour * 60) / 60) * hourH;
  const nowCol = days.indexOf(todayK);

  // Same absolute-date format as the Day view, applied to both ends of the week.
  const rangeLabel = `${formatDayKey(days[0], dateFormat)} – ${formatDayKey(days[N - 1], dateFormat)}`;

  const submitAdd = () => { const t = newTitle.trim(); if (!t) return; onAddTask({ title: t }); setNewTitle(''); };

  return (
    <View ref={rootRef} collapsable={false} style={styles.root}>
      <View style={styles.nav}>
        <Text style={styles.rangeLabel}>{rangeLabel}</Text>
        <View style={styles.navBtns}>
          <Pressable onPress={() => setShowPanel((v) => !v)} style={[styles.planBtn, showPanel && styles.planBtnActive]}>
            <Ionicons name="albums-outline" size={15} color={showPanel ? colors.accent : colors.textSecondary} />
            <Text style={[styles.planText, showPanel && { color: colors.accent }]}>Plan {unscheduled.length}</Text>
          </Pressable>
          <Pressable onPress={() => setWeekStart(startOfWeek(todayKey()))} style={styles.todayBtn}>
            <Text style={styles.todayText}>Today</Text>
          </Pressable>
          <Pressable onPress={() => setWeekStart(addDays(weekStart, -7))} hitSlop={8} style={styles.navBtn}>
            <Ionicons name="chevron-back" size={20} color={colors.textSecondary} />
          </Pressable>
          <Pressable onPress={() => setWeekStart(addDays(weekStart, 7))} hitSlop={8} style={styles.navBtn}>
            <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
          </Pressable>
        </View>
      </View>

      <View style={styles.body}>
        <View style={styles.weekCol}>
          {/* Day headers */}
          <View style={styles.headerRow}>
            <View style={{ width: GUTTER }} />
            {days.map((k) => {
              const d = keyToDate(k);
              const isToday = k === todayK;
              return (
                <View key={k} style={styles.headCell}>
                  <Text style={[styles.headWeekday, isToday && styles.headToday]}>{WEEKDAYS_SHORT[d.getDay()]}</Text>
                  <View style={[styles.headDayBadge, isToday && styles.headDayBadgeToday]}>
                    <Text style={[styles.headDay, isToday && styles.headDayNumToday]}>{d.getDate()}</Text>
                  </View>
                </View>
              );
            })}
          </View>

          {/* All-day row */}
          <View style={styles.allDayRow}>
            <View style={[styles.allDayGutter, { width: GUTTER }]}>
              <Text style={styles.allDayLabel}>all-day</Text>
            </View>
            <View ref={allDayRef} collapsable={false} style={styles.allDayCells}>
              {days.map((k) => (
                <View key={k} style={styles.allDayCell}>
                  {(allDayByDay[k] || []).slice(0, 3).map((t) => (
                    <Draggable key={t.id} task={t} ctx={ctx} onOpen={onOpenTask} style={styles.allDayChipWrap}>
                      <View style={[styles.allDayChip, { borderColor: color }]}>
                        <Text style={styles.allDayChipText} numberOfLines={1}>{t.title || 'New To-Do'}</Text>
                      </View>
                    </Draggable>
                  ))}
                  {(allDayByDay[k] || []).length > 3 && <Text style={styles.moreText}>+{(allDayByDay[k] || []).length - 3}</Text>}
                </View>
              ))}
            </View>
          </View>

          <ScrollView ref={scrollRef} style={styles.scroll} showsVerticalScrollIndicator={false} onLayout={(e) => setGridViewH(e.nativeEvent.layout.height)}>
            <View style={[styles.grid, { height: gridH }]}>
              {/* Day columns + today highlight sit behind the hour lines so the
                  lines stay visible through the highlighted (today) column. */}
              <View style={[styles.colLayer, { left: GUTTER }]} pointerEvents="none">
                {days.map((k) => (
                  <View key={k} style={[styles.colDivider, k === todayK && styles.colToday]} />
                ))}
              </View>
              {Array.from({ length: END_HOUR - startHour + 1 }, (_, i) => startHour + i).map((h) => (
                <View key={h} style={[styles.hourRow, { top: TOP_PAD + (h - startHour) * hourH, height: hourH }]}>
                  <Text style={styles.hourLabel}>{fmt(h * 60)}</Text>
                  <View style={styles.hourLine} />
                </View>
              ))}

              <View ref={layerRef} collapsable={false} style={[styles.blockLayer, { left: GUTTER }]}>
                {showNow && nowCol >= 0 && (
                  <View style={[styles.nowLine, { top: nowTop, left: `${(nowCol * 100) / N}%`, width: `${100 / N}%` }]} pointerEvents="none">
                    <View style={styles.nowDot} />
                  </View>
                )}
                {days.map((k, di) => {
                  // Split overlapping events within a day into side-by-side
                  // sub-columns so every parallel session stays readable.
                  const layout = layoutOverlaps(timedByDay[k] || []);
                  return (timedByDay[k] || []).map((t) => {
                    const top = ((t.startMinutes - startHour * 60) / 60) * hourH;
                    const height = Math.max(16, ((t.durationMinutes || DEFAULT_DUR) / 60) * hourH - 2);
                    const doneT = t.status !== STATUS.OPEN;
                    const { col = 0, count = 1 } = layout.get(t.id) || {};
                    const colW = 100 / N / count;
                    const left = `${(di * 100) / N + col * colW}%`;
                    const width = `${colW}%`;
                    return (
                      <Draggable key={t.id} task={t} ctx={ctx} onOpen={onOpenTask} style={[styles.block, { top, height, left, width }]}>
                        <View style={[styles.blockInner, { backgroundColor: tint(color), borderLeftColor: color }]}>
                          <Text style={[styles.blockTitle, doneT && styles.done]} numberOfLines={count > 1 ? 2 : 1}>{t.title || 'New To-Do'}</Text>
                          {count < 3 && <Text style={styles.blockTime} numberOfLines={1}>{fmt(t.startMinutes)}</Text>}
                        </View>
                      </Draggable>
                    );
                  });
                })}
              </View>
            </View>
          </ScrollView>
        </View>

        {showPanel && (
          <View ref={panelRef} collapsable={false} style={styles.panel}>
            <Text style={styles.panelTitle}>Unscheduled <Text style={styles.panelCount}>{unscheduled.length}</Text></Text>
            <ScrollView style={styles.panelScroll} showsVerticalScrollIndicator={false}>
              {unscheduled.map((t) => (
                <Draggable key={t.id} task={t} ctx={ctx} onOpen={onOpenTask} style={styles.panelItemWrap}>
                  <View style={styles.panelItem}>
                    <View style={[styles.panelDot, { borderColor: color }]} />
                    <Text style={[styles.panelItemText, t.status !== STATUS.OPEN && styles.done]} numberOfLines={2}>{t.title || 'New To-Do'}</Text>
                  </View>
                </Draggable>
              ))}
              <View style={styles.addRow}>
                <Ionicons name="add" size={18} color={colors.textTertiary} />
                <TextInput style={styles.addInput} value={newTitle} onChangeText={setNewTitle} onSubmitEditing={submitAdd} blurOnSubmit={false} placeholder="Add task" placeholderTextColor={colors.placeholder} returnKeyType="done" />
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

function Draggable({ task, ctx, onOpen, style, children }) {
  const dragged = React.useRef(false);
  const moved = useSharedValue(false);
  const markDragged = () => { dragged.current = true; };
  const handlePress = () => { if (dragged.current) { dragged.current = false; return; } onOpen(task.id); };
  const pan = Gesture.Pan()
    .activateAfterLongPress(150)
    .onStart(() => { moved.value = false; runOnJS(ctx.measureOnly)(); })
    .onUpdate((e) => {
      const far = Math.abs(e.translationX) + Math.abs(e.translationY) > 6;
      if (far && !moved.value) { moved.value = true; runOnJS(markDragged)(); runOnJS(ctx.begin)(task); }
      if (!moved.value) return;
      ctx.ghostX.value = e.absoluteX - ctx.rootX.value - 16;
      ctx.ghostY.value = e.absoluteY - ctx.rootY.value - 12;
    })
    .onEnd((e) => { if (moved.value) runOnJS(ctx.end)(task.id, e.absoluteX, e.absoluteY); else runOnJS(ctx.cancelDrag)(); });
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
  nav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingRight: spacing.lg, marginBottom: spacing.sm },
  rangeLabel: { ...typography.title, color: colors.text },
  navBtns: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  planBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separatorStrong, marginRight: spacing.xs, ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null) },
  planBtnActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  planText: { ...typography.subhead, color: colors.textSecondary, fontWeight: '600' },
  todayBtn: { paddingHorizontal: spacing.md, paddingVertical: 4, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separatorStrong, marginRight: spacing.xs, ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null) },
  todayText: { ...typography.subhead, color: colors.textSecondary, fontWeight: '600' },
  navBtn: { padding: 2, ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null) },
  body: { flex: 1, flexDirection: 'row' },
  weekCol: { flex: 1, paddingRight: spacing.lg },
  headerRow: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator, paddingBottom: 4 },
  headCell: { flex: 1, alignItems: 'center', gap: 2 },
  headWeekday: { ...typography.caption, color: colors.textTertiary, textTransform: 'uppercase' },
  headToday: { color: colors.accent, fontWeight: '700' },
  headDayBadge: { minWidth: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  headDayBadgeToday: { backgroundColor: colors.accent },
  headDay: { ...typography.subhead, color: colors.text, fontWeight: '600' },
  headDayNumToday: { color: colors.white },
  allDayRow: { flexDirection: 'row', minHeight: 26, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separatorStrong, paddingVertical: 3 },
  allDayGutter: { justifyContent: 'center' },
  allDayLabel: { ...typography.caption, color: colors.textTertiary, fontSize: 10 },
  allDayCells: { flex: 1, flexDirection: 'row' },
  allDayCell: { flex: 1, gap: 2, paddingHorizontal: 2, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.separator },
  allDayChipWrap: { width: '100%' },
  allDayChip: { borderLeftWidth: 3, borderRadius: 3, backgroundColor: colors.groupedBackground, paddingHorizontal: 4, paddingVertical: 1 },
  allDayChipText: { ...typography.caption, color: colors.text, fontSize: 10 },
  moreText: { ...typography.caption, color: colors.textTertiary, fontSize: 10, paddingLeft: 4 },
  scroll: { flex: 1 },
  grid: { position: 'relative' },
  hourRow: { position: 'absolute', left: 0, right: 0, flexDirection: 'row', alignItems: 'flex-start' },
  hourLabel: { width: GUTTER, ...typography.caption, color: colors.textTertiary, marginTop: -6, fontSize: 10, textAlign: 'right', paddingRight: 4, fontVariant: ['tabular-nums'] },
  hourLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.separator },
  colLayer: { position: 'absolute', top: 0, bottom: 0, right: 0, flexDirection: 'row' },
  colDivider: { flex: 1, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.separator },
  // Light, translucent accent tint so the hour lines stay visible through it.
  colToday: { backgroundColor: 'rgba(43, 111, 255, 0.06)' },
  blockLayer: { position: 'absolute', top: TOP_PAD, bottom: 0, right: 0 },
  nowLine: { position: 'absolute', height: 2, backgroundColor: colors.deadline },
  nowDot: { position: 'absolute', left: -3, top: -3, width: 8, height: 8, borderRadius: 4, backgroundColor: colors.deadline },
  block: { position: 'absolute', paddingHorizontal: 1 },
  blockInner: { flex: 1, borderLeftWidth: 3, borderRadius: 3, paddingHorizontal: 3, paddingVertical: 1, overflow: 'hidden' },
  blockTitle: { ...typography.caption, color: colors.text, fontWeight: '600', fontSize: 10 },
  blockTime: { ...typography.caption, color: colors.textSecondary, fontSize: 9 },
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

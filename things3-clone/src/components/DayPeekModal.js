import React, { useRef, useState } from 'react';
import { Modal, View, Text, Pressable, ScrollView, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, runOnJS } from 'react-native-reanimated';
import { colors, spacing, typography, radius } from '../theme';
import { STATUS } from '../store/constants';
import { formatDayKey } from '../utils/date';
import { layoutOverlaps } from '../utils/overlap';

const END_HOUR = 23;
const HOUR_H = 44;
const GUTTER = 44;
const TOP_PAD = 8;
const BOTTOM_PAD = 10;
const DEFAULT_DUR = 60;
const SNAP = 15; // minutes a dragged block snaps to

const fmt = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
function tint(hex) {
  const h = (hex || '').replace('#', '');
  if (h.length !== 6) return colors.accentSoft;
  return `rgba(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}, 0.16)`;
}

// A single day's schedule, shown as a centered dialog when a date is tapped in
// the Month view. Tapping an event opens it; press-and-drag a timed block to
// reschedule it within the day; the "Open" button jumps to the full Day view.
export default function DayPeekModal({
  visible,
  dayKey,
  dayTasks = [],
  color = colors.accent,
  startHour = 0,
  dateFormat = 'weekday-long',
  onClose,
  onOpenTask,
  onOpenFull,
  onUpdateTask,
}) {
  const scrollRef = useRef(null);
  const scrolledRef = useRef(false);
  const gridRef = useRef(null); // the hour-grid content, measured to map a drop -> time
  const rectsRef = useRef({});
  const [dragChip, setDragChip] = useState(null); // all-day task being dragged onto the grid
  const [dropMin, setDropMin] = useState(null); // live target time while dragging
  const ghostX = useSharedValue(0);
  const ghostY = useSharedValue(0);

  const timed = dayTasks.filter((t) => t.startMinutes != null).sort((a, b) => a.startMinutes - b.startMinutes);
  const allDay = dayTasks.filter((t) => t.startMinutes == null);
  const layout = layoutOverlaps(timed);

  const HOURS = END_HOUR - startHour;
  const gridH = TOP_PAD + HOURS * HOUR_H + BOTTOM_PAD;

  // Land the scroll on the first event (or 8:00) once laid out.
  const onContentReady = () => {
    if (scrolledRef.current) return;
    scrolledRef.current = true;
    const firstMin = timed.length ? timed[0].startMinutes : 8 * 60;
    const y = TOP_PAD + Math.max(0, (firstMin - startHour * 60) / 60 - 0.5) * HOUR_H;
    scrollRef.current?.scrollTo({ y, animated: false });
  };

  // Measure the scroll viewport (drop zone) and the grid content (time origin)
  // once, at the start of an all-day drag.
  const measure = () => {
    const grab = (ref, key) =>
      new Promise((res) => {
        const n = ref.current;
        if (n && n.measureInWindow) n.measureInWindow((x, y, w, h) => { rectsRef.current[key] = { x, y, w, h }; res(); });
        else res();
      });
    return Promise.all([grab(scrollRef, 'view'), grab(gridRef, 'grid')]);
  };
  // Pointer (window coords) -> snapped minutes, or null when off the grid.
  const computeMin = (ax, ay) => {
    const v = rectsRef.current.view;
    const g = rectsRef.current.grid;
    if (!v || !g) return null;
    if (ax < v.x || ax > v.x + v.w || ay < v.y || ay > v.y + v.h) return null;
    const relY = ay - g.y;
    let mins = startHour * 60 + Math.round(((relY - TOP_PAD) / HOUR_H) * 60 / SNAP) * SNAP;
    return Math.max(startHour * 60, Math.min(END_HOUR * 60 - SNAP, mins));
  };
  const chipCtx = {
    ghostX,
    ghostY,
    enabled: !!onUpdateTask,
    measure,
    begin: (t) => setDragChip(t),
    updateDrop: (ax, ay) => { const m = computeMin(ax, ay); setDropMin((p) => (p === m ? p : m)); },
    cancel: () => { setDragChip(null); setDropMin(null); },
    end: (id, ax, ay) => {
      const m = computeMin(ax, ay);
      setDragChip(null);
      setDropMin(null);
      if (m != null) onUpdateTask(id, { startMinutes: m });
    },
  };
  const ghostStyle = useAnimatedStyle(() => ({ transform: [{ translateX: ghostX.value }, { translateY: ghostY.value }] }));

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {/* Modal content renders outside the app's GestureHandlerRootView, so wrap
          it in its own root or the block drag gestures won't activate. */}
      <GestureHandlerRootView style={styles.ghRoot}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={(e) => e?.stopPropagation?.()}>
          <View style={styles.header}>
            <Text style={styles.title}>{dayKey ? formatDayKey(dayKey, dateFormat) : ''}</Text>
            <View style={styles.headerBtns}>
              {onOpenFull && (
                <Pressable onPress={onOpenFull} style={styles.openBtn}>
                  <Ionicons name="open-outline" size={14} color={colors.accent} />
                  <Text style={styles.openText}>Open</Text>
                </Pressable>
              )}
              <Pressable onPress={onClose} hitSlop={8} style={styles.closeBtn}>
                <Ionicons name="close" size={20} color={colors.textSecondary} />
              </Pressable>
            </View>
          </View>

          {allDay.length > 0 && (
            <View style={styles.allDay}>
              {allDay.map((t) => (
                <AllDayChip key={t.id} task={t} color={color} ctx={chipCtx} onOpen={onOpenTask} />
              ))}
            </View>
          )}

          <ScrollView
            ref={scrollRef}
            style={styles.scroll}
            showsVerticalScrollIndicator={false}
            onContentSizeChange={onContentReady}
          >
            <View ref={gridRef} collapsable={false} style={{ height: gridH }}>
              {Array.from({ length: HOURS + 1 }, (_, i) => startHour + i).map((h) => (
                <View key={h} style={[styles.hourRow, { top: TOP_PAD + (h - startHour) * HOUR_H }]}>
                  <Text style={styles.hourLabel}>{fmt(h * 60)}</Text>
                  <View style={styles.hourLine} />
                </View>
              ))}
              <View style={[styles.blockLayer, { left: GUTTER }]}>
                {timed.map((t) => {
                  const top = TOP_PAD + ((t.startMinutes - startHour * 60) / 60) * HOUR_H;
                  const height = Math.max(16, ((t.durationMinutes || DEFAULT_DUR) / 60) * HOUR_H - 2);
                  const { col = 0, count = 1 } = layout.get(t.id) || {};
                  const w = 100 / count;
                  return (
                    <Block
                      key={t.id}
                      task={t}
                      color={color}
                      startHour={startHour}
                      top={top}
                      height={height}
                      left={`${col * w}%`}
                      width={`${w}%`}
                      count={count}
                      onOpen={onOpenTask}
                      onUpdateTask={onUpdateTask}
                    />
                  );
                })}
              </View>
              {/* Live drop indicator while pulling an all-day task onto a time. */}
              {dropMin != null && (
                <View pointerEvents="none" style={[styles.dropLine, { top: TOP_PAD + ((dropMin - startHour * 60) / 60) * HOUR_H, left: GUTTER }]}>
                  <View style={styles.dropDot} />
                  <View style={styles.dropRule} />
                  <Text style={styles.dropTime}>{fmt(dropMin)}</Text>
                </View>
              )}
              {timed.length === 0 && allDay.length === 0 && (
                <Text style={styles.empty}>No events</Text>
              )}
            </View>
          </ScrollView>
        </Pressable>
      </Pressable>
      {/* Floating ghost of the all-day task being dragged onto the grid. */}
      {dragChip && (
        <Animated.View pointerEvents="none" style={[styles.ghost, ghostStyle]}>
          <View style={[styles.ghostChip, { borderLeftColor: color }]}>
            <Text style={styles.ghostText} numberOfLines={1}>{dragChip.title || 'New To-Do'}</Text>
          </View>
        </Animated.View>
      )}
      </GestureHandlerRootView>
    </Modal>
  );
}

// A timed event block. Tap opens it; press-and-drag moves it in time (snapped
// to SNAP minutes) via a live translateY, committing the new start on release.
// When onUpdateTask is absent the block is plain tap-to-open (read-only).
function Block({ task, color, startHour, top, height, left, width, count, onOpen, onUpdateTask }) {
  const ty = useSharedValue(0);
  const moved = useSharedValue(false);
  const draggedRef = React.useRef(false);
  const markDragged = () => { draggedRef.current = true; };
  const handlePress = () => {
    if (draggedRef.current) { draggedRef.current = false; return; }
    onOpen && onOpen(task.id);
  };
  const commitMove = (dtY) => {
    const deltaMin = Math.round((dtY / HOUR_H) * 60 / SNAP) * SNAP;
    if (!deltaMin) return;
    const cur = task.startMinutes;
    const ns = Math.max(startHour * 60, Math.min(END_HOUR * 60 - SNAP, cur + deltaMin));
    if (ns !== cur) onUpdateTask(task.id, { startMinutes: ns });
  };
  const pan = Gesture.Pan()
    .enabled(!!onUpdateTask)
    .activateAfterLongPress(150)
    .onStart(() => { moved.value = false; })
    .onUpdate((e) => {
      if (Math.abs(e.translationY) > 3 && !moved.value) {
        moved.value = true;
        runOnJS(markDragged)();
      }
      if (moved.value) ty.value = e.translationY;
    })
    .onEnd((e) => {
      if (moved.value) runOnJS(commitMove)(e.translationY);
      ty.value = 0;
    });
  const animStyle = useAnimatedStyle(() => ({ transform: [{ translateY: ty.value }] }));
  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[styles.block, { top, height, left, width }, onUpdateTask && styles.blockDraggable, animStyle]}>
        <Pressable onPress={handlePress} style={styles.blockPress}>
          <View style={[styles.blockInner, { backgroundColor: tint(color), borderLeftColor: color }]}>
            <Text style={[styles.blockTitle, task.status !== STATUS.OPEN && styles.done]} numberOfLines={count > 1 ? 2 : 1}>
              {task.title || 'New To-Do'}
            </Text>
            {count < 3 && <Text style={styles.blockTime} numberOfLines={1}>{fmt(task.startMinutes)}</Text>}
          </View>
        </Pressable>
      </Animated.View>
    </GestureDetector>
  );
}

// An all-day task chip. Tap opens it; press-and-drag pulls it down onto the
// hour grid to give it a start time (via coordinate-based drop detection).
function AllDayChip({ task, color, ctx, onOpen }) {
  const draggedRef = React.useRef(false);
  const moved = useSharedValue(false);
  const markDragged = () => { draggedRef.current = true; };
  const handlePress = () => {
    if (draggedRef.current) { draggedRef.current = false; return; }
    onOpen && onOpen(task.id);
  };
  const pan = Gesture.Pan()
    .enabled(ctx.enabled)
    .activateAfterLongPress(150)
    .onStart(() => { moved.value = false; runOnJS(ctx.measure)(); })
    .onUpdate((e) => {
      if (!moved.value && Math.abs(e.translationX) + Math.abs(e.translationY) > 4) {
        moved.value = true;
        runOnJS(markDragged)();
        runOnJS(ctx.begin)(task);
      }
      if (!moved.value) return;
      ctx.ghostX.value = e.absoluteX - 16;
      ctx.ghostY.value = e.absoluteY - 14;
      runOnJS(ctx.updateDrop)(e.absoluteX, e.absoluteY);
    })
    .onEnd((e) => {
      if (moved.value) runOnJS(ctx.end)(task.id, e.absoluteX, e.absoluteY);
      else runOnJS(ctx.cancel)();
    });
  return (
    <GestureDetector gesture={pan}>
      <Animated.View>
        <Pressable onPress={handlePress} style={[styles.allDayChip, { borderLeftColor: color }, ctx.enabled && styles.allDayDraggable]}>
          <Text style={[styles.allDayText, task.status !== STATUS.OPEN && styles.done]} numberOfLines={1}>
            {task.title || 'New To-Do'}
          </Text>
        </Pressable>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  ghRoot: { flex: 1 },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
    ...(Platform.OS === 'web' ? { cursor: 'default' } : null),
  },
  card: {
    width: '100%',
    maxWidth: 640,
    maxHeight: '80%',
    backgroundColor: colors.background,
    borderRadius: radius.lg,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  title: { ...typography.title, color: colors.text, flexShrink: 1 },
  headerBtns: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  openBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.accent, backgroundColor: colors.accentSoft,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  openText: { ...typography.subhead, color: colors.accent, fontWeight: '600' },
  closeBtn: { ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null) },
  allDay: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 4,
    paddingHorizontal: spacing.lg, paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator,
  },
  allDayChip: {
    borderLeftWidth: 3, borderRadius: 4, backgroundColor: colors.surfaceMuted,
    paddingHorizontal: spacing.sm, paddingVertical: 3, maxWidth: '100%',
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  allDayDraggable: { ...(Platform.OS === 'web' ? { cursor: 'grab' } : null) },
  allDayText: { ...typography.caption, color: colors.text },
  dropLine: { position: 'absolute', right: 0, height: 0, flexDirection: 'row', alignItems: 'center' },
  dropDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent, marginLeft: -4 },
  dropRule: { flex: 1, height: 2, backgroundColor: colors.accent, borderRadius: 1 },
  dropTime: { ...typography.caption, color: colors.accent, fontWeight: '700', fontSize: 10, marginLeft: 4, marginRight: 4 },
  ghost: {
    position: 'absolute', top: 0, left: 0, zIndex: 1000,
    ...(Platform.OS === 'web' ? { pointerEvents: 'none' } : null),
  },
  ghostChip: {
    borderLeftWidth: 3, borderLeftColor: colors.accent, borderRadius: 4,
    backgroundColor: colors.background, paddingHorizontal: spacing.sm, paddingVertical: 4,
    maxWidth: 220,
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 8,
  },
  ghostText: { ...typography.caption, color: colors.text, fontWeight: '600' },
  scroll: { paddingHorizontal: spacing.lg },
  hourRow: { position: 'absolute', left: 0, right: 0, height: HOUR_H, flexDirection: 'row', alignItems: 'flex-start' },
  hourLabel: { width: GUTTER, ...typography.caption, color: colors.textTertiary, marginTop: -6, fontSize: 10, textAlign: 'right', paddingRight: 4, fontVariant: ['tabular-nums'] },
  hourLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.separator },
  blockLayer: { position: 'absolute', top: 0, bottom: 0, right: 0 },
  block: { position: 'absolute', paddingRight: 2 },
  blockDraggable: { ...(Platform.OS === 'web' ? { cursor: 'grab' } : null) },
  blockPress: { flex: 1, ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null) },
  blockInner: { flex: 1, borderLeftWidth: 3, borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1, overflow: 'hidden' },
  blockTitle: { ...typography.caption, color: colors.text, fontWeight: '600', fontSize: 11 },
  blockTime: { ...typography.caption, color: colors.textSecondary, fontSize: 9 },
  done: { color: colors.textTertiary, textDecorationLine: 'line-through' },
  empty: { position: 'absolute', top: TOP_PAD + 3 * HOUR_H, left: 0, right: 0, textAlign: 'center', ...typography.subhead, color: colors.textTertiary },
});

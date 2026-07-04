import React, { useCallback, useMemo, useRef, useEffect } from 'react';
import { FlatList, View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import { colors, spacing, typography } from '../theme';
import TaskRow from './TaskRow';
import ProgressPie from './ProgressPie';

// A windowed (virtualized) task list that ALSO supports drag-to-reorder — used
// for lists too large for the rich absolutely-positioned drag surface (e.g. the
// 2k-task project). It's the same FlatList as VirtualTaskList, with three things
// added: uniform-height rows, a long-press drag, and edge auto-scroll.
//
// Why uniform rows: with virtualization only the on-screen rows are mounted, so
// there's no reliable way to know an off-screen row's pixel position. Fixing
// every row to ROW_H makes the target slot a pure function of the pointer's
// content-Y — exact regardless of what's mounted. The trade is that very tall
// rows clip; fine at this scale (huge flat lists), and normal lists never reach
// here (they use the full drag surface).
//
// Only tasks are draggable; headings/dividers/add-rows are static anchors that
// slide aside during the preview. Reorder semantics match the small-list
// surface: on drop, onCommitKeys gets the new key order (a task adopts the
// heading it lands under, via the same commit handler).

const ROW_H = 56; // uniform row height in this mode
const EDGE = 90; // distance from a viewport edge that starts auto-scroll
const SPEED = 12; // auto-scroll px per frame
const EASE = { duration: 140 };

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function listToObject(keys) {
  const o = {};
  keys.forEach((k, i) => (o[k] = i));
  return o;
}

// Move the item at `from` to `to`, sliding the rows in between (shift, not swap).
function objectMove(obj, from, to) {
  const next = {};
  for (const id in obj) {
    const p = obj[id];
    if (p === from) next[id] = to;
    else if (from < to && p > from && p <= to) next[id] = p - 1;
    else if (from > to && p >= to && p < from) next[id] = p + 1;
    else next[id] = p;
  }
  return next;
}

export default function DraggableVirtualTaskList({
  items,
  header,
  showProject = false,
  inProject = false,
  onOpenTask,
  onToggleExpand,
  onToggleCollapse,
  onToggleDivider,
  onAddTask,
  onCommitKeys,
}) {
  // The title rides as the first (non-sticky, non-draggable) row so sticky
  // header indices are plain data indices.
  const data = useMemo(
    () => (header ? [{ kind: '__title', key: '__title__' }, ...items] : items),
    [items, header]
  );
  const stickyIndices = useMemo(() => {
    const s = [];
    data.forEach((it, i) => {
      if (it.kind === 'heading' || (it.kind === 'divider' && it.title)) s.push(i);
    });
    return s;
  }, [data]);
  const dataKeys = useMemo(() => data.map((d) => d.key), [data]);
  const indexByKey = useMemo(() => {
    const m = {};
    dataKeys.forEach((k, i) => (m[k] = i));
    return m;
  }, [dataKeys]);
  const hasTitle = !!header;

  // Preview order during a drag (key -> slot). Reset to identity whenever the
  // item set/order changes (a committed reorder, collapse/expand, etc.).
  const positions = useSharedValue(listToObject(dataKeys));
  const activeKey = useSharedValue(null);
  const activeTranslate = useSharedValue(0);
  useEffect(() => {
    positions.value = listToObject(dataKeys);
  }, [dataKeys.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // Geometry + drag bookkeeping (plain refs — the drag runs on the JS thread).
  const listRef = useRef(null);
  const wrapRef = useRef(null);
  const scrollRef = useRef(0);
  const titleHRef = useRef(0);
  const viewportRef = useRef({ top: 0, height: 0 });
  const dragStartScroll = useRef(0);
  const dragStartFingerY = useRef(0);
  const lastFingerY = useRef(0);
  const autoRAF = useRef(null);
  const autoDir = useRef(0);

  const contentHeight = () => (hasTitle ? titleHRef.current : 0) + items.length * ROW_H;
  const maxScroll = () => Math.max(0, contentHeight() - viewportRef.current.height);

  // Slot the pointer is over, given its absolute Y. First real row is index
  // (hasTitle ? 1 : 0); the title (0) is never a drop target.
  const slotForFinger = (absY) => {
    const firstIdx = hasTitle ? 1 : 0;
    const contentY = scrollRef.current + (absY - viewportRef.current.top) - (hasTitle ? titleHRef.current : 0);
    const slot = firstIdx + Math.floor(contentY / ROW_H);
    return clamp(slot, firstIdx, data.length - 1);
  };

  const updateDrag = (absY) => {
    const key = activeKey.value;
    if (key == null) return;
    // Follow the finger, compensating for any auto-scroll since drag start.
    activeTranslate.value =
      absY - dragStartFingerY.current + (scrollRef.current - dragStartScroll.current);
    const target = slotForFinger(absY);
    if (positions.value[key] !== target) {
      positions.value = objectMove(positions.value, positions.value[key], target);
    }
  };

  const stopAuto = () => {
    if (autoRAF.current != null) {
      cancelAnimationFrame(autoRAF.current);
      autoRAF.current = null;
    }
    autoDir.current = 0;
  };
  const autoStep = () => {
    const next = clamp(scrollRef.current + autoDir.current * SPEED, 0, maxScroll());
    if (next !== scrollRef.current) {
      scrollRef.current = next;
      listRef.current?.scrollToOffset({ offset: next, animated: false });
    }
    updateDrag(lastFingerY.current);
    autoRAF.current = requestAnimationFrame(autoStep);
  };
  const maybeAuto = (absY) => {
    const { top, height } = viewportRef.current;
    let dir = 0;
    if (absY < top + EDGE) dir = -1;
    else if (absY > top + height - EDGE) dir = 1;
    if (dir === 0) {
      stopAuto();
      return;
    }
    autoDir.current = dir;
    if (autoRAF.current == null) autoRAF.current = requestAnimationFrame(autoStep);
  };

  const beginDrag = (key, absY) => {
    // Measure the viewport fresh (scroll container may have moved / resized).
    wrapRef.current?.measureInWindow?.((x, y, w, h) => {
      viewportRef.current = { top: y, height: h };
    });
    dragStartScroll.current = scrollRef.current;
    dragStartFingerY.current = absY;
    lastFingerY.current = absY;
    activeTranslate.value = 0;
    activeKey.value = key;
  };
  const moveDrag = (absY) => {
    if (activeKey.value == null) return;
    lastFingerY.current = absY;
    updateDrag(absY);
    maybeAuto(absY);
  };
  const endDrag = () => {
    stopAuto();
    const key = activeKey.value;
    activeKey.value = null;
    activeTranslate.value = 0;
    if (key == null) return;
    const order = [...dataKeys].sort((a, b) => positions.value[a] - positions.value[b]);
    const keys = order.filter((k) => k !== '__title__');
    const before = dataKeys.filter((k) => k !== '__title__').join(',');
    // Snap everything back to identity; if the order actually changed, the
    // parent will re-render with the new item order and reset us again.
    positions.value = listToObject(dataKeys);
    if (keys.join(',') !== before) onCommitKeys(keys, { draggedKey: key, dx: 0 });
  };

  const onScroll = (e) => {
    scrollRef.current = e.nativeEvent.contentOffset.y;
  };
  const onWrapLayout = () => {
    wrapRef.current?.measureInWindow?.((x, y, w, h) => {
      viewportRef.current = { top: y, height: h };
    });
  };

  const renderRow = useCallback(
    ({ item, index }) => {
      if (item.kind === '__title') {
        return (
          <View onLayout={(e) => { titleHRef.current = e.nativeEvent.layout.height; }}>
            {header}
          </View>
        );
      }
      const draggable = item.kind === 'task';
      return (
        <Cell
          itemKey={item.key}
          index={index}
          draggable={draggable}
          positions={positions}
          activeKey={activeKey}
          activeTranslate={activeTranslate}
          onStart={beginDrag}
          onMove={moveDrag}
          onEnd={endDrag}
        >
          <RowContent
            item={item}
            showProject={showProject}
            inProject={inProject}
            onOpenTask={onOpenTask}
            onToggleExpand={onToggleExpand}
            onToggleCollapse={onToggleCollapse}
            onToggleDivider={onToggleDivider}
            onAddTask={onAddTask}
          />
        </Cell>
      );
    },
    [header, showProject, inProject, onOpenTask, onToggleExpand, onToggleCollapse, onToggleDivider, onAddTask]
  );

  return (
    <View ref={wrapRef} collapsable={false} onLayout={onWrapLayout} style={styles.list}>
      <FlatList
        ref={listRef}
        data={data}
        keyExtractor={(it) => it.key}
        renderItem={renderRow}
        stickyHeaderIndices={stickyIndices}
        onScroll={onScroll}
        scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={24}
        maxToRenderPerBatch={24}
        windowSize={11}
        removeClippedSubviews={false}
        contentContainerStyle={styles.content}
      />
    </View>
  );
}

// One draggable/animated cell. Non-title rows are forced to ROW_H so the drag
// math is exact; the active row lifts and follows the finger, the rest slide to
// their preview slot.
function Cell({ itemKey, index, draggable, positions, activeKey, activeTranslate, onStart, onMove, onEnd, children }) {
  const style = useAnimatedStyle(() => {
    const isActive = activeKey.value === itemKey;
    if (isActive) {
      return {
        transform: [{ translateY: activeTranslate.value }, { scale: 1.03 }],
        zIndex: 999,
        opacity: 0.96,
      };
    }
    const slot = positions.value[itemKey];
    const offset = (slot == null ? index : slot) - index;
    return {
      transform: [{ translateY: withTiming(offset * ROW_H, EASE) }, { scale: 1 }],
      zIndex: 0,
      opacity: 1,
    };
  });

  const pan = Gesture.Pan()
    .activateAfterLongPress(200)
    .onStart((e) => {
      runOnJS(onStart)(itemKey, e.absoluteY);
    })
    .onUpdate((e) => {
      runOnJS(onMove)(e.absoluteY);
    })
    .onEnd(() => {
      runOnJS(onEnd)();
    })
    .onFinalize(() => {
      runOnJS(onEnd)();
    });

  const body = <View style={styles.rowFixed}>{children}</View>;

  return (
    <Animated.View style={[styles.cell, style]}>
      {draggable ? <GestureDetector gesture={pan}>{body}</GestureDetector> : body}
    </Animated.View>
  );
}

// Row visuals — mirrors VirtualTaskList's row rendering.
function RowContent({ item, showProject, inProject, onOpenTask, onToggleExpand, onToggleCollapse, onToggleDivider, onAddTask }) {
  if (item.kind === 'task') {
    return (
      <TaskRow
        task={item.task}
        onPress={() => onOpenTask(item.task.id)}
        onOpenTask={onOpenTask}
        showProject={showProject}
        inProject={inProject}
        showSubtasks
        depth={item.depth || 0}
        hasChildren={item.hasChildren}
        expanded={item.expanded}
        onToggleExpand={onToggleExpand}
      />
    );
  }
  if (item.kind === 'heading') {
    return (
      <Pressable style={styles.heading} onPress={() => onToggleCollapse && onToggleCollapse(item.headingId)}>
        <Ionicons name={item.collapsed ? 'chevron-forward' : 'chevron-down'} size={16} color={colors.textSecondary} />
        <Text style={styles.headingText} numberOfLines={1}>{item.title || 'Section'}</Text>
        {item.total > 0 && (
          <View style={styles.count}>
            <Text style={styles.countText}>{item.done}/{item.total}</Text>
            <ProgressPie progress={item.total ? item.done / item.total : 0} color={item.color} size={14} />
          </View>
        )}
      </Pressable>
    );
  }
  if (item.kind === 'divider') {
    return (
      <Pressable style={styles.divider} onPress={() => item.collapsible && onToggleDivider && onToggleDivider(item.dividerKey)}>
        {item.collapsible && (
          <Ionicons name={item.collapsed ? 'chevron-forward' : 'chevron-down'} size={16} color={colors.textSecondary} />
        )}
        {item.icon && (
          <Ionicons name={item.icon} size={item.iconColor ? 16 : 14} color={item.iconColor || colors.textTertiary} style={{ marginRight: 6 }} />
        )}
        <Text style={[styles.dividerText, item.iconColor && { color: item.iconColor }]} numberOfLines={1}>{item.title}</Text>
        {item.subtitle ? <Text style={styles.dividerSub} numberOfLines={1}>{item.subtitle}</Text> : null}
        {item.total > 0 && (
          <View style={styles.count}>
            <Text style={styles.countText}>{item.done}/{item.total}</Text>
            <ProgressPie progress={item.total ? item.done / item.total : 0} color={item.color} size={14} />
          </View>
        )}
      </Pressable>
    );
  }
  if (item.kind === 'addtask') {
    return (
      <Pressable style={styles.add} onPress={() => onAddTask && onAddTask(item.headingId ?? null)}>
        <Ionicons name="add" size={18} color={colors.textTertiary} />
        <Text style={styles.addText}>Add task</Text>
      </Pressable>
    );
  }
  return null;
}

const styles = StyleSheet.create({
  list: { flex: 1 },
  content: { paddingBottom: 120 },
  // Every non-title row occupies exactly ROW_H so the drag target is exact.
  cell: { height: ROW_H, ...(Platform.OS === 'web' ? { userSelect: 'none' } : null) },
  rowFixed: { height: ROW_H, justifyContent: 'center', overflow: 'hidden' },
  heading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.background,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  headingText: { flex: 1, ...typography.heading, color: colors.text },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
    backgroundColor: colors.background,
    height: ROW_H,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  dividerText: { ...typography.heading, color: colors.text },
  dividerSub: { flex: 1, ...typography.subhead, color: colors.textTertiary },
  count: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  countText: { ...typography.caption, color: colors.textTertiary, fontVariant: ['tabular-nums'] },
  add: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  addText: { ...typography.body, color: colors.textTertiary },
});

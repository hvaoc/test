import React, { useEffect } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useAnimatedReaction,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import TaskRow from './TaskRow';
import { colors, spacing, typography } from '../theme';

// Used only until a row reports its real height via onLayout.
const FALLBACK_H = 48;
// A short, non-bouncy ease — subtle settle, no spring overshoot.
const EASE = { duration: 140 };

// --- worklet layout helpers (variable row heights) -------------------------

function orderedKeys(positions) {
  'worklet';
  const arr = [];
  for (const k in positions) arr[positions[k]] = k;
  return arr;
}

function topForIndex(keys, heights, index) {
  'worklet';
  let t = 0;
  for (let i = 0; i < index; i++) t += heights[keys[i]] ?? FALLBACK_H;
  return t;
}

function totalHeight(keys, heights) {
  'worklet';
  let t = 0;
  for (let i = 0; i < keys.length; i++) t += heights[keys[i]] ?? FALLBACK_H;
  return t;
}

// Move a single index `from` -> `to`.
function reposition(positions, from, to) {
  'worklet';
  const next = { ...positions };
  for (const key in next) {
    const i = next[key];
    if (i === from) next[key] = to;
    else if (from < to && i > from && i <= to) next[key] = i - 1;
    else if (from > to && i >= to && i < from) next[key] = i + 1;
  }
  return next;
}

// Move a contiguous block of keys (kept in their order) to insert at `at`
// among the remaining rows.
function repositionBlock(positions, blockKeys, at) {
  'worklet';
  const arr = orderedKeys(positions);
  const inBlock = {};
  for (let i = 0; i < blockKeys.length; i++) inBlock[blockKeys[i]] = true;
  const rest = arr.filter((k) => !inBlock[k]);
  const clamped = Math.max(0, Math.min(rest.length, at));
  const result = [...rest.slice(0, clamped), ...blockKeys, ...rest.slice(clamped)];
  const next = {};
  for (let i = 0; i < result.length; i++) next[result[i]] = i;
  return next;
}

// Shared per-row logic: where does this row sit right now?
function useRowTop(itemKey, ctx) {
  const { positions, heights, activeId, activeBlockSet, blockTranslate, blockStartTops } = ctx;
  const top = useSharedValue(0);
  useAnimatedReaction(
    () => ({
      pos: positions.value[itemKey],
      h: heights.value,
      inBlock: !!activeBlockSet.value[itemKey],
      bt: blockTranslate.value,
      act: activeId.value,
    }),
    (cur) => {
      if (cur.inBlock) {
        // Part of a heading-block being dragged — follow the block.
        top.value = (blockStartTops.value[itemKey] ?? 0) + cur.bt;
      } else if (itemKey === cur.act) {
        // Own single-item drag handles top directly in onUpdate.
      } else {
        top.value = withTiming(topForIndex(orderedKeys(positions.value), cur.h, cur.pos), EASE);
      }
    }
  );
  return top;
}

function measure(heights, itemKey) {
  return (e) => {
    const h = e.nativeEvent.layout.height;
    if (heights.value[itemKey] !== h) heights.value = { ...heights.value, [itemKey]: h };
  };
}

// --- heading (draggable as a block with its child tasks) -------------------

function HeadingRow({ itemKey, title, headingId, onDelete, onUpdate, onCommit, ctx }) {
  const { positions, heights, kinds, activeBlockKeys, activeBlockSet, blockTranslate, blockStartTops } = ctx;
  const top = useRowTop(itemKey, ctx);

  const base =
    Platform.OS === 'web'
      ? Gesture.Pan().activeOffsetY([-8, 8]).failOffsetX([-12, 12])
      : Gesture.Pan().activateAfterLongPress(180);

  const pan = base
    .onStart(() => {
      const keys = orderedKeys(positions.value);
      const startIdx = positions.value[itemKey];
      // Block = this heading + the consecutive task rows until the next heading.
      const blockKeys = [itemKey];
      for (let i = startIdx + 1; i < keys.length; i++) {
        if (kinds.value[keys[i]] === 'heading') break;
        blockKeys.push(keys[i]);
      }
      const set = {};
      const starts = {};
      for (let i = 0; i < blockKeys.length; i++) {
        const k = blockKeys[i];
        set[k] = true;
        starts[k] = topForIndex(keys, heights.value, positions.value[k]);
      }
      activeBlockKeys.value = blockKeys;
      activeBlockSet.value = set;
      blockStartTops.value = starts;
      blockTranslate.value = 0;
    })
    .onUpdate((e) => {
      blockTranslate.value = e.translationY;
      const keys = orderedKeys(positions.value);
      const blockTop = (blockStartTops.value[itemKey] ?? 0) + e.translationY;
      // A heading block may only land at a *section boundary* — the start of
      // another heading, or the very end — never inside another section. Snap
      // to whichever boundary is closest to the dragged block's top.
      let acc = 0;
      let restIndex = 0;
      let bestIndex = 0;
      let bestDist = -1;
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (activeBlockSet.value[k]) continue;
        if (kinds.value[k] === 'heading') {
          const d = Math.abs(acc - blockTop);
          if (bestDist < 0 || d < bestDist) {
            bestDist = d;
            bestIndex = restIndex;
          }
        }
        acc += heights.value[k] ?? FALLBACK_H;
        restIndex += 1;
      }
      const dEnd = Math.abs(acc - blockTop);
      if (bestDist < 0 || dEnd < bestDist) bestIndex = restIndex;
      positions.value = repositionBlock(positions.value, activeBlockKeys.value, bestIndex);
    })
    .onFinalize(() => {
      // Clearing the block set lets every row reflow to its final slot.
      activeBlockSet.value = {};
      activeBlockKeys.value = [];
      blockTranslate.value = 0;
      runOnJS(onCommit)();
    });

  const style = useAnimatedStyle(() => ({
    position: 'absolute',
    left: 0,
    right: 0,
    top: top.value,
    zIndex: activeBlockSet.value[itemKey] ? 10 : 0,
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={style}>
        <View style={styles.headingRow} onLayout={measure(heights, itemKey)}>
          {onUpdate ? (
            <TextInput
              style={styles.headingTitle}
              value={title}
              onChangeText={(text) => onUpdate(headingId, text)}
              placeholder="Heading"
              placeholderTextColor={colors.placeholder}
            />
          ) : (
            <Text style={styles.headingTitle}>{title}</Text>
          )}
          {onDelete && (
            <Pressable hitSlop={12} onPress={() => onDelete(headingId)} style={styles.headingDelete}>
              <Ionicons name="close" size={15} color={colors.separatorStrong} />
            </Pressable>
          )}
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

// --- task (draggable individually) -----------------------------------------

function DraggableRow({ itemKey, task, showProject, onOpenTask, onCommit, ctx }) {
  const { positions, heights, activeId, activeBlockSet, blockTranslate, blockStartTops } = ctx;
  const top = useRowTop(itemKey, ctx);
  const startTop = useSharedValue(0);

  // A real drag also produces a trailing press/click on web — swallow that one.
  const draggedRef = React.useRef(false);
  const flagDragged = () => {
    draggedRef.current = true;
  };
  const clearDraggedSoon = () => {
    setTimeout(() => {
      draggedRef.current = false;
    }, 80);
  };
  const handlePress = () => {
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    onOpenTask(task.id);
  };

  const base =
    Platform.OS === 'web'
      ? Gesture.Pan().activeOffsetY([-8, 8]).failOffsetX([-12, 12])
      : Gesture.Pan().activateAfterLongPress(180);

  const pan = base
    .onStart(() => {
      activeId.value = itemKey;
      startTop.value = topForIndex(orderedKeys(positions.value), heights.value, positions.value[itemKey]);
      runOnJS(flagDragged)();
    })
    .onUpdate((e) => {
      top.value = startTop.value + e.translationY;
      const keys = orderedKeys(positions.value);
      const myH = heights.value[itemKey] ?? FALLBACK_H;
      const center = top.value + myH / 2;
      let acc = 0;
      let newIndex = 0;
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (k === itemKey) continue;
        const h = heights.value[k] ?? FALLBACK_H;
        if (center > acc + h / 2) newIndex += 1;
        acc += h;
      }
      if (newIndex !== positions.value[itemKey]) {
        positions.value = reposition(positions.value, positions.value[itemKey], newIndex);
      }
    })
    .onEnd(() => {
      top.value = withTiming(
        topForIndex(orderedKeys(positions.value), heights.value, positions.value[itemKey]),
        EASE
      );
    })
    .onFinalize(() => {
      if (activeId.value === itemKey) {
        activeId.value = null;
        runOnJS(onCommit)();
      }
      runOnJS(clearDraggedSoon)();
    });

  const style = useAnimatedStyle(() => ({
    position: 'absolute',
    left: 0,
    right: 0,
    top: top.value,
    zIndex: activeId.value === itemKey || activeBlockSet.value[itemKey] ? 10 : 0,
    transform: [{ scale: withTiming(activeId.value === itemKey ? 1.02 : 1, EASE) }],
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={style}>
        <View style={styles.row} onLayout={measure(heights, itemKey)}>
          <TaskRow task={task} showProject={showProject} onPress={handlePress} />
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

// Drag-to-reorder over a flat `items` array (tasks + heading dividers).
// Tasks drag individually (and can cross headings); a heading drags its whole
// block (heading + child tasks). `onCommitKeys` gets the new ordered key array.
export default function ReorderableTaskList({
  items,
  showProject,
  onOpenTask,
  onCommitKeys,
  onDeleteHeading,
  onUpdateHeading,
}) {
  const ctx = {
    positions: useSharedValue(Object.fromEntries(items.map((it, i) => [it.key, i]))),
    heights: useSharedValue({}),
    kinds: useSharedValue(Object.fromEntries(items.map((it) => [it.key, it.kind]))),
    activeId: useSharedValue(null),
    activeBlockKeys: useSharedValue([]),
    activeBlockSet: useSharedValue({}),
    blockTranslate: useSharedValue(0),
    blockStartTops: useSharedValue({}),
  };
  const { positions, heights, kinds } = ctx;
  const keysKey = items.map((it) => it.key).join(',');

  useEffect(() => {
    positions.value = Object.fromEntries(items.map((it, i) => [it.key, i]));
    kinds.value = Object.fromEntries(items.map((it) => [it.key, it.kind]));
  }, [keysKey]);

  const commit = () => {
    const map = positions.value;
    const arr = new Array(items.length);
    for (const key in map) arr[map[key]] = key;
    onCommitKeys(arr.filter(Boolean));
  };

  const containerStyle = useAnimatedStyle(() => ({
    height: totalHeight(orderedKeys(positions.value), heights.value),
  }));

  return (
    <Animated.View style={containerStyle}>
      {items.map((item) =>
        item.kind === 'heading' ? (
          <HeadingRow
            key={item.key}
            itemKey={item.key}
            title={item.title}
            headingId={item.headingId}
            onDelete={onDeleteHeading}
            onUpdate={onUpdateHeading}
            onCommit={commit}
            ctx={ctx}
          />
        ) : (
          <DraggableRow
            key={item.key}
            itemKey={item.key}
            task={item.task}
            showProject={showProject}
            onOpenTask={onOpenTask}
            onCommit={commit}
            ctx={ctx}
          />
        )
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: { backgroundColor: colors.background, userSelect: 'none' },
  headingRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
    backgroundColor: colors.background,
    userSelect: 'none',
  },
  headingTitle: { flex: 1, ...typography.heading, color: colors.text, padding: 0 },
  headingDelete: { paddingLeft: spacing.md },
});

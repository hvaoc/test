import React, { useEffect } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useAnimatedReaction,
  withSpring,
  runOnJS,
} from 'react-native-reanimated';

const ROW_H = 44; // sidebar row height (paddingVertical 9 + 26px icon)
const SPRING = { damping: 24, stiffness: 240, mass: 0.6 };

// Drag-to-reorder for the middle group of sidebar smart lists. Long-press a row
// to pick it up (a quick tap still navigates); no handle. Layout is a single
// source of truth (a positions map), so committing the new order doesn't make
// rows snap/jump. The drag is clamped to the group's own span, so a row can't
// cross the pinned rows or the Areas below.
export default function ReorderableSmartLists({ ids, renderRow, onReorder }) {
  const positions = useSharedValue(listToObject(ids));

  // Re-seed positions when the id set/order changes (a committed reorder or a
  // new list appearing). For a committed reorder the values are unchanged, so
  // nothing re-animates.
  useEffect(() => {
    positions.value = listToObject(ids);
  }, [ids.join(',')]);

  const commit = () => {
    const order = [...ids].sort((a, b) => positions.value[a] - positions.value[b]);
    if (order.join(',') !== ids.join(',')) onReorder(order);
  };

  return (
    <View style={{ height: ROW_H * ids.length }}>
      {ids.map((id) => (
        <ReorderItem key={id} id={id} count={ids.length} positions={positions} onCommit={commit}>
          {renderRow(id)}
        </ReorderItem>
      ))}
    </View>
  );
}

function listToObject(ids) {
  const o = {};
  ids.forEach((id, i) => (o[id] = i));
  return o;
}

// Move the item at `from` to `to`, sliding the rows in between — the shift, not
// a swap, so multi-slot drags land correctly.
function objectMove(obj, from, to) {
  'worklet';
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

function ReorderItem({ id, count, positions, onCommit, children }) {
  const top = useSharedValue(positions.value[id] * ROW_H);
  const startTop = useSharedValue(0);
  const dragging = useSharedValue(false);

  // Non-dragged rows glide to their slot whenever the positions map changes.
  useAnimatedReaction(
    () => positions.value[id],
    (idx, prev) => {
      if (idx !== prev && !dragging.value) top.value = withSpring(idx * ROW_H, SPRING);
    }
  );

  const pan = Gesture.Pan()
    .activateAfterLongPress(220)
    .onStart(() => {
      dragging.value = true;
      startTop.value = positions.value[id] * ROW_H;
    })
    .onUpdate((e) => {
      const y = Math.max(0, Math.min((count - 1) * ROW_H, startTop.value + e.translationY));
      top.value = y;
      const idx = Math.max(0, Math.min(count - 1, Math.round(y / ROW_H)));
      if (idx !== positions.value[id]) positions.value = objectMove(positions.value, positions.value[id], idx);
    })
    .onEnd(() => {
      dragging.value = false;
      top.value = withSpring(positions.value[id] * ROW_H, SPRING);
      runOnJS(onCommit)();
    });

  const style = useAnimatedStyle(() => ({
    position: 'absolute',
    left: 0,
    right: 0,
    top: top.value,
    zIndex: dragging.value ? 20 : 0,
  }));

  return (
    <Animated.View style={style}>
      <GestureDetector gesture={pan}>
        <View>{children}</View>
      </GestureDetector>
    </Animated.View>
  );
}

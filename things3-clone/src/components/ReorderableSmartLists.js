import React, { useState } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, runOnJS } from 'react-native-reanimated';

// Drag-to-reorder for the middle group of sidebar smart lists. Long-press a row
// to pick it up; the drag is clamped to the group's own vertical span, so a row
// can never be dropped above the pinned top row or below the pinned bottom rows
// (or into the Areas beneath). A quick tap still navigates (the Pan only
// activates after a long press). Persist the new order via onReorder.
export default function ReorderableSmartLists({ ids, renderRow, onReorder }) {
  const [rowH, setRowH] = useState(44);
  const from = useSharedValue(-1); // index of the row being dragged
  const over = useSharedValue(-1); // current insertion index
  const dragY = useSharedValue(0); // translateY of the dragged row

  const commit = (f, t) => {
    if (f < 0 || t < 0 || f === t) return;
    const next = ids.slice();
    const [moved] = next.splice(f, 1);
    next.splice(t, 0, moved);
    onReorder(next);
  };

  return (
    <View>
      {ids.map((id, index) => (
        <ReorderRow
          key={id}
          index={index}
          count={ids.length}
          rowH={rowH}
          from={from}
          over={over}
          dragY={dragY}
          onCommit={commit}
          onMeasure={index === 0 ? setRowH : undefined}
        >
          {renderRow(id)}
        </ReorderRow>
      ))}
    </View>
  );
}

function ReorderRow({ index, count, rowH, from, over, dragY, onCommit, onMeasure, children }) {
  const pan = Gesture.Pan()
    .activateAfterLongPress(220)
    .onStart(() => {
      from.value = index;
      over.value = index;
      dragY.value = 0;
    })
    .onUpdate((e) => {
      const minY = -index * rowH;
      const maxY = (count - 1 - index) * rowH;
      dragY.value = Math.max(minY, Math.min(maxY, e.translationY));
      over.value = Math.max(0, Math.min(count - 1, index + Math.round(dragY.value / rowH)));
    })
    .onEnd(() => {
      const f = from.value;
      const t = over.value;
      from.value = -1;
      over.value = -1;
      dragY.value = 0;
      if (f !== t) runOnJS(onCommit)(f, t);
    });

  const style = useAnimatedStyle(() => {
    // The picked-up row follows the finger and floats above the others.
    if (from.value === index) {
      return { transform: [{ translateY: dragY.value }], zIndex: 20 };
    }
    // Everyone else slides to open a gap at the current insertion point.
    let shift = 0;
    if (from.value >= 0 && over.value >= 0) {
      if (from.value < index && over.value >= index) shift = -rowH;
      else if (from.value > index && over.value <= index) shift = rowH;
    }
    return { transform: [{ translateY: withTiming(shift, { duration: 140 }) }], zIndex: 0 };
  });

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        style={style}
        onLayout={onMeasure ? (e) => onMeasure(Math.round(e.nativeEvent.layout.height)) : undefined}
      >
        {children}
      </Animated.View>
    </GestureDetector>
  );
}

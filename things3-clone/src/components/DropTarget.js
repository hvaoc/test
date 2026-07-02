import React, { useEffect, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { colors, radius } from '../theme';
import { useDrag } from '../store/DragContext';

// Wraps a sidebar row so a task dragged from the detail pane can be dropped on
// it. Registers its on-screen rect with the DragContext and fades in an accent
// highlight while the dragged pointer is over it. A no-op passthrough when
// there's no DragProvider (phone / single-pane).
export default function DropTarget({ targetKey, meta, style, children }) {
  const drag = useDrag();
  const ref = useRef(null);

  // Keep node + latest meta registered while mounted.
  useEffect(() => {
    if (drag) drag.register(targetKey, ref, meta);
  });
  useEffect(() => {
    if (!drag) return undefined;
    return () => drag.unregister(targetKey);
  }, [targetKey]);

  const highlight = useAnimatedStyle(() => ({
    opacity: drag && drag.hovered.value === targetKey ? 1 : 0,
  }));

  if (!drag) return <View style={style}>{children}</View>;

  return (
    <View ref={ref} style={style} collapsable={false}>
      <Animated.View pointerEvents="none" style={[styles.highlight, highlight]} />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  highlight: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
  },
});

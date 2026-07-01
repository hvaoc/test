import React from 'react';
import { Pressable, StyleSheet, Platform } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius } from '../theme';
import { STATUS } from '../store/constants';

const HOVERABLE = Platform.OS === 'web';

// The Things checkbox: a rounded square that fills with the accent color when
// completed, or shows an X tint when canceled. When open, `borderColor` lets a
// caller tint the outline (e.g. a task's priority in the project view). On web,
// hovering an open box fades in a tick and a faint (25%) fill in that same
// border color.
export default function Checkbox({ status = STATUS.OPEN, color, borderColor, onPress, size = 22 }) {
  const done = status === STATUS.COMPLETED;
  const canceled = status === STATUS.CANCELED;
  const tint = color || colors.accent;
  const openBorder = borderColor || colors.separatorStrong;

  const hover = useSharedValue(0);
  // Interior fades to 25% of the border color; the tick fades fully in.
  const fillStyle = useAnimatedStyle(() => ({ opacity: hover.value * 0.25 }));
  const tickStyle = useAnimatedStyle(() => ({ opacity: hover.value }));
  const hoverProps =
    HOVERABLE && !done && !canceled
      ? {
          onHoverIn: () => (hover.value = withTiming(1, { duration: 150 })),
          onHoverOut: () => (hover.value = withTiming(0, { duration: 150 })),
        }
      : null;

  return (
    <Pressable
      hitSlop={10}
      onPress={onPress}
      {...hoverProps}
      style={[
        styles.box,
        {
          width: size,
          height: size,
          borderRadius: radius.sm,
          borderColor: done || canceled ? tint : openBorder,
          backgroundColor: done ? tint : canceled ? '#f0f0f2' : 'transparent',
        },
      ]}
    >
      {!done && !canceled && HOVERABLE && (
        <>
          <Animated.View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              { borderRadius: radius.sm - 1, backgroundColor: openBorder },
              fillStyle,
            ]}
          />
          <Animated.View style={tickStyle} pointerEvents="none">
            <Ionicons name="checkmark" size={size - 8} color={openBorder} />
          </Animated.View>
        </>
      )}
      {done && <Ionicons name="checkmark" size={size - 8} color={colors.white} />}
      {canceled && (
        <Ionicons name="close" size={size - 8} color={colors.textSecondary} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: {
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

import React, { useRef, useEffect } from 'react';
import { Animated, View, Text, StyleSheet, Platform } from 'react-native';
import { colors, spacing, typography } from '../theme';

// A small, self-fading "added by X" pill. Mounts at full opacity, holds briefly,
// then eases to 0 — a subtle, momentary hint. It carries NO persisted state; the
// parent shows it only while an ephemeral mark exists and unmounts it after.
// Reusable: give it any label + colour.
export default function EphemeralBadge({ label, color, duration = 2800, hold = 800 }) {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const anim = Animated.timing(opacity, {
      toValue: 0,
      duration,
      delay: hold,
      useNativeDriver: Platform.OS !== 'web', // web has no native driver for opacity
    });
    anim.start();
    return () => anim.stop();
  }, [opacity, duration, hold]);

  return (
    <Animated.View style={[styles.pill, { opacity, borderColor: color || colors.accent }]}>
      <View style={[styles.dot, { backgroundColor: color || colors.accent }]} />
      <Text style={styles.text} numberOfLines={1}>
        {label}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
    borderRadius: 999,
    borderWidth: 1,
    backgroundColor: colors.surfaceMuted,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  text: { ...typography.caption, color: colors.textSecondary },
});

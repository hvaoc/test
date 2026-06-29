import React from 'react';
import { Pressable, View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius } from '../theme';
import { STATUS } from '../store/constants';

// The Things checkbox: a rounded square that fills with the accent color when
// completed, or shows an X tint when canceled.
export default function Checkbox({ status = STATUS.OPEN, color, onPress, size = 22 }) {
  const done = status === STATUS.COMPLETED;
  const canceled = status === STATUS.CANCELED;
  const tint = color || colors.accent;

  return (
    <Pressable
      hitSlop={10}
      onPress={onPress}
      style={[
        styles.box,
        {
          width: size,
          height: size,
          borderRadius: radius.sm,
          borderColor: done || canceled ? tint : colors.separatorStrong,
          backgroundColor: done ? tint : canceled ? '#f0f0f2' : 'transparent',
        },
      ]}
    >
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

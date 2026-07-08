import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import BottomSheet from './BottomSheet';
import MiniCalendar from './MiniCalendar';
import { colors, spacing, typography } from '../theme';

// Deadline picker — the red flag in Things. A deadline is a hard due date,
// distinct from "when" you plan to work on it.
export default function DeadlineSheet({ visible, onClose, value, onChange }) {
  const choose = (key) => {
    onChange(key);
    onClose();
  };

  return (
    <BottomSheet visible={visible} onClose={onClose} title="Deadline">
      <MiniCalendar selected={value} onSelect={choose} />
      {value ? (
        <Pressable testID="deadline-remove" style={styles.clear} onPress={() => choose(null)}>
          <Ionicons name="close-circle" size={18} color={colors.textSecondary} />
          <Text style={styles.clearText}>Remove Deadline</Text>
        </Pressable>
      ) : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  clear: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    marginTop: spacing.sm,
  },
  clearText: { ...typography.body, color: colors.textSecondary },
});

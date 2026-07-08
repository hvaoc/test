import React from 'react';
import { Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import BottomSheet from './BottomSheet';
import { colors, spacing, typography } from '../theme';
import { PRIORITIES } from '../store/constants';

// Pick a task priority (or clear it).
export default function PrioritySheet({ visible, onClose, value, onChange }) {
  const pick = (key) => {
    onChange(key);
    onClose();
  };
  return (
    <BottomSheet visible={visible} onClose={onClose} title="Priority">
      {PRIORITIES.map((p) => (
        <Pressable testID={`priority-option-${p.key}`} key={p.key} style={styles.row} onPress={() => pick(p.key)}>
          <Ionicons name="flag" size={18} color={p.color} />
          <Text style={styles.label}>{p.label}</Text>
          {value === p.key && <Ionicons name="checkmark" size={18} color={colors.accent} />}
        </Pressable>
      ))}
      <Pressable testID="priority-option-none" style={styles.row} onPress={() => pick(null)}>
        <Ionicons name="flag-outline" size={18} color={colors.textTertiary} />
        <Text style={styles.label}>None</Text>
        {!value && <Ionicons name="checkmark" size={18} color={colors.accent} />}
      </Pressable>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  label: { flex: 1, ...typography.body, color: colors.text },
});

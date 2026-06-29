import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import BottomSheet from './BottomSheet';
import MiniCalendar from './MiniCalendar';
import { colors, spacing, typography } from '../theme';
import { WHEN } from '../store/constants';

// "When" scheduler — the yellow star menu in Things. Lets you drop a task into
// Today, This Evening, Someday, or pick a concrete date; or clear scheduling.
export default function WhenSheet({ visible, onClose, value, onChange }) {
  const choose = (when) => {
    onChange(when);
    onClose();
  };

  const Option = ({ icon, color, label, onPress, active }) => (
    <Pressable style={styles.option} onPress={onPress}>
      <Ionicons name={icon} size={20} color={color} style={styles.optIcon} />
      <Text style={styles.optLabel}>{label}</Text>
      {active && <Ionicons name="checkmark" size={20} color={colors.accent} />}
    </Pressable>
  );

  return (
    <BottomSheet visible={visible} onClose={onClose} title="When">
      <Option
        icon="star"
        color={colors.today}
        label="Today"
        active={value === WHEN.TODAY}
        onPress={() => choose(WHEN.TODAY)}
      />
      <Option
        icon="moon"
        color={colors.someday}
        label="This Evening"
        active={value === WHEN.EVENING}
        onPress={() => choose(WHEN.EVENING)}
      />
      <Option
        icon="archive"
        color={colors.someday}
        label="Someday"
        active={value === WHEN.SOMEDAY}
        onPress={() => choose(WHEN.SOMEDAY)}
      />

      <View style={styles.divider} />

      <MiniCalendar
        selected={
          value && ![WHEN.TODAY, WHEN.EVENING, WHEN.SOMEDAY].includes(value)
            ? value
            : null
        }
        onSelect={(key) => choose(key)}
      />

      {value ? (
        <Pressable style={styles.clear} onPress={() => choose(null)}>
          <Ionicons name="close-circle" size={18} color={colors.textSecondary} />
          <Text style={styles.clearText}>Clear</Text>
        </Pressable>
      ) : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    gap: spacing.md,
  },
  optIcon: { width: 24, textAlign: 'center' },
  optLabel: { flex: 1, ...typography.body, color: colors.text },
  divider: {
    height: 1,
    backgroundColor: colors.separator,
    marginVertical: spacing.sm,
  },
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

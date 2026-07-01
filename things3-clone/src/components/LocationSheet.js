import React from 'react';
import { View, TextInput, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import BottomSheet from './BottomSheet';
import { colors, spacing, typography, radius } from '../theme';

// A free-text location for the task (updates live).
export default function LocationSheet({ visible, onClose, value, onChange }) {
  return (
    <BottomSheet visible={visible} onClose={onClose} title="Location">
      <View style={styles.inputRow}>
        <Ionicons name="location-outline" size={18} color={colors.textTertiary} />
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={onChange}
          placeholder="Add a location…"
          placeholderTextColor={colors.placeholder}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={onClose}
        />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.groupedBackground,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.md,
  },
  input: { flex: 1, ...typography.body, color: colors.text, padding: 0 },
});

import React, { useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  TextInput,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import BottomSheet from './BottomSheet';
import { colors, spacing, typography, radius } from '../theme';
import { useTasks } from '../store/TasksContext';

// Tag picker with inline creation.
export default function TagSheet({ visible, onClose, selected = [], onChange }) {
  const { state, addTag } = useTasks();
  const [draft, setDraft] = useState('');

  const toggle = (tag) => {
    if (selected.includes(tag)) {
      onChange(selected.filter((t) => t !== tag));
    } else {
      onChange([...selected, tag]);
    }
  };

  const create = () => {
    const tag = draft.trim();
    if (!tag) return;
    addTag(tag);
    if (!selected.includes(tag)) onChange([...selected, tag]);
    setDraft('');
  };

  return (
    <BottomSheet visible={visible} onClose={onClose} title="Tags">
      <View style={styles.inputRow}>
        <Ionicons name="pricetag-outline" size={18} color={colors.textTertiary} />
        <TextInput
          style={styles.input}
          placeholder="New tag…"
          placeholderTextColor={colors.placeholder}
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={create}
          returnKeyType="done"
        />
        {draft.length > 0 && (
          <Pressable onPress={create}>
            <Text style={styles.add}>Add</Text>
          </Pressable>
        )}
      </View>

      <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={styles.chips}>
        {state.tags.map((tag) => {
          const active = selected.includes(tag);
          return (
            <Pressable
              key={tag}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => toggle(tag)}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {tag}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.md,
  },
  input: { flex: 1, ...typography.body, color: colors.text, padding: 0 },
  add: { ...typography.body, color: colors.accent, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingBottom: spacing.md },
  chip: {
    borderWidth: 1,
    borderColor: colors.separatorStrong,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { ...typography.callout, color: colors.text },
  chipTextActive: { color: colors.white, fontWeight: '600' },
});

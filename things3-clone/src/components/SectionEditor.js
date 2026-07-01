import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, Platform } from 'react-native';
import { colors, spacing, typography, radius } from '../theme';

// Title + description edit form for a section (heading). One bordered card with
// the fields stacked inside and the actions on the right — matching the inline
// task compose card. Used inline (wide) and inside a full-page view (mobile).
export default function SectionEditor({ title: initialTitle, description: initialDescription, onSave, onCancel }) {
  const [title, setTitle] = useState(initialTitle || '');
  const [description, setDescription] = useState(initialDescription || '');

  const save = () => onSave({ title: title.trim() || 'Untitled', description: description.trim() });

  return (
    <View style={styles.card}>
      <TextInput
        style={styles.title}
        value={title}
        onChangeText={setTitle}
        placeholder="Section name"
        placeholderTextColor={colors.placeholder}
        autoFocus
        returnKeyType="done"
        onSubmitEditing={save}
      />
      <TextInput
        style={styles.desc}
        value={description}
        onChangeText={setDescription}
        placeholder="Description"
        placeholderTextColor={colors.placeholder}
        multiline
      />
      <View style={styles.actions}>
        <Pressable style={styles.cancel} onPress={onCancel}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
        <Pressable style={styles.save} onPress={save}>
          <Text style={styles.saveText}>Save</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: colors.separatorStrong,
    borderRadius: radius.sm,
    padding: spacing.md,
    gap: spacing.xs,
    backgroundColor: colors.background,
  },
  title: {
    ...typography.heading,
    color: colors.text,
    padding: 0,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null),
  },
  desc: {
    ...typography.subhead,
    color: colors.textSecondary,
    padding: 0,
    minHeight: 34,
    textAlignVertical: 'top',
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null),
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator,
    paddingTop: spacing.sm,
  },
  cancel: {
    backgroundColor: colors.groupedBackground,
    borderRadius: 4,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  cancelText: { ...typography.subhead, color: colors.textSecondary, fontWeight: '600' },
  save: {
    backgroundColor: colors.accent,
    borderRadius: 4,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  saveText: { ...typography.subhead, color: colors.white, fontWeight: '600' },
});

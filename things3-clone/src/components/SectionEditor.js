import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native';
import { colors, spacing, typography, radius } from '../theme';

// Title + description edit form for a section (heading), with Save / Cancel.
// Used inline in the project view (wide) and inside a full-screen page (mobile).
export default function SectionEditor({ title: initialTitle, description: initialDescription, onSave, onCancel }) {
  const [title, setTitle] = useState(initialTitle || '');
  const [description, setDescription] = useState(initialDescription || '');

  const save = () => onSave({ title: title.trim() || 'Untitled', description: description.trim() });

  return (
    <View style={styles.wrap}>
      <TextInput
        style={styles.titleInput}
        value={title}
        onChangeText={setTitle}
        placeholder="Section name"
        placeholderTextColor={colors.placeholder}
        autoFocus
        returnKeyType="done"
        onSubmitEditing={save}
      />
      <TextInput
        style={styles.descInput}
        value={description}
        onChangeText={setDescription}
        placeholder="Description"
        placeholderTextColor={colors.placeholder}
        multiline
      />
      <View style={styles.actions}>
        <Pressable style={styles.save} onPress={save}>
          <Text style={styles.saveText}>Save</Text>
        </Pressable>
        <Pressable style={styles.cancel} onPress={onCancel}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

const box = {
  borderWidth: 1,
  borderColor: colors.separatorStrong,
  borderRadius: radius.md,
  paddingHorizontal: spacing.md,
  paddingVertical: spacing.sm,
  color: colors.text,
};

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm, paddingVertical: spacing.sm },
  titleInput: { ...box, ...typography.heading },
  descInput: { ...box, ...typography.body, minHeight: 88, textAlignVertical: 'top' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.xs },
  save: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  saveText: { ...typography.body, color: colors.white, fontWeight: '600' },
  cancel: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  cancelText: { ...typography.body, color: colors.textSecondary, fontWeight: '600' },
});

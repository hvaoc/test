import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Platform,
} from 'react-native';
import { colors, spacing, typography } from '../theme';
import { useTasks } from '../store/TasksContext';
import { selectProjectTasks, isOpen } from '../store/selectors';
import ProgressPie from './ProgressPie';
import EmojiPicker from './EmojiPicker';

// Editable header shown atop a project: title, notes, progress ring, and a
// Delete action. Scheduling/priority/etc. live on the individual tasks; adding
// a section is done inline in the project body.
export default function ProjectHeader({ project, navigation }) {
  const { state, updateProject } = useTasks();
  const [pickerOpen, setPickerOpen] = useState(false);

  const tasks = selectProjectTasks(state.tasks, project.id);
  const total = tasks.length;
  const done = tasks.filter((t) => !isOpen(t)).length;
  const progress = total ? done / total : 0;

  return (
    <View style={styles.wrap}>
      <View style={styles.titleRow}>
        {/* Optional emoji icon (used in the sidebar too); "#" when empty. Tap to
            open the emoji picker. */}
        <Pressable style={styles.emoji} onPress={() => setPickerOpen(true)}>
          <Text style={[styles.emojiText, !project.emoji && { color: project.color, fontWeight: '700' }]}>
            {project.emoji || '#'}
          </Text>
        </Pressable>
        <TextInput
          style={styles.title}
          value={project.name}
          onChangeText={(name) => updateProject(project.id, { name })}
          placeholder="Project name"
          placeholderTextColor={colors.placeholder}
        />
        {total > 0 && (
          <View style={styles.progressWrap}>
            <Text style={styles.progressCount}>
              {done}/{total}
            </Text>
            <ProgressPie progress={progress} color={project.color} size={16} />
          </View>
        )}
      </View>

      <TextInput
        style={styles.notes}
        value={project.notes}
        onChangeText={(notes) => updateProject(project.id, { notes })}
        placeholder="Notes"
        placeholderTextColor={colors.placeholder}
        multiline
      />

      <EmojiPicker
        visible={pickerOpen}
        current={project.emoji}
        color={project.color}
        onColorChange={(c) => updateProject(project.id, { color: c })}
        onSelect={(e) => { updateProject(project.id, { emoji: e }); setPickerOpen(false); }}
        onRemove={() => { updateProject(project.id, { emoji: '' }); setPickerOpen(false); }}
        onClose={() => setPickerOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: spacing.lg,
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  emoji: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  emojiText: { fontSize: 26, color: colors.text, textAlign: 'center' },
  emojiPlaceholder: { color: colors.textTertiary },
  title: { flex: 1, ...typography.largeTitle, fontSize: 28, color: colors.text, padding: 0 },
  progressWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  progressCount: { ...typography.subhead, color: colors.textTertiary, fontVariant: ['tabular-nums'] },
  notes: {
    ...typography.body,
    color: colors.textSecondary,
    marginTop: spacing.sm,
    marginLeft: 34,
    padding: 0,
  },
});

import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, typography } from '../theme';
import { useTasks } from '../store/TasksContext';
import { selectProjectTasks, isOpen } from '../store/selectors';
import { relativeLabel, isPast, isToday } from '../utils/date';
import DeadlineSheet from './DeadlineSheet';

// Editable header shown atop a project: title, notes, progress ring, deadline,
// and an action row (add heading, delete project).
export default function ProjectHeader({ project, navigation }) {
  const { state, updateProject, deleteProject, addHeading } = useTasks();
  const [sheet, setSheet] = useState(null);

  const tasks = selectProjectTasks(state.tasks, project.id);
  const total = tasks.length;
  const done = tasks.filter((t) => !isOpen(t)).length;
  const progress = total ? done / total : 0;

  const deadlineOverdue =
    project.deadline && (isPast(project.deadline) || isToday(project.deadline));

  const confirmDelete = () => {
    Alert.alert('Delete Project', `Delete "${project.name}"? Its to-dos will move to your Inbox.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          deleteProject(project.id);
          navigation.goBack();
        },
      },
    ]);
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.titleRow}>
        <ProgressPie progress={progress} color={project.color} />
        <TextInput
          style={styles.title}
          value={project.name}
          onChangeText={(name) => updateProject(project.id, { name })}
          placeholder="Project name"
          placeholderTextColor={colors.placeholder}
        />
      </View>

      <TextInput
        style={styles.notes}
        value={project.notes}
        onChangeText={(notes) => updateProject(project.id, { notes })}
        placeholder="Notes"
        placeholderTextColor={colors.placeholder}
        multiline
      />

      <View style={styles.actions}>
        <Pressable
          style={styles.actionBtn}
          onPress={() => setSheet('deadline')}
        >
          <Ionicons
            name="flag-outline"
            size={16}
            color={deadlineOverdue ? colors.deadline : colors.textSecondary}
          />
          <Text
            style={[
              styles.actionText,
              deadlineOverdue && { color: colors.deadline },
            ]}
          >
            {project.deadline ? relativeLabel(project.deadline) : 'Deadline'}
          </Text>
        </Pressable>

        <Pressable
          style={styles.actionBtn}
          onPress={() => addHeading(project.id, 'New Heading')}
        >
          <Ionicons name="text-outline" size={16} color={colors.textSecondary} />
          <Text style={styles.actionText}>Heading</Text>
        </Pressable>

        <Pressable style={styles.actionBtn} onPress={confirmDelete}>
          <Ionicons name="trash-outline" size={16} color={colors.textSecondary} />
          <Text style={styles.actionText}>Delete</Text>
        </Pressable>
      </View>

      <DeadlineSheet
        visible={sheet === 'deadline'}
        onClose={() => setSheet(null)}
        value={project.deadline}
        onChange={(deadline) => updateProject(project.id, { deadline })}
      />
    </View>
  );
}

function ProgressPie({ progress, color }) {
  return (
    <View style={[styles.pie, { borderColor: color }]}>
      <View
        style={[
          styles.pieFill,
          { backgroundColor: color, height: 18 * progress },
        ]}
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
  pie: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  pieFill: { width: '100%' },
  title: { flex: 1, ...typography.largeTitle, fontSize: 28, color: colors.text, padding: 0 },
  notes: {
    ...typography.body,
    color: colors.textSecondary,
    marginTop: spacing.sm,
    marginLeft: 34,
    padding: 0,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.lg,
    marginTop: spacing.md,
    marginLeft: 34,
  },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  actionText: { ...typography.subhead, color: colors.textSecondary },
});

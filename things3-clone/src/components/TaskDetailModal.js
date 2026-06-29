import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Checkbox from './Checkbox';
import WhenSheet from './WhenSheet';
import DeadlineSheet from './DeadlineSheet';
import MoveSheet from './MoveSheet';
import TagSheet from './TagSheet';
import { colors, spacing, typography, radius } from '../theme';
import { WHEN, STATUS } from '../store/constants';
import { relativeLabel } from '../utils/date';
import { useTasks } from '../store/TasksContext';

// Maps a "when" value to the chip label/icon shown on the schedule button.
function whenMeta(when) {
  if (!when) return { label: 'When', icon: 'calendar-outline', color: colors.textSecondary };
  if (when === WHEN.TODAY) return { label: 'Today', icon: 'star', color: colors.today };
  if (when === WHEN.EVENING) return { label: 'This Evening', icon: 'moon', color: colors.someday };
  if (when === WHEN.SOMEDAY) return { label: 'Someday', icon: 'archive', color: colors.someday };
  return { label: relativeLabel(when), icon: 'calendar', color: colors.accent };
}

// Full-screen to-do editor. Receives the task id; reads live data from context.
export default function TaskDetailModal({ visible, taskId, onClose }) {
  const insets = useSafeAreaInsets();
  const { state, updateTask, toggleTask, setStatus, deleteTask, addCheck, toggleCheck, updateCheck, deleteCheck } = useTasks();
  const task = state.tasks.find((t) => t.id === taskId);

  const [sheet, setSheet] = useState(null); // 'when' | 'deadline' | 'move' | 'tags'
  const [newCheck, setNewCheck] = useState('');

  if (!task) return null;

  const project = task.projectId
    ? state.projects.find((p) => p.id === task.projectId)
    : null;
  const area = !project && task.areaId
    ? state.areas.find((a) => a.id === task.areaId)
    : null;
  const containerLabel = project?.name || area?.name || 'Inbox';
  const containerColor = project?.color || area?.color || colors.inbox;

  const when = whenMeta(task.when);
  const done = task.status !== STATUS.OPEN;

  const submitCheck = () => {
    const title = newCheck.trim();
    if (!title) return;
    addCheck(task.id, title);
    setNewCheck('');
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.container, { paddingTop: insets.top }]}>
        {/* Top bar */}
        <View style={styles.topBar}>
          <Pressable hitSlop={10} onPress={onClose} style={styles.topBtn}>
            <Ionicons name="chevron-back" size={26} color={colors.accent} />
            <Text style={styles.backText} numberOfLines={1}>
              {containerLabel}
            </Text>
          </Pressable>
          <View style={styles.topActions}>
            <Pressable
              hitSlop={10}
              onPress={() =>
                setStatus(
                  task.id,
                  task.status === STATUS.CANCELED ? STATUS.OPEN : STATUS.CANCELED
                )
              }
            >
              <Ionicons
                name="close-circle-outline"
                size={24}
                color={task.status === STATUS.CANCELED ? colors.deadline : colors.textSecondary}
              />
            </Pressable>
            <Pressable hitSlop={10} onPress={() => { deleteTask(task.id); onClose(); }}>
              <Ionicons name="trash-outline" size={22} color={colors.textSecondary} />
            </Pressable>
          </View>
        </View>

        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView
            contentContainerStyle={styles.scroll}
            keyboardShouldPersistTaps="handled"
          >
            {/* Title row */}
            <View style={styles.titleRow}>
              <Checkbox
                status={task.status}
                color={project?.color}
                onPress={() => toggleTask(task.id)}
                size={24}
              />
              <TextInput
                style={[styles.title, done && styles.titleDone]}
                value={task.title}
                placeholder="New To-Do"
                placeholderTextColor={colors.placeholder}
                onChangeText={(text) => updateTask(task.id, { title: text })}
                multiline
              />
            </View>

            {/* Notes */}
            <TextInput
              style={styles.notes}
              value={task.notes}
              placeholder="Notes"
              placeholderTextColor={colors.placeholder}
              onChangeText={(text) => updateTask(task.id, { notes: text })}
              multiline
            />

            {/* Checklist */}
            {task.checklist.length > 0 && (
              <View style={styles.checklist}>
                {task.checklist.map((c) => (
                  <View key={c.id} style={styles.checkRow}>
                    <Pressable hitSlop={8} onPress={() => toggleCheck(task.id, c.id)}>
                      <Ionicons
                        name={c.done ? 'checkmark-circle' : 'ellipse-outline'}
                        size={20}
                        color={c.done ? colors.accent : colors.separatorStrong}
                      />
                    </Pressable>
                    <TextInput
                      style={[styles.checkText, c.done && styles.checkTextDone]}
                      value={c.title}
                      onChangeText={(text) => updateCheck(task.id, c.id, text)}
                    />
                    <Pressable hitSlop={8} onPress={() => deleteCheck(task.id, c.id)}>
                      <Ionicons name="close" size={16} color={colors.textTertiary} />
                    </Pressable>
                  </View>
                ))}
              </View>
            )}

            <View style={styles.checkRow}>
              <Ionicons name="add-circle-outline" size={20} color={colors.textTertiary} />
              <TextInput
                style={styles.checkText}
                value={newCheck}
                placeholder="Add checklist item"
                placeholderTextColor={colors.placeholder}
                onChangeText={setNewCheck}
                onSubmitEditing={submitCheck}
                blurOnSubmit={false}
                returnKeyType="done"
              />
            </View>

            {/* Tags */}
            {task.tags.length > 0 && (
              <View style={styles.tagsRow}>
                {task.tags.map((tag) => (
                  <View key={tag} style={styles.tagChip}>
                    <Text style={styles.tagText}>{tag}</Text>
                  </View>
                ))}
              </View>
            )}
          </ScrollView>

          {/* Attribute toolbar */}
          <View style={[styles.toolbar, { paddingBottom: insets.bottom + spacing.sm }]}>
            <ToolButton
              icon={when.icon}
              color={when.color}
              label={when.label}
              active={!!task.when}
              onPress={() => setSheet('when')}
            />
            <ToolButton
              icon="flag-outline"
              color={task.deadline ? colors.deadline : colors.textSecondary}
              label={task.deadline ? relativeLabel(task.deadline) : 'Deadline'}
              active={!!task.deadline}
              onPress={() => setSheet('deadline')}
            />
            <ToolButton
              icon="pricetag-outline"
              color={colors.textSecondary}
              label={task.tags.length ? `${task.tags.length} Tag${task.tags.length > 1 ? 's' : ''}` : 'Tags'}
              active={task.tags.length > 0}
              onPress={() => setSheet('tags')}
            />
            <ToolButton
              icon="ellipse"
              color={containerColor}
              label="Move"
              onPress={() => setSheet('move')}
            />
          </View>
        </KeyboardAvoidingView>

        <WhenSheet
          visible={sheet === 'when'}
          onClose={() => setSheet(null)}
          value={task.when}
          onChange={(when) => updateTask(task.id, { when })}
        />
        <DeadlineSheet
          visible={sheet === 'deadline'}
          onClose={() => setSheet(null)}
          value={task.deadline}
          onChange={(deadline) => updateTask(task.id, { deadline })}
        />
        <MoveSheet
          visible={sheet === 'move'}
          onClose={() => setSheet(null)}
          task={task}
          onMove={(patch) => updateTask(task.id, patch)}
        />
        <TagSheet
          visible={sheet === 'tags'}
          onClose={() => setSheet(null)}
          selected={task.tags}
          onChange={(tags) => updateTask(task.id, { tags })}
        />
      </View>
    </Modal>
  );
}

function ToolButton({ icon, color, label, onPress, active }) {
  return (
    <Pressable style={styles.toolBtn} onPress={onPress}>
      <Ionicons name={icon} size={22} color={color} />
      <Text
        style={[styles.toolLabel, active && { color, fontWeight: '600' }]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  topBtn: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  backText: { ...typography.body, color: colors.accent, flexShrink: 1 },
  topActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, paddingRight: spacing.sm },
  scroll: { padding: spacing.lg, paddingBottom: spacing.xxl },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  title: {
    flex: 1,
    ...typography.title,
    fontSize: 22,
    color: colors.text,
    padding: 0,
  },
  titleDone: { color: colors.textTertiary, textDecorationLine: 'line-through' },
  notes: {
    ...typography.body,
    color: colors.text,
    marginTop: spacing.lg,
    marginLeft: spacing.xl + spacing.md,
    minHeight: 24,
    padding: 0,
  },
  checklist: { marginTop: spacing.lg, marginLeft: spacing.xl + spacing.md },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 6,
    marginLeft: spacing.xl + spacing.md,
  },
  checkText: { flex: 1, ...typography.body, color: colors.text, padding: 0 },
  checkTextDone: { color: colors.textTertiary, textDecorationLine: 'line-through' },
  tagsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.lg,
    marginLeft: spacing.xl + spacing.md,
  },
  tagChip: {
    backgroundColor: colors.groupedBackground,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  tagText: { ...typography.subhead, color: colors.textSecondary },
  toolbar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: colors.separator,
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  toolBtn: { flex: 1, alignItems: 'center', gap: 2 },
  toolLabel: { ...typography.caption, color: colors.textSecondary, maxWidth: 80 },
});

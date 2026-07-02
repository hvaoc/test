import React, { useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, typography, radius } from '../theme';
import TaskRow from './TaskRow';
import TaskComposer from './TaskComposer';
import SectionEditor from './SectionEditor';

const COL_W = 300;

// Kanban board for a project: one column per section (plus a "(No Section)"
// column and a trailing "Add section" column). Cards reuse TaskRow, so the
// checkbox completes and tapping the card opens the detail — exactly as in the
// list view. Columns scroll horizontally within the page's vertical scroll.
export default function BoardView({
  columns,
  onOpenTask,
  onAddTask,
  onAddSection,
  onEditSection,
}) {
  const lastHeadingId = [...columns].reverse().find((c) => c.headingId)?.headingId || null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.board}
      keyboardShouldPersistTaps="handled"
    >
      {columns.map((col) => (
        <BoardColumn
          key={col.key}
          col={col}
          onOpenTask={onOpenTask}
          onAddTask={onAddTask}
          onEditSection={onEditSection}
        />
      ))}
      <AddColumn afterHeadingId={lastHeadingId} onAddSection={onAddSection} />
    </ScrollView>
  );
}

function BoardColumn({ col, onOpenTask, onAddTask, onEditSection }) {
  const [adding, setAdding] = useState(false);
  return (
    <View style={styles.column}>
      <Pressable
        style={styles.colHeader}
        onPress={() => col.headingId && onEditSection && onEditSection(col.headingId)}
        disabled={!col.headingId}
      >
        <Text style={styles.colTitle} numberOfLines={1}>
          {col.title}
        </Text>
        <Text style={styles.colCount}>{col.count}</Text>
      </Pressable>

      {col.tasks.map((task) => (
        <View key={task.id} style={styles.card}>
          <TaskRow task={task} inProject onPress={() => onOpenTask(task.id)} />
        </View>
      ))}

      {adding ? (
        <TaskComposer
          submitLabel="Add task"
          persistAfterAdd
          onAdd={(p) => onAddTask(col.headingId, p)}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <Pressable style={styles.addBtn} onPress={() => setAdding(true)}>
          <Ionicons name="add" size={18} color={colors.textTertiary} />
          <Text style={styles.addText}>Add task</Text>
        </Pressable>
      )}
    </View>
  );
}

// Trailing column: a single "Add section" trigger that expands into the shared
// section editor and appends a new section after the last one.
function AddColumn({ afterHeadingId, onAddSection }) {
  const [adding, setAdding] = useState(false);
  return (
    <View style={styles.column}>
      {adding ? (
        <SectionEditor
          onSave={({ title, description }) => {
            onAddSection(afterHeadingId, { title, description });
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <Pressable style={styles.addSection} onPress={() => setAdding(true)}>
          <Ionicons name="add" size={18} color={colors.textTertiary} />
          <Text style={styles.addText}>Add section</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  board: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, alignItems: 'flex-start' },
  column: { width: COL_W, marginRight: spacing.lg },
  colHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.xs,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  colTitle: { ...typography.heading, color: colors.text, flexShrink: 1 },
  colCount: { ...typography.subhead, color: colors.textTertiary, fontVariant: ['tabular-nums'] },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separatorStrong,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    marginBottom: spacing.sm,
    overflow: 'hidden',
    // A soft lift so cards read above the page.
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  addSection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
    borderColor: colors.separatorStrong,
    borderRadius: radius.md,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  addText: { ...typography.subhead, color: colors.textTertiary },
});

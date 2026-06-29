import React from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import BottomSheet from './BottomSheet';
import { colors, spacing, typography } from '../theme';
import { useTasks } from '../store/TasksContext';

// "Move to" picker — assign a task to Inbox, an Area, or a Project.
export default function MoveSheet({ visible, onClose, task, onMove }) {
  const { state } = useTasks();

  const choose = (patch) => {
    onMove(patch);
    onClose();
  };

  const currentProject = task?.projectId;
  const currentArea = !task?.projectId ? task?.areaId : null;

  const Row = ({ icon, color, label, active, onPress, indent }) => (
    <Pressable
      style={[styles.row, indent && { paddingLeft: spacing.xl + spacing.md }]}
      onPress={onPress}
    >
      <Ionicons name={icon} size={18} color={color} style={styles.icon} />
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      {active && <Ionicons name="checkmark" size={20} color={colors.accent} />}
    </Pressable>
  );

  return (
    <BottomSheet visible={visible} onClose={onClose} title="Move To">
      <ScrollView style={{ maxHeight: 420 }}>
        <Row
          icon="file-tray"
          color={colors.inbox}
          label="Inbox"
          active={!task?.projectId && !task?.areaId}
          onPress={() => choose({ projectId: null, areaId: null, headingId: null })}
        />

        {state.areas.map((area) => {
          const projects = state.projects.filter((p) => p.areaId === area.id);
          return (
            <View key={area.id}>
              <Row
                icon="cube-outline"
                color={area.color}
                label={area.name}
                active={currentArea === area.id}
                onPress={() =>
                  choose({ areaId: area.id, projectId: null, headingId: null })
                }
              />
              {projects.map((p) => (
                <Row
                  key={p.id}
                  icon="ellipse"
                  color={p.color}
                  label={p.name}
                  indent
                  active={currentProject === p.id}
                  onPress={() =>
                    choose({ projectId: p.id, areaId: p.areaId, headingId: null })
                  }
                />
              ))}
            </View>
          );
        })}

        {/* Projects with no area */}
        {state.projects
          .filter((p) => !p.areaId)
          .map((p) => (
            <Row
              key={p.id}
              icon="ellipse"
              color={p.color}
              label={p.name}
              active={currentProject === p.id}
              onPress={() => choose({ projectId: p.id, areaId: null, headingId: null })}
            />
          ))}
      </ScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    gap: spacing.md,
  },
  icon: { width: 22, textAlign: 'center' },
  label: { flex: 1, ...typography.body, color: colors.text },
});

import React from 'react';
import { View, Text, StyleSheet, Switch } from 'react-native';
import BottomSheet from './BottomSheet';
import { colors, spacing, typography } from '../theme';
import { useTasks } from '../store/TasksContext';

// App preferences. Currently a single toggle for whether completed to-dos are
// shown inside projects; structured as a list so more settings can slot in.
export default function SettingsSheet({ visible, onClose }) {
  const { state, setSetting } = useTasks();
  const { showCompleted, centeredContent } = state.settings;

  return (
    <BottomSheet visible={visible} onClose={onClose} title="Settings">
      <View style={styles.row}>
        <View style={styles.labelWrap}>
          <Text style={styles.label}>Show completed items</Text>
          <Text style={styles.hint}>
            Display finished to-dos in their project. The Logbook always keeps them.
          </Text>
        </View>
        <Switch
          value={showCompleted}
          onValueChange={(v) => setSetting('showCompleted', v)}
          trackColor={{ true: colors.accent, false: colors.separatorStrong }}
          ios_backgroundColor={colors.separatorStrong}
        />
      </View>

      <View style={styles.row}>
        <View style={styles.labelWrap}>
          <Text style={styles.label}>Center content</Text>
          <Text style={styles.hint}>
            Constrain lists and projects to a centered column instead of the full width.
          </Text>
        </View>
        <Switch
          value={centeredContent}
          onValueChange={(v) => setSetting('centeredContent', v)}
          trackColor={{ true: colors.accent, false: colors.separatorStrong }}
          ios_backgroundColor={colors.separatorStrong}
        />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  labelWrap: { flex: 1 },
  label: { ...typography.body, color: colors.text },
  hint: { ...typography.subhead, color: colors.textTertiary, marginTop: 2 },
});

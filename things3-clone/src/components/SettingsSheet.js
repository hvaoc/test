import React from 'react';
import { View, Text, Pressable, StyleSheet, Switch, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import BottomSheet from './BottomSheet';
import { colors, spacing, typography, radius } from '../theme';
import { useTasks } from '../store/TasksContext';

// App preferences. Currently a single toggle for whether completed to-dos are
// shown inside projects; structured as a list so more settings can slot in.
export default function SettingsSheet({ visible, onClose }) {
  const { state, setSetting, reset } = useTasks();
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

      <View style={styles.divider} />

      <View style={styles.labelWrap}>
        <Text style={styles.label}>Sample data</Text>
        <Text style={styles.hint}>
          This build always starts from the demo data; reloading resets it. Use
          this to reset without reloading.
        </Text>
      </View>
      <Pressable
        style={styles.resetBtn}
        onPress={() => {
          reset();
          onClose();
        }}
      >
        <Ionicons name="refresh" size={16} color={colors.accent} />
        <Text style={styles.resetText}>Reset to sample data</Text>
      </Pressable>
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
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.separator,
    marginVertical: spacing.md,
  },
  resetBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  resetText: { ...typography.body, color: colors.accent, fontWeight: '600' },
});

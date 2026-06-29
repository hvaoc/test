import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, TextInput } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import BottomSheet from './BottomSheet';
import { colors, spacing, typography, radius } from '../theme';
import { PROJECT_COLORS } from '../store/constants';
import { useTasks } from '../store/TasksContext';

// Create a new Project or Area, the two organizing containers in Things.
export default function NewListSheet({ visible, onClose, navigation }) {
  const { state, addProject, addArea } = useTasks();
  const [mode, setMode] = useState('project'); // 'project' | 'area'
  const [name, setName] = useState('');
  const [color, setColor] = useState(PROJECT_COLORS[0]);
  const [areaId, setAreaId] = useState(null);

  const reset = () => {
    setName('');
    setColor(PROJECT_COLORS[0]);
    setAreaId(null);
    setMode('project');
  };

  const close = () => {
    reset();
    onClose();
  };

  const create = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (mode === 'project') {
      addProject({ name: trimmed, color, areaId });
    } else {
      addArea({ name: trimmed, color });
    }
    close();
  };

  return (
    <BottomSheet visible={visible} onClose={close} title="New List">
      <View style={styles.segment}>
        <SegBtn label="Project" active={mode === 'project'} onPress={() => setMode('project')} />
        <SegBtn label="Area" active={mode === 'area'} onPress={() => setMode('area')} />
      </View>

      <View style={styles.inputRow}>
        <View style={[styles.dot, { backgroundColor: color }]} />
        <TextInput
          style={styles.input}
          autoFocus
          placeholder={mode === 'project' ? 'Project name' : 'Area name'}
          placeholderTextColor={colors.placeholder}
          value={name}
          onChangeText={setName}
          onSubmitEditing={create}
          returnKeyType="done"
        />
      </View>

      <Text style={styles.label}>Color</Text>
      <View style={styles.swatches}>
        {PROJECT_COLORS.map((c) => (
          <Pressable
            key={c}
            style={[
              styles.swatch,
              { backgroundColor: c },
              color === c && styles.swatchActive,
            ]}
            onPress={() => setColor(c)}
          >
            {color === c && <Ionicons name="checkmark" size={16} color={colors.white} />}
          </Pressable>
        ))}
      </View>

      {mode === 'project' && state.areas.length > 0 && (
        <>
          <Text style={styles.label}>Area (optional)</Text>
          <View style={styles.areaChips}>
            <Pressable
              style={[styles.areaChip, !areaId && styles.areaChipActive]}
              onPress={() => setAreaId(null)}
            >
              <Text style={[styles.areaChipText, !areaId && styles.areaChipTextActive]}>
                None
              </Text>
            </Pressable>
            {state.areas.map((a) => (
              <Pressable
                key={a.id}
                style={[styles.areaChip, areaId === a.id && styles.areaChipActive]}
                onPress={() => setAreaId(a.id)}
              >
                <Text
                  style={[
                    styles.areaChipText,
                    areaId === a.id && styles.areaChipTextActive,
                  ]}
                >
                  {a.name}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      )}

      <Pressable
        style={[styles.createBtn, !name.trim() && styles.createBtnDisabled]}
        onPress={create}
        disabled={!name.trim()}
      >
        <Text style={styles.createText}>Create {mode === 'project' ? 'Project' : 'Area'}</Text>
      </Pressable>
    </BottomSheet>
  );
}

function SegBtn({ label, active, onPress }) {
  return (
    <Pressable style={[styles.segBtn, active && styles.segBtnActive]} onPress={onPress}>
      <Text style={[styles.segText, active && styles.segTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  segment: {
    flexDirection: 'row',
    backgroundColor: colors.groupedBackground,
    borderRadius: radius.md,
    padding: 3,
    marginBottom: spacing.lg,
  },
  segBtn: { flex: 1, paddingVertical: spacing.sm, alignItems: 'center', borderRadius: radius.sm },
  segBtnActive: { backgroundColor: colors.background },
  segText: { ...typography.callout, color: colors.textSecondary },
  segTextActive: { color: colors.text, fontWeight: '600' },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.separator,
    paddingBottom: spacing.md,
    marginBottom: spacing.lg,
  },
  dot: { width: 14, height: 14, borderRadius: 7 },
  input: { flex: 1, ...typography.title, fontSize: 20, color: colors.text, padding: 0 },
  label: {
    ...typography.caption,
    color: colors.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
  },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginBottom: spacing.lg },
  swatch: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatchActive: { borderWidth: 2, borderColor: colors.text },
  areaChips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.lg },
  areaChip: {
    borderWidth: 1,
    borderColor: colors.separatorStrong,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  areaChipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  areaChipText: { ...typography.callout, color: colors.text },
  areaChipTextActive: { color: colors.white, fontWeight: '600' },
  createBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  createBtnDisabled: { opacity: 0.4 },
  createText: { ...typography.body, color: colors.white, fontWeight: '600' },
});

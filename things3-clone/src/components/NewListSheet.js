import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, TextInput, Modal, ScrollView, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import BottomSheet from './BottomSheet';
import { colors, spacing, typography, radius } from '../theme';
import { PROJECT_COLORS } from '../store/constants';
import { useTasks } from '../store/TasksContext';
import EmojiPicker from './EmojiPicker';
import ColorPickerSwatch from './ColorPickerSwatch';

// Create a new Project or Area, the two organizing containers in Things.
export default function NewListSheet({ visible, onClose, navigation }) {
  const { state, addProject, addArea } = useTasks();
  const [mode, setMode] = useState('project'); // 'project' | 'area'
  const [name, setName] = useState('');
  const [color, setColor] = useState(PROJECT_COLORS[0]);
  const [emoji, setEmoji] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [areaId, setAreaId] = useState(null);
  const [areaOpen, setAreaOpen] = useState(false);
  const [areaQuery, setAreaQuery] = useState('');

  const reset = () => {
    setName('');
    setColor(PROJECT_COLORS[0]);
    setEmoji('');
    setAreaId(null);
    setAreaOpen(false);
    setAreaQuery('');
    setMode('project');
  };

  const selectedArea = state.areas.find((a) => a.id === areaId) || null;
  const filteredAreas = state.areas.filter((a) =>
    a.name.toLowerCase().includes(areaQuery.trim().toLowerCase())
  );

  const close = () => {
    reset();
    onClose();
  };

  const create = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (mode === 'project') {
      addProject({ name: trimmed, color, emoji, areaId });
    } else {
      addArea({ name: trimmed, color, emoji });
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
        {/* Icon: tap to pick an emoji. Defaults to the box (cube) for an Area
            and "#" for a Project, drawn in the chosen color. */}
        <Pressable style={styles.iconSlot} onPress={() => setPickerOpen(true)}>
          {emoji ? (
            <Text style={styles.iconEmoji}>{emoji}</Text>
          ) : mode === 'area' ? (
            <Ionicons name="cube-outline" size={22} color={color} />
          ) : (
            <Text style={[styles.iconHash, { color }]}>#</Text>
          )}
        </Pressable>
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

      <EmojiPicker
        visible={pickerOpen}
        current={emoji}
        onSelect={(e) => { setEmoji(e); setPickerOpen(false); }}
        onRemove={() => { setEmoji(''); setPickerOpen(false); }}
        onClose={() => setPickerOpen(false)}
      />

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
        {/* A picked custom color (not in the presets) shows as its own swatch. */}
        {!PROJECT_COLORS.includes(color) && (
          <View style={[styles.swatch, { backgroundColor: color }, styles.swatchActive]}>
            <Ionicons name="checkmark" size={16} color={colors.white} />
          </View>
        )}
        {/* Rainbow trigger → the OS color picker for any custom color. */}
        <ColorPickerSwatch value={color} onChange={setColor} />
      </View>

      {mode === 'project' && state.areas.length > 0 && (
        <>
          <Text style={styles.label}>Area (optional)</Text>
          <Pressable style={styles.areaField} onPress={() => setAreaOpen(true)}>
            {selectedArea ? (
              selectedArea.emoji ? (
                <Text style={styles.areaFieldEmoji}>{selectedArea.emoji}</Text>
              ) : (
                <Ionicons name="cube-outline" size={16} color={selectedArea.color} />
              )
            ) : null}
            <Text style={[styles.areaFieldText, !selectedArea && styles.areaFieldPlaceholder]}>
              {selectedArea ? selectedArea.name : 'None'}
            </Text>
            <Ionicons name="chevron-down" size={16} color={colors.textTertiary} />
          </Pressable>

          <Modal visible={areaOpen} transparent animationType="fade" onRequestClose={() => setAreaOpen(false)}>
            <Pressable style={styles.dropBackdrop} onPress={() => setAreaOpen(false)}>
              <Pressable style={styles.dropCard} onPress={(e) => e?.stopPropagation?.()}>
                <View style={styles.dropSearch}>
                  <Ionicons name="search" size={16} color={colors.textTertiary} />
                  <TextInput
                    style={styles.dropSearchInput}
                    value={areaQuery}
                    onChangeText={setAreaQuery}
                    placeholder="Search areas"
                    placeholderTextColor={colors.placeholder}
                    autoFocus
                  />
                </View>
                <ScrollView style={styles.dropList} keyboardShouldPersistTaps="handled">
                  <Pressable style={styles.dropRow} onPress={() => { setAreaId(null); setAreaOpen(false); setAreaQuery(''); }}>
                    <Text style={[styles.dropRowText, !areaId && styles.dropRowActive]}>None</Text>
                    {!areaId && <Ionicons name="checkmark" size={16} color={colors.accent} />}
                  </Pressable>
                  {filteredAreas.map((a) => (
                    <Pressable key={a.id} style={styles.dropRow} onPress={() => { setAreaId(a.id); setAreaOpen(false); setAreaQuery(''); }}>
                      {a.emoji ? <Text style={styles.dropRowEmoji}>{a.emoji}</Text> : <Ionicons name="cube-outline" size={16} color={a.color} style={styles.dropRowIcon} />}
                      <Text style={[styles.dropRowText, areaId === a.id && styles.dropRowActive]} numberOfLines={1}>{a.name}</Text>
                      {areaId === a.id && <Ionicons name="checkmark" size={16} color={colors.accent} />}
                    </Pressable>
                  ))}
                  {filteredAreas.length === 0 && <Text style={styles.dropEmpty}>No areas found</Text>}
                </ScrollView>
              </Pressable>
            </Pressable>
          </Modal>
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
  iconSlot: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
  },
  iconEmoji: { fontSize: 22 },
  iconHash: { ...typography.title, fontWeight: '700' },
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
  // Searchable area dropdown.
  areaField: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separatorStrong,
    borderRadius: radius.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    marginBottom: spacing.lg,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  areaFieldEmoji: { fontSize: 16 },
  areaFieldText: { flex: 1, ...typography.body, color: colors.text },
  areaFieldPlaceholder: { color: colors.textTertiary },
  dropBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.25)', alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  dropCard: {
    width: '100%', maxWidth: 340, maxHeight: '70%', backgroundColor: colors.background,
    borderRadius: radius.lg, overflow: 'hidden',
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 12,
  },
  dropSearch: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator,
  },
  dropSearchInput: { flex: 1, ...typography.body, color: colors.text, padding: 0, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null) },
  dropList: { maxHeight: 280 },
  dropRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  dropRowEmoji: { fontSize: 16, width: 18, textAlign: 'center' },
  dropRowIcon: { width: 18, textAlign: 'center' },
  dropRowHash: { width: 18, textAlign: 'center', ...typography.body, fontWeight: '700' },
  dropRowText: { flex: 1, ...typography.body, color: colors.text },
  dropRowActive: { color: colors.accent, fontWeight: '600' },
  dropEmpty: { ...typography.subhead, color: colors.textTertiary, padding: spacing.md },
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

import React, { useMemo, useState } from 'react';
import { Modal, View, Text, Pressable, ScrollView, TextInput, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import groups from 'unicode-emoji-json/data-by-group.json';
import { colors, spacing, typography, radius } from '../theme';

// A dependency-light emoji picker. Web/RN-web has no programmatic hook to the OS
// emoji panel, so this is our own UI over the full Unicode emoji set (the
// `unicode-emoji-json` dataset — ~1900 emojis with names): category tabs plus a
// name/keyword search.
const TAB_ICON = {
  'Smileys & Emotion': '😀',
  'People & Body': '👋',
  'Animals & Nature': '🐶',
  'Food & Drink': '🍔',
  'Travel & Places': '✈️',
  Activities: '⚽',
  Objects: '💡',
  Symbols: '❤️',
  Flags: '🏳️',
};
// [{ key, icon, items: [{emoji, name, slug}, ...] }]
const CATEGORIES = groups.map((g) => ({
  key: g.name,
  icon: TAB_ICON[g.name] || (g.emojis[0] && g.emojis[0].emoji),
  items: g.emojis,
}));
const ALL = groups.flatMap((g) => g.emojis);

export default function EmojiPicker({ visible, current, onSelect, onRemove, onClose }) {
  const [cat, setCat] = useState(CATEGORIES[0].key);
  const [query, setQuery] = useState('');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q) return ALL.filter((it) => it.name.includes(q) || it.slug.includes(q)).map((it) => it.emoji);
    return (CATEGORIES.find((c) => c.key === cat) || CATEGORIES[0]).items.map((it) => it.emoji);
  }, [query, cat]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={(e) => e?.stopPropagation?.()}>
          <View style={styles.searchRow}>
            <Ionicons name="search" size={16} color={colors.textTertiary} />
            <TextInput
              style={styles.search}
              value={query}
              onChangeText={setQuery}
              placeholder="Search emoji"
              placeholderTextColor={colors.placeholder}
              autoFocus
            />
            {current ? (
              <Pressable onPress={onRemove} style={styles.removeBtn}>
                <Ionicons name="close-circle" size={14} color={colors.textSecondary} />
                <Text style={styles.removeText}>Remove</Text>
              </Pressable>
            ) : null}
          </View>

          {!query && (
            <View style={styles.tabs}>
              {CATEGORIES.map((c) => (
                <Pressable
                  key={c.key}
                  onPress={() => setCat(c.key)}
                  style={[styles.tab, cat === c.key && styles.tabActive]}
                >
                  <Text style={styles.tabIcon}>{c.icon}</Text>
                </Pressable>
              ))}
            </View>
          )}

          <ScrollView style={styles.gridScroll} contentContainerStyle={styles.grid} keyboardShouldPersistTaps="handled">
            {shown.length === 0 ? (
              <Text style={styles.empty}>No emoji found</Text>
            ) : (
              shown.map((e, i) => (
                <Pressable key={`${e}-${i}`} onPress={() => onSelect(e)} style={styles.cell}>
                  <Text style={styles.cellEmoji}>{e}</Text>
                </Pressable>
              ))
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    height: 420,
    backgroundColor: colors.background,
    borderRadius: radius.lg,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  search: { flex: 1, ...typography.body, color: colors.text, padding: 0, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null) },
  removeBtn: { flexDirection: 'row', alignItems: 'center', gap: 3, ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null) },
  removeText: { ...typography.caption, color: colors.textSecondary },
  tabs: {
    flexDirection: 'row',
    paddingHorizontal: spacing.xs,
    paddingVertical: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 4,
    borderRadius: radius.sm,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  tabActive: { backgroundColor: colors.groupedBackground },
  tabIcon: { fontSize: 18 },
  gridScroll: { flex: 1 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', padding: spacing.sm, gap: 2 },
  cell: {
    width: '12.5%',
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  cellEmoji: { fontSize: 24 },
  empty: { ...typography.subhead, color: colors.textTertiary, padding: spacing.lg },
});

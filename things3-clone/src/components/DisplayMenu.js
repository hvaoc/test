import React, { useState } from 'react';
import { Modal, View, Text, Pressable, ScrollView, Switch, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, typography, radius } from '../theme';

// A Todoist-style "Display" popover: Layout tabs, a Completed toggle, a Sort
// group (grouping + sorting), and a Filter group (date / priority / label).
// All state lives in the parent; this is a controlled presentational component.

const LAYOUTS = [
  { key: 'list', label: 'List', icon: 'list' },
  { key: 'board', label: 'Board', icon: 'grid-outline' },
  { key: 'calendar', label: 'Calendar', icon: 'calendar-outline' },
  { key: 'gantt', label: 'Timeline', icon: 'stats-chart-outline' },
  { key: 'date', label: 'By Date', icon: 'calendar-number-outline' },
];

// A labelled row whose right side is a tappable value that expands an inline
// option list.
function SelectRow({ label, value, options, onChange, open, onToggleOpen }) {
  const current = options.find((o) => o.key === value) || options[0];
  return (
    <View>
      <View style={styles.row}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Pressable style={styles.select} onPress={onToggleOpen}>
          <Text style={styles.selectValue}>{current.label}</Text>
          <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={14} color={colors.textTertiary} />
        </Pressable>
      </View>
      {open && (
        <View style={styles.options}>
          {options.map((o) => {
            const active = o.key === value;
            return (
              <Pressable key={o.key} style={styles.option} onPress={() => onChange(o.key)}>
                <Text style={[styles.optionText, active && styles.optionTextActive]}>{o.label}</Text>
                {active && <Ionicons name="checkmark" size={16} color={colors.accent} />}
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

export default function DisplayMenu({
  visible,
  onClose,
  layout,
  onLayout,
  layouts, // list of allowed layout keys
  showCompleted,
  onToggleCompleted,
  grouping,
  onGrouping,
  sorting,
  onSorting,
  filterDate,
  onFilterDate,
  filterPriority,
  onFilterPriority,
  filterLabel,
  onFilterLabel,
  labels = [], // available label/tag names
}) {
  const [openKey, setOpenKey] = useState(null);
  const toggle = (k) => setOpenKey((p) => (p === k ? null : k));

  const groupOpts = [
    { key: 'section', label: 'Section' },
    { key: 'none', label: 'None' },
    { key: 'priority', label: 'Priority' },
    { key: 'date', label: 'Date' },
    { key: 'label', label: 'Label' },
  ];
  const sortOpts = [
    { key: 'manual', label: 'Manual' },
    { key: 'name', label: 'Name' },
    { key: 'date', label: 'Date' },
    { key: 'priority', label: 'Priority' },
  ];
  const dateOpts = [
    { key: 'all', label: 'All' },
    { key: 'overdue', label: 'Overdue' },
    { key: 'today', label: 'Today' },
    { key: 'upcoming', label: 'Upcoming' },
    { key: 'none', label: 'No date' },
  ];
  const priorityOpts = [
    { key: 'all', label: 'All' },
    { key: 'high', label: 'High' },
    { key: 'medium', label: 'Medium' },
    { key: 'low', label: 'Low' },
  ];
  const labelOpts = [{ key: 'all', label: 'All' }, ...labels.map((l) => ({ key: l, label: l }))];

  const shownLayouts = LAYOUTS.filter((l) => !layouts || layouts.includes(l.key));

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable testID="display-backdrop" style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={(e) => e?.stopPropagation?.()}>
          <ScrollView showsVerticalScrollIndicator={false}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={styles.title}>Layout</Text>
              {/* Explicit close control. The full-screen backdrop can't be reliably
                  dismissed by an automated tap (its center sits over the card), so a
                  testID'd Done button gives tests a deterministic, cross-platform close. */}
              <Pressable testID="display-done" hitSlop={10} onPress={onClose}>
                <Text style={{ color: colors.accent, fontWeight: '600', fontSize: 15 }}>Done</Text>
              </Pressable>
            </View>
            <View style={styles.layoutRow}>
              {shownLayouts.map((l) => {
                const active = layout === l.key;
                return (
                  <Pressable
                    key={l.key}
                    onPress={() => onLayout(l.key)}
                    style={[styles.layoutTab, active && styles.layoutTabActive]}
                  >
                    <Ionicons name={l.icon} size={18} color={active ? colors.accent : colors.textSecondary} />
                    <Text style={[styles.layoutLabel, active && styles.layoutLabelActive]}>{l.label}</Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.row}>
              <Text style={styles.rowLabel}>Completed tasks</Text>
              <Switch
                testID="setting-show-completed"
                value={showCompleted}
                onValueChange={onToggleCompleted}
                trackColor={{ true: colors.accent, false: colors.separatorStrong }}
                ios_backgroundColor={colors.separatorStrong}
              />
            </View>

            <View style={styles.divider} />
            <Text style={styles.group}>Sort</Text>
            <SelectRow label="Grouping" value={grouping} options={groupOpts} onChange={onGrouping} open={openKey === 'grouping'} onToggleOpen={() => toggle('grouping')} />
            <SelectRow label="Sorting" value={sorting} options={sortOpts} onChange={onSorting} open={openKey === 'sorting'} onToggleOpen={() => toggle('sorting')} />

            <View style={styles.divider} />
            <Text style={styles.group}>Filter</Text>
            <SelectRow label="Date" value={filterDate} options={dateOpts} onChange={onFilterDate} open={openKey === 'fdate'} onToggleOpen={() => toggle('fdate')} />
            <SelectRow label="Priority" value={filterPriority} options={priorityOpts} onChange={onFilterPriority} open={openKey === 'fpri'} onToggleOpen={() => toggle('fpri')} />
            <SelectRow label="Label" value={filterLabel} options={labelOpts} onChange={onFilterLabel} open={openKey === 'flabel'} onToggleOpen={() => toggle('flabel')} />
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.2)', alignItems: 'flex-end', paddingTop: 52, paddingRight: spacing.lg },
  card: {
    width: 320, maxHeight: '85%', backgroundColor: colors.background, borderRadius: radius.lg,
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md, overflow: 'hidden',
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 12,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separator,
  },
  title: { ...typography.heading, color: colors.text, marginBottom: spacing.sm },
  layoutRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: spacing.sm },
  layoutTab: {
    flexGrow: 1, minWidth: 84, alignItems: 'center', gap: 3, paddingVertical: spacing.sm,
    borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separator,
    backgroundColor: colors.surfaceMuted, ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  layoutTabActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  layoutLabel: { ...typography.caption, color: colors.textSecondary },
  layoutLabelActive: { color: colors.accent, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: spacing.sm, gap: spacing.md },
  rowLabel: { ...typography.body, color: colors.text },
  select: {
    flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 130, justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separatorStrong, backgroundColor: colors.background,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  selectValue: { ...typography.subhead, color: colors.text },
  options: { borderRadius: radius.sm, backgroundColor: colors.surfaceMuted, marginBottom: spacing.xs, overflow: 'hidden' },
  option: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  optionText: { ...typography.subhead, color: colors.textSecondary },
  optionTextActive: { color: colors.accent, fontWeight: '600' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.separator, marginVertical: spacing.sm },
  group: { ...typography.subhead, color: colors.textTertiary, fontWeight: '700', textTransform: 'uppercase', marginBottom: 2 },
});

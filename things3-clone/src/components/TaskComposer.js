import React, { useState, useRef } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, typography, radius } from '../theme';
import { WHEN, PRIORITY_MAP } from '../store/constants';
import { relativeLabel } from '../utils/date';
import WhenSheet from './WhenSheet';
import DeadlineSheet from './DeadlineSheet';
import PrioritySheet from './PrioritySheet';
import LocationSheet from './LocationSheet';
import TagSheet from './TagSheet';

function whenLabel(when) {
  if (!when) return 'Date';
  if (when === WHEN.TODAY) return 'Today';
  if (when === WHEN.EVENING) return 'This Evening';
  if (when === WHEN.SOMEDAY) return 'Someday';
  return relativeLabel(when);
}

// A small outlined field chip (icon + label), highlighted when it has a value.
function Chip({ icon, label, color, active, onPress }) {
  return (
    <Pressable style={[styles.chip, active && { borderColor: color || colors.accent }]} onPress={onPress}>
      <Ionicons name={icon} size={14} color={active ? color || colors.accent : colors.textSecondary} />
      <Text
        style={[styles.chipText, active && { color: color || colors.accent, fontWeight: '600' }]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}

// Inline compose card with the full field set (Date / Deadline / Priority /
// Location / Labels). Stays open after adding so several can be entered.
export default function TaskComposer({ onAdd, onCancel }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [when, setWhen] = useState(null);
  const [deadline, setDeadline] = useState(null);
  const [priority, setPriority] = useState(null);
  const [location, setLocation] = useState('');
  const [tags, setTags] = useState([]);
  const [sheet, setSheet] = useState(null);
  const ref = useRef(null);

  const add = () => {
    const t = title.trim();
    if (!t) return;
    onAdd({
      title: t,
      description: description.trim(),
      when,
      deadline,
      priority,
      location: location.trim(),
      tags,
    });
    // Keep the field selections for rapid entry; clear the text.
    setTitle('');
    setDescription('');
    if (ref.current) ref.current.focus();
  };

  const priorityMeta = priority ? PRIORITY_MAP[priority] : null;

  return (
    <View style={styles.card}>
      <TextInput
        ref={ref}
        style={styles.title}
        value={title}
        onChangeText={setTitle}
        placeholder="Task name"
        placeholderTextColor={colors.placeholder}
        autoFocus
        blurOnSubmit={false}
        returnKeyType="done"
        onSubmitEditing={add}
      />
      <TextInput
        style={styles.desc}
        value={description}
        onChangeText={setDescription}
        placeholder="Description"
        placeholderTextColor={colors.placeholder}
        multiline
      />

      <View style={styles.fields}>
        <Chip
          icon={when ? 'calendar' : 'calendar-outline'}
          label={whenLabel(when)}
          color={colors.accent}
          active={!!when}
          onPress={() => setSheet('when')}
        />
        <Chip
          icon="alarm-outline"
          label={deadline ? relativeLabel(deadline) : 'Deadline'}
          color={colors.deadline}
          active={!!deadline}
          onPress={() => setSheet('deadline')}
        />
        <Chip
          icon={priority ? 'flag' : 'flag-outline'}
          label={priorityMeta ? priorityMeta.label : 'Priority'}
          color={priorityMeta ? priorityMeta.color : colors.textSecondary}
          active={!!priority}
          onPress={() => setSheet('priority')}
        />
        <Chip
          icon={location ? 'location' : 'location-outline'}
          label={location || 'Location'}
          color={colors.accent}
          active={!!location}
          onPress={() => setSheet('location')}
        />
        <Chip
          icon="pricetag-outline"
          label={tags.length ? `${tags.length} Label${tags.length > 1 ? 's' : ''}` : 'Labels'}
          color={colors.accent}
          active={tags.length > 0}
          onPress={() => setSheet('tags')}
        />
      </View>

      <View style={styles.actions}>
        <Pressable style={styles.cancel} onPress={onCancel}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
        <Pressable
          style={[styles.add, !title.trim() && styles.addDisabled]}
          onPress={add}
          disabled={!title.trim()}
        >
          <Text style={styles.addText}>Add task</Text>
        </Pressable>
      </View>

      <WhenSheet visible={sheet === 'when'} onClose={() => setSheet(null)} value={when} onChange={setWhen} />
      <DeadlineSheet visible={sheet === 'deadline'} onClose={() => setSheet(null)} value={deadline} onChange={setDeadline} />
      <PrioritySheet visible={sheet === 'priority'} onClose={() => setSheet(null)} value={priority} onChange={setPriority} />
      <LocationSheet visible={sheet === 'location'} onClose={() => setSheet(null)} value={location} onChange={setLocation} />
      <TagSheet visible={sheet === 'tags'} onClose={() => setSheet(null)} selected={tags} onChange={setTags} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.xs,
    borderWidth: 1,
    borderColor: colors.separatorStrong,
    borderRadius: radius.sm,
    padding: spacing.md,
    gap: spacing.xs,
    backgroundColor: colors.background,
  },
  title: {
    ...typography.body,
    fontWeight: '600',
    color: colors.text,
    padding: 0,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null),
  },
  desc: {
    ...typography.subhead,
    color: colors.textSecondary,
    padding: 0,
    minHeight: 30,
    textAlignVertical: 'top',
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null),
  },
  fields: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: colors.separatorStrong,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  chipText: { ...typography.caption, color: colors.textSecondary, maxWidth: 120 },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator,
    paddingTop: spacing.sm,
  },
  cancel: {
    backgroundColor: colors.groupedBackground,
    borderRadius: 4,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  cancelText: { ...typography.subhead, color: colors.textSecondary, fontWeight: '600' },
  add: {
    backgroundColor: colors.accent,
    borderRadius: 4,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  addDisabled: { opacity: 0.5 },
  addText: { ...typography.subhead, color: colors.white, fontWeight: '600' },
});

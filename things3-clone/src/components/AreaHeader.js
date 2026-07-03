import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Alert,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, typography } from '../theme';
import { useTasks } from '../store/TasksContext';
import EmojiPicker from './EmojiPicker';

// Editable header shown atop an Area — mirrors ProjectHeader so editing an area
// feels identical: tap the icon to change its emoji and color, edit the title
// inline, and delete. (Areas have no notes/progress in the data model.)
export default function AreaHeader({ area, navigation }) {
  const { updateArea, deleteArea } = useTasks();
  const [pickerOpen, setPickerOpen] = useState(false);

  const confirmDelete = () => {
    Alert.alert(
      'Delete Area',
      `Delete "${area.name}"? Its projects and to-dos will be kept (moved out of the area).`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            deleteArea(area.id);
            navigation.goBack();
          },
        },
      ]
    );
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.titleRow}>
        {/* Tap to change emoji + color; the box (cube) is the default Area
            symbol, drawn in the area color when no emoji is set. */}
        <Pressable style={styles.emoji} onPress={() => setPickerOpen(true)}>
          {area.emoji ? (
            <Text style={styles.emojiText}>{area.emoji}</Text>
          ) : (
            <Ionicons name="cube-outline" size={26} color={area.color} />
          )}
        </Pressable>
        <TextInput
          style={styles.title}
          value={area.name}
          onChangeText={(name) => updateArea(area.id, { name })}
          placeholder="Area name"
          placeholderTextColor={colors.placeholder}
        />
      </View>

      <View style={styles.actions}>
        <Pressable style={styles.actionBtn} onPress={confirmDelete}>
          <Ionicons name="trash-outline" size={16} color={colors.textSecondary} />
          <Text style={styles.actionText}>Delete</Text>
        </Pressable>
      </View>

      <EmojiPicker
        visible={pickerOpen}
        current={area.emoji}
        color={area.color}
        onColorChange={(c) => updateArea(area.id, { color: c })}
        onSelect={(e) => { updateArea(area.id, { emoji: e }); setPickerOpen(false); }}
        onRemove={() => { updateArea(area.id, { emoji: '' }); setPickerOpen(false); }}
        onClose={() => setPickerOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: spacing.lg,
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  emoji: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  emojiText: { fontSize: 26, color: colors.text, textAlign: 'center' },
  title: { flex: 1, ...typography.largeTitle, fontSize: 28, color: colors.text, padding: 0 },
  actions: {
    flexDirection: 'row',
    gap: spacing.lg,
    marginTop: spacing.md,
    marginLeft: 34,
  },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  actionText: { ...typography.subhead, color: colors.textSecondary },
});

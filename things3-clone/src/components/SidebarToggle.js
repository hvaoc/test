import React from 'react';
import { Pressable, View, StyleSheet, Platform } from 'react-native';
import { colors } from '../theme';

// A small "panel" glyph — a rounded rectangle with a filled left column — used
// to collapse/expand the sidebar, mirroring the toggle in Todoist/Things.
export default function SidebarToggle({ onPress, color = colors.textSecondary, style }) {
  return (
    <Pressable
      hitSlop={10}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Open/close sidebar"
      style={[styles.btn, style]}
    >
      <View style={[styles.frame, { borderColor: color }]}>
        <View style={[styles.panel, { backgroundColor: color }]} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    alignItems: 'center',
    justifyContent: 'center',
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  frame: {
    width: 20,
    height: 16,
    borderWidth: 1.6,
    borderRadius: 3.5,
    overflow: 'hidden',
    flexDirection: 'row',
  },
  panel: { width: 6, height: '100%', opacity: 0.85 },
});

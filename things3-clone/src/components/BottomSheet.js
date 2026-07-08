import React from 'react';
import {
  Modal,
  View,
  Pressable,
  StyleSheet,
  Text,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, radius, typography } from '../theme';
import { useIsWide } from '../navigation/responsive';

// A slide-up sheet built on the RN Modal. Tap the backdrop to dismiss.
// On wide surfaces (iPad / web / desktop) it becomes a centered dialog instead.
export default function BottomSheet({ visible, onClose, title, children }) {
  const insets = useSafeAreaInsets();
  const centered = useIsWide();
  return (
    <Modal
      visible={visible}
      transparent
      animationType={centered ? 'fade' : 'slide'}
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose} />
      {/* Keep the sheet above the keyboard when it contains a focused input. */}
      <KeyboardAvoidingView
        style={[styles.avoider, centered && styles.avoiderCentered]}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        pointerEvents="box-none"
      >
        <View
          style={[
            styles.sheet,
            centered
              ? styles.sheetCentered
              : { paddingBottom: insets.bottom + spacing.md },
          ]}
        >
          {!centered && <View style={styles.grabber} />}
          {title ? (
            <View style={styles.header}>
              <Text style={styles.title}>{title}</Text>
              <Pressable testID="sheet-done" hitSlop={10} onPress={onClose}>
                <Text style={styles.done}>Done</Text>
              </Pressable>
            </View>
          ) : null}
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  avoider: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  avoiderCentered: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
  },
  sheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.md,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOpacity: 0.15,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: -2 },
      },
      android: { elevation: 12 },
    }),
  },
  // Centered dialog variant: full rounding, capped width, sits in the middle
  // with roomier padding on every side than the bottom-sheet variant.
  sheetCentered: {
    borderBottomLeftRadius: radius.lg,
    borderBottomRightRadius: radius.lg,
    width: '100%',
    maxWidth: 460,
    paddingTop: spacing.lg,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xl,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.separatorStrong,
    marginBottom: spacing.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
  },
  title: { ...typography.heading, color: colors.text },
  done: { ...typography.body, color: colors.accent, fontWeight: '600' },
});

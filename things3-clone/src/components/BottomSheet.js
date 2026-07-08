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
import { Ionicons } from '@expo/vector-icons';
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
          {/* No grab handle: this sheet isn't drag-dismissable (backdrop / Done
              only), so showing one would imply a gesture that doesn't exist. */}
          {title ? (
            <View style={styles.header}>
              <Text style={styles.title}>{title}</Text>
              {/* A ✓ tick button (matching the Date sheet) instead of a "Done" label. */}
              <Pressable testID="sheet-done" hitSlop={10} onPress={onClose} style={styles.doneBtn}>
                <Ionicons name="checkmark" size={20} color={colors.white} />
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
  // Round accent ✓ button — same affordance the Date sheet uses to confirm.
  doneBtn: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
});

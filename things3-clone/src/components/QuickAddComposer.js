import React, { useState, useRef, useEffect } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Keyboard,
  Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, typography, radius } from '../theme';
import { PRIORITY_MAP, WHEN } from '../store/constants';
import { relativeLabel } from '../utils/date';
import { useTasks } from '../store/TasksContext';
import WhenSheet from './WhenSheet';
import DeadlineSheet from './DeadlineSheet';
import PrioritySheet from './PrioritySheet';
import TagSheet from './TagSheet';
import MoveSheet from './MoveSheet';

const EMPTY_CONTAINER = { projectId: null, areaId: null, headingId: null };

// Icon + label + tint for the current When value (mirrors the detail editor):
// Today = star, This Evening = moon, Someday = archive, a concrete date = calendar
// with its relative label ("Jan 22"); unset shows a plain "Date".
function whenMeta(when) {
  if (!when) return { label: 'Date', icon: 'calendar-outline', color: colors.textSecondary };
  if (when === WHEN.TODAY) return { label: 'Today', icon: 'star', color: colors.today };
  if (when === WHEN.EVENING) return { label: 'This Evening', icon: 'moon', color: colors.someday };
  if (when === WHEN.SOMEDAY) return { label: 'Someday', icon: 'archive', color: colors.someday };
  return { label: relativeLabel(when), icon: 'calendar', color: colors.accent };
}

// An icon-only field trigger. The picker for each field opens as its own bottom
// sheet; only the icon shows (it tints + gets a soft fill once the field has a value).
function FieldIcon({ icon, active, color, onPress, testID }) {
  const tint = color || colors.accent;
  return (
    <Pressable
      testID={testID}
      hitSlop={6}
      onPress={onPress}
      style={[styles.iconBtn, active && { backgroundColor: tint + '22' }]}
    >
      <Ionicons name={icon} size={22} color={active ? tint : colors.textSecondary} />
    </Pressable>
  );
}

/**
 * Mobile quick-add: a compact composer that slides up from the bottom instead of
 * the full-screen detail editor, so tasks can be entered with minimal friction.
 *   - the title field autofocuses on appear,
 *   - pressing return ADDS the task but keeps the composer open (title clears,
 *     field selections persist) so several tasks can be typed in a row,
 *   - every field is an icon-only trigger that opens its own bottom-sheet picker
 *     and returns to the composer.
 * The grab handle also drags: pull it DOWN to dismiss, pull it UP to promote the
 * in-progress task into the full-screen detail editor. A plain tap dismisses.
 */
export default function QuickAddComposer({ visible, onClose, onAdd, onExpand, defaultContainer = EMPTY_CONTAINER, onCoveredHeight }) {
  const cardRef = useRef(null);
  // Report how much of the screen the composer (and keyboard above which it sits) covers,
  // measured from the card's top to the screen bottom, so the list behind can pad+scroll
  // its last item to just above the composer.
  const reportCovered = () => {
    cardRef.current?.measureInWindow?.((x, y) => {
      if (typeof y === 'number' && y > 0) onCoveredHeight?.(Math.round(Dimensions.get('window').height - y));
    });
  };
  const { state } = useTasks();
  const [title, setTitle] = useState('');
  const [when, setWhen] = useState(null);
  const [timeInfo, setTimeInfo] = useState(null); // { startMinutes, durationMinutes, timezone } | null
  const [deadline, setDeadline] = useState(null);
  const [priority, setPriority] = useState(null);
  const [tags, setTags] = useState([]);
  const [container, setContainer] = useState(defaultContainer);
  const [sheet, setSheet] = useState(null);
  const [kbHeight, setKbHeight] = useState(0);
  const ref = useRef(null);
  const insets = useSafeAreaInsets();
  // Vertical drag offset of the card, driven by the grab handle.
  const dragY = useSharedValue(0);
  const cardAnimStyle = useAnimatedStyle(() => ({ transform: [{ translateY: dragY.value }] }));

  // Track the keyboard height so the (non-modal) composer can sit just above it. Being a
  // plain overlay rather than a Modal is what lets the list behind stay scrollable.
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const s = Keyboard.addListener(showEvt, (e) => setKbHeight(e.endCoordinates?.height ?? 0));
    const h = Keyboard.addListener(hideEvt, () => setKbHeight(0));
    return () => { s.remove(); h.remove(); };
  }, []);

  // Fresh session each time the composer opens: clear the fields (but seed the
  // container from the list we opened from) and focus the title.
  useEffect(() => {
    if (!visible) return;
    dragY.value = 0;
    setTitle('');
    setWhen(null);
    setTimeInfo(null);
    setDeadline(null);
    setPriority(null);
    setTags([]);
    setContainer(defaultContainer);
    setSheet(null);
    const t = setTimeout(() => ref.current?.focus(), 80);
    return () => clearTimeout(t);
    // defaultContainer is a fresh object each render; key on its ids so we don't loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, defaultContainer.projectId, defaultContainer.areaId]);

  const containerLabel = container.projectId
    ? state.projects.find((p) => p.id === container.projectId)?.name || 'Project'
    : 'Inbox';

  const focusTitle = () => requestAnimationFrame(() => ref.current?.focus());

  const add = () => {
    const t = title.trim();
    if (!t) return;
    onAdd({
      title: t,
      when,
      startMinutes: timeInfo?.startMinutes ?? null,
      durationMinutes: timeInfo?.durationMinutes ?? null,
      timezone: timeInfo?.timezone ?? null,
      deadline,
      priority,
      tags,
      projectId: container.projectId,
      areaId: container.areaId,
      headingId: container.headingId,
    });
    // Keep the field + container selections for rapid entry; clear only the title.
    setTitle('');
    focusTitle();
  };

  // Promote the in-progress entry into the full-screen detail editor. Whatever has
  // been typed/picked so far is carried over; the title may be empty (the editor
  // lets the user finish it there).
  const expand = () => {
    Keyboard.dismiss();
    onExpand?.({
      title: title.trim(),
      when,
      startMinutes: timeInfo?.startMinutes ?? null,
      durationMinutes: timeInfo?.durationMinutes ?? null,
      timezone: timeInfo?.timezone ?? null,
      deadline,
      priority,
      tags,
      projectId: container.projectId,
      areaId: container.areaId,
      headingId: container.headingId,
    });
  };

  // Opening a picker: drop the keyboard so the sheet isn't fighting it; re-focus on close.
  const openSheet = (kind) => {
    Keyboard.dismiss();
    setSheet(kind);
  };
  const closeSheet = () => {
    setSheet(null);
    focusTitle();
  };

  if (!visible) return null;
  const pr = priority ? PRIORITY_MAP[priority] : null;
  const whenM = whenMeta(when);

  // Grab-handle gestures: drag down past a threshold to dismiss, drag up past a
  // threshold to expand into the full-screen editor; a plain tap dismisses.
  const handleDrag = Gesture.Pan()
    .onUpdate((e) => {
      // Follow the finger down; add resistance going up (the editor takes over on release).
      dragY.value = e.translationY > 0 ? e.translationY : Math.max(-70, e.translationY * 0.5);
    })
    .onEnd((e) => {
      if (e.translationY > 60) {
        runOnJS(onClose)();
      } else if (e.translationY < -50) {
        runOnJS(expand)();
      } else {
        dragY.value = withTiming(0, { duration: 140 });
      }
    });
  const handleTap = Gesture.Tap().onEnd(() => {
    runOnJS(onClose)();
  });
  const handleGesture = Gesture.Race(handleDrag, handleTap);

  return (
    <>
      {/* A plain bottom overlay (NOT a Modal) so the list behind stays scrollable. It
          sits just above the keyboard; the grab handle dismisses it. */}
      <View
        style={[styles.overlay, { bottom: kbHeight > 0 ? kbHeight : insets.bottom }]}
        pointerEvents="box-none"
      >
        <Animated.View ref={cardRef} style={[styles.card, cardAnimStyle]} onLayout={reportCovered}>
          <GestureDetector gesture={handleGesture}>
            <View style={styles.grabWrap}>
              <View style={styles.grabber} />
            </View>
          </GestureDetector>
            <View style={styles.titleRow}>
              <TextInput
                ref={ref}
                testID="quickadd-title"
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
            </View>

            <View style={styles.controlRow}>
              <View style={styles.icons}>
                {when ? (
                  <Pressable
                    testID="quickadd-when"
                    onPress={() => openSheet('when')}
                    style={[styles.whenChip, { borderColor: whenM.color, backgroundColor: whenM.color + '18' }]}
                  >
                    <Ionicons name={whenM.icon} size={18} color={whenM.color} />
                    <Text style={[styles.whenText, { color: whenM.color, fontWeight: '600' }]} numberOfLines={1}>
                      {whenM.label}
                    </Text>
                  </Pressable>
                ) : (
                  <FieldIcon testID="quickadd-when" icon={whenM.icon} onPress={() => openSheet('when')} />
                )}
                <FieldIcon
                  testID="quickadd-priority"
                  icon={priority ? 'flag' : 'flag-outline'}
                  color={pr?.color}
                  active={!!priority}
                  onPress={() => openSheet('priority')}
                />
                <FieldIcon
                  testID="quickadd-deadline"
                  icon="hourglass-outline"
                  color={colors.deadline}
                  active={!!deadline}
                  onPress={() => openSheet('deadline')}
                />
                <FieldIcon
                  testID="quickadd-tags"
                  icon="pricetag-outline"
                  active={tags.length > 0}
                  onPress={() => openSheet('tags')}
                />
              </View>
            </View>

            <Pressable
              testID="quickadd-container"
              style={styles.footer}
              onPress={() => openSheet('move')}
            >
              <Ionicons
                name={container.projectId ? 'file-tray-full-outline' : 'file-tray-outline'}
                size={15}
                color={colors.textSecondary}
              />
              <Text style={styles.footerText} numberOfLines={1}>{containerLabel}</Text>
              <Ionicons name="chevron-down" size={13} color={colors.textSecondary} />
            </Pressable>
        </Animated.View>
      </View>

      <WhenSheet
        visible={sheet === 'when'}
        onClose={closeSheet}
        value={when}
        onChange={(w, ti) => { setWhen(w); setTimeInfo(ti || null); }}
        timeInfo={timeInfo}
        showTime
      />
      <DeadlineSheet visible={sheet === 'deadline'} onClose={closeSheet} value={deadline} onChange={setDeadline} />
      <PrioritySheet visible={sheet === 'priority'} onClose={closeSheet} value={priority} onChange={setPriority} />
      <TagSheet visible={sheet === 'tags'} onClose={closeSheet} selected={tags} onChange={setTags} />
      <MoveSheet
        visible={sheet === 'move'}
        onClose={closeSheet}
        task={container}
        onMove={(patch) =>
          setContainer({
            projectId: patch.projectId ?? null,
            areaId: patch.areaId ?? null,
            headingId: patch.headingId ?? null,
          })
        }
      />
    </>
  );
}

const styles = StyleSheet.create({
  overlay: { position: 'absolute', left: 0, right: 0 },
  // Roomy so the whole strip is an easy drag target (down = dismiss, up = expand).
  grabWrap: { alignItems: 'center', paddingTop: spacing.xs, paddingBottom: spacing.md },
  grabber: { width: 36, height: 5, borderRadius: 3, backgroundColor: colors.separatorStrong },
  card: {
    backgroundColor: colors.background,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    gap: spacing.md,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: colors.separatorStrong,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -3 },
    shadowOpacity: 0.22,
    shadowRadius: 10,
    elevation: 14,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  title: {
    flex: 1,
    ...typography.title,
    // Quick-add title: smaller and regular weight (the full typography.title is
    // too large/bold for the compact composer).
    fontSize: 18,
    fontWeight: '400',
    color: colors.text,
    padding: 0,
    // Explicitly clear the decoration: iOS leaks a previous TextInput's
    // line-through (e.g. a task title marked done in the detail editor) onto the
    // next focused field, striking through this placeholder otherwise.
    textDecorationLine: 'none',
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null),
  },
  controlRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  icons: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  whenChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 38,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.separatorStrong,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  whenText: { ...typography.subhead, color: colors.textSecondary, maxWidth: 120 },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  footer: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  footerText: { ...typography.caption, color: colors.textSecondary },
});

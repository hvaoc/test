import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  Modal,
  Animated,
  PanResponder,
  Dimensions,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ScrollCalendar from './ScrollCalendar';
import TimeSheet from './TimeSheet';
import { colors, spacing, typography, radius } from '../theme';
import { WHEN } from '../store/constants';
import { todayKey, keyToDate, addDays, longLabel } from '../utils/date';

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const isBucket = (v) => v === WHEN.TODAY || v === WHEN.EVENING || v === WHEN.SOMEDAY;
const isDate = (v) => v && !isBucket(v);

const WIN = Dimensions.get('window');
const COLLAPSED_H = Math.min(680, Math.round(WIN.height * 0.8));
const EXPANDED_H = Math.round(WIN.height * 0.94);

function nextWeekday(target, keepToday) {
  const today = todayKey();
  const day = keyToDate(today).getDay();
  let add = (target - day + 7) % 7;
  if (add === 0 && !keepToday) add = 7;
  return addDays(today, add);
}

function fmtTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const ap = h < 12 ? 'AM' : 'PM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, '0')} ${ap}`;
}

// "When" scheduler in an expandable bottom sheet. Collapsed shows the quick rows over
// a short calendar; drag the handle up (or tap the chevron) to expand into a tall
// continuous calendar. Quick rows commit immediately; the calendar drafts a date that
// the header ✓ commits.
export default function WhenSheet({ visible, onClose, value, onChange, timeInfo = null, showTime = false }) {
  const insets = useSafeAreaInsets();
  const today = todayKey();
  const tomorrow = addDays(today, 1);
  const weekend = nextWeekday(6, true);
  const nextWeek = nextWeekday(1, false);

  const [draft, setDraft] = useState(isDate(value) ? value : null);
  const [mins, setMins] = useState(timeInfo?.startMinutes ?? null);
  const [dur, setDur] = useState(timeInfo?.durationMinutes ?? null);
  const [tz, setTz] = useState(timeInfo?.timezone ?? null);
  const [timeOpen, setTimeOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const height = useRef(new Animated.Value(COLLAPSED_H)).current;
  const translateY = useRef(new Animated.Value(EXPANDED_H)).current;
  const expandedRef = useRef(false);
  useEffect(() => { expandedRef.current = expanded; }, [expanded]);

  useEffect(() => {
    if (visible) {
      setDraft(isDate(value) ? value : null);
      setMins(timeInfo?.startMinutes ?? null);
      setDur(timeInfo?.durationMinutes ?? null);
      setTz(timeInfo?.timezone ?? null);
      setTimeOpen(false);
      setExpanded(false);
      height.setValue(COLLAPSED_H);
      translateY.setValue(EXPANDED_H);
      // Non-native driver to match the height spring (same view — avoid mixing drivers).
      Animated.timing(translateY, { toValue: 0, duration: 220, useNativeDriver: false }).start();
    }
  }, [visible]);

  const snapTo = (toExpanded) => {
    if (expandedRef.current === toExpanded) return;
    expandedRef.current = toExpanded;
    setExpanded(toExpanded);
    Animated.spring(height, { toValue: toExpanded ? EXPANDED_H : COLLAPSED_H, useNativeDriver: false, bounciness: 2, speed: 14 }).start();
  };

  // Drive the expand/collapse from the calendar's own scroll: scrolling up past the
  // top expands to the full calendar; scrolling back to the top collapses to the
  // quick-rows view.
  const onCalendarScroll = (e) => {
    const y = e.nativeEvent.contentOffset.y;
    if (!expandedRef.current && y > 24) snapTo(true);
    else if (expandedRef.current && y <= 0) snapTo(false);
  };

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 6,
      onPanResponderMove: (_, g) => {
        const base = expandedRef.current ? EXPANDED_H : COLLAPSED_H;
        height.setValue(Math.max(COLLAPSED_H - 60, Math.min(EXPANDED_H, base - g.dy)));
      },
      onPanResponderRelease: (_, g) => {
        if (g.dy < -50) snapTo(true);
        else if (g.dy > 50) {
          if (expandedRef.current) snapTo(false);
          else onClose();
        } else snapTo(expandedRef.current);
      },
    })
  ).current;

  const pick = (v) => {
    onChange(v, null);
    onClose();
  };

  const confirm = () => {
    if (draft) {
      onChange(draft, mins != null ? { startMinutes: mins, durationMinutes: dur, timezone: tz } : null);
    }
    onClose();
  };

  const caption = draft
    ? longLabel(draft)
    : isBucket(value)
    ? { [WHEN.TODAY]: 'Today', [WHEN.EVENING]: 'This Evening', [WHEN.SOMEDAY]: 'Someday' }[value]
    : 'No day selected';

  const Row = ({ icon, color, label, hint, onPress, testID }) => (
    <Pressable testID={testID} style={styles.row} onPress={onPress}>
      <Ionicons name={icon} size={20} color={color} style={styles.rowIcon} />
      <Text style={styles.rowLabel}>{label}</Text>
      {hint ? <Text style={styles.rowHint}>{hint}</Text> : null}
    </Pressable>
  );

  // The shortcut rows adapt to the current selection. The middle slot toggles between
  // "Tomorrow" and "Later this Week": normally it's Tomorrow, but when Tomorrow is the
  // current selection it flips to "Later this Week" (and vice-versa). The already-selected
  // shortcut is dropped (redundant), and once anything is scheduled a "No date" row is
  // appended so it can be cleared.
  const later = addDays(today, 3);
  const tomorrowRow = { testID: 'when-option-tomorrow', icon: 'partly-sunny', color: colors.deadlineSoon, label: 'Tomorrow', hint: WD[keyToDate(tomorrow).getDay()], value: tomorrow };
  const laterRow = { testID: 'when-option-later', icon: 'calendar-clear-outline', color: '#3aa675', label: 'Later this Week', hint: WD[keyToDate(later).getDay()], value: later };
  const midRow = value === tomorrow ? laterRow : tomorrowRow;
  const shortcuts = [
    { testID: 'when-option-today', icon: 'star', color: colors.today, label: 'Today', hint: WD[keyToDate(today).getDay()], value: WHEN.TODAY },
    { testID: 'when-option-evening', icon: 'moon', color: colors.someday, label: 'This Evening', value: WHEN.EVENING },
    midRow,
    { testID: 'when-option-weekend', icon: 'bed', color: colors.accent, label: 'This Weekend', hint: WD[keyToDate(weekend).getDay()], value: weekend },
    { testID: 'when-option-nextweek', icon: 'arrow-forward-circle', color: '#9b6dff', label: 'Next Week', hint: WD[keyToDate(nextWeek).getDay()], value: nextWeek },
  ].filter((s) => s.value !== value);

  // When both Today and This Evening survive (neither is selected), they're both "today"
  // — pair them onto one row to save a line; otherwise everything renders full-width.
  const pairToday = shortcuts.find((s) => s.value === WHEN.TODAY);
  const pairEvening = shortcuts.find((s) => s.value === WHEN.EVENING);
  const pairMode = !!(pairToday && pairEvening);
  const restShortcuts = pairMode ? shortcuts.filter((s) => s.value !== WHEN.TODAY && s.value !== WHEN.EVENING) : shortcuts;

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <View style={styles.fill}>
        <Pressable style={styles.scrim} onPress={onClose} />
        <Animated.View style={[styles.sheet, { height, paddingBottom: insets.bottom, transform: [{ translateY }] }]}>
          <View {...pan.panHandlers} style={styles.grabWrap}>
            <View style={styles.grabber} />
          </View>

          <View style={styles.header}>
            <Pressable testID="when-cancel" hitSlop={10} onPress={onClose} style={styles.hBtn}>
              <Ionicons name="close" size={24} color={colors.text} />
            </Pressable>
            <Pressable onPress={() => snapTo(!expanded)} hitSlop={10} style={styles.hTitleWrap}>
              <Text style={styles.hTitle}>Date</Text>
              <Ionicons name={expanded ? 'chevron-down' : 'chevron-up'} size={16} color={colors.textSecondary} />
            </Pressable>
            <Pressable testID="when-confirm" hitSlop={10} onPress={confirm} style={[styles.hBtn, styles.hConfirm]}>
              <Ionicons name="checkmark" size={20} color={colors.white} />
            </Pressable>
          </View>

          {!expanded && (
            <View>
              {pairMode && (
                <View style={styles.pairRow}>
                  {[pairToday, pairEvening].map((s) => (
                    <Pressable key={s.testID} testID={s.testID} style={styles.halfRow} onPress={() => pick(s.value)}>
                      <Ionicons name={s.icon} size={20} color={s.color} style={styles.rowIcon} />
                      <Text style={styles.rowLabel} numberOfLines={1}>{s.label}</Text>
                    </Pressable>
                  ))}
                </View>
              )}
              {restShortcuts.map((s) => (
                <Row key={s.testID} testID={s.testID} icon={s.icon} color={s.color} label={s.label} hint={s.hint} onPress={() => pick(s.value)} />
              ))}
              {value ? (
                <Row testID="when-option-none" icon="close-circle-outline" color={colors.textSecondary} label="No date" onPress={() => pick(null)} />
              ) : null}
              <View style={styles.divider} />
            </View>
          )}

          <Text style={styles.caption}>{caption}</Text>
          <ScrollCalendar fill selected={draft} onSelect={(key) => setDraft(key)} onScroll={onCalendarScroll} />

          {showTime && (
            <Pressable testID="when-time" style={styles.timeRow} onPress={() => draft && setTimeOpen(true)}>
              <Ionicons name="time-outline" size={18} color={draft ? colors.text : colors.textTertiary} />
              <Text style={[styles.timeLabel, !draft && { color: colors.textTertiary }]}>Time</Text>
              <Text style={[styles.timeValue, mins != null && { color: colors.accent }]}>{mins != null ? fmtTime(mins) : 'None'}</Text>
              <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
            </Pressable>
          )}
        </Animated.View>
      </View>

      <TimeSheet
        visible={timeOpen}
        minutes={mins}
        duration={dur}
        timezone={tz}
        onClose={() => setTimeOpen(false)}
        onSave={(m, d, zone) => { setMins(m); setDur(d); setTz(zone); setTimeOpen(false); }}
      />
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: 'flex-end' },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: colors.separatorStrong,
    paddingHorizontal: spacing.lg,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -3 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 16,
  },
  grabWrap: { alignItems: 'center', paddingVertical: spacing.sm },
  grabber: { width: 36, height: 5, borderRadius: 3, backgroundColor: colors.separatorStrong },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: spacing.sm,
    marginBottom: spacing.xs,
  },
  hBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  hConfirm: { backgroundColor: colors.accent },
  hTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  hTitle: { ...typography.heading, color: colors.text },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    gap: spacing.md,
  },
  rowIcon: { width: 24, textAlign: 'center' },
  rowLabel: { flex: 1, ...typography.body, color: colors.text },
  pairRow: { flexDirection: 'row' },
  halfRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
  },
  rowHint: { ...typography.subhead, color: colors.textTertiary },
  divider: { height: 1, backgroundColor: colors.separator, marginVertical: spacing.sm },
  caption: { textAlign: 'center', ...typography.subhead, color: colors.textTertiary, marginBottom: spacing.xs },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator,
  },
  timeLabel: { flex: 1, ...typography.body, color: colors.text },
  timeValue: { ...typography.body, color: colors.textSecondary },
});

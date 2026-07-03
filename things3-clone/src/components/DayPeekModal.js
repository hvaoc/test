import React, { useRef } from 'react';
import { Modal, View, Text, Pressable, ScrollView, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, typography, radius } from '../theme';
import { STATUS } from '../store/constants';
import { formatDayKey } from '../utils/date';
import { layoutOverlaps } from '../utils/overlap';

const END_HOUR = 23;
const HOUR_H = 44;
const GUTTER = 44;
const TOP_PAD = 8;
const BOTTOM_PAD = 10;
const DEFAULT_DUR = 60;

const fmt = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
function tint(hex) {
  const h = (hex || '').replace('#', '');
  if (h.length !== 6) return colors.accentSoft;
  return `rgba(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}, 0.16)`;
}

// A lightweight, read-only "peek" at a single day's schedule, shown as a centered
// dialog when a date is tapped in the Month view. Tapping an event opens it; the
// "Open" button jumps to the full Day view.
export default function DayPeekModal({
  visible,
  dayKey,
  dayTasks = [],
  color = colors.accent,
  startHour = 0,
  dateFormat = 'weekday-long',
  onClose,
  onOpenTask,
  onOpenFull,
}) {
  const scrollRef = useRef(null);
  const scrolledRef = useRef(false);

  const timed = dayTasks.filter((t) => t.startMinutes != null).sort((a, b) => a.startMinutes - b.startMinutes);
  const allDay = dayTasks.filter((t) => t.startMinutes == null);
  const layout = layoutOverlaps(timed);

  const HOURS = END_HOUR - startHour;
  const gridH = TOP_PAD + HOURS * HOUR_H + BOTTOM_PAD;

  // Land the scroll on the first event (or 8:00) once laid out.
  const onContentReady = () => {
    if (scrolledRef.current) return;
    scrolledRef.current = true;
    const firstMin = timed.length ? timed[0].startMinutes : 8 * 60;
    const y = TOP_PAD + Math.max(0, (firstMin - startHour * 60) / 60 - 0.5) * HOUR_H;
    scrollRef.current?.scrollTo({ y, animated: false });
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={(e) => e?.stopPropagation?.()}>
          <View style={styles.header}>
            <Text style={styles.title}>{dayKey ? formatDayKey(dayKey, dateFormat) : ''}</Text>
            <View style={styles.headerBtns}>
              {onOpenFull && (
                <Pressable onPress={onOpenFull} style={styles.openBtn}>
                  <Ionicons name="open-outline" size={14} color={colors.accent} />
                  <Text style={styles.openText}>Open</Text>
                </Pressable>
              )}
              <Pressable onPress={onClose} hitSlop={8} style={styles.closeBtn}>
                <Ionicons name="close" size={20} color={colors.textSecondary} />
              </Pressable>
            </View>
          </View>

          {allDay.length > 0 && (
            <View style={styles.allDay}>
              {allDay.map((t) => (
                <Pressable key={t.id} onPress={() => onOpenTask && onOpenTask(t.id)} style={[styles.allDayChip, { borderLeftColor: color }]}>
                  <Text style={[styles.allDayText, t.status !== STATUS.OPEN && styles.done]} numberOfLines={1}>
                    {t.title || 'New To-Do'}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}

          <ScrollView
            ref={scrollRef}
            style={styles.scroll}
            showsVerticalScrollIndicator={false}
            onContentSizeChange={onContentReady}
          >
            <View style={{ height: gridH }}>
              {Array.from({ length: HOURS + 1 }, (_, i) => startHour + i).map((h) => (
                <View key={h} style={[styles.hourRow, { top: TOP_PAD + (h - startHour) * HOUR_H }]}>
                  <Text style={styles.hourLabel}>{fmt(h * 60)}</Text>
                  <View style={styles.hourLine} />
                </View>
              ))}
              <View style={[styles.blockLayer, { left: GUTTER }]}>
                {timed.map((t) => {
                  const top = TOP_PAD + ((t.startMinutes - startHour * 60) / 60) * HOUR_H;
                  const height = Math.max(16, ((t.durationMinutes || DEFAULT_DUR) / 60) * HOUR_H - 2);
                  const { col = 0, count = 1 } = layout.get(t.id) || {};
                  const w = 100 / count;
                  return (
                    <Pressable
                      key={t.id}
                      onPress={() => onOpenTask && onOpenTask(t.id)}
                      style={[styles.block, { top, height, left: `${col * w}%`, width: `${w}%` }]}
                    >
                      <View style={[styles.blockInner, { backgroundColor: tint(color), borderLeftColor: color }]}>
                        <Text style={[styles.blockTitle, t.status !== STATUS.OPEN && styles.done]} numberOfLines={count > 1 ? 2 : 1}>
                          {t.title || 'New To-Do'}
                        </Text>
                        {count < 3 && <Text style={styles.blockTime} numberOfLines={1}>{fmt(t.startMinutes)}</Text>}
                      </View>
                    </Pressable>
                  );
                })}
              </View>
              {timed.length === 0 && allDay.length === 0 && (
                <Text style={styles.empty}>No events</Text>
              )}
            </View>
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
    ...(Platform.OS === 'web' ? { cursor: 'default' } : null),
  },
  card: {
    width: '100%',
    maxWidth: 560,
    maxHeight: '80%',
    backgroundColor: colors.background,
    borderRadius: radius.lg,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  title: { ...typography.title, color: colors.text, flexShrink: 1 },
  headerBtns: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  openBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.accent, backgroundColor: colors.accentSoft,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  openText: { ...typography.subhead, color: colors.accent, fontWeight: '600' },
  closeBtn: { ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null) },
  allDay: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 4,
    paddingHorizontal: spacing.lg, paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator,
  },
  allDayChip: {
    borderLeftWidth: 3, borderRadius: 4, backgroundColor: colors.groupedBackground,
    paddingHorizontal: spacing.sm, paddingVertical: 3, maxWidth: '100%',
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  allDayText: { ...typography.caption, color: colors.text },
  scroll: { paddingHorizontal: spacing.lg },
  hourRow: { position: 'absolute', left: 0, right: 0, height: HOUR_H, flexDirection: 'row', alignItems: 'flex-start' },
  hourLabel: { width: GUTTER, ...typography.caption, color: colors.textTertiary, marginTop: -6, fontSize: 10, textAlign: 'right', paddingRight: 4, fontVariant: ['tabular-nums'] },
  hourLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.separator },
  blockLayer: { position: 'absolute', top: 0, bottom: 0, right: 0 },
  block: { position: 'absolute', paddingRight: 2, ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null) },
  blockInner: { flex: 1, borderLeftWidth: 3, borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1, overflow: 'hidden' },
  blockTitle: { ...typography.caption, color: colors.text, fontWeight: '600', fontSize: 11 },
  blockTime: { ...typography.caption, color: colors.textSecondary, fontSize: 9 },
  done: { color: colors.textTertiary, textDecorationLine: 'line-through' },
  empty: { position: 'absolute', top: TOP_PAD + 3 * HOUR_H, left: 0, right: 0, textAlign: 'center', ...typography.subhead, color: colors.textTertiary },
});

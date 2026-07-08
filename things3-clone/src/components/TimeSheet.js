import React, { useState, useEffect, useRef } from 'react';
import { View, Text, Pressable, ScrollView, Modal, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, typography, radius } from '../theme';

const ITEM_H = 40;
const HOURS = Array.from({ length: 12 }, (_, i) => i + 1); // 1..12
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5); // 0,5,..55
const APS = ['AM', 'PM'];

const to24 = (h12, ap) => (ap === 'PM' ? (h12 % 12) + 12 : h12 % 12);
const parts = (mins) => {
  const m = mins == null ? 9 * 60 : mins;
  const h24 = Math.floor(m / 60);
  const ap = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return { h12, m5: (m % 60) - ((m % 60) % 5), ap };
};

function fmtDur(mins) {
  if (!mins) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

// A snapping wheel column: scroll snaps to the item under the centre band and commits
// it; it also scrolls to the current value when the sheet opens. Tapping an item works
// too. `data[i]` is centred when the scroll offset is `i * ITEM_H`.
function Column({ data, value, onChange, fmt }) {
  const ref = useRef(null);
  const idx = Math.max(0, data.indexOf(value));

  // Land on the current/default value on mount (the sheet remounts each open).
  useEffect(() => {
    const t = setTimeout(() => ref.current?.scrollTo({ y: idx * ITEM_H, animated: false }), 40);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commit = (y) => {
    const i = Math.max(0, Math.min(data.length - 1, Math.round(y / ITEM_H)));
    if (data[i] !== value) onChange(data[i]);
  };

  return (
    <ScrollView
      ref={ref}
      style={styles.col}
      showsVerticalScrollIndicator={false}
      snapToInterval={ITEM_H}
      decelerationRate="fast"
      contentContainerStyle={{ paddingVertical: ITEM_H * 2 }}
      onMomentumScrollEnd={(e) => commit(e.nativeEvent.contentOffset.y)}
      onScrollEndDrag={(e) => commit(e.nativeEvent.contentOffset.y)}
    >
      {data.map((v, i) => (
        <Pressable key={v} style={styles.item} onPress={() => { onChange(v); ref.current?.scrollTo({ y: i * ITEM_H, animated: true }); }}>
          <Text style={[styles.itemText, v === value && styles.itemTextSel]}>{fmt ? fmt(v) : String(v).padStart(2, '0')}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

// The full "Time" sub-screen: a wheel for the start time, an optional duration, and a
// time-zone toggle (Floating vs. device). Returns (startMinutes, durationMinutes,
// timezone) on Save.
export default function TimeSheet({ visible, minutes, duration = null, timezone = null, onClose, onSave }) {
  const insets = useSafeAreaInsets();
  const init = parts(minutes);
  const [h12, setH12] = useState(init.h12);
  const [m5, setM5] = useState(init.m5);
  const [ap, setAp] = useState(init.ap);
  const [dur, setDur] = useState(duration);
  const [tz, setTz] = useState(timezone); // null = Floating Time

  useEffect(() => {
    if (!visible) return;
    const p = parts(minutes);
    setH12(p.h12); setM5(p.m5); setAp(p.ap);
    setDur(duration);
    setTz(timezone);
  }, [visible]);

  if (!visible) return null;
  const startMinutes = to24(h12, ap) * 60 + m5;

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Pressable testID="time-back" hitSlop={10} onPress={onClose} style={styles.hBtn}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </Pressable>
          <Text style={styles.hTitle}>Time</Text>
          <Pressable testID="time-save" hitSlop={10} onPress={() => onSave(startMinutes, dur, tz)} style={styles.saveBtn}>
            <Text style={styles.saveText}>Save</Text>
          </Pressable>
        </View>

        <View style={styles.row}>
          <Text style={styles.rowLabel}>Time</Text>
          <Text style={styles.rowValue}>{`${h12}:${String(m5).padStart(2, '0')} ${ap}`}</Text>
        </View>

        <View style={styles.wheel}>
          <View style={styles.centerBand} pointerEvents="none" />
          <Column data={HOURS} value={h12} onChange={setH12} />
          <Text style={styles.colon}>:</Text>
          <Column data={MINUTES} value={m5} onChange={setM5} />
          <Column data={APS} value={ap} onChange={setAp} fmt={(v) => v} />
        </View>

        <Pressable testID="time-duration" style={styles.card} onPress={() => setDur((d) => (d ? null : 60))}>
          <Text style={styles.cardLabel}>{dur ? 'Duration' : 'Add Duration'}</Text>
          {dur ? (
            <View style={styles.stepper}>
              <Pressable hitSlop={8} onPress={(e) => { e.stopPropagation?.(); setDur((d) => Math.max(15, (d || 60) - 15)); }}>
                <Ionicons name="remove-circle-outline" size={22} color={colors.accent} />
              </Pressable>
              <Text style={styles.durText}>{fmtDur(dur)}</Text>
              <Pressable hitSlop={8} onPress={(e) => { e.stopPropagation?.(); setDur((d) => Math.min(720, (d || 60) + 15)); }}>
                <Ionicons name="add-circle-outline" size={22} color={colors.accent} />
              </Pressable>
            </View>
          ) : (
            <Ionicons name="add" size={20} color={colors.textSecondary} />
          )}
        </Pressable>

        <Pressable testID="time-timezone" style={styles.card} onPress={() => setTz((z) => (z ? null : 'device'))}>
          <Text style={styles.cardLabel}>Time Zone</Text>
          <View style={styles.tzVal}>
            <Text style={styles.tzText}>{tz ? 'Device Time' : 'Floating Time'}</Text>
            <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
          </View>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background, paddingHorizontal: spacing.lg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: spacing.md },
  hBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceMuted },
  hTitle: { ...typography.heading, color: colors.text },
  saveBtn: { backgroundColor: colors.accent, borderRadius: radius.pill, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  saveText: { ...typography.body, color: colors.white, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: spacing.lg, marginTop: spacing.md },
  rowLabel: { ...typography.body, color: colors.text },
  rowValue: { ...typography.body, color: colors.text, backgroundColor: colors.surfaceMuted, borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 6 },
  wheel: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: ITEM_H * 5, marginVertical: spacing.md },
  centerBand: { position: 'absolute', left: 0, right: 0, top: ITEM_H * 2, height: ITEM_H, backgroundColor: colors.surfaceMuted, borderRadius: radius.sm },
  col: { width: 72 },
  item: { height: ITEM_H, alignItems: 'center', justifyContent: 'center' },
  itemText: { ...typography.title, fontWeight: '400', color: colors.textTertiary },
  itemTextSel: { color: colors.text, fontWeight: '700' },
  colon: { ...typography.title, color: colors.text, marginHorizontal: 2 },
  card: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.surfaceMuted, borderRadius: radius.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.lg, marginTop: spacing.md },
  cardLabel: { ...typography.body, color: colors.text },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  durText: { ...typography.body, color: colors.text, minWidth: 48, textAlign: 'center' },
  tzVal: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  tzText: { ...typography.body, color: colors.textSecondary },
});

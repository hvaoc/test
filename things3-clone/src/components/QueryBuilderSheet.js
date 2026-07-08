import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  TextInput,
  ScrollView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import BottomSheet from './BottomSheet';
import { colors, spacing, typography, radius } from '../theme';
import { PRIORITIES, PROJECT_COLORS } from '../store/constants';
import {
  QUERY_FIELDS,
  QUERY_FIELD_MAP,
  WHEN_STATES,
  emptyQuery,
  todayKey,
} from '../store/query';

// Icons offered for a saved Custom View.
const VIEW_ICONS = [
  'funnel-outline', 'filter-outline', 'flash-outline', 'flame-outline',
  'star-outline', 'bookmark-outline', 'flag-outline', 'pricetag-outline',
  'time-outline', 'calendar-outline', 'rocket-outline', 'sparkles-outline',
];

// The editor for a query — used both for a live Search (mode="search") and for
// creating / editing a saved Custom View (mode="view", which also edits the
// view's name / icon / color). It keeps a working copy in local state and hands
// the finished query (+ view meta) back through onSubmit.
export default function QueryBuilderSheet({
  visible,
  onClose,
  mode = 'view',
  availableTags = [],
  initialQuery,
  initialMeta,
  onSubmit,
  onDelete,
}) {
  const [query, setQuery] = useState(() => initialQuery || emptyQuery());
  const [meta, setMeta] = useState(
    () => initialMeta || { name: '', icon: 'funnel-outline', color: colors.accent }
  );

  // Reset the working copy whenever the sheet is (re)opened for a target.
  useEffect(() => {
    if (visible) {
      setQuery(initialQuery || emptyQuery());
      setMeta(initialMeta || { name: '', icon: 'funnel-outline', color: colors.accent });
    }
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const patch = (p) => setQuery((q) => ({ ...q, ...p }));
  const setCondition = (i, cond) =>
    patch({ conditions: query.conditions.map((c, j) => (j === i ? cond : c)) });
  const addCondition = () => {
    const field = QUERY_FIELDS[0];
    patch({
      conditions: [
        ...query.conditions,
        { field: field.key, op: field.ops[0].key, value: defaultValue(field.ops[0]) },
      ],
    });
  };
  const removeCondition = (i) =>
    patch({ conditions: query.conditions.filter((_, j) => j !== i) });

  const submit = () => {
    onSubmit && onSubmit(query, meta);
    onClose && onClose();
  };

  const title = mode === 'view' ? (initialMeta ? 'Edit View' : 'New View') : 'Search Filter';
  const canSave = mode === 'search' || (meta.name || '').trim().length > 0;

  return (
    <BottomSheet visible={visible} onClose={onClose} title={title}>
      <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
        {mode === 'view' && (
          <>
            <Text style={styles.label}>Name</Text>
            <TextInput
              testID="qb-name"
              style={styles.input}
              value={meta.name}
              onChangeText={(t) => setMeta((m) => ({ ...m, name: t }))}
              placeholder="e.g. High priority this week"
              placeholderTextColor={colors.placeholder}
            />

            <Text style={styles.label}>Icon</Text>
            <View style={styles.chipWrap}>
              {VIEW_ICONS.map((ic) => (
                <Pressable
                  key={ic}
                  onPress={() => setMeta((m) => ({ ...m, icon: ic }))}
                  style={[styles.iconChip, meta.icon === ic && { borderColor: meta.color, backgroundColor: colors.surfaceMuted }]}
                >
                  <Ionicons name={ic} size={18} color={meta.icon === ic ? meta.color : colors.textSecondary} />
                </Pressable>
              ))}
            </View>

            <Text style={styles.label}>Color</Text>
            <View style={styles.chipWrap}>
              {PROJECT_COLORS.slice(0, 12).map((c) => (
                <Pressable
                  key={c}
                  onPress={() => setMeta((m) => ({ ...m, color: c }))}
                  style={[styles.colorDot, { backgroundColor: c }, meta.color === c && styles.colorDotSel]}
                />
              ))}
            </View>
            <View style={styles.divider} />
          </>
        )}

        <Text style={styles.label}>Text contains</Text>
        <TextInput
          testID="qb-text"
          style={styles.input}
          value={query.text}
          onChangeText={(t) => patch({ text: t })}
          placeholder="Fuzzy match on title (optional)"
          placeholderTextColor={colors.placeholder}
        />

        <View style={styles.matchRow}>
          <Text style={styles.label}>Match</Text>
          <Segmented
            options={[
              { key: 'all', label: 'All' },
              { key: 'any', label: 'Any' },
            ]}
            value={query.match}
            onChange={(v) => patch({ match: v })}
          />
          <Text style={styles.matchHint}>of the conditions</Text>
        </View>

        {query.conditions.map((cond, i) => (
          <ConditionRow
            key={i}
            cond={cond}
            availableTags={availableTags}
            onChange={(c) => setCondition(i, c)}
            onRemove={() => removeCondition(i)}
          />
        ))}

        <Pressable testID="qb-add-condition" style={styles.addCond} onPress={addCondition}>
          <Ionicons name="add-circle-outline" size={18} color={colors.accent} />
          <Text style={styles.addCondText}>Add condition</Text>
        </Pressable>

        <View style={styles.divider} />
        <Toggle
          label="Include completed"
          value={!!query.includeCompleted}
          onChange={(v) => patch({ includeCompleted: v })}
        />

        <View style={styles.actions}>
          {mode === 'view' && onDelete && (
            <Pressable style={styles.deleteBtn} onPress={() => { onDelete(); onClose && onClose(); }}>
              <Text style={styles.deleteText}>Delete</Text>
            </Pressable>
          )}
          <View style={{ flex: 1 }} />
          <Pressable
            testID="qb-save"
            style={[styles.saveBtn, !canSave && styles.saveBtnDisabled]}
            disabled={!canSave}
            onPress={submit}
          >
            <Text style={styles.saveText}>{mode === 'view' ? 'Save View' : 'Apply'}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </BottomSheet>
  );
}

// ---------------------------------------------------------------------------
// One condition: field select → operator select → value editor + remove.
// ---------------------------------------------------------------------------

function ConditionRow({ cond, availableTags, onChange, onRemove }) {
  const field = QUERY_FIELD_MAP[cond.field] || QUERY_FIELDS[0];
  const op = field.ops.find((o) => o.key === cond.op) || field.ops[0];

  const onField = (key) => {
    const f = QUERY_FIELD_MAP[key];
    onChange({ field: key, op: f.ops[0].key, value: defaultValue(f.ops[0]) });
  };
  const onOp = (key) => {
    const o = field.ops.find((x) => x.key === key);
    onChange({ ...cond, op: key, value: defaultValue(o) });
  };
  const onValue = (value) => onChange({ ...cond, value });

  return (
    <View style={styles.condCard}>
      <View style={styles.condTop}>
        <Dropdown
          testID="qb-field"
          value={field.key}
          options={QUERY_FIELDS.map((f) => ({ key: f.key, label: f.label }))}
          onChange={onField}
          style={{ flex: 1 }}
        />
        <Dropdown
          testID="qb-op"
          value={op.key}
          options={field.ops.map((o) => ({ key: o.key, label: o.label }))}
          onChange={onOp}
          style={{ flex: 1.2 }}
        />
        <Pressable hitSlop={8} onPress={onRemove} style={styles.removeBtn}>
          <Ionicons name="close" size={16} color={colors.textTertiary} />
        </Pressable>
      </View>
      <ValueEditor op={op} value={cond.value} onChange={onValue} availableTags={availableTags} />
    </View>
  );
}

function ValueEditor({ op, value, onChange, availableTags }) {
  switch (op.arity) {
    case 'none':
      return null;
    case 'tags':
      return (
        <MultiChips
          options={(availableTags || []).map((t) => ({ key: t, label: t }))}
          value={Array.isArray(value) ? value : []}
          onChange={onChange}
          empty="No labels yet"
        />
      );
    case 'priorities':
      return (
        <MultiChips
          testID="qb-priority"
          options={PRIORITIES.map((p) => ({ key: p.key, label: p.label, color: p.color }))}
          value={Array.isArray(value) ? value : []}
          onChange={onChange}
        />
      );
    case 'whenState':
      return (
        <SingleChips
          options={WHEN_STATES.map((s) => ({ key: s.key, label: s.label }))}
          value={value}
          onChange={onChange}
        />
      );
    case 'date':
      return <DateField value={value} onChange={onChange} />;
    case 'dateRange':
      return (
        <View style={styles.rangeRow}>
          <DateField value={value?.[0]} onChange={(v) => onChange([v, value?.[1] || v])} />
          <Text style={styles.rangeDash}>–</Text>
          <DateField value={value?.[1]} onChange={(v) => onChange([value?.[0] || v, v])} />
        </View>
      );
    case 'minutes':
      return <NumField value={value} onChange={onChange} suffix="min" />;
    case 'minutesRange':
      return (
        <View style={styles.rangeRow}>
          <NumField value={value?.[0]} onChange={(v) => onChange([v, value?.[1] ?? v])} suffix="min" />
          <Text style={styles.rangeDash}>–</Text>
          <NumField value={value?.[1]} onChange={(v) => onChange([value?.[0] ?? v, v])} suffix="min" />
        </View>
      );
    case 'time':
      return <TimeField value={value} onChange={onChange} />;
    case 'timeRange':
      return (
        <View style={styles.rangeRow}>
          <TimeField value={value?.[0]} onChange={(v) => onChange([v, value?.[1] ?? v])} />
          <Text style={styles.rangeDash}>–</Text>
          <TimeField value={value?.[1]} onChange={(v) => onChange([value?.[0] ?? v, v])} />
        </View>
      );
    default:
      return null;
  }
}

// A sensible starting value for an operator (so a fresh condition is valid).
function defaultValue(op) {
  switch (op.arity) {
    case 'tags':
    case 'priorities':
      return [];
    case 'whenState':
      return 'today';
    case 'date':
      return todayKey();
    case 'dateRange':
      return [todayKey(), todayKey()];
    case 'minutes':
      return 30;
    case 'minutesRange':
      return [15, 60];
    case 'time':
      return 9 * 60;
    case 'timeRange':
      return [9 * 60, 17 * 60];
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Small primitives.
// ---------------------------------------------------------------------------

function Dropdown({ value, options, onChange, style, testID }) {
  const [open, setOpen] = useState(false);
  const cur = options.find((o) => o.key === value);
  return (
    <View style={[{ position: 'relative' }, style]}>
      <Pressable testID={testID} style={styles.dd} onPress={() => setOpen((o) => !o)}>
        <Text style={styles.ddText} numberOfLines={1}>{cur ? cur.label : '—'}</Text>
        <Ionicons name="chevron-down" size={13} color={colors.textTertiary} />
      </Pressable>
      {open && (
        <View style={styles.ddMenu}>
          {options.map((o) => (
            <Pressable
              key={o.key}
              testID={testID ? `${testID}-${o.key}` : undefined}
              style={({ hovered }) => [styles.ddItem, (hovered || o.key === value) && styles.ddItemActive]}
              onPress={() => { onChange(o.key); setOpen(false); }}
            >
              <Text style={[styles.ddItemText, o.key === value && { color: colors.accent, fontWeight: '600' }]}>{o.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

function Segmented({ options, value, onChange }) {
  return (
    <View style={styles.segmented}>
      {options.map((o) => (
        <Pressable
          key={o.key}
          style={[styles.segItem, value === o.key && styles.segItemActive]}
          onPress={() => onChange(o.key)}
        >
          <Text style={[styles.segText, value === o.key && styles.segTextActive]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function MultiChips({ options, value, onChange, empty, testID }) {
  if (!options.length) return <Text style={styles.emptyChips}>{empty || 'None available'}</Text>;
  const toggle = (k) =>
    onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k]);
  return (
    <View style={styles.chipWrap}>
      {options.map((o) => {
        const on = value.includes(o.key);
        return (
          <Pressable
            key={o.key}
            testID={testID ? `${testID}-${o.key}` : undefined}
            onPress={() => toggle(o.key)}
            style={[styles.chip, on && { backgroundColor: (o.color || colors.accent) + '22', borderColor: o.color || colors.accent }]}
          >
            {o.color && <View style={[styles.chipDot, { backgroundColor: o.color }]} />}
            <Text style={[styles.chipText, on && { color: o.color || colors.accent, fontWeight: '600' }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function SingleChips({ options, value, onChange }) {
  return (
    <View style={styles.chipWrap}>
      {options.map((o) => {
        const on = value === o.key;
        return (
          <Pressable
            key={o.key}
            onPress={() => onChange(o.key)}
            style={[styles.chip, on && { backgroundColor: colors.accentSoft, borderColor: colors.accent }]}
          >
            <Text style={[styles.chipText, on && { color: colors.accent, fontWeight: '600' }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function DateField({ value, onChange }) {
  return (
    <View style={styles.valueRow}>
      <TextInput
        style={[styles.input, styles.valueInput]}
        value={value || ''}
        onChangeText={onChange}
        placeholder="YYYY-MM-DD"
        placeholderTextColor={colors.placeholder}
        autoCapitalize="none"
      />
      <Pressable style={styles.todayBtn} onPress={() => onChange(todayKey())}>
        <Text style={styles.todayText}>Today</Text>
      </Pressable>
    </View>
  );
}

function NumField({ value, onChange, suffix }) {
  return (
    <View style={styles.valueRow}>
      <TextInput
        style={[styles.input, styles.numInput]}
        value={value == null ? '' : String(value)}
        onChangeText={(t) => onChange(t === '' ? 0 : parseInt(t.replace(/[^0-9]/g, ''), 10) || 0)}
        keyboardType="number-pad"
        placeholder="0"
        placeholderTextColor={colors.placeholder}
      />
      {suffix ? <Text style={styles.suffix}>{suffix}</Text> : null}
    </View>
  );
}

// A HH:MM (24h) editor that stores minutes-since-midnight.
function TimeField({ value, onChange }) {
  const text = value == null ? '' : `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  const commit = (t) => {
    const m = /^(\d{1,2}):?(\d{0,2})$/.exec(t.trim());
    if (m) {
      const h = Math.min(23, parseInt(m[1], 10) || 0);
      const mm = Math.min(59, parseInt(m[2] || '0', 10) || 0);
      onChange(h * 60 + mm);
    }
  };
  return (
    <TextInput
      style={[styles.input, styles.numInput]}
      value={draft}
      onChangeText={setDraft}
      onBlur={() => commit(draft)}
      onSubmitEditing={() => commit(draft)}
      placeholder="09:00"
      placeholderTextColor={colors.placeholder}
      keyboardType="numbers-and-punctuation"
    />
  );
}

function Toggle({ label, value, onChange }) {
  return (
    <Pressable style={styles.toggleRow} onPress={() => onChange(!value)}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <View style={[styles.switch, value && styles.switchOn]}>
        <View style={[styles.knob, value && styles.knobOn]} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  body: { maxHeight: 520 },
  label: {
    ...typography.subhead,
    color: colors.textSecondary,
    fontWeight: '600',
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  input: {
    ...typography.body,
    color: colors.text,
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'ios' ? spacing.sm : spacing.xs,
    minHeight: 38,
  },
  matchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.md },
  matchHint: { ...typography.subhead, color: colors.textTertiary },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.separator, marginVertical: spacing.md },

  condCard: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    padding: spacing.sm,
    marginTop: spacing.sm,
  },
  condTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  removeBtn: { padding: 4 },

  dd: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separatorStrong,
    paddingHorizontal: spacing.sm,
    paddingVertical: 7,
    gap: 4,
  },
  ddText: { ...typography.subhead, color: colors.text, flexShrink: 1 },
  ddMenu: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    marginTop: 2,
    backgroundColor: colors.background,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separatorStrong,
    paddingVertical: 4,
    zIndex: 50,
    ...Platform.select({
      web: { boxShadow: '0 6px 20px rgba(0,0,0,0.15)' },
      default: { elevation: 8, shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } },
    }),
  },
  ddItem: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  ddItemActive: { backgroundColor: colors.surfaceMuted },
  ddItemText: { ...typography.subhead, color: colors.text },

  segmented: { flexDirection: 'row', backgroundColor: colors.surfaceMuted, borderRadius: radius.sm, padding: 2 },
  segItem: { paddingHorizontal: spacing.md, paddingVertical: 5, borderRadius: radius.sm - 1 },
  segItemActive: { backgroundColor: colors.background, ...Platform.select({ web: { boxShadow: '0 1px 3px rgba(0,0,0,0.12)' }, default: {} }) },
  segText: { ...typography.subhead, color: colors.textSecondary },
  segTextActive: { color: colors.text, fontWeight: '600' },

  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: 4 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separatorStrong,
    backgroundColor: colors.background,
  },
  chipDot: { width: 8, height: 8, borderRadius: 4 },
  chipText: { ...typography.subhead, color: colors.textSecondary },
  emptyChips: { ...typography.subhead, color: colors.textTertiary, marginTop: 4 },

  iconChip: {
    width: 40,
    height: 36,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: colors.separatorStrong,
    backgroundColor: colors.background,
  },
  colorDot: { width: 26, height: 26, borderRadius: 13 },
  colorDotSel: { borderWidth: 2, borderColor: colors.text },

  valueRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  valueInput: { flex: 1 },
  numInput: { width: 90, textAlign: 'center' },
  suffix: { ...typography.subhead, color: colors.textTertiary },
  rangeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  rangeDash: { ...typography.body, color: colors.textTertiary },
  todayBtn: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, backgroundColor: colors.accentSoft, borderRadius: radius.sm },
  todayText: { ...typography.subhead, color: colors.accent, fontWeight: '600' },

  addCond: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: spacing.md, paddingVertical: spacing.sm },
  addCondText: { ...typography.body, color: colors.accent, fontWeight: '600' },

  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: spacing.sm },
  toggleLabel: { ...typography.body, color: colors.text },
  switch: { width: 44, height: 26, borderRadius: 13, backgroundColor: colors.separatorStrong, padding: 3, justifyContent: 'center' },
  switchOn: { backgroundColor: colors.accent },
  knob: { width: 20, height: 20, borderRadius: 10, backgroundColor: colors.white },
  knobOn: { alignSelf: 'flex-end' },

  actions: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.lg, gap: spacing.md },
  deleteBtn: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  deleteText: { ...typography.body, color: colors.overdue || '#c04f43', fontWeight: '600' },
  saveBtn: { backgroundColor: colors.accent, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: radius.md },
  saveBtnDisabled: { opacity: 0.4 },
  saveText: { ...typography.body, color: colors.white, fontWeight: '700' },
});

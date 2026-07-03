import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Checkbox from './Checkbox';
import WhenSheet from './WhenSheet';
import DeadlineSheet from './DeadlineSheet';
import MoveSheet from './MoveSheet';
import TagSheet from './TagSheet';
import PrioritySheet from './PrioritySheet';
import LocationSheet from './LocationSheet';
import { colors, spacing, typography, radius } from '../theme';
import { WHEN, STATUS, PRIORITY_MAP } from '../store/constants';
import { relativeLabel } from '../utils/date';
import { useTasks, newTask } from '../store/TasksContext';
import { selectSubtasks } from '../store/selectors';
import WailsTitleBar, { useIsWails } from './WailsTitleBar';
import { useIsWide } from '../navigation/responsive';

// Maps a "when" value to the chip label/icon shown on the schedule button.
function whenMeta(when) {
  if (!when) return { label: 'When', icon: 'calendar-outline', color: colors.textSecondary };
  if (when === WHEN.TODAY) return { label: 'Today', icon: 'star', color: colors.today };
  if (when === WHEN.EVENING) return { label: 'This Evening', icon: 'moon', color: colors.someday };
  if (when === WHEN.SOMEDAY) return { label: 'Someday', icon: 'archive', color: colors.someday };
  return { label: relativeLabel(when), icon: 'calendar', color: colors.accent };
}

// Full-screen to-do editor. Receives the task id; reads live data from context.
export default function TaskDetailModal({ visible, taskId, onClose, onOpenTask }) {
  const insets = useSafeAreaInsets();
  const isWails = useIsWails();
  const isWide = useIsWide();
  const { state, addTask, updateTask, toggleTask, setStatus, deleteTask, addCheck, toggleCheck, updateCheck, deleteCheck } = useTasks();
  const task = state.tasks.find((t) => t.id === taskId);

  const [sheet, setSheet] = useState(null); // 'when' | 'deadline' | 'move' | 'tags'
  const [newCheck, setNewCheck] = useState('');
  const [newSub, setNewSub] = useState('');
  const [titleH, setTitleH] = useState(0); // auto-grow the title to its content height

  if (!task) return null;

  const subtasks = selectSubtasks(state.tasks, task.id);
  const submitSub = () => {
    const title = newSub.trim();
    if (!title) return;
    addTask(
      newTask({
        parentId: task.id,
        projectId: task.projectId,
        areaId: task.areaId,
        title,
      })
    );
    setNewSub('');
  };

  const project = task.projectId
    ? state.projects.find((p) => p.id === task.projectId)
    : null;
  const area = !project && task.areaId
    ? state.areas.find((a) => a.id === task.areaId)
    : null;
  const containerLabel = project?.name || area?.name || 'Inbox';
  const containerColor = project?.color || area?.color || colors.inbox;

  const when = whenMeta(task.when);
  const done = task.status !== STATUS.OPEN;

  const submitCheck = () => {
    const title = newCheck.trim();
    if (!title) return;
    addCheck(task.id, title);
    setNewCheck('');
  };

  const body = (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        {/* Full-screen (mobile / narrow) Wails windows need a draggable strip to
            clear the native traffic lights. When wide, the detail opens inside
            the content pane, which already sits below the app-level strip. */}
        {!isWide && isWails && <WailsTitleBar />}
        {/* Top bar */}
        <View style={styles.topBar}>
          <Pressable hitSlop={10} onPress={onClose} style={styles.topBtn}>
            <Ionicons name="chevron-back" size={26} color={colors.accent} />
            <Text style={styles.backText} numberOfLines={1}>
              {containerLabel}
            </Text>
          </Pressable>
          <View style={styles.topActions}>
            <Pressable
              hitSlop={10}
              onPress={() =>
                setStatus(
                  task.id,
                  task.status === STATUS.CANCELED ? STATUS.OPEN : STATUS.CANCELED
                )
              }
            >
              <Ionicons
                name="close-circle-outline"
                size={24}
                color={task.status === STATUS.CANCELED ? colors.deadline : colors.textSecondary}
              />
            </Pressable>
            <Pressable hitSlop={10} onPress={() => { deleteTask(task.id); onClose(); }}>
              <Ionicons name="trash-outline" size={22} color={colors.textSecondary} />
            </Pressable>
          </View>
        </View>

        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
         <View style={[styles.bodyRow, isWide && styles.bodyRowWide]}>
          <ScrollView
            style={styles.contentScroll}
            contentContainerStyle={styles.scroll}
            keyboardShouldPersistTaps="handled"
          >
            {/* Title row */}
            <View style={styles.titleRow}>
              <Checkbox
                status={task.status}
                color={project?.color}
                onPress={() => toggleTask(task.id)}
                size={24}
              />
              <TextInput
                style={[styles.title, done && styles.titleDone, { height: Math.max(28, titleH) }]}
                value={task.title}
                placeholder="New To-Do"
                placeholderTextColor={colors.placeholder}
                onChangeText={(text) => updateTask(task.id, { title: text })}
                onContentSizeChange={(e) => setTitleH(e.nativeEvent.contentSize.height)}
                multiline
              />
            </View>

            {/* Notes */}
            <TextInput
              style={styles.notes}
              value={task.notes}
              placeholder="Notes"
              placeholderTextColor={colors.placeholder}
              onChangeText={(text) => updateTask(task.id, { notes: text })}
              multiline
            />

            {/* Fields stack below notes on narrow; on wide they live in the right
                side panel (rendered outside the ScrollView, below). */}
            {!isWide && (
              <FieldsPanel
                task={task}
                when={when}
                containerLabel={containerLabel}
                containerColor={containerColor}
                onEdit={setSheet}
                onUpdate={(patch) => updateTask(task.id, patch)}
                style={styles.panelStacked}
              />
            )}

            {/* Sub-tasks — nested tasks (distinct from the lightweight checklist) */}
            <View style={styles.subtasks}>
              {subtasks.map((s) => {
                const sDone = s.status !== STATUS.OPEN;
                const kids = selectSubtasks(state.tasks, s.id);
                return (
                  <Pressable
                    key={s.id}
                    style={styles.subRow}
                    onPress={() => onOpenTask && onOpenTask(s.id)}
                  >
                    <Checkbox
                      status={s.status}
                      color={project?.color}
                      onPress={() => toggleTask(s.id)}
                      size={20}
                    />
                    <Text style={[styles.subText, sDone && styles.subTextDone]} numberOfLines={1}>
                      {s.title || 'New To-Do'}
                    </Text>
                    {kids.length > 0 && (
                      <View style={styles.subBadge}>
                        <Ionicons name="git-branch-outline" size={12} color={colors.textTertiary} />
                        <Text style={styles.subBadgeText}>
                          {kids.filter((k) => k.status !== STATUS.OPEN).length}/{kids.length}
                        </Text>
                      </View>
                    )}
                    <Ionicons name="chevron-forward" size={16} color={colors.separatorStrong} />
                  </Pressable>
                );
              })}
              <View style={styles.subRow}>
                <Ionicons name="add-circle-outline" size={20} color={colors.textTertiary} />
                <TextInput
                  style={styles.subText}
                  value={newSub}
                  placeholder="Add sub-task"
                  placeholderTextColor={colors.placeholder}
                  onChangeText={setNewSub}
                  onSubmitEditing={submitSub}
                  blurOnSubmit={false}
                  returnKeyType="done"
                />
              </View>
            </View>

            {/* Checklist */}
            {task.checklist.length > 0 && (
              <View style={styles.checklist}>
                {task.checklist.map((c) => (
                  <View key={c.id} style={styles.checkRow}>
                    <Pressable hitSlop={8} onPress={() => toggleCheck(task.id, c.id)}>
                      <Ionicons
                        name={c.done ? 'checkmark-circle' : 'ellipse-outline'}
                        size={20}
                        color={c.done ? colors.accent : colors.separatorStrong}
                      />
                    </Pressable>
                    <TextInput
                      style={[styles.checkText, c.done && styles.checkTextDone]}
                      value={c.title}
                      onChangeText={(text) => updateCheck(task.id, c.id, text)}
                    />
                    <Pressable hitSlop={8} onPress={() => deleteCheck(task.id, c.id)}>
                      <Ionicons name="close" size={16} color={colors.textTertiary} />
                    </Pressable>
                  </View>
                ))}
              </View>
            )}

            <View style={styles.checkRow}>
              <Ionicons name="add-circle-outline" size={20} color={colors.textTertiary} />
              <TextInput
                style={styles.checkText}
                value={newCheck}
                placeholder="Add checklist item"
                placeholderTextColor={colors.placeholder}
                onChangeText={setNewCheck}
                onSubmitEditing={submitCheck}
                blurOnSubmit={false}
                returnKeyType="done"
              />
            </View>

            {/* Tags */}
            {task.tags.length > 0 && (
              <View style={styles.tagsRow}>
                {task.tags.map((tag) => (
                  <View key={tag} style={styles.tagChip}>
                    <Text style={styles.tagText}>{tag}</Text>
                  </View>
                ))}
              </View>
            )}
          </ScrollView>

          {/* Right-side properties panel on wide screens (fixed-width View so
              the content column keeps the rest of the space). */}
          {isWide && (
            <View style={styles.sidePanel}>
              <ScrollView contentContainerStyle={styles.sidePanelScroll}>
                <FieldsPanel
                  task={task}
                  when={when}
                  containerLabel={containerLabel}
                  containerColor={containerColor}
                  onEdit={setSheet}
                  onUpdate={(patch) => updateTask(task.id, patch)}
                />
              </ScrollView>
            </View>
          )}
         </View>
        </KeyboardAvoidingView>

        <WhenSheet
          visible={sheet === 'when'}
          onClose={() => setSheet(null)}
          value={task.when}
          onChange={(when) => updateTask(task.id, { when })}
        />
        <DeadlineSheet
          visible={sheet === 'deadline'}
          onClose={() => setSheet(null)}
          value={task.deadline}
          onChange={(deadline) => updateTask(task.id, { deadline })}
        />
        <MoveSheet
          visible={sheet === 'move'}
          onClose={() => setSheet(null)}
          task={task}
          onMove={(patch) => updateTask(task.id, patch)}
        />
        <TagSheet
          visible={sheet === 'tags'}
          onClose={() => setSheet(null)}
          selected={task.tags}
          onChange={(tags) => updateTask(task.id, { tags })}
        />
        <PrioritySheet
          visible={sheet === 'priority'}
          onClose={() => setSheet(null)}
          value={task.priority}
          onChange={(priority) => updateTask(task.id, { priority })}
        />
        <LocationSheet
          visible={sheet === 'location'}
          onClose={() => setSheet(null)}
          value={task.location}
          onChange={(location) => updateTask(task.id, { location })}
        />
      </View>
  );

  // Wide (iPad / desktop): open the detail inside the content pane only, so the
  // sidebar stays visible. It's an absolute overlay filling the ListScreen
  // container (the detail pane), not a full-screen Modal.
  if (isWide) {
    if (!visible) return null;
    return <View style={styles.paneOverlay}>{body}</View>;
  }

  // Mobile / narrow: full-screen modal.
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      {body}
    </Modal>
  );
}

const isDateStr = (w) => typeof w === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(w);
const fmtTime = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const fmtDur = (m) => (m % 60 === 0 ? `${m / 60}h` : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`);

// The always-visible, first-class attributes for a task. Each row shows the
// current value and opens the matching editor sheet; Start/Duration edit inline.
function FieldsPanel({ task, when, containerLabel, containerColor, onEdit, onUpdate, style }) {
  return (
    <View style={[styles.panel, style]}>
      <Text style={styles.panelHeader}>Details</Text>
      <FieldRow icon="ellipse" iconColor={containerColor} label="List" value={containerLabel} active onPress={() => onEdit('move')} />
      <FieldRow icon={when.icon} iconColor={when.color} label="When" value={when.label} active={!!task.when} onPress={() => onEdit('when')} />
      <TimeField task={task} onUpdate={onUpdate} />
      <FieldRow icon="alarm-outline" iconColor={task.deadline ? colors.deadline : undefined} label="Deadline" value={task.deadline ? relativeLabel(task.deadline) : 'None'} active={!!task.deadline} onPress={() => onEdit('deadline')} />
      <FieldRow icon={task.priority ? 'flag' : 'flag-outline'} iconColor={task.priority ? PRIORITY_MAP[task.priority].color : undefined} label="Priority" value={task.priority ? PRIORITY_MAP[task.priority].label : 'None'} active={!!task.priority} onPress={() => onEdit('priority')} />
      <FieldRow icon="pricetag-outline" label="Labels" value={task.tags.length ? task.tags.join(', ') : 'None'} active={task.tags.length > 0} onPress={() => onEdit('tags')} />
      <FieldRow icon={task.location ? 'location' : 'location-outline'} iconColor={task.location ? colors.accent : undefined} label="Location" value={task.location || 'None'} active={!!task.location} onPress={() => onEdit('location')} />
    </View>
  );
}

function FieldRow({ icon, iconColor, label, value, active, onPress }) {
  return (
    <Pressable style={styles.fieldRow} onPress={onPress}>
      <Ionicons name={icon} size={18} color={iconColor || colors.textSecondary} style={styles.fieldIcon} />
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={[styles.fieldValue, !active && styles.fieldValueMuted]} numberOfLines={1}>{value}</Text>
      <Ionicons name="chevron-forward" size={15} color={colors.separatorStrong} />
    </Pressable>
  );
}

// Start time + duration. A task can only be time-blocked on a concrete date, so
// the controls are inert (with a hint) until a date is set. Start uses the OS
// time picker on web; duration is a 15-minute stepper. Empty start = all-day.
function TimeField({ task, onUpdate }) {
  const scheduled = isDateStr(task.when);
  const start = task.startMinutes;
  const dur = task.durationMinutes || 60;
  const setStart = (mins) =>
    onUpdate(mins == null ? { startMinutes: null } : { startMinutes: mins, durationMinutes: task.durationMinutes || 60 });
  const stepDur = (delta) => onUpdate({ durationMinutes: Math.max(15, Math.min(720, dur + delta)) });

  if (!scheduled) {
    return (
      <View style={styles.fieldRow}>
        <Ionicons name="time-outline" size={18} color={colors.textTertiary} style={styles.fieldIcon} />
        <Text style={styles.fieldLabel}>Start</Text>
        <Text style={[styles.fieldValue, styles.fieldValueMuted]} numberOfLines={1}>Set a date first</Text>
      </View>
    );
  }
  return (
    <>
      <View style={styles.fieldRow}>
        <Ionicons name="time-outline" size={18} color={start != null ? colors.accent : colors.textSecondary} style={styles.fieldIcon} />
        <Text style={styles.fieldLabel}>Start</Text>
        <View style={styles.timeWrap}>
          <TimePicker minutes={start} onChange={setStart} />
          {start != null && (
            <Pressable onPress={() => setStart(null)} hitSlop={8} style={styles.clearBtn}>
              <Ionicons name="close-circle" size={16} color={colors.textTertiary} />
            </Pressable>
          )}
        </View>
      </View>
      {start != null && (
        <View style={styles.fieldRow}>
          <Ionicons name="hourglass-outline" size={18} color={colors.textSecondary} style={styles.fieldIcon} />
          <Text style={styles.fieldLabel}>Duration</Text>
          <View style={styles.stepper}>
            <Pressable onPress={() => stepDur(-15)} style={styles.stepBtn}><Ionicons name="remove" size={16} color={colors.textSecondary} /></Pressable>
            <Text style={styles.stepValue}>{fmtDur(dur)}</Text>
            <Pressable onPress={() => stepDur(15)} style={styles.stepBtn}><Ionicons name="add" size={16} color={colors.textSecondary} /></Pressable>
          </View>
        </View>
      )}
    </>
  );
}

const ITEM_H = 40;
const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
const pad2 = (n) => String(n).padStart(2, '0');

// A theme-matched time picker: a pill showing the time that opens a small card
// with scrollable Hour / Minute columns (no OS chrome).
function TimePicker({ minutes, onChange }) {
  const [open, setOpen] = useState(false);
  const cur = minutes == null ? 9 * 60 : minutes;
  const h = Math.floor(cur / 60);
  const m = cur - h * 60;
  const hourRef = React.useRef(null);
  const minRef = React.useRef(null);
  React.useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      hourRef.current?.scrollTo({ y: Math.max(0, (h - 1) * ITEM_H), animated: false });
      const mi = MINUTES.indexOf(m - (m % 5));
      minRef.current?.scrollTo({ y: Math.max(0, (mi - 1) * ITEM_H), animated: false });
    }, 0);
    return () => clearTimeout(t);
  }, [open]);

  return (
    <>
      <Pressable style={styles.timePill} onPress={() => setOpen(true)}>
        <Ionicons name="time-outline" size={13} color={colors.accent} />
        <Text style={styles.timePillText}>{minutes == null ? 'All day' : fmtTime(minutes)}</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.tpBackdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.tpCard} onPress={(e) => e?.stopPropagation?.()}>
            <View style={styles.tpHeader}>
              <Text style={styles.tpTitle}>Start time</Text>
              <Pressable onPress={() => setOpen(false)} hitSlop={8}><Text style={styles.tpDone}>Done</Text></Pressable>
            </View>
            <View style={styles.tpCols}>
              <ScrollView ref={hourRef} style={styles.tpCol} showsVerticalScrollIndicator={false}>
                {Array.from({ length: 24 }, (_, hh) => (
                  <Pressable key={hh} style={[styles.tpItem, hh === h && styles.tpItemSel]} onPress={() => onChange(hh * 60 + m)}>
                    <Text style={[styles.tpItemText, hh === h && styles.tpItemTextSel]}>{pad2(hh)}</Text>
                  </Pressable>
                ))}
              </ScrollView>
              <Text style={styles.tpColon}>:</Text>
              <ScrollView ref={minRef} style={styles.tpCol} showsVerticalScrollIndicator={false}>
                {MINUTES.map((mm) => (
                  <Pressable key={mm} style={[styles.tpItem, mm === m && styles.tpItemSel]} onPress={() => onChange(h * 60 + mm)}>
                    <Text style={[styles.tpItemText, mm === m && styles.tpItemTextSel]}>{pad2(mm)}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  // Wide layout: fills the content pane (over the list), leaving the sidebar.
  paneOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.background,
    zIndex: 20,
  },
  container: { flex: 1, backgroundColor: colors.background },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  topBtn: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  backText: { ...typography.body, color: colors.accent, flexShrink: 1 },
  topActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, paddingRight: spacing.sm },
  scroll: { padding: spacing.lg, paddingBottom: spacing.xxl },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  title: {
    flex: 1,
    ...typography.title,
    fontSize: 22,
    color: colors.text,
    padding: 0,
  },
  titleDone: { color: colors.textTertiary, textDecorationLine: 'line-through' },
  notes: {
    ...typography.body,
    color: colors.text,
    marginTop: spacing.lg,
    marginLeft: spacing.xl + spacing.md,
    minHeight: 24,
    padding: 0,
  },
  subtasks: { marginTop: spacing.lg, marginLeft: spacing.xl + spacing.md },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 6 },
  subText: { flex: 1, ...typography.body, color: colors.text, padding: 0 },
  subTextDone: { color: colors.textTertiary, textDecorationLine: 'line-through' },
  subBadge: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  subBadgeText: { ...typography.caption, color: colors.textTertiary },
  checklist: { marginTop: spacing.lg, marginLeft: spacing.xl + spacing.md },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 6,
    marginLeft: spacing.xl + spacing.md,
  },
  checkText: { flex: 1, ...typography.body, color: colors.text, padding: 0 },
  checkTextDone: { color: colors.textTertiary, textDecorationLine: 'line-through' },
  tagsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.lg,
    marginLeft: spacing.xl + spacing.md,
  },
  tagChip: {
    backgroundColor: colors.groupedBackground,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  tagText: { ...typography.subhead, color: colors.textSecondary },
  // Hybrid layout: content scrolls on the left; on wide, a properties sidebar
  // sits on the right. On narrow the panel stacks below notes (styles.panelStacked).
  bodyRow: { flex: 1 },
  bodyRowWide: { flexDirection: 'row' },
  contentScroll: { flex: 1, minWidth: 0 },
  sidePanel: {
    width: 300,
    flexShrink: 0,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.separator,
    backgroundColor: colors.groupedBackground,
  },
  sidePanelScroll: { padding: spacing.lg },
  panel: {},
  panelStacked: {
    marginTop: spacing.lg,
    marginLeft: spacing.xl + spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator,
    paddingTop: spacing.sm,
  },
  panelHeader: {
    ...typography.caption, color: colors.textTertiary, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: spacing.xs,
  },
  fieldRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingVertical: 7, minHeight: 34,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  fieldIcon: { width: 20, textAlign: 'center' },
  fieldLabel: { ...typography.subhead, color: colors.textSecondary, width: 76, flexShrink: 0 },
  fieldValue: { flex: 1, ...typography.subhead, color: colors.text, textAlign: 'right' },
  fieldValueMuted: { color: colors.textTertiary },
  clearBtn: { ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null) },
  timeWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: spacing.sm },
  timePill: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separatorStrong,
    borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: 4,
    backgroundColor: colors.background,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  timePillText: { ...typography.subhead, color: colors.text, fontVariant: ['tabular-nums'] },
  tpBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.25)',
    alignItems: 'center', justifyContent: 'center', padding: spacing.lg,
  },
  tpCard: {
    width: 240, backgroundColor: colors.background, borderRadius: radius.lg, overflow: 'hidden',
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 12,
  },
  tpHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator,
  },
  tpTitle: { ...typography.subhead, color: colors.text, fontWeight: '600' },
  tpDone: { ...typography.subhead, color: colors.accent, fontWeight: '600', ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null) },
  tpCols: { flexDirection: 'row', height: ITEM_H * 5, paddingVertical: spacing.xs },
  tpCol: { flex: 1 },
  tpColon: { ...typography.title, color: colors.textTertiary, alignSelf: 'center' },
  tpItem: {
    height: ITEM_H, alignItems: 'center', justifyContent: 'center', marginHorizontal: spacing.sm,
    borderRadius: radius.sm, ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  tpItemSel: { backgroundColor: colors.accentSoft },
  tpItemText: { ...typography.body, color: colors.text, fontVariant: ['tabular-nums'] },
  tpItemTextSel: { color: colors.accent, fontWeight: '700' },
  stepper: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: spacing.sm,
  },
  stepBtn: {
    width: 26, height: 26, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separatorStrong, backgroundColor: colors.background,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  stepValue: { ...typography.subhead, color: colors.text, fontVariant: ['tabular-nums'], minWidth: 48, textAlign: 'center' },
  endHint: { ...typography.caption, color: colors.textTertiary, marginLeft: spacing.sm },
});

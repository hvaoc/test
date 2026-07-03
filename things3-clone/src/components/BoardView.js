import React, { useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, FlatList, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, runOnJS } from 'react-native-reanimated';
import { colors, spacing, typography, radius } from '../theme';
import { PRIORITIES, PRIORITY_MAP, STATUS, WHEN } from '../store/constants';
import { byOrder } from '../store/selectors';
import { todayKey, addDays } from '../utils/date';
import TaskRow from './TaskRow';
import TaskComposer from './TaskComposer';
import SectionEditor from './SectionEditor';

const COL_W = 300;

const GROUPINGS = [
  { key: 'section', label: 'Section' },
  { key: 'priority', label: 'Priority' },
  { key: 'date', label: 'Date' },
  { key: 'deadline', label: 'Deadline' },
  { key: 'label', label: 'Label' },
  { key: 'none', label: 'None' },
];

const whenKey = (t) => {
  if (t.when === WHEN.TODAY || t.when === WHEN.EVENING) return todayKey();
  if (!t.when || t.when === WHEN.SOMEDAY) return null;
  return t.when;
};

// Relative date buckets, shared by the Date (When) and Deadline groupings. A card
// dropped into a bucket adopts a representative date for that bucket.
function dateColumns(kind) {
  const tk = todayKey();
  const get = kind === 'deadline' ? (t) => t.deadline || null : whenKey;
  const field = kind === 'deadline' ? (v) => ({ deadline: v }) : (v) => ({ when: v });
  return [
    { key: 'd-over', title: 'Overdue', match: (t) => { const d = get(t); return d && d < tk; }, field: field(addDays(tk, -1)) },
    { key: 'd-today', title: 'Today', match: (t) => get(t) === tk, field: field(tk) },
    { key: 'd-tom', title: 'Tomorrow', match: (t) => get(t) === addDays(tk, 1), field: field(addDays(tk, 1)) },
    { key: 'd-week', title: 'This Week', match: (t) => { const d = get(t); return d && d > addDays(tk, 1) && d <= addDays(tk, 7); }, field: field(addDays(tk, 3)) },
    { key: 'd-later', title: 'Later', match: (t) => { const d = get(t); return d && d > addDays(tk, 7); }, field: field(addDays(tk, 14)) },
    { key: 'd-none', title: kind === 'deadline' ? 'No Deadline' : 'No Date', match: (t) => !get(t), field: field(null) },
  ];
}
const SORTS = [
  { key: 'manual', label: 'Manual' },
  { key: 'name', label: 'Name' },
  { key: 'priority', label: 'Priority' },
  { key: 'date', label: 'Date' },
];

const prank = (t) => {
  const i = PRIORITIES.findIndex((p) => p.key === t.priority);
  return i < 0 ? PRIORITIES.length : i;
};
const dateVal = (t) => t.deadline || t.when || '9999-99-99';

// Build the columns for a grouping. Each column carries a `field` patch applied
// to a task dropped into it, and a `match` predicate for which tasks belong.
function buildColumns(grouping, tasks, headings) {
  if (grouping === 'priority') {
    const cols = PRIORITIES.map((p) => ({
      key: `p:${p.key}`,
      title: p.label,
      color: p.color,
      field: { priority: p.key },
      match: (t) => t.priority === p.key,
    }));
    cols.push({ key: 'p:none', title: 'No Priority', field: { priority: null }, match: (t) => !t.priority });
    return cols;
  }
  if (grouping === 'label') {
    const tags = [...new Set(tasks.flatMap((t) => t.tags || []))].sort();
    const cols = tags.map((tag) => ({
      key: `l:${tag}`,
      title: tag,
      field: { tags: [tag] },
      match: (t) => (t.tags || []).includes(tag),
    }));
    cols.push({ key: 'l:none', title: 'No Label', field: { tags: [] }, match: (t) => !(t.tags || []).length });
    return cols;
  }
  if (grouping === 'date') return dateColumns('when');
  if (grouping === 'deadline') return dateColumns('deadline');
  if (grouping === 'none') {
    return [{ key: 'all', title: 'All', field: {}, match: () => true }];
  }
  // section (default)
  const cols = [
    { key: 'h:none', title: '(No Section)', headingId: null, field: { headingId: null }, match: (t) => !t.headingId },
  ];
  headings.forEach((h) =>
    cols.push({
      key: `h:${h.id}`,
      title: h.title,
      headingId: h.id,
      field: { headingId: h.id },
      match: (t) => t.headingId === h.id,
    })
  );
  return cols;
}

function sortTasks(list, sort) {
  const arr = [...list];
  if (sort === 'name') arr.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  else if (sort === 'priority') arr.sort((a, b) => prank(a) - prank(b));
  else if (sort === 'date') arr.sort((a, b) => (dateVal(a) < dateVal(b) ? -1 : dateVal(a) > dateVal(b) ? 1 : 0));
  else arr.sort(byOrder);
  return arr;
}

// Kanban board for a project. Grouping (Section / Priority / Label / None) and
// sorting are user-changeable from the Display menu; cards can be dragged
// between columns, which re-assigns the grouped field (section, priority, or
// label) and reorders within the target column.
export default function BoardView({
  tasks,
  headings,
  project,
  onOpenTask,
  onUpdateTask,
  onReorder,
  onAddTask,
  onAddSection,
  onEditSection,
  // Grouping / sorting are driven by the project's Display menu.
  grouping = 'section',
  sorting = 'manual',
}) {
  const sort = sorting;
  const [dragTask, setDragTask] = useState(null);
  const [dropTarget, setDropTarget] = useState(null); // { colKey, index }
  const [scrollX, setScrollX] = useState(0);
  const [viewW, setViewW] = useState(0);
  const [contentW, setContentW] = useState(0);

  const boardScrollRef = useRef(null);
  const rootRef = useRef(null);
  const colRefs = useRef(new Map());
  const cardRefs = useRef(new Map());
  const rectsRef = useRef({ cols: {}, cards: {} });
  const ghostX = useSharedValue(0);
  const ghostY = useSharedValue(0);
  const rootX = useSharedValue(0);
  const rootY = useSharedValue(0);

  const baseCols = buildColumns(grouping, tasks, headings);
  const columns = baseCols.map((c) => ({ ...c, tasks: sortTasks(tasks.filter(c.match), sort) }));
  const lastHeadingId = [...headings].reverse()[0]?.id || null;
  // Changes on every drag move so each column's virtualized list re-renders the
  // live placeholder / dimming (FlatList skips renders unless extraData changes).
  const dragKey = `${dragTask?.id || ''}|${dropTarget?.colKey || ''}|${dropTarget?.index ?? ''}`;

  const measureOnly = () => {
    const cols = {};
    const cards = {};
    const jobs = [];
    const grab = (node, store, key) =>
      new Promise((res) => {
        if (node && node.measureInWindow) node.measureInWindow((x, y, w, h) => { store[key] = { x, y, w, h }; res(); });
        else res();
      });
    if (rootRef.current) jobs.push(grab(rootRef.current, { r: 0 }, 'r').then(() => {}));
    colRefs.current.forEach((node, key) => jobs.push(grab(node, cols, key)));
    cardRefs.current.forEach((node, id) => jobs.push(grab(node, cards, id)));
    // root separately for ghost origin
    const rootJob = new Promise((res) => {
      const n = rootRef.current;
      if (n && n.measureInWindow) n.measureInWindow((x, y) => { rootX.value = x; rootY.value = y; res(); });
      else res();
    });
    Promise.all([...jobs, rootJob]).then(() => {
      rectsRef.current = { cols, cards };
    });
  };
  const beginDrag = (task) => setDragTask(task);
  const cancelDrag = () => {
    setDragTask(null);
    setDropTarget(null);
  };
  // Which column + insertion index (among that column's displayed cards) the
  // pointer is over. Shared by the live placeholder and the drop commit.
  const computeDrop = (ax, ay) => {
    const { cols, cards } = rectsRef.current || {};
    if (!cols) return null;
    let colKey = null;
    for (const key in cols) {
      const r = cols[key];
      if (ax >= r.x && ax <= r.x + r.w) { colKey = key; break; }
    }
    const col = columns.find((c) => c.key === colKey);
    if (!col) return null;
    const ids = col.tasks.map((t) => t.id);
    let index = ids.length;
    for (let i = 0; i < ids.length; i++) {
      const cr = cards[ids[i]];
      if (cr && ay < cr.y + cr.h / 2) { index = i; break; }
    }
    return { colKey, index };
  };
  const updateDrop = (ax, ay) => {
    const dt = computeDrop(ax, ay);
    setDropTarget((prev) => {
      if (dt === prev) return prev;
      if (dt && prev && dt.colKey === prev.colKey && dt.index === prev.index) return prev;
      return dt;
    });
  };
  const endDrag = (taskId, ax, ay) => {
    setDragTask(null);
    setDropTarget(null);
    const dt = computeDrop(ax, ay);
    if (!dt) return;
    const col = columns.find((c) => c.key === dt.colKey);
    const task = tasks.find((t) => t.id === taskId);
    if (!col || !task) return;
    if (!col.match(task)) onUpdateTask(taskId, col.field);
    // Insert at the placeholder index, adjusting for the dragged card's own slot.
    const ids = col.tasks.map((t) => t.id);
    const from = ids.indexOf(taskId);
    let insert = dt.index;
    if (from >= 0 && from < insert) insert -= 1;
    const next = ids.filter((id) => id !== taskId);
    next.splice(insert, 0, taskId);
    if (onReorder) onReorder(next);
  };
  const dragCtx = { ghostX, ghostY, rootX, rootY, measureOnly, beginDrag, cancelDrag, updateDrop, endDrag };
  const ghostStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: ghostX.value }, { translateY: ghostY.value }],
  }));

  return (
    <View ref={rootRef} collapsable={false} style={styles.root}>
      <ScrollView
        ref={boardScrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.boardScroll}
        contentContainerStyle={styles.board}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={16}
        onScroll={(e) => setScrollX(e.nativeEvent.contentOffset.x)}
        onLayout={(e) => setViewW(e.nativeEvent.layout.width)}
        onContentSizeChange={(w) => setContentW(w)}
      >
        {columns.map((col) => {
          const isTarget = dropTarget && dropTarget.colKey === col.key;
          return (
            <View
              key={col.key}
              ref={(n) => (n ? colRefs.current.set(col.key, n) : colRefs.current.delete(col.key))}
              collapsable={false}
              style={[styles.column, isTarget && styles.columnTarget]}
            >
              {/* Fixed header: stays put while the column's tasks scroll below it. */}
              <Pressable
                style={styles.colHeader}
                onPress={() => col.headingId && onEditSection && onEditSection(col.headingId)}
                disabled={!col.headingId}
              >
                {col.color && <View style={[styles.colDot, { backgroundColor: col.color }]} />}
                <Text style={styles.colTitle} numberOfLines={1}>
                  {col.title}
                </Text>
                <Text style={styles.colCount}>{col.tasks.length}</Text>
              </Pressable>

              {/* Virtualized: only the visible cards mount, so switching to a
                  huge project's board stays fast. contentContainer grows to
                  fill the column, so the empty area below a short column's
                  tasks is still a valid drop zone. */}
              <FlatList
                data={col.tasks}
                style={styles.colScroll}
                contentContainerStyle={styles.colScrollContent}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                keyExtractor={(t) => t.id}
                extraData={dragKey}
                initialNumToRender={10}
                maxToRenderPerBatch={10}
                windowSize={3}
                removeClippedSubviews={false}
                renderItem={({ item, index }) => (
                  <>
                    {isTarget && dropTarget.index === index && <View style={styles.placeholder} />}
                    <Card
                      task={item}
                      ctx={dragCtx}
                      onOpen={onOpenTask}
                      cardRefs={cardRefs}
                      dimmed={dragTask?.id === item.id}
                    />
                  </>
                )}
                ListFooterComponent={
                  <>
                    {isTarget && dropTarget.index >= col.tasks.length && <View style={styles.placeholder} />}
                    <AddInColumn col={col} grouping={grouping} onAddTask={onAddTask} />
                  </>
                }
              />
            </View>
          );
        })}

        {grouping === 'section' && <AddColumn afterHeadingId={lastHeadingId} onAddSection={onAddSection} />}
      </ScrollView>

      {/* Edge affordances: more columns exist beyond the visible area. */}
      {scrollX > 4 && (
        <Pressable
          style={[styles.edge, styles.edgeLeft]}
          onPress={() => boardScrollRef.current?.scrollTo({ x: Math.max(0, scrollX - (COL_W + 16) * 2), animated: true })}
        >
          <Ionicons name="chevron-back" size={20} color={colors.textSecondary} />
        </Pressable>
      )}
      {contentW > 0 && scrollX + viewW < contentW - 4 && (
        <Pressable
          style={[styles.edge, styles.edgeRight]}
          onPress={() => boardScrollRef.current?.scrollTo({ x: scrollX + (COL_W + 16) * 2, animated: true })}
        >
          <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
        </Pressable>
      )}

      {dragTask && (
        <Animated.View pointerEvents="none" style={[styles.ghost, ghostStyle]}>
          <TaskRow task={dragTask} inProject onPress={() => {}} />
        </Animated.View>
      )}
    </View>
  );
}

// A board card: opens on tap, drags (long-press + move) to another column.
function Card({ task, ctx, onOpen, cardRefs, dimmed }) {
  const dragged = React.useRef(false);
  const moved = useSharedValue(false);
  const markDragged = () => {
    dragged.current = true;
  };
  const handlePress = () => {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    onOpen(task.id);
  };
  const pan = Gesture.Pan()
    .activateAfterLongPress(150)
    .onStart(() => {
      moved.value = false;
      runOnJS(ctx.measureOnly)();
    })
    .onUpdate((e) => {
      const far = Math.abs(e.translationX) + Math.abs(e.translationY) > 6;
      if (far && !moved.value) {
        moved.value = true;
        runOnJS(markDragged)();
        runOnJS(ctx.beginDrag)(task);
      }
      if (!moved.value) return;
      ctx.ghostX.value = e.absoluteX - ctx.rootX.value - 18;
      ctx.ghostY.value = e.absoluteY - ctx.rootY.value - 16;
      runOnJS(ctx.updateDrop)(e.absoluteX, e.absoluteY);
    })
    .onEnd((e) => {
      if (moved.value) runOnJS(ctx.endDrag)(task.id, e.absoluteX, e.absoluteY);
      else runOnJS(ctx.cancelDrag)();
    });
  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[styles.card, dimmed && styles.cardDimmed]}>
        <View
          ref={(n) => (n ? cardRefs.current.set(task.id, n) : cardRefs.current.delete(task.id))}
          collapsable={false}
          style={styles.cardPress}
        >
          <Pressable onPress={handlePress}>
            <TaskRow task={task} inProject onPress={handlePress} />
          </Pressable>
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

function AddInColumn({ col, grouping, onAddTask }) {
  const [adding, setAdding] = useState(false);
  // Sections add into that heading; other groupings add a plain task pre-set to
  // the column's field (its priority / date / deadline / label).
  const addField = grouping === 'section' ? col.headingId : null;
  const extra = grouping === 'section' ? {} : col.field;
  return adding ? (
    <TaskComposer
      submitLabel="Add task"
      persistAfterAdd
      onAdd={(p) => onAddTask(addField, { ...p, ...extra })}
      onCancel={() => setAdding(false)}
    />
  ) : (
    <Pressable style={styles.addBtn} onPress={() => setAdding(true)}>
      <Ionicons name="add" size={18} color={colors.textTertiary} />
      <Text style={styles.addText}>Add task</Text>
    </Pressable>
  );
}

function AddColumn({ afterHeadingId, onAddSection }) {
  const [adding, setAdding] = useState(false);
  return (
    <View style={styles.column}>
      {adding ? (
        <SectionEditor
          onSave={({ title, description }) => {
            onAddSection(afterHeadingId, { title, description });
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <Pressable style={styles.addSection} onPress={() => setAdding(true)}>
          <Ionicons name="add" size={18} color={colors.textTertiary} />
          <Text style={styles.addText}>Add section</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  displayBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separatorStrong,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  displayText: { ...typography.subhead, color: colors.textSecondary, fontWeight: '600' },
  groupHint: { ...typography.caption, color: colors.textTertiary },
  scrim: { ...StyleSheet.absoluteFillObject, zIndex: 40 },
  popover: {
    position: 'absolute',
    top: 40,
    left: spacing.lg,
    zIndex: 50,
    width: 300,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separatorStrong,
    gap: spacing.xs,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  popLabel: { ...typography.caption, color: colors.textTertiary, fontWeight: '700', textTransform: 'uppercase', marginTop: spacing.xs },
  segRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.xs },
  seg: {
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: radius.sm,
    backgroundColor: colors.groupedBackground,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  segActive: { backgroundColor: colors.accent },
  segText: { ...typography.subhead, color: colors.textSecondary },
  segTextActive: { color: colors.white, fontWeight: '600' },
  boardScroll: { flex: 1 },
  board: { paddingHorizontal: spacing.lg, alignItems: 'stretch' },
  column: { width: COL_W, marginRight: spacing.lg, borderRadius: radius.md },
  columnTarget: { backgroundColor: colors.accentSoft },
  colScroll: { flex: 1 },
  colScrollContent: { flexGrow: 1, paddingBottom: spacing.lg },
  edge: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 34,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.86)',
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  edgeLeft: { left: 0, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.separator },
  edgeRight: { right: 0, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.separator },
  colHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
    backgroundColor: colors.background,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  colDot: { width: 9, height: 9, borderRadius: 5 },
  colTitle: { ...typography.heading, color: colors.text, flexShrink: 1 },
  colCount: { ...typography.subhead, color: colors.textTertiary, fontVariant: ['tabular-nums'] },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separatorStrong,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    marginBottom: spacing.sm,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  cardDimmed: { opacity: 0.35 },
  placeholder: {
    height: 44,
    marginBottom: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
  },
  cardPress: { ...(Platform.OS === 'web' ? { cursor: 'grab' } : null) },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  addSection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
    borderColor: colors.separatorStrong,
    borderRadius: radius.md,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  addText: { ...typography.subhead, color: colors.textTertiary },
  ghost: {
    position: 'absolute',
    top: 0,
    left: 0,
    zIndex: 1000,
    width: COL_W,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separatorStrong,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
    opacity: 0.97,
  },
});

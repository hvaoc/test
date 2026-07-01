import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, Platform } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useIsWide } from '../navigation/responsive';
import ProgressPie from './ProgressPie';

// Reveal drag handles on hover (mouse); always show on touch surfaces.
const HOVERABLE = Platform.OS === 'web';
// Width of the drag-handle gutter (paddingLeft + 20px icon + paddingRight).
const HANDLE_W = spacing.sm + 20 + spacing.xs;
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useAnimatedReaction,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import TaskRow from './TaskRow';
import SectionEditor from './SectionEditor';
import { colors, spacing, typography, radius } from '../theme';

// Used only until a row reports its real height via onLayout.
const FALLBACK_H = 48;
// A short, non-bouncy ease — subtle settle, no spring overshoot.
const EASE = { duration: 140 };

// --- worklet layout helpers (variable row heights) -------------------------

function orderedKeys(positions) {
  'worklet';
  const arr = [];
  for (const k in positions) arr[positions[k]] = k;
  return arr;
}

function topForIndex(keys, heights, index) {
  'worklet';
  let t = 0;
  for (let i = 0; i < index; i++) t += heights[keys[i]] ?? FALLBACK_H;
  return t;
}

function totalHeight(keys, heights) {
  'worklet';
  let t = 0;
  for (let i = 0; i < keys.length; i++) t += heights[keys[i]] ?? FALLBACK_H;
  return t;
}

// Move a single index `from` -> `to`.
function reposition(positions, from, to) {
  'worklet';
  const next = { ...positions };
  for (const key in next) {
    const i = next[key];
    if (i === from) next[key] = to;
    else if (from < to && i > from && i <= to) next[key] = i - 1;
    else if (from > to && i >= to && i < from) next[key] = i + 1;
  }
  return next;
}

// Move a contiguous block of keys (kept in their order) to insert at `at`
// among the remaining rows.
function repositionBlock(positions, blockKeys, at) {
  'worklet';
  const arr = orderedKeys(positions);
  const inBlock = {};
  for (let i = 0; i < blockKeys.length; i++) inBlock[blockKeys[i]] = true;
  const rest = arr.filter((k) => !inBlock[k]);
  const clamped = Math.max(0, Math.min(rest.length, at));
  const result = [...rest.slice(0, clamped), ...blockKeys, ...rest.slice(clamped)];
  const next = {};
  for (let i = 0; i < result.length; i++) next[result[i]] = i;
  return next;
}

// Shared per-row logic: where does this row sit right now?
function useRowTop(itemKey, ctx) {
  const { positions, heights, activeId, activeBlockSet, blockTranslate, blockStartTops, dragging } = ctx;
  const top = useSharedValue(0);
  useAnimatedReaction(
    () => ({
      pos: positions.value[itemKey],
      h: heights.value,
      inBlock: !!activeBlockSet.value[itemKey],
      bt: blockTranslate.value,
      act: activeId.value,
      drag: dragging.value,
    }),
    (cur) => {
      if (cur.inBlock) {
        // Part of a heading-block being dragged — follow the block.
        top.value = (blockStartTops.value[itemKey] ?? 0) + cur.bt;
      } else if (itemKey === cur.act) {
        // Own single-item drag handles top directly in onUpdate.
      } else {
        const target = topForIndex(orderedKeys(positions.value), cur.h, cur.pos);
        // Animate the reflow only during a drag; otherwise (collapse/expand,
        // add/remove) snap straight to position.
        top.value = cur.drag ? withTiming(target, EASE) : target;
      }
    }
  );
  return top;
}

function measure(heights, itemKey) {
  return (e) => {
    const h = e.nativeEvent.layout.height;
    if (heights.value[itemKey] !== h) heights.value = { ...heights.value, [itemKey]: h };
  };
}

// With a handle, the drag starts on a small move; without one (phone), the whole
// row lifts on a long-press so taps and scrolling still work.
function makePan(showHandle) {
  if (showHandle) return Gesture.Pan().activeOffsetY([-6, 6]);
  return Platform.OS === 'web'
    ? Gesture.Pan().activeOffsetY([-8, 8]).failOffsetX([-12, 12])
    : Gesture.Pan().activateAfterLongPress(180);
}

// The explicit drag grip shown on non-mobile surfaces (hover-revealed on web).
function Handle({ gesture, style, visible }) {
  return (
    <GestureDetector gesture={gesture}>
      <View style={[styles.handle, style, { opacity: visible ? 1 : 0 }]}>
        <MaterialCommunityIcons name="drag-vertical" size={20} color={colors.separatorStrong} />
      </View>
    </GestureDetector>
  );
}

// Inline compose card: type a title (+ optional description) and Add task.
// Stays open after adding so several can be entered in a row.
function TaskComposer({ onAdd, onCancel }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const ref = React.useRef(null);
  const add = () => {
    const t = title.trim();
    if (!t) return;
    onAdd({ title: t, description: description.trim() });
    setTitle('');
    setDescription('');
    if (ref.current) ref.current.focus();
  };
  return (
    <View style={styles.composer}>
      <TextInput
        ref={ref}
        style={styles.composerTitle}
        value={title}
        onChangeText={setTitle}
        placeholder="Task name"
        placeholderTextColor={colors.placeholder}
        autoFocus
        blurOnSubmit={false}
        returnKeyType="done"
        onSubmitEditing={add}
      />
      <TextInput
        style={styles.composerDesc}
        value={description}
        onChangeText={setDescription}
        placeholder="Description"
        placeholderTextColor={colors.placeholder}
        multiline
      />
      <View style={styles.composerActions}>
        <Pressable style={styles.composerCancel} onPress={onCancel}>
          <Text style={styles.composerCancelText}>Cancel</Text>
        </Pressable>
        <Pressable
          style={[styles.composerAdd, !title.trim() && styles.composerAddDisabled]}
          onPress={add}
          disabled={!title.trim()}
        >
          <Text style={styles.composerAddText}>Add task</Text>
        </Pressable>
      </View>
    </View>
  );
}

// A "+ Add task" row at the end of a section — expands into the compose card.
// Rides the layout like the other rows (so it stays put during reflow).
function AddTaskRow({ itemKey, headingId, onAddTask, ctx }) {
  const { heights } = ctx;
  const top = useRowTop(itemKey, ctx);
  const [adding, setAdding] = useState(false);
  const style = useAnimatedStyle(() => ({ position: 'absolute', left: 0, right: 0, top: top.value }));

  if (adding) {
    return (
      <Animated.View style={style}>
        <View onLayout={measure(heights, itemKey)}>
          <TaskComposer
            onAdd={(t) => onAddTask && onAddTask(headingId, t)}
            onCancel={() => setAdding(false)}
          />
        </View>
      </Animated.View>
    );
  }

  return (
    <Animated.View style={style}>
      <Pressable
        style={styles.addTask}
        onLayout={measure(heights, itemKey)}
        onPress={() => setAdding(true)}
      >
        {ctx.showHandle && <View style={styles.addTaskGutter} />}
        <View style={styles.addTaskInner}>
          <View style={styles.addTaskIconCol}>
            <Ionicons name="add" size={20} color={colors.accent} />
          </View>
          <Text style={styles.addTaskText}>Add task</Text>
        </View>
      </Pressable>
    </Animated.View>
  );
}

// A static "Add section" trigger sitting between sections: a faint divider that
// lights up and reveals its label on hover; tap to insert a heading here.
function AddSectionRow({ itemKey, afterHeadingId, onAddSection, ctx }) {
  const { heights } = ctx;
  const top = useRowTop(itemKey, ctx);
  const [hovered, setHovered] = useState(false);
  const style = useAnimatedStyle(() => ({ position: 'absolute', left: 0, right: 0, top: top.value }));
  return (
    <Animated.View style={style}>
      <Pressable
        style={styles.addSection}
        onLayout={measure(heights, itemKey)}
        onPress={() => onAddSection && onAddSection(afterHeadingId)}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
      >
        <View style={[styles.addSectionLine, hovered && styles.addSectionLineActive]} />
        <Text style={[styles.addSectionText, !hovered && styles.addSectionTextHidden]}>
          Add section
        </Text>
        <View style={[styles.addSectionLine, hovered && styles.addSectionLineActive]} />
      </Pressable>
    </Animated.View>
  );
}

// --- heading (draggable as a block with its child tasks) -------------------

function HeadingRow({
  itemKey,
  title,
  description,
  headingId,
  collapsed,
  done,
  total,
  color,
  onDelete,
  onUpdate,
  onToggleCollapse,
  onEditSection,
  onCommit,
  ctx,
}) {
  const { positions, heights, kinds, activeBlockKeys, activeBlockSet, blockTranslate, blockStartTops, dragging } = ctx;
  const top = useRowTop(itemKey, ctx);
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  const handleVisible = ctx.showHandle && (!HOVERABLE || hovered);

  // Tap the title to edit: inline on wide surfaces, a full page on mobile.
  const startEdit = () => {
    if (ctx.showHandle) setEditing(true);
    else onEditSection && onEditSection(headingId);
  };

  const pan = makePan(ctx.showHandle)
    .onStart(() => {
      const keys = orderedKeys(positions.value);
      const startIdx = positions.value[itemKey];
      // Block = this heading + the consecutive task rows until the next heading.
      const blockKeys = [itemKey];
      for (let i = startIdx + 1; i < keys.length; i++) {
        if (kinds.value[keys[i]] === 'heading') break;
        blockKeys.push(keys[i]);
      }
      const set = {};
      const starts = {};
      for (let i = 0; i < blockKeys.length; i++) {
        const k = blockKeys[i];
        set[k] = true;
        starts[k] = topForIndex(keys, heights.value, positions.value[k]);
      }
      activeBlockKeys.value = blockKeys;
      activeBlockSet.value = set;
      blockStartTops.value = starts;
      blockTranslate.value = 0;
      dragging.value = true;
    })
    .onUpdate((e) => {
      blockTranslate.value = e.translationY;
      const keys = orderedKeys(positions.value);
      const blockTop = (blockStartTops.value[itemKey] ?? 0) + e.translationY;
      // A heading block may only land at a *section boundary* — the start of
      // another heading, or the very end — never inside another section. Snap
      // to whichever boundary is closest to the dragged block's top.
      let acc = 0;
      let restIndex = 0;
      let bestIndex = 0;
      let bestDist = -1;
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (activeBlockSet.value[k]) continue;
        if (kinds.value[k] === 'heading') {
          const d = Math.abs(acc - blockTop);
          if (bestDist < 0 || d < bestDist) {
            bestDist = d;
            bestIndex = restIndex;
          }
        }
        acc += heights.value[k] ?? FALLBACK_H;
        restIndex += 1;
      }
      const dEnd = Math.abs(acc - blockTop);
      if (bestDist < 0 || dEnd < bestDist) bestIndex = restIndex;
      positions.value = repositionBlock(positions.value, activeBlockKeys.value, bestIndex);
    })
    .onFinalize(() => {
      // Clearing the block set lets every row reflow to its final slot.
      activeBlockSet.value = {};
      activeBlockKeys.value = [];
      blockTranslate.value = 0;
      dragging.value = false;
      runOnJS(onCommit)();
    });

  const style = useAnimatedStyle(() => ({
    position: 'absolute',
    left: 0,
    right: 0,
    top: top.value,
    zIndex: activeBlockSet.value[itemKey] ? 10 : 0,
  }));

  // Inline edit form (wide) replaces the heading row while editing.
  if (editing) {
    return (
      <Animated.View style={style}>
        <View style={styles.headingEdit} onLayout={measure(heights, itemKey)}>
          <SectionEditor
            title={title}
            description={description}
            onSave={(patch) => {
              onUpdate && onUpdate(headingId, patch);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        </View>
      </Animated.View>
    );
  }

  const inner = (
    <>
      {onToggleCollapse && (
        <Pressable
          hitSlop={8}
          onPress={() => onToggleCollapse(headingId)}
          style={styles.headingChevron}
        >
          <Ionicons
            name={collapsed ? 'chevron-forward' : 'chevron-down'}
            size={16}
            color={colors.textSecondary}
          />
        </Pressable>
      )}
      <Pressable style={styles.headingTitleWrap} onPress={startEdit}>
        <Text style={styles.headingTitle} numberOfLines={1}>
          {title || 'Section'}
        </Text>
        {!!description && (
          <Text style={styles.headingDesc} numberOfLines={2}>
            {description}
          </Text>
        )}
      </Pressable>
      {total > 0 && (
        <View style={styles.headingProgress}>
          <Text style={styles.headingCount}>
            {done}/{total}
          </Text>
          <ProgressPie progress={total ? done / total : 0} color={color || colors.accent} size={14} />
        </View>
      )}
      {onDelete && (
        <Pressable hitSlop={12} onPress={() => onDelete(headingId)} style={styles.headingDelete}>
          <Ionicons name="close" size={15} color={colors.separatorStrong} />
        </Pressable>
      )}
    </>
  );

  const hoverProps = HOVERABLE
    ? { onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) }
    : null;

  return ctx.showHandle ? (
    <Animated.View style={style}>
      <View
        style={[styles.headingRow, styles.headingRowHandled]}
        onLayout={measure(heights, itemKey)}
        {...hoverProps}
      >
        <Handle gesture={pan} style={styles.headingHandle} visible={handleVisible} />
        {inner}
      </View>
    </Animated.View>
  ) : (
    <GestureDetector gesture={pan}>
      <Animated.View style={style}>
        <View style={styles.headingRow} onLayout={measure(heights, itemKey)}>{inner}</View>
      </Animated.View>
    </GestureDetector>
  );
}

// --- task (draggable individually) -----------------------------------------

function DraggableRow({ itemKey, task, showProject, onOpenTask, onCommit, ctx }) {
  const { positions, heights, activeId, activeBlockSet, blockTranslate, blockStartTops, dragging } = ctx;
  const top = useRowTop(itemKey, ctx);
  const startTop = useSharedValue(0);
  const [hovered, setHovered] = useState(false);
  const handleVisible = ctx.showHandle && (!HOVERABLE || hovered);

  // A real drag also produces a trailing press/click on web — swallow that one.
  const draggedRef = React.useRef(false);
  const flagDragged = () => {
    draggedRef.current = true;
  };
  const clearDraggedSoon = () => {
    setTimeout(() => {
      draggedRef.current = false;
    }, 80);
  };
  const handlePress = () => {
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    onOpenTask(task.id);
  };

  const pan = makePan(ctx.showHandle)
    .onStart(() => {
      activeId.value = itemKey;
      dragging.value = true;
      startTop.value = topForIndex(orderedKeys(positions.value), heights.value, positions.value[itemKey]);
      runOnJS(flagDragged)();
    })
    .onUpdate((e) => {
      top.value = startTop.value + e.translationY;
      const keys = orderedKeys(positions.value);
      const myH = heights.value[itemKey] ?? FALLBACK_H;
      const center = top.value + myH / 2;
      let acc = 0;
      let newIndex = 0;
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (k === itemKey) continue;
        const h = heights.value[k] ?? FALLBACK_H;
        if (center > acc + h / 2) newIndex += 1;
        acc += h;
      }
      if (newIndex !== positions.value[itemKey]) {
        positions.value = reposition(positions.value, positions.value[itemKey], newIndex);
      }
    })
    .onEnd(() => {
      top.value = withTiming(
        topForIndex(orderedKeys(positions.value), heights.value, positions.value[itemKey]),
        EASE
      );
    })
    .onFinalize(() => {
      if (activeId.value === itemKey) {
        activeId.value = null;
        runOnJS(onCommit)();
      }
      dragging.value = false;
      runOnJS(clearDraggedSoon)();
    });

  const style = useAnimatedStyle(() => ({
    position: 'absolute',
    left: 0,
    right: 0,
    top: top.value,
    zIndex: activeId.value === itemKey || activeBlockSet.value[itemKey] ? 10 : 0,
    transform: [{ scale: withTiming(activeId.value === itemKey ? 1.02 : 1, EASE) }],
  }));

  const hoverProps = HOVERABLE
    ? { onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) }
    : null;

  return ctx.showHandle ? (
    <Animated.View style={style}>
      <View style={styles.rowHandled} onLayout={measure(heights, itemKey)} {...hoverProps}>
        <Handle gesture={pan} style={styles.taskHandle} visible={handleVisible} />
        <View style={styles.rowBody}>
          <TaskRow task={task} showProject={showProject} onPress={handlePress} />
        </View>
      </View>
    </Animated.View>
  ) : (
    <GestureDetector gesture={pan}>
      <Animated.View style={style}>
        <View style={styles.row} onLayout={measure(heights, itemKey)}>
          <TaskRow task={task} showProject={showProject} onPress={handlePress} />
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

// Drag-to-reorder over a flat `items` array (tasks + heading dividers).
// Tasks drag individually (and can cross headings); a heading drags its whole
// block (heading + child tasks). `onCommitKeys` gets the new ordered key array.
export default function ReorderableTaskList({
  items,
  showProject,
  onOpenTask,
  onCommitKeys,
  onDeleteHeading,
  onUpdateHeading,
  onToggleCollapse,
  onAddTask,
  onAddSection,
  onEditSection,
}) {
  // Non-mobile (iPad / web / desktop): drag from an explicit handle.
  const showHandle = useIsWide();
  const ctx = {
    positions: useSharedValue(Object.fromEntries(items.map((it, i) => [it.key, i]))),
    heights: useSharedValue({}),
    kinds: useSharedValue(Object.fromEntries(items.map((it) => [it.key, it.kind]))),
    activeId: useSharedValue(null),
    activeBlockKeys: useSharedValue([]),
    activeBlockSet: useSharedValue({}),
    blockTranslate: useSharedValue(0),
    blockStartTops: useSharedValue({}),
    // True only while a drag is in progress — reflow animates during a drag,
    // but collapse/expand/add/remove snap into place with no animation.
    dragging: useSharedValue(false),
    showHandle,
  };
  const { positions, heights, kinds } = ctx;
  const keysKey = items.map((it) => it.key).join(',');

  useEffect(() => {
    positions.value = Object.fromEntries(items.map((it, i) => [it.key, i]));
    kinds.value = Object.fromEntries(items.map((it) => [it.key, it.kind]));
  }, [keysKey]);

  const commit = () => {
    const map = positions.value;
    const arr = new Array(items.length);
    for (const key in map) arr[map[key]] = key;
    onCommitKeys(arr.filter(Boolean));
  };

  const containerStyle = useAnimatedStyle(() => ({
    height: totalHeight(orderedKeys(positions.value), heights.value),
  }));

  return (
    <Animated.View style={containerStyle}>
      {items.map((item) =>
        item.kind === 'addtask' ? (
          <AddTaskRow
            key={item.key}
            itemKey={item.key}
            headingId={item.headingId}
            onAddTask={onAddTask}
            ctx={ctx}
          />
        ) : item.kind === 'addsection' ? (
          <AddSectionRow
            key={item.key}
            itemKey={item.key}
            afterHeadingId={item.afterHeadingId}
            onAddSection={onAddSection}
            ctx={ctx}
          />
        ) : item.kind === 'heading' ? (
          <HeadingRow
            key={item.key}
            itemKey={item.key}
            title={item.title}
            description={item.description}
            headingId={item.headingId}
            collapsed={item.collapsed}
            done={item.done}
            total={item.total}
            color={item.color}
            onDelete={onDeleteHeading}
            onUpdate={onUpdateHeading}
            onToggleCollapse={onToggleCollapse}
            onEditSection={onEditSection}
            onCommit={commit}
            ctx={ctx}
          />
        ) : (
          <DraggableRow
            key={item.key}
            itemKey={item.key}
            task={item.task}
            showProject={showProject}
            onOpenTask={onOpenTask}
            onCommit={commit}
            ctx={ctx}
          />
        )
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: {
    backgroundColor: colors.background,
    userSelect: 'none',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  rowHandled: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: colors.background,
    userSelect: 'none',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  addTask: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  // Empty gutter matching the handle column so the "+" lines up with checkboxes.
  addTaskGutter: { width: HANDLE_W },
  addTaskInner: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: spacing.lg,
    gap: spacing.md,
  },
  addTaskIconCol: { width: 22, alignItems: 'center' },
  addTaskText: { ...typography.body, color: colors.textTertiary },
  composer: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.xs,
    borderWidth: 1,
    borderColor: colors.separatorStrong,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.xs,
    backgroundColor: colors.background,
  },
  composerTitle: { ...typography.body, fontWeight: '600', color: colors.text, padding: 0 },
  composerDesc: {
    ...typography.subhead,
    color: colors.textSecondary,
    padding: 0,
    minHeight: 34,
    textAlignVertical: 'top',
  },
  composerActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator,
    paddingTop: spacing.sm,
  },
  composerCancel: {
    backgroundColor: colors.groupedBackground,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  composerCancelText: { ...typography.subhead, color: colors.textSecondary, fontWeight: '600' },
  composerAdd: {
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  composerAddDisabled: { opacity: 0.5 },
  composerAddText: { ...typography.subhead, color: colors.white, fontWeight: '600' },
  addSection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  addSectionLine: { flex: 1, height: 1, backgroundColor: 'transparent' },
  addSectionLineActive: { backgroundColor: colors.accent },
  addSectionText: { ...typography.subhead, color: colors.accent, fontWeight: '600' },
  addSectionTextHidden: { opacity: 0 },
  rowBody: { flex: 1 },
  handle: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingLeft: spacing.sm,
    paddingRight: spacing.xs,
    ...(Platform.OS === 'web' ? { cursor: 'grab' } : null),
  },
  // Align the grip with the checkbox (which sits ~11px below the row top).
  taskHandle: { paddingTop: 11 },
  headingHandle: { paddingBottom: 1 },
  headingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
    backgroundColor: colors.background,
    userSelect: 'none',
  },
  // With a handle, drop the left padding so the grip aligns with the task grips.
  headingRowHandled: { paddingLeft: 0 },
  headingChevron: { paddingRight: spacing.sm },
  headingTitleWrap: {
    flex: 1,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  headingTitle: { ...typography.heading, color: colors.text },
  headingDesc: { ...typography.caption, color: colors.textTertiary, marginTop: 1 },
  headingEdit: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    backgroundColor: colors.background,
  },
  headingProgress: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  headingCount: {
    ...typography.subhead,
    color: colors.textTertiary,
    fontVariant: ['tabular-nums'],
  },
  headingDelete: { paddingLeft: spacing.md },
});

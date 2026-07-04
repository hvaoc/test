import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, Platform } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useIsWide } from '../navigation/responsive';
import ProgressPie from './ProgressPie';

// Reveal drag handles on hover (mouse); always show on touch surfaces.
const HOVERABLE = Platform.OS === 'web';
// Width of the drag-handle gutter (paddingLeft + 20px icon + paddingRight).
// Exported so the sticky-header bar can reserve the same gutter and stay aligned
// with the real heading rows on wide (handled) layouts.
export const HANDLE_W = spacing.sm + 20 + spacing.xs;
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useAnimatedReaction,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import TaskRow from './TaskRow';
import SectionEditor from './SectionEditor';
import TaskComposer from './TaskComposer';
import WhenSheet from './WhenSheet';
import PrioritySheet from './PrioritySheet';
import { useTasks } from '../store/TasksContext';
import { useDrag, SIDEBAR_ZONE_KEY } from '../store/DragContext';
import { PRIORITY_MAP } from '../store/constants';
import { chevronRotate } from '../utils/sections';
import { colors, spacing, typography, radius } from '../theme';

// Used only until a row reports its real height via onLayout.
const FALLBACK_H = 48;
// A short, non-bouncy ease — subtle settle, no spring overshoot.
const EASE = { duration: 140 };
// Max preview shift when dragging a row right to nest it under the row above.
const NEST_SHIFT = 26;

// While a drag is in progress on web, suppress native text selection so the
// pointer sweeping across rows (and the sidebar) doesn't select text.
function beginBodyDrag() {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;
  document.body.style.userSelect = 'none';
  document.body.style.webkitUserSelect = 'none';
  document.body.style.cursor = 'grabbing';
  const sel = window.getSelection && window.getSelection();
  if (sel) sel.removeAllRanges();
}
function endBodyDrag() {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;
  document.body.style.userSelect = '';
  document.body.style.webkitUserSelect = '';
  document.body.style.cursor = '';
}

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
          {ctx.inProject && <View style={styles.moreDisclosure} />}
          <View style={styles.addTaskIconCol}>
            <Ionicons name="add" size={20} color={colors.accent} />
          </View>
          <Text style={styles.addTaskText}>Add task</Text>
        </View>
      </Pressable>
    </Animated.View>
  );
}

// The three-state "show N more" / "show less" row at the tail of a section that
// has more than the minimal 10 items. Rides the layout like the other rows.
function MoreRow({ itemKey, sectionKey, action, hidden, color, onToggleMore, ctx }) {
  const { heights, showHandle, inProject } = ctx;
  const top = useRowTop(itemKey, ctx);
  const style = useAnimatedStyle(() => ({ position: 'absolute', left: 0, right: 0, top: top.value }));
  const tint = color || colors.accent;
  return (
    <Animated.View style={style}>
      <Pressable
        style={styles.moreRow}
        onLayout={measure(heights, itemKey)}
        onPress={() => onToggleMore && onToggleMore(sectionKey, action)}
      >
        {showHandle && <View style={styles.rowGutter} />}
        {/* Mirror a task row's leading columns so the label lands in the title
            column: an (empty) disclosure gutter in project views, then the
            checkbox-width column holding the chevron. */}
        <View style={styles.moreInner}>
          {inProject && <View style={styles.moreDisclosure} />}
          <View style={styles.moreCheckCol}>
            <Ionicons name={action === 'more' ? 'chevron-down' : 'chevron-up'} size={15} color={tint} />
          </View>
          <Text style={[styles.moreText, { color: tint }]}>
            {action === 'more' ? `Show ${hidden} more` : 'Show less'}
          </Text>
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
  const [composing, setComposing] = useState(false);
  const style = useAnimatedStyle(() => ({ position: 'absolute', left: 0, right: 0, top: top.value }));

  // Composing replaces this slot's trigger with the section compose form.
  if (composing) {
    return (
      <Animated.View style={style}>
        <View style={styles.headingEdit} onLayout={measure(heights, itemKey)}>
          <SectionEditor
            title=""
            description=""
            onSave={(patch) => {
              onAddSection && onAddSection(afterHeadingId, patch);
              setComposing(false);
              setHovered(false);
            }}
            onCancel={() => {
              setComposing(false);
              setHovered(false);
            }}
          />
        </View>
      </Animated.View>
    );
  }

  return (
    <Animated.View style={style}>
      <Pressable
        style={styles.addSection}
        onLayout={measure(heights, itemKey)}
        onPress={() => setComposing(true)}
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

// A fixed, non-draggable group header (e.g. "This Evening" in Today, or a date
// bucket in the date views). Tasks can be dragged across it; on commit the
// caller decides each task's group from which side of the divider it landed on.
// The icon sits in the checkbox column and the title aligns with task titles.
// When `collapsible`, the checkbox column shows a disclosure chevron and tapping
// the header toggles the group (the caller then drops/adds its task rows).
function DividerRow({
  itemKey,
  title,
  subtitle,
  icon,
  collapsible,
  collapsed,
  chevron,
  dividerKey,
  onToggleCollapse,
  total,
  done,
  color,
  ctx,
}) {
  const { heights, showHandle } = ctx;
  const top = useRowTop(itemKey, ctx);
  const style = useAnimatedStyle(() => ({ position: 'absolute', left: 0, right: 0, top: top.value }));
  const progress =
    total > 0 ? (
      <View style={styles.dividerProgress}>
        <Text style={styles.headingCount}>
          {done}/{total}
        </Text>
        <ProgressPie progress={total ? done / total : 0} color={color || colors.accent} size={14} />
      </View>
    ) : null;
  const header = collapsible ? (
    // Collapsible date header: the chevron sits in the grip column and the title
    // aligns with task titles — matching the project heading rows exactly.
    <View style={[styles.dividerRow, !showHandle && styles.dividerRowInset]}>
      {showHandle && <View style={styles.rowGutter} />}
      <View style={styles.headingChevron}>
        <Ionicons
          name="chevron-forward"
          size={16}
          color={colors.textSecondary}
          style={{ transform: [{ rotate: chevronRotate(chevron ?? (collapsed ? 'collapsed' : 'full')) }] }}
        />
      </View>
      {icon && <Ionicons name={icon} size={15} color={colors.textTertiary} style={styles.dividerLeadIcon} />}
      <View style={styles.dividerTitleWrap}>
        <Text style={styles.dividerTitle}>{title}</Text>
        {subtitle ? <Text style={styles.dividerSubtitle}>{subtitle}</Text> : null}
      </View>
      {progress}
    </View>
  ) : (
    // Fixed sub-header (e.g. "This Evening"): the icon sits in the checkbox column.
    <View style={styles.dividerRow}>
      {showHandle && <View style={styles.rowGutter} />}
      <View style={styles.dividerInner}>
        <View style={styles.rowCheckCol}>
          {icon && <Ionicons name={icon} size={15} color={colors.textTertiary} />}
        </View>
        <Text style={styles.dividerTitle}>{title}</Text>
        {subtitle ? <Text style={styles.dividerSubtitle}>{subtitle}</Text> : null}
        {progress}
      </View>
    </View>
  );
  return (
    <Animated.View style={style}>
      {/* The measured wrapper includes a spacer below the border line, so the
          first task in the group sits clear of the divider. A bare margin here
          wouldn't count toward the row height and the task would overlap it. */}
      <View onLayout={measure(heights, itemKey)}>
        {collapsible ? (
          <Pressable onPress={() => onToggleCollapse && onToggleCollapse(dividerKey)}>
            {header}
          </Pressable>
        ) : (
          header
        )}
        <View style={styles.dividerSpacer} />
      </View>
    </Animated.View>
  );
}

// A placeholder that reserves droppable space for an empty group (e.g. an empty
// "This Evening"). Shows a faint "no tasks" message when idle. During a drag it
// collapses to nothing: the row being dropped into the group already fills this
// space, and the divider above defines the group boundary — so keeping the
// placeholder would leave a phantom second slot below the dropped task. Not
// committed.
function EmptySlotRow({ itemKey, label, ctx }) {
  const { heights, showHandle, dragging } = ctx;
  const top = useRowTop(itemKey, ctx);
  const measuredH = useSharedValue(FALLBACK_H);
  const style = useAnimatedStyle(() => ({ position: 'absolute', left: 0, right: 0, top: top.value }));
  const collapse = useAnimatedStyle(() => ({
    height: dragging.value ? 0 : measuredH.value,
    overflow: 'hidden',
    opacity: dragging.value ? 0 : 1,
  }));
  // Feed the collapsed height into the shared layout so sibling rows reflow
  // correctly: 0 while a drag is active, the real measured height when idle.
  useAnimatedReaction(
    () => dragging.value,
    (d, prev) => {
      if (d === prev) return;
      heights.value = { ...heights.value, [itemKey]: d ? 0 : measuredH.value };
    }
  );
  const onMeasure = (e) => {
    const h = e.nativeEvent.layout.height;
    measuredH.value = h;
    if (!dragging.value && heights.value[itemKey] !== h) {
      heights.value = { ...heights.value, [itemKey]: h };
    }
  };
  return (
    <Animated.View style={style}>
      <Animated.View style={collapse}>
        <View style={styles.emptySlot} onLayout={onMeasure}>
          {showHandle && <View style={styles.rowGutter} />}
          <View style={styles.emptySlotInner}>
            <Text style={styles.emptySlotText}>{label}</Text>
          </View>
        </View>
      </Animated.View>
    </Animated.View>
  );
}

// --- heading (draggable as a block with its child tasks) -------------------

function HeadingRow({
  itemKey,
  chevron,
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
      runOnJS(beginBodyDrag)();
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
      runOnJS(endBodyDrag)();
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
            name="chevron-forward"
            size={16}
            color={colors.textSecondary}
            style={{ transform: [{ rotate: chevronRotate(chevron ?? (collapsed ? 'collapsed' : 'full')) }] }}
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

// Hover-revealed quick actions on the right of a task row: edit (inline
// compose), set date, set priority. Wide/non-mobile only.
function RowActions({ visible, onEdit, onDate, onPriority, priority }) {
  const prio = priority ? PRIORITY_MAP[priority] : null;
  return (
    <View style={[styles.rowActions, { opacity: visible ? 1 : 0 }]} pointerEvents={visible ? 'auto' : 'none'}>
      <Pressable hitSlop={6} style={styles.rowActionBtn} onPress={onEdit}>
        <Ionicons name="create-outline" size={19} color={colors.textSecondary} />
      </Pressable>
      <Pressable hitSlop={6} style={styles.rowActionBtn} onPress={onDate}>
        <Ionicons name="calendar-outline" size={19} color={colors.textSecondary} />
      </Pressable>
      <Pressable hitSlop={6} style={styles.rowActionBtn} onPress={onPriority}>
        <Ionicons name={prio ? 'flag' : 'flag-outline'} size={19} color={prio ? prio.color : colors.textSecondary} />
      </Pressable>
    </View>
  );
}

function DraggableRow({ itemKey, task, showProject, inProject, showSubtasks, depth, hasChildren, expanded, onToggleExpand, onOpenTask, onCommit, ctx }) {
  const { positions, heights, kinds, activeId, activeBlockSet, blockTranslate, blockStartTops, dragging } = ctx;
  const { updateTask } = useTasks();
  // Cross-pane drop onto sidebar projects/areas (two-pane layout only).
  const drag = useDrag();
  const dropRects = drag?.targetRects;
  const dropHover = drag?.hovered;
  const overSidebar = drag?.overSidebar;
  const measureTargets = drag?.measureTargets;
  const dropFn = drag?.drop;
  const ghostX = drag?.ghostX;
  const ghostY = drag?.ghostY;
  const beginGhost = drag?.beginGhost;
  const endGhost = drag?.endGhost;
  const hasGhost = !!drag;
  const top = useRowTop(itemKey, ctx);
  const startTop = useSharedValue(0);
  // Snapshot of the row order at drag start, restored while hovering the sidebar
  // so the list shows no reflow gap.
  const startPositions = useSharedValue(null);
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  const [sheet, setSheet] = useState(null); // 'when' | 'priority' | null
  const handleVisible = ctx.showHandle && (!HOVERABLE || hovered);
  const actionsVisible = ctx.showHandle && (!HOVERABLE || hovered);

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
    .onStart((e) => {
      activeId.value = itemKey;
      dragging.value = true;
      ctx.dragKey.value = itemKey;
      ctx.dragDX.value = 0;
      startTop.value = topForIndex(orderedKeys(positions.value), heights.value, positions.value[itemKey]);
      startPositions.value = positions.value;
      if (measureTargets) runOnJS(measureTargets)();
      if (ghostX && ghostY) {
        ghostX.value = e.absoluteX;
        ghostY.value = e.absoluteY;
      }
      if (beginGhost) runOnJS(beginGhost)({ title: task.title });
      runOnJS(beginBodyDrag)();
      runOnJS(flagDragged)();
    })
    .onUpdate((e) => {
      // The ghost follows the raw pointer so it can travel across both panes.
      if (ghostX && ghostY) {
        ghostX.value = e.absoluteX;
        ghostY.value = e.absoluteY;
      }
      ctx.dragDX.value = e.translationX;
      // Cross-pane hit-test: find the hovered drop target (for highlight/drop)
      // and whether the pointer is anywhere over the sidebar (to freeze).
      let hit = null;
      let over = false;
      if (dropRects) {
        const ax = e.absoluteX;
        const ay = e.absoluteY;
        const rects = dropRects.value;
        const inside = (r) => r && ax >= r.x && ax <= r.x + r.w && ay >= r.y && ay <= r.y + r.h;
        over = inside(rects[SIDEBAR_ZONE_KEY]);
        for (const key in rects) {
          if (key === SIDEBAR_ZONE_KEY) continue;
          if (inside(rects[key])) {
            hit = key;
            over = true;
            break;
          }
        }
        if (dropHover) dropHover.value = hit;
        if (overSidebar) overSidebar.value = over;
      }
      // Anywhere over the sidebar (target or not): freeze the list to its
      // pre-drag order (no reflow gap or indicator) and park the dragged row in
      // its slot — only the ghost moves. The task moves on drop, not here.
      if (over) {
        if (startPositions.value) positions.value = startPositions.value;
        top.value = startTop.value;
        return;
      }
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
      // The "Add task"/"Add section" rows stay pinned at the bottom of their
      // section: a task can't land on or below them. Pull the target up above
      // any add-rows it would otherwise slot beneath.
      const rest = keys.filter((k) => k !== itemKey);
      while (
        newIndex > 0 &&
        (kinds.value[rest[newIndex - 1]] === 'addtask' ||
          kinds.value[rest[newIndex - 1]] === 'addsection' ||
          kinds.value[rest[newIndex - 1]] === 'more')
      ) {
        newIndex -= 1;
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
      const externalKey = dropHover ? dropHover.value : null;
      if (activeId.value === itemKey) {
        activeId.value = null;
        // Dropped on a sidebar project/area → move the task there instead of
        // committing an in-list reorder.
        if (externalKey && dropFn) {
          runOnJS(dropFn)(task.id, externalKey);
        } else {
          runOnJS(onCommit)();
        }
      }
      if (dropHover) dropHover.value = null;
      if (overSidebar) overSidebar.value = false;
      dragging.value = false;
      if (endGhost) runOnJS(endGhost)();
      runOnJS(endBodyDrag)();
      runOnJS(clearDraggedSoon)();
    });

  const style = useAnimatedStyle(() => {
    const isActive = activeId.value === itemKey;
    // While hovering the sidebar the list is frozen; show the dragged row in
    // its slot (the ghost carries it) so there's no gap.
    const onSidebar = !!(overSidebar && overSidebar.value);
    // Rightward drag previews nesting: shift the active row by up to one indent.
    const nestShift = isActive && !onSidebar ? Math.max(0, Math.min(NEST_SHIFT, ctx.dragDX.value)) : 0;
    return {
      position: 'absolute',
      left: 0,
      right: 0,
      top: top.value,
      zIndex: isActive || activeBlockSet.value[itemKey] ? 10 : 0,
      // When a ghost is present it stands in for the dragged row, so hide the
      // original (it's clipped to the pane anyway). Native/phone keeps the row.
      opacity: hasGhost && isActive && !onSidebar ? 0 : 1,
      transform: [
        { translateX: nestShift },
        { scale: withTiming(isActive && !onSidebar ? 1.02 : 1, EASE) },
      ],
    };
  });

  const hoverProps = HOVERABLE
    ? { onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) }
    : null;

  const sheets = (
    <>
      <WhenSheet
        visible={sheet === 'when'}
        onClose={() => setSheet(null)}
        value={task.when}
        onChange={(when) => updateTask(task.id, { when })}
      />
      <PrioritySheet
        visible={sheet === 'priority'}
        onClose={() => setSheet(null)}
        value={task.priority}
        onChange={(priority) => updateTask(task.id, { priority })}
      />
    </>
  );

  // Inline compose view for editing the existing task (wide surfaces).
  if (editing) {
    return (
      <Animated.View style={style}>
        <View onLayout={measure(heights, itemKey)}>
          <TaskComposer
            initial={{
              title: task.title,
              description: task.notes,
              when: task.when,
              deadline: task.deadline,
              priority: task.priority,
              location: task.location,
              tags: task.tags,
            }}
            submitLabel="Save"
            persistAfterAdd={false}
            onAdd={(p) => {
              updateTask(task.id, {
                title: p.title,
                notes: p.description,
                when: p.when,
                deadline: p.deadline,
                priority: p.priority,
                location: p.location,
                tags: p.tags,
              });
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        </View>
        {sheets}
      </Animated.View>
    );
  }

  return ctx.showHandle ? (
    <Animated.View style={style}>
      <View style={styles.rowHandled} onLayout={measure(heights, itemKey)} {...hoverProps}>
        <Handle gesture={pan} style={styles.taskHandle} visible={handleVisible} />
        <View style={styles.rowBody}>
          <TaskRow task={task} showProject={showProject} inProject={inProject} showSubtasks={showSubtasks} depth={depth} hasChildren={hasChildren} expanded={expanded} onToggleExpand={onToggleExpand} onOpenTask={onOpenTask} onPress={handlePress} />
        </View>
        <RowActions
          visible={actionsVisible}
          priority={task.priority}
          onEdit={() => setEditing(true)}
          onDate={() => setSheet('when')}
          onPriority={() => setSheet('priority')}
        />
      </View>
      {sheets}
    </Animated.View>
  ) : (
    <GestureDetector gesture={pan}>
      <Animated.View style={style}>
        <View style={styles.row} onLayout={measure(heights, itemKey)}>
          <TaskRow task={task} showProject={showProject} inProject={inProject} showSubtasks={showSubtasks} depth={depth} hasChildren={hasChildren} expanded={expanded} onToggleExpand={onToggleExpand} onOpenTask={onOpenTask} onPress={handlePress} />
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

// Tracks which section the top-of-screen row belongs to and reports it upward,
// so the page can render a *fixed* sticky header bar OUTSIDE the scroll view.
//
// The reorder surface is one tall block of absolutely-positioned rows inside the
// page ScrollView, so a FlatList/CSS sticky header can't be used here. An
// earlier version floated a bar *inside* the scroll and JS-compensated its top
// against the scroll offset every frame — which visibly tears when you scroll
// faster than the JS handler updates. Instead this component only *computes* the
// active section (from the SAME measured row heights the drag engine tracks) and
// hands it to ListScreen, which draws a bar that never scrolls, so nothing can
// tear. Purely passive: it renders nothing and never touches the drag state.
//
// It needs, from the page ScrollView: `scrollY` (shared value of the scroll
// offset) and `listOffsetY` (shared value of this list's top within the scroll
// content). The viewport top in this list's coordinates is `scrollY -
// listOffsetY`; the active header is the last one at or above it. Reports null
// while dragging (heights are in flux) and before the first header reaches top.
function StickyHeaderTracker({ items, ctx, scrollY, listOffsetY, onChange }) {
  const { heights, dragging } = ctx;
  const headers = React.useMemo(
    () =>
      items
        .filter((it) => it.kind === 'heading' || (it.kind === 'divider' && it.title))
        .map((it) => ({
          key: it.key,
          kind: it.kind,
          title: it.title,
          subtitle: it.subtitle,
          icon: it.icon,
          color: it.color,
          done: it.done,
          total: it.total,
          collapsible: it.kind === 'heading' || it.collapsible,
          collapsed: it.collapsed,
          chevron: it.chevron,
          headingId: it.headingId,
          dividerKey: it.dividerKey,
        })),
    [items]
  );
  const order = React.useMemo(() => items.map((it) => it.key), [items]);
  const headerIndexByKey = React.useMemo(() => {
    const m = {};
    headers.forEach((h, idx) => { m[h.key] = idx; });
    return m;
  }, [headers]);

  // Always report against the latest headers, even if the reaction closure is
  // one render stale.
  const headersRef = React.useRef(headers);
  headersRef.current = headers;
  const lastActive = useSharedValue(-1);
  const report = React.useCallback(
    (idx) => onChange(idx >= 0 ? headersRef.current[idx] : null),
    [onChange]
  );

  useAnimatedReaction(
    () => scrollY.value - listOffsetY.value,
    (viewTop) => {
      if (dragging.value || headers.length === 0 || viewTop < 0) {
        if (lastActive.value !== -1) { lastActive.value = -1; runOnJS(report)(-1); }
        return;
      }
      // Walk rows in order, summing heights, tracking the last header whose top
      // is at or above the viewport top.
      let acc = 0;
      let active = -1;
      for (let i = 0; i < order.length; i++) {
        const k = order[i];
        const hIdx = headerIndexByKey[k];
        if (hIdx !== undefined) {
          if (acc <= viewTop + 0.5) active = hIdx;
          else break; // later headers are further down — nothing more to find
        }
        acc += heights.value[k] ?? FALLBACK_H;
      }
      if (active !== lastActive.value) { lastActive.value = active; runOnJS(report)(active); }
    },
    [order, headerIndexByKey, headers.length]
  );

  // Clear the bar when this list unmounts (e.g. switching to a non-drag view).
  React.useEffect(() => () => onChange(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

// A drop-target placeholder for the item being dragged: a faint slot with a
// red insertion line + dot at its top, marking where the row will land. Only
// shown for single-task drags (activeId set); block/heading drags skip it.
function DropIndicator({ ctx, overSidebar }) {
  const { positions, heights, activeId, dragging } = ctx;
  const style = useAnimatedStyle(() => {
    const act = activeId.value;
    // Hide the in-list indicator whenever the pointer is over the sidebar — the
    // task is being moved there, not reordered within this list.
    const onSidebar = overSidebar && overSidebar.value;
    if (!act || !dragging.value || onSidebar) return { opacity: 0, top: 0, height: 0 };
    const keys = orderedKeys(positions.value);
    const top = topForIndex(keys, heights.value, positions.value[act]);
    return { opacity: 1, top, height: heights.value[act] ?? FALLBACK_H };
  });
  return (
    <Animated.View pointerEvents="none" style={[styles.dropSlot, style]}>
      <View style={styles.dropPlaceholder} />
      <View style={styles.dropLineRow}>
        <View style={styles.dropDot} />
        <View style={styles.dropLine} />
      </View>
    </Animated.View>
  );
}

// Drag-to-reorder over a flat `items` array (tasks + heading dividers).
// Tasks drag individually (and can cross headings); a heading drags its whole
// block (heading + child tasks). `onCommitKeys` gets the new ordered key array.
export default function ReorderableTaskList({
  items,
  showProject,
  inProject,
  showSubtasks,
  onToggleExpand,
  onOpenTask,
  onCommitKeys,
  onDeleteHeading,
  onUpdateHeading,
  onToggleCollapse,
  onToggleDivider,
  onToggleMore,
  onAddTask,
  onAddSection,
  onEditSection,
  // Optional sticky section headers: the page ScrollView's scroll offset and
  // this list's top within the scroll content (both shared values), plus a
  // callback that receives the active section header (or null). When all are
  // supplied, ListScreen draws a fixed sticky bar from what this reports.
  stickyScrollY,
  stickyOffsetY,
  onStickyHeaderChange,
}) {
  // Non-mobile (iPad / web / desktop): drag from an explicit handle.
  const showHandle = useIsWide();
  // Cross-pane drag: the currently-hovered sidebar drop target (or null).
  const drag = useDrag();
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
    // The active row's horizontal drag distance + key, read at commit to decide
    // nesting: dragging a row rightward drops it as a child of the row above.
    dragDX: useSharedValue(0),
    dragKey: useSharedValue(null),
    showHandle,
    inProject,
  };
  const { positions, heights, kinds } = ctx;
  const keysKey = items.map((it) => it.key).join(',');

  // Reset row positions/kinds *synchronously* when the item set changes (e.g.
  // toggling a project between its list and date views). Doing this in a
  // useEffect would leave one committed frame where the new rows read stale
  // positions and stack at top:0 — collapsing the container height so the
  // ScrollView clamps and the list visibly jumps. Setting it during render
  // means rows are placed correctly on the first frame; heights measured for
  // tasks common to both views are retained, so there's no re-measure flash.
  const prevKeys = React.useRef(keysKey);
  if (prevKeys.current !== keysKey) {
    positions.value = Object.fromEntries(items.map((it, i) => [it.key, i]));
    kinds.value = Object.fromEntries(items.map((it) => [it.key, it.kind]));
    prevKeys.current = keysKey;
  }

  const commit = () => {
    const map = positions.value;
    const arr = new Array(items.length);
    for (const key in map) arr[map[key]] = key;
    onCommitKeys(arr.filter(Boolean), { draggedKey: ctx.dragKey.value, dx: ctx.dragDX.value });
  };

  const containerStyle = useAnimatedStyle(() => ({
    height: totalHeight(orderedKeys(positions.value), heights.value),
  }));

  return (
    <Animated.View style={containerStyle}>
      {stickyScrollY && stickyOffsetY && onStickyHeaderChange && (
        <StickyHeaderTracker
          items={items}
          ctx={ctx}
          scrollY={stickyScrollY}
          listOffsetY={stickyOffsetY}
          onChange={onStickyHeaderChange}
        />
      )}
      <DropIndicator ctx={ctx} overSidebar={drag?.overSidebar} />
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
            chevron={item.chevron}
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
        ) : item.kind === 'divider' ? (
          <DividerRow
            key={item.key}
            itemKey={item.key}
            title={item.title}
            subtitle={item.subtitle}
            icon={item.icon}
            collapsible={item.collapsible}
            collapsed={item.collapsed}
            chevron={item.chevron}
            dividerKey={item.dividerKey}
            onToggleCollapse={onToggleDivider}
            total={item.total}
            done={item.done}
            color={item.color}
            ctx={ctx}
          />
        ) : item.kind === 'more' ? (
          <MoreRow
            key={item.key}
            itemKey={item.key}
            sectionKey={item.sectionKey}
            action={item.action}
            hidden={item.hidden}
            color={item.color}
            onToggleMore={onToggleMore}
            ctx={ctx}
          />
        ) : item.kind === 'emptyslot' ? (
          <EmptySlotRow key={item.key} itemKey={item.key} label={item.label} ctx={ctx} />
        ) : (
          <DraggableRow
            key={item.key}
            itemKey={item.key}
            task={item.task}
            showProject={showProject}
            inProject={inProject}
            showSubtasks={showSubtasks}
            depth={item.depth}
            hasChildren={item.hasChildren}
            expanded={item.expanded}
            onToggleExpand={onToggleExpand}
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
    borderBottomColor: 'rgba(0,0,0,0.035)',
  },
  rowHandled: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: colors.background,
    userSelect: 'none',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(0,0,0,0.035)',
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
  // Empty drag-handle gutter, so dividers/empty rows line up with task rows.
  rowGutter: { width: HANDLE_W },
  // The checkbox column (icon here) that a task's title sits after.
  rowCheckCol: { width: 22, alignItems: 'center', marginRight: spacing.md },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    // Use padding, not margin: row positions are computed from onLayout
    // heights, which exclude margins — margins here would let the next row
    // overlap the divider. Padding is measured, so spacing stays honest.
    paddingTop: spacing.xl,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
    backgroundColor: colors.background,
    userSelect: 'none',
  },
  dividerInner: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingLeft: spacing.lg },
  // Measured gap below the divider's border line so the group's first task
  // (or the empty placeholder) sits clear of "This Evening".
  dividerSpacer: { height: spacing.md },
  dividerTitle: { ...typography.heading, color: colors.text },
  // On mobile (no grip gutter) a collapsible date header still needs the same
  // left inset the grip would otherwise provide.
  dividerRowInset: { paddingLeft: spacing.lg },
  dividerLeadIcon: { marginRight: 6 },
  dividerTitleWrap: { flex: 1, flexDirection: 'row', alignItems: 'baseline' },
  dividerSubtitle: { ...typography.subhead, color: colors.textTertiary, marginLeft: spacing.sm },
  // Pie + done/total pushed to the right edge of a date divider (mirrors the
  // heading rows' progress indicator).
  dividerProgress: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginLeft: 'auto',
    paddingRight: spacing.lg,
  },
  emptySlot: { flexDirection: 'row', alignItems: 'center', minHeight: 48, paddingTop: spacing.md },
  // Match a task row's inner padding so the message aligns with task titles.
  emptySlotInner: { flex: 1, paddingLeft: spacing.lg + 22 + spacing.md, paddingRight: spacing.lg },
  emptySlotText: { ...typography.subhead, color: colors.textTertiary, fontStyle: 'italic' },
  addSectionTextHidden: { opacity: 0 },
  // "Show N more" / "Show less" row — its label lines up with task titles by
  // reproducing a task row's leading columns.
  moreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  moreInner: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  moreDisclosure: { width: 20, marginRight: -spacing.sm },
  moreCheckCol: { width: 22, alignItems: 'center' },
  moreText: { ...typography.subhead, fontWeight: '600' },
  rowBody: { flex: 1 },
  // Drop-target placeholder shown under the floating dragged row.
  dropSlot: { position: 'absolute', left: 0, right: 0 },
  dropPlaceholder: {
    ...StyleSheet.absoluteFillObject,
    marginHorizontal: spacing.md,
    marginVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.groupedBackground,
  },
  dropLineRow: {
    position: 'absolute',
    top: -1,
    left: spacing.lg,
    right: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
  },
  dropLine: { flex: 1, height: 2, backgroundColor: colors.deadline },
  dropDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: colors.deadline,
    backgroundColor: colors.background,
    marginLeft: -4,
    marginRight: 2,
  },
  // Right-aligned hover actions (edit / date / priority).
  rowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingTop: 8,
    paddingRight: spacing.lg,
    paddingLeft: spacing.sm,
  },
  rowActionBtn: {
    padding: 3,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
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

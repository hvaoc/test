import React, { createContext, useContext, useRef, useCallback, useState, useMemo, useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle } from 'react-native-reanimated';
import { useTasks } from './TasksContext';
import { WHEN } from './constants';
import { colors, spacing, typography, radius } from '../theme';

// Cross-pane drag state: lets sidebar rows (projects / areas) act as drop
// targets for a task being dragged in the detail pane. Only mounted in the
// two-pane (wide) layout; on phones `useDrag()` returns null and callers skip
// the cross-pane behavior.
const Ctx = createContext(null);
export const useDrag = () => useContext(Ctx);

// Reserved target key for the whole sidebar. Registered like a drop target so
// its rect is measured, but it's not a real drop destination — it only tells
// the drag whether the pointer is anywhere over the sidebar (to freeze the list
// and hide the in-list drop indicator).
export const SIDEBAR_ZONE_KEY = '__sidebar__';

export function DragProvider({ children }) {
  const { updateTask } = useTasks();
  // Absolute window rects of registered targets, hit-tested on the UI thread.
  const targetRects = useSharedValue({});
  // Key of the target currently under the dragged pointer (for highlight).
  const hovered = useSharedValue(null);
  // True while the pointer is anywhere over the sidebar during a drag.
  const overSidebar = useSharedValue(false);
  // key -> { node: ref, meta } for measuring + resolving the drop.
  const targetsRef = useRef({});

  // A floating "ghost" of the dragged task, rendered at the root so it can move
  // freely across both panes (the in-pane row is clipped by its scroll view).
  // The ghost owns its own visibility state and exposes an imperative handle, so
  // showing/hiding it during a drag never re-renders the provider (which would
  // recreate and cancel the active gesture).
  const ghostX = useSharedValue(0);
  const ghostY = useSharedValue(0);
  const ghostApiRef = useRef(null);
  const beginGhost = useCallback((info) => {
    if (ghostApiRef.current) ghostApiRef.current.show(info);
  }, []);
  const endGhost = useCallback(() => {
    if (ghostApiRef.current) ghostApiRef.current.hide();
  }, []);

  const register = useCallback((key, node, meta) => {
    targetsRef.current[key] = { node, meta };
  }, []);
  const unregister = useCallback((key) => {
    delete targetsRef.current[key];
  }, []);

  // Snapshot every target's on-screen rect (called at drag start so scroll
  // position is accounted for). measureInWindow is async, so we assemble the
  // map and publish it once the last callback lands.
  const measureTargets = useCallback(() => {
    const entries = Object.entries(targetsRef.current);
    let pending = entries.length;
    const rects = {};
    if (!pending) {
      targetRects.value = {};
      return;
    }
    entries.forEach(([key, { node }]) => {
      const n = node && node.current ? node.current : node;
      if (n && n.measureInWindow) {
        n.measureInWindow((x, y, w, h) => {
          rects[key] = { x, y, w, h };
          pending -= 1;
          if (pending === 0) targetRects.value = rects;
        });
      } else {
        pending -= 1;
        if (pending === 0) targetRects.value = rects;
      }
    });
  }, []);

  // Move the task into the dropped-on target. Valid targets: a project, or the
  // Inbox / Today smart lists.
  const drop = useCallback(
    (taskId, key) => {
      const entry = targetsRef.current[key];
      if (!entry || !taskId) return;
      const m = entry.meta;
      if (m.kind === 'project') {
        // Dropping onto a project promotes a subtask to a top-level to-do there.
        updateTask(taskId, { projectId: m.id, areaId: m.areaId || null, headingId: null, parentId: null });
      } else if (m.kind === 'list' && m.id === 'inbox') {
        // Inbox: unfiled and unscheduled.
        updateTask(taskId, { projectId: null, areaId: null, headingId: null, parentId: null, when: null });
      } else if (m.kind === 'list' && m.id === 'today') {
        // Today: scheduled for today, keeps its project/area but leaves its parent.
        updateTask(taskId, { when: WHEN.TODAY, parentId: null });
      }
    },
    [updateTask]
  );

  // Memoized so that showing/hiding the ghost (a state change) does NOT produce
  // a new context value — otherwise every consumer re-renders and the active
  // drag gesture gets recreated and cancelled mid-drag. All members are stable.
  const value = useMemo(
    () => ({
      targetRects,
      hovered,
      overSidebar,
      register,
      unregister,
      measureTargets,
      drop,
      ghostX,
      ghostY,
      beginGhost,
      endGhost,
    }),
    [register, unregister, measureTargets, drop, beginGhost, endGhost]
  );
  return (
    <Ctx.Provider value={value}>
      {children}
      <DragGhost apiRef={ghostApiRef} x={ghostX} y={ghostY} />
    </Ctx.Provider>
  );
}

// The floating clone that tracks the pointer during a drag. Always mounted; it
// holds its own visible/title state (set imperatively via apiRef) so the
// provider never re-renders mid-drag. pointerEvents none so it never interferes
// with hit-testing the drop targets underneath.
function DragGhost({ apiRef, x, y }) {
  const [info, setInfo] = useState(null);
  useEffect(() => {
    apiRef.current = { show: (i) => setInfo(i), hide: () => setInfo(null) };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef]);
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value + 10 }, { translateY: y.value - 14 }],
  }));
  if (!info) return null;
  return (
    <Animated.View pointerEvents="none" style={[styles.ghost, style]}>
      <View style={styles.ghostCheckbox} />
      <Text style={styles.ghostText} numberOfLines={1}>
        {info.title || 'New To-Do'}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  ghost: {
    position: 'absolute',
    top: 0,
    left: 0,
    zIndex: 1000,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    maxWidth: 320,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: colors.background,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separatorStrong,
    // A soft lift so it reads as "picked up".
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
    opacity: 0.96,
  },
  ghostCheckbox: {
    width: 20,
    height: 20,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    borderColor: colors.separatorStrong,
  },
  ghostText: { ...typography.body, color: colors.text, flexShrink: 1 },
});

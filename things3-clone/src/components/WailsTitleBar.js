import React, { useEffect, useRef, useState } from 'react';
import { View, Platform, StyleSheet } from 'react-native';
import { colors } from '../theme';

// True when running inside the Wails (macOS desktop) WebView. Wails injects
// `window.runtime` before the app script runs; we also poll briefly in case it
// attaches a tick late. On web/native this stays false, so nothing changes.
export function useIsWails() {
  const [isWails, setIsWails] = useState(
    Platform.OS === 'web' && typeof window !== 'undefined' && !!window.runtime
  );
  useEffect(() => {
    if (isWails || Platform.OS !== 'web' || typeof window === 'undefined') return undefined;
    const id = setInterval(() => {
      if (window.runtime) {
        setIsWails(true);
        clearInterval(id);
      }
    }, 100);
    const stop = setTimeout(() => clearInterval(id), 2000);
    return () => {
      clearInterval(id);
      clearTimeout(stop);
    };
  }, [isWails]);
  return isWails;
}

// A draggable top strip that reserves room for the macOS traffic-light buttons
// (Wails draws them natively at the top-left with TitleBarHiddenInset). Marked
// as a Wails drag region so the window can be moved by dragging it.
export default function WailsTitleBar() {
  const ref = useRef(null);
  // Remembers the pre-zoom bounds so double-click can restore them.
  const savedBounds = useRef(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    // RN-web View ref is the DOM node; mark it as a Wails drag handle.
    if (node.style && node.style.setProperty) {
      node.style.setProperty('--wails-draggable', 'drag');
    }
    // Double-click to zoom/restore (macOS convention). We set the frame
    // directly instead of WindowToggleMaximise so it happens instantly — the
    // native maximise animates.
    const onDoubleClick = () => {
      const rt = typeof window !== 'undefined' ? window.runtime : undefined;
      if (!rt || !rt.WindowSetSize || !rt.WindowSetPosition) return;
      // Set size before position: Wails' SetPosition derives the top edge from
      // the current window height, so sizing first keeps the top flush.
      if (savedBounds.current) {
        const b = savedBounds.current;
        savedBounds.current = null;
        rt.WindowSetSize(b.w, b.h);
        rt.WindowSetPosition(b.x, b.y);
        return;
      }
      Promise.all([rt.WindowGetPosition(), rt.WindowGetSize()])
        .then(([pos, size]) => {
          savedBounds.current = { x: pos.x, y: pos.y, w: size.w, h: size.h };
          const s = (typeof window !== 'undefined' && window.screen) || {};
          // Wails positions relative to the work area (already below the menu
          // bar), so (0,0) is the top-left of the usable screen — no top gap.
          rt.WindowSetSize(s.availWidth || size.w, s.availHeight || size.h);
          rt.WindowSetPosition(0, 0);
        })
        .catch(() => {});
    };
    node.addEventListener('dblclick', onDoubleClick);
    return () => node.removeEventListener('dblclick', onDoubleClick);
  }, []);
  return <View ref={ref} style={styles.bar} />;
}

// Height of the title strip; the traffic lights sit within it on the left.
export const WAILS_TITLEBAR_HEIGHT = 36;

const styles = StyleSheet.create({
  bar: {
    height: WAILS_TITLEBAR_HEIGHT,
    backgroundColor: colors.groupedBackground,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separatorStrong,
  },
});

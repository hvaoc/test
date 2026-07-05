import React, { useState, useLayoutEffect } from 'react';
import { View, Text, Platform, StyleSheet } from 'react-native';

// RemoteCarets — a reusable overlay that draws collaborators' cursors (a coloured
// caret bar + a name label) at their positions inside a plain <textarea>. This is
// the Google-Docs-style presence caret, and it's intentionally self-contained so
// it can be lifted into other products: it depends only on
//   - a DOM <textarea> node (via `getNode`)
//   - the current text (`text`)
//   - a list of remote carets: [{ key, color, label, index }]
//
// Web only (it measures DOM geometry). On native it renders nothing.
//
// Mount it as an absolutely-positioned sibling that exactly overlays the
// textarea, inside a `position: relative` container.

// Style properties copied to the hidden mirror so its text wraps identically to
// the textarea — the basis of accurate caret measurement.
const MIRROR_PROPS = [
  'boxSizing', 'width', 'height',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
  'letterSpacing', 'lineHeight', 'textTransform', 'textAlign',
  'wordSpacing', 'textIndent', 'whiteSpace', 'overflowWrap', 'tabSize',
];

// caretCoordinates returns the {top, left, height} of the caret at `index` in the
// textarea's own coordinate space (padding box included), using a hidden mirror
// div — the standard textarea-caret-position technique.
function caretCoordinates(textarea, index) {
  const doc = textarea.ownerDocument;
  const win = doc.defaultView || window;
  const style = win.getComputedStyle(textarea);

  const mirror = doc.createElement('div');
  mirror.setAttribute('aria-hidden', 'true');
  const s = mirror.style;
  s.position = 'absolute';
  s.top = '0';
  s.left = '-9999px';
  s.visibility = 'hidden';
  s.whiteSpace = 'pre-wrap';
  s.overflowWrap = 'break-word';
  MIRROR_PROPS.forEach((p) => { s[p] = style[p]; });
  // The mirror must not force its own height; let content define it.
  s.height = 'auto';

  const value = textarea.value || '';
  mirror.textContent = value.substring(0, index);
  // A marker whose position IS the caret position. Non-empty so it lays out.
  const marker = doc.createElement('span');
  marker.textContent = value.substring(index) || '​';
  mirror.appendChild(marker);

  doc.body.appendChild(mirror);
  const top = marker.offsetTop + parseFloat(style.borderTopWidth || '0');
  const left = marker.offsetLeft + parseFloat(style.borderLeftWidth || '0');
  const lineHeight =
    parseFloat(style.lineHeight) ||
    parseFloat(style.fontSize) * 1.2 ||
    16;
  doc.body.removeChild(mirror);
  return { top, left, height: lineHeight };
}

export default function RemoteCarets({ getNode, text, carets }) {
  const [positions, setPositions] = useState([]);

  useLayoutEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const node = typeof getNode === 'function' ? getNode() : null;
    if (!node || node.nodeName !== 'TEXTAREA') {
      setPositions([]);
      return undefined;
    }
    const compute = () => {
      const len = (node.value || '').length;
      const next = (carets || [])
        .filter((c) => c && typeof c.index === 'number')
        .map((c) => {
          const idx = Math.max(0, Math.min(c.index, len));
          const { top, left, height } = caretCoordinates(node, idx);
          return { key: c.key, color: c.color, label: c.label, height, top: top - node.scrollTop, left: left - node.scrollLeft };
        });
      setPositions(next);
    };
    compute();
    node.addEventListener('scroll', compute);
    const win = node.ownerDocument.defaultView || window;
    win.addEventListener('resize', compute);
    return () => {
      node.removeEventListener('scroll', compute);
      win.removeEventListener('resize', compute);
    };
  }, [getNode, text, carets]);

  if (Platform.OS !== 'web' || positions.length === 0) return null;

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {positions.map((p) => (
        <View key={p.key} style={[styles.caret, { top: p.top, left: p.left, height: p.height }]}>
          <View style={[styles.bar, { backgroundColor: p.color, height: p.height }]} />
          {!!p.label && (
            <View style={[styles.flag, { backgroundColor: p.color, top: -12 }]}>
              <Text style={styles.flagText} numberOfLines={1}>{p.label}</Text>
            </View>
          )}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  caret: { position: 'absolute', width: 2 },
  bar: { width: 2, borderRadius: 1 },
  flag: { position: 'absolute', left: -1, borderRadius: 3, paddingHorizontal: 3, paddingVertical: 1 },
  flagText: { color: '#fff', fontSize: 9, fontWeight: '700' },
});

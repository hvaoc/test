import React from 'react';
import Svg, { Circle, Path } from 'react-native-svg';

// A small pie-chart progress indicator: a thin track ring with a filled wedge
// that sweeps clockwise from 12 o'clock as a project's to-dos get completed.
//
// Drawn as a pie on purpose — it reads as a *chart*, so it's visually distinct
// from the (square) to-do checkbox and the (circle) checklist item, both of
// which are tappable. This one is read-only status.
export default function ProgressPie({ progress, color, size = 16 }) {
  const p = Math.max(0, Math.min(1, progress));
  const r = size / 2;
  const stroke = 1.5;
  // Inset a full stroke-width so the ring never touches the SVG edge — SVG has
  // overflow:hidden on web and would otherwise clip the stroke.
  const rr = r - stroke;

  // Wedge endpoint, sweeping clockwise from the top.
  const angle = p * 2 * Math.PI;
  const endX = r + rr * Math.sin(angle);
  const endY = r - rr * Math.cos(angle);
  const largeArc = p > 0.5 ? 1 : 0;
  const wedge = `M ${r} ${r} L ${r} ${r - rr} A ${rr} ${rr} 0 ${largeArc} 1 ${endX} ${endY} Z`;

  return (
    <Svg width={size} height={size}>
      <Circle cx={r} cy={r} r={rr} fill="none" stroke={color} strokeWidth={stroke} />
      {p >= 0.999 ? (
        <Circle cx={r} cy={r} r={rr} fill={color} />
      ) : p > 0 ? (
        <Path d={wedge} fill={color} />
      ) : null}
    </Svg>
  );
}

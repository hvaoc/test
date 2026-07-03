import React from 'react';
import { Platform } from 'react-native';

// A rainbow swatch that opens the OS color picker (web). A native
// <input type=color> sits invisibly over a conic-gradient tile so any color
// can be chosen. No-op on native platforms (they use the preset palette).
export default function ColorPickerSwatch({ value, onChange, size = 28 }) {
  if (Platform.OS !== 'web') return null;
  return React.createElement(
    'label',
    {
      title: 'Custom color',
      style: {
        width: size, height: size, borderRadius: size / 2, cursor: 'pointer', overflow: 'hidden',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', position: 'relative',
        border: '1px solid #dcdde0',
        background: 'conic-gradient(from 0deg, #ff0000, #ffea00, #33cc33, #00c2ff, #2b6fff, #a83cff, #ff3ca8, #ff0000)',
      },
    },
    React.createElement('input', {
      type: 'color',
      value,
      onChange: (e) => onChange(e.target.value),
      style: { position: 'absolute', width: '150%', height: '150%', opacity: 0, cursor: 'pointer', border: 'none', padding: 0 },
    })
  );
}

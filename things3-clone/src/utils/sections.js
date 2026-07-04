// The section header chevron shows three states by rotating a single
// right-pointing chevron: collapsed ▶ (0°), partially expanded ◢ (45°), fully
// expanded ▼ (90°). A section with no overflow (≤ the minimal count) has no
// distinct partial state, so it reads as fully open.
export function chevronRotate(state) {
  return state === 'full' ? '90deg' : state === 'partial' ? '45deg' : '0deg';
}

// Derive the chevron state for a section from its mode + whether it overflows
// the minimal view (i.e. still has a "show more" affordance).
export function chevronState(mode, hasMore) {
  if (mode === 'collapsed') return 'collapsed';
  return hasMore ? 'partial' : 'full';
}

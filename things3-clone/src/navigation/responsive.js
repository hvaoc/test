import { Platform, useWindowDimensions } from 'react-native';

// A stable key identifying a "what to show" selection, shared by the sidebar
// (for highlighting the active row) and the split view (for remounting the
// detail pane). Mirrors the params shape used by ListScreen's route.
export function selectionKey(params) {
  if (!params) return null;
  // A search selection carries its scope so scoped searches (within an Area /
  // Project) remount independently of the global one.
  if (params.search) {
    const s = params.scope;
    return s && s.id ? `search:${s.type}:${s.id}` : 'search';
  }
  if (params.viewId) return `view:${params.viewId}`;
  if (params.listId) return `list:${params.listId}`;
  if (params.projectId) return `project:${params.projectId}`;
  if (params.areaId) return `area:${params.areaId}`;
  return null;
}

// Should we show the always-visible two-pane (sidebar + detail) layout?
//   - Desktop surfaces (web / macOS / Windows): key off window width so the
//     browser/window can be resized down to the mobile layout.
//   - Touch surfaces (iOS / Android): key off the *shorter* side so every iPad
//     gets two panes in both orientations while every phone stays single-pane.
export function useIsWide() {
  const { width, height } = useWindowDimensions();
  const isDesktop =
    Platform.OS === 'web' || Platform.OS === 'macos' || Platform.OS === 'windows';
  return isDesktop ? width >= 768 : Math.min(width, height) >= 600;
}

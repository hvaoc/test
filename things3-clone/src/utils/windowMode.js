import { Platform } from 'react-native';

// Bridge to the Wails Go binding (window.go.main.App) that controls how the
// desktop window opens. Only present in the Wails desktop build; every function
// is a safe no-op elsewhere (web / native), and `hasWindowApi()` gates the UI.

const api = () => {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  const app = window.go && window.go.main && window.go.main.App;
  return app && typeof app.SetWindowMode === 'function' ? app : null;
};

export const hasWindowApi = () => !!api();

// 'maximized' | 'remember'  (async — the binding returns a Promise).
export async function getWindowMode() {
  const a = api();
  if (!a) return null;
  try {
    return await a.GetWindowMode();
  } catch {
    return null;
  }
}

export function setWindowMode(mode) {
  const a = api();
  if (a) {
    try {
      a.SetWindowMode(mode);
    } catch {}
  }
}

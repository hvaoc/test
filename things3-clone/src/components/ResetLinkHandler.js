import { useEffect } from 'react';
import { Platform } from 'react-native';
import { openAuth } from '../store/authModal';

// Opens the auth modal in "set a new password" mode when the app is loaded from a
// password-reset link (?reset=CODE), then cleans the URL.
export default function ResetLinkHandler() {
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return undefined;
    let code = null;
    try {
      const u = new URL(window.location.href);
      code = u.searchParams.get('reset');
      if (code) {
        u.searchParams.delete('reset');
        window.history.replaceState({}, '', u.pathname + (u.search || '') + u.hash);
      }
    } catch {
      return undefined;
    }
    if (!code) return undefined;
    // Let AuthSheet register its opener first.
    const t = setTimeout(() => openAuth('reset', { code }), 60);
    return () => clearTimeout(t);
  }, []);
  return null;
}

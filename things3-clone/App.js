import React, { useEffect } from 'react';
import { View, Platform } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';

import { TasksProvider } from './src/store/TasksContext';
import RootNavigator from './src/navigation/RootNavigator';
import WailsTitleBar, { useIsWails } from './src/components/WailsTitleBar';
import { stepZoom, applyStoredZoom } from './src/utils/zoom';

export default function App() {
  // On the Wails macOS desktop build, add a draggable title strip that clears
  // the native traffic-light buttons. No-op on web / iOS / Android.
  const isWails = useIsWails();

  // Behave like an app, not a web page: disable text selection everywhere
  // (so Cmd/Ctrl+A and click-drag don't select the sidebar, titles, etc.),
  // but keep real inputs selectable/editable. Web (incl. Wails) only.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return undefined;
    const style = document.createElement('style');
    style.textContent =
      '*{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}' +
      'input,textarea,[contenteditable="true"]{-webkit-user-select:text;user-select:text}';
    document.head.appendChild(style);
    const onKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) {
        const t = e.target;
        const editable =
          t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
        if (!editable) e.preventDefault(); // block "select all" outside inputs
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      style.remove();
    };
  }, []);

  // Browser-style zoom for the desktop (Wails WKWebView) / web build: Cmd/Ctrl
  // with +, - and 0 (reset). The webview has no native zoom, so we drive the
  // WebKit `zoom` CSS on <html> (it reflows layout like real browser zoom) and
  // persist the level across launches.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return undefined;
    applyStoredZoom(); // restore the persisted level on launch
    // Native Wails "View" menu drives zoom through this global (via ExecJS).
    window.__appZoom = stepZoom;
    const onZoomKey = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.key === '=' || e.key === '+' || e.code === 'NumpadAdd') {
        e.preventDefault();
        stepZoom('in');
      } else if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') {
        e.preventDefault();
        stepZoom('out');
      } else if (e.key === '0' || e.code === 'Numpad0') {
        e.preventDefault();
        stepZoom('reset');
      }
    };
    document.addEventListener('keydown', onZoomKey, true);
    return () => {
      document.removeEventListener('keydown', onZoomKey, true);
      delete window.__appZoom;
    };
  }, []);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <TasksProvider>
          {isWails && <WailsTitleBar />}
          <View style={{ flex: 1 }}>
            <NavigationContainer>
              <StatusBar style="dark" />
              <RootNavigator />
            </NavigationContainer>
          </View>
        </TasksProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

import React, { useEffect } from 'react';
import { View, Platform } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';

import { TasksProvider } from './src/store/TasksContext';
import RootNavigator from './src/navigation/RootNavigator';
import WailsTitleBar, { useIsWails } from './src/components/WailsTitleBar';

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

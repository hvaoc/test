import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { MemoryProvider } from '../lib/store';
import { colors } from '../lib/theme';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <MemoryProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.surface },
            headerTintColor: colors.text,
            headerTitleStyle: { fontWeight: '700' },
            contentStyle: { backgroundColor: colors.bg },
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="onboarding" options={{ title: 'Meet Cairn' }} />
          <Stack.Screen name="chat" options={{ title: 'Cairn' }} />
          <Stack.Screen name="memory" options={{ title: 'What Cairn remembers' }} />
        </Stack>
      </MemoryProvider>
    </SafeAreaProvider>
  );
}

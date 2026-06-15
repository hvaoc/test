import { Redirect } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { useMemory } from '../lib/store';
import { colors } from '../lib/theme';

// Gate: send the user to onboarding the first time, otherwise straight to chat.
export default function Index() {
  const { ready, state } = useMemory();

  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return <Redirect href={state.onboarded ? '/chat' : '/onboarding'} />;
}

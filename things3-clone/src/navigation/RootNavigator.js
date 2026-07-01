import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import HomeScreen from '../screens/HomeScreen';
import ListScreen from '../screens/ListScreen';
import SplitView from './SplitView';
import { useIsWide } from './responsive';

const Stack = createNativeStackNavigator();

// Phone / narrow: the sidebar (Home) drills into a List via a push stack.
// Both screens render their own headers, so we hide the native one.
function MobileStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false, animation: 'slide_from_right' }}>
      <Stack.Screen name="Home" component={HomeScreen} />
      <Stack.Screen name="List" component={ListScreen} />
    </Stack.Navigator>
  );
}

// Responsive root: wide surfaces (iPad / web / desktop) get an always-visible
// two-pane split; phones keep the single-pane push navigation.
export default function RootNavigator() {
  const isWide = useIsWide();
  return isWide ? <SplitView /> : <MobileStack />;
}

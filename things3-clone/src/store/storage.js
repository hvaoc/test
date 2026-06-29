import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'things3clone:data:v1';

export async function loadState() {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.warn('Failed to load state', e);
    return null;
  }
}

// Persisting on every keystroke would thrash AsyncStorage, so callers debounce.
export async function saveState(state) {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('Failed to save state', e);
  }
}

export async function clearState() {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch (e) {
    console.warn('Failed to clear state', e);
  }
}

import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import BottomSheet from './BottomSheet';
import { colors, spacing, typography, radius } from '../theme';

// Free geocoding autocomplete via Photon (photon.komoot.io) — OpenStreetMap-based,
// no API key, CORS-enabled, so it works on native AND the WKWebView desktop/web
// build. Falls back to plain free-text if the network is unavailable, so the
// prototype is always usable offline.
const PHOTON_URL = 'https://photon.komoot.io/api';
const MIN_CHARS = 3;
const DEBOUNCE_MS = 300;

// Build a readable one-line label from a Photon feature's properties.
function labelFor(props = {}) {
  const line1 = [props.name, props.street && !props.name ? props.street : null]
    .filter(Boolean)
    .join(' ');
  const rest = [props.city || props.town || props.village, props.state, props.country]
    .filter(Boolean);
  return [line1 || props.street || props.city, ...rest.filter((r) => r !== line1)]
    .filter(Boolean)
    .join(', ');
}

// A location for the task with free-text + OSM autocomplete suggestions.
export default function LocationSheet({ visible, onClose, value, onChange }) {
  const [query, setQuery] = useState(value || '');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  // Skip the fetch right after the user picks a suggestion (query === value).
  const justPicked = useRef(false);

  // Reset the field to the task's current value each time the sheet opens.
  useEffect(() => {
    if (visible) {
      setQuery(value || '');
      setResults([]);
      setLoading(false);
    }
  }, [visible, value]);

  // Debounced Photon lookup as the user types.
  useEffect(() => {
    if (!visible) return undefined;
    const q = query.trim();
    if (justPicked.current) { justPicked.current = false; return undefined; }
    if (q.length < MIN_CHARS) { setResults([]); setLoading(false); return undefined; }

    const controller = new AbortController();
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`${PHOTON_URL}?q=${encodeURIComponent(q)}&limit=5`, {
          signal: controller.signal,
        });
        const json = await res.json();
        const items = (json.features || [])
          .map((f) => ({
            key: `${f.properties?.osm_type || ''}${f.properties?.osm_id || Math.random()}`,
            label: labelFor(f.properties),
            lat: f.geometry?.coordinates?.[1],
            lon: f.geometry?.coordinates?.[0],
          }))
          .filter((r) => r.label);
        setResults(items);
      } catch (e) {
        if (e.name !== 'AbortError') setResults([]); // network down → free-text only
      } finally {
        setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => { controller.abort(); clearTimeout(t); };
  }, [query, visible]);

  const type = (text) => {
    setQuery(text);
    onChange(text); // keep free-text live, like before
  };
  const pick = (item) => {
    justPicked.current = true;
    setQuery(item.label);
    setResults([]);
    onChange(item.label);
    onClose();
  };

  return (
    <BottomSheet visible={visible} onClose={onClose} title="Location">
      <View style={styles.inputRow}>
        <Ionicons name="location-outline" size={18} color={colors.textTertiary} />
        <TextInput
          style={styles.input}
          value={query}
          onChangeText={type}
          placeholder="Search a place…"
          placeholderTextColor={colors.placeholder}
          autoFocus
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={onClose}
        />
        {loading ? <ActivityIndicator size="small" color={colors.textTertiary} /> : null}
        {!!query && !loading ? (
          <Pressable hitSlop={8} onPress={() => type('')}>
            <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
          </Pressable>
        ) : null}
      </View>

      {results.length > 0 ? (
        <View style={styles.results}>
          {results.map((r) => (
            <Pressable key={r.key} style={styles.resultRow} onPress={() => pick(r)}>
              <Ionicons name="location-outline" size={16} color={colors.textTertiary} style={{ marginTop: 1 }} />
              <Text style={styles.resultText} numberOfLines={2}>{r.label}</Text>
            </Pressable>
          ))}
          <Text style={styles.attribution}>Results © OpenStreetMap contributors</Text>
        </View>
      ) : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.sm,
  },
  input: {
    flex: 1,
    ...typography.body,
    color: colors.text,
    padding: 0,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null),
  },
  results: { marginBottom: spacing.md },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  resultText: { flex: 1, ...typography.body, color: colors.text },
  attribution: { ...typography.caption, color: colors.textTertiary, marginTop: spacing.sm, paddingHorizontal: spacing.xs },
});

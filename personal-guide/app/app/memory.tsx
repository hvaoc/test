import type { ReactNode } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useMemory } from '../lib/store';
import type { Profile } from '../lib/types';
import { colors, radius, space } from '../lib/theme';

// "What Cairn remembers" — the trust surface. Everything is inspectable and
// deletable; nothing the guide knows is hidden from the user.
export default function Memory() {
  const { state, deleteFact, toggleFollowUp, reset } = useMemory();
  const { profile, facts, followUps } = state;

  const confirmReset = () => {
    const doReset = () => reset();
    if (Platform.OS === 'web') {
      // RN Web has no Alert dialog buttons — confirm() is the pragmatic path.
      // eslint-disable-next-line no-alert
      if (typeof window !== 'undefined' && window.confirm('Forget everything and start over?')) doReset();
      return;
    }
    Alert.alert('Forget everything?', 'This deletes your profile, memories, and chat on this device.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Forget all', style: 'destructive', onPress: doReset },
    ]);
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.intro}>
        This is everything I know about you. It lives only on your device and is never shared.
        Delete anything that's wrong or you'd rather I forget.
      </Text>

      <Section title="Profile">
        {profileRows(profile).length ? (
          profileRows(profile).map(([k, v]) => (
            <View key={k} style={styles.profileRow}>
              <Text style={styles.profileKey}>{k}</Text>
              <Text style={styles.profileVal}>{v}</Text>
            </View>
          ))
        ) : (
          <Empty>Nothing yet — keep chatting and I'll learn.</Empty>
        )}
      </Section>

      <Section title={`Things I remember (${facts.length})`}>
        {facts.length ? (
          [...facts].reverse().map((f) => (
            <View key={f.id} style={styles.factRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.factText}>{f.text}</Text>
                <Text style={styles.factMeta}>
                  {f.category} · {f.source}
                </Text>
              </View>
              <Pressable onPress={() => deleteFact(f.id)} hitSlop={8}>
                <Text style={styles.delete}>Delete</Text>
              </Pressable>
            </View>
          ))
        ) : (
          <Empty>No memories captured yet.</Empty>
        )}
      </Section>

      <Section title={`Open loops (${followUps.filter((f) => !f.done).length})`}>
        {followUps.length ? (
          [...followUps].reverse().map((f) => (
            <Pressable key={f.id} style={styles.factRow} onPress={() => toggleFollowUp(f.id)}>
              <Text style={[styles.factText, { flex: 1 }, f.done && styles.done]}>
                {f.done ? '✓ ' : '○ '}
                {f.text}
                {f.dueHint ? `  ·  ${f.dueHint}` : ''}
              </Text>
            </Pressable>
          ))
        ) : (
          <Empty>No follow-ups yet. I'll add these as life happens.</Empty>
        )}
      </Section>

      <Pressable style={styles.resetBtn} onPress={confirmReset}>
        <Text style={styles.resetText}>Forget everything</Text>
      </Pressable>
    </ScrollView>
  );
}

function profileRows(p: Profile): [string, string][] {
  const rows: [string, string][] = [];
  if (p.name) rows.push(['Name', p.name]);
  if (p.age) rows.push(['Age', p.age]);
  if (p.occupation) rows.push(['Work', p.occupation]);
  if (p.education) rows.push(['Education', p.education]);
  if (p.location) rows.push(['Location', p.location]);
  if (p.interests.length) rows.push(['Interests', p.interests.join(', ')]);
  if (p.goals.length) rows.push(['Goals', p.goals.join(', ')]);
  return rows;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <Text style={styles.empty}>{children}</Text>;
}

const styles = StyleSheet.create({
  container: { padding: space.md, paddingBottom: space.lg * 2 },
  intro: { color: colors.muted, fontSize: 14, lineHeight: 20, marginBottom: space.md },
  section: { marginBottom: space.lg },
  sectionTitle: { color: colors.text, fontSize: 16, fontWeight: '800', marginBottom: space.sm },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.sm,
  },
  profileRow: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md },
  profileKey: { color: colors.muted, fontSize: 14 },
  profileVal: { color: colors.text, fontSize: 14, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  factRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  factText: { color: colors.text, fontSize: 15, lineHeight: 20 },
  factMeta: { color: colors.muted, fontSize: 12, marginTop: 2 },
  done: { color: colors.muted, textDecorationLine: 'line-through' },
  delete: { color: colors.danger, fontSize: 13, fontWeight: '600' },
  empty: { color: colors.muted, fontSize: 14, fontStyle: 'italic' },
  resetBtn: {
    borderColor: colors.danger,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: space.sm + 2,
    alignItems: 'center',
  },
  resetText: { color: colors.danger, fontWeight: '700', fontSize: 15 },
});

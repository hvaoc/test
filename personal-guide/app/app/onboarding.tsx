import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useMemory } from '../lib/store';
import { EMPTY_PROFILE, type FactCategory, type Profile } from '../lib/types';
import { colors, radius, space } from '../lib/theme';

function splitList(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

export default function Onboarding() {
  const { completeOnboarding } = useMemory();
  const router = useRouter();

  const [name, setName] = useState('');
  const [age, setAge] = useState('');
  const [occupation, setOccupation] = useState('');
  const [education, setEducation] = useState('');
  const [location, setLocation] = useState('');
  const [interests, setInterests] = useState('');
  const [goals, setGoals] = useState('');

  const onStart = () => {
    const profile: Profile = {
      ...EMPTY_PROFILE,
      name: name.trim() || undefined,
      age: age.trim() || undefined,
      occupation: occupation.trim() || undefined,
      education: education.trim() || undefined,
      location: location.trim() || undefined,
      interests: splitList(interests),
      goals: splitList(goals),
    };

    // Seed memory so the very first chat is already grounded.
    const seed: { text: string; category: FactCategory }[] = [];
    for (const g of profile.goals) seed.push({ text: `Wants help with: ${g}`, category: 'goal' });
    for (const i of profile.interests) seed.push({ text: `Interested in ${i}`, category: 'preference' });

    completeOnboarding(profile, seed);
    router.replace('/chat');
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>I'm Cairn — your personal guide.</Text>
        <Text style={styles.sub}>
          Tell me a little about you so my advice actually fits your life. This stays private
          on your device — you can edit or delete anything later.
        </Text>

        <Field label="What should I call you?" value={name} onChange={setName} placeholder="e.g. Alex" />
        <Field label="Age" value={age} onChange={setAge} placeholder="e.g. 27" keyboardType="number-pad" />
        <Field label="What do you do?" value={occupation} onChange={setOccupation} placeholder="Work / studies" />
        <Field label="Education" value={education} onChange={setEducation} placeholder="e.g. CS degree" />
        <Field label="Where are you based?" value={location} onChange={setLocation} placeholder="City / country" />
        <Field
          label="Interests (comma-separated)"
          value={interests}
          onChange={setInterests}
          placeholder="climbing, jazz, cooking"
        />
        <Field
          label="What do you want help with right now?"
          value={goals}
          onChange={setGoals}
          placeholder="exam in Sept, dating, switching jobs"
          multiline
        />

        <Pressable style={styles.button} onPress={onStart}>
          <Text style={styles.buttonText}>Start talking →</Text>
        </Pressable>
        <Text style={styles.fine}>
          You can skip anything. The more I know, the more useful I get over time.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  keyboardType?: 'default' | 'number-pad';
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{props.label}</Text>
      <TextInput
        style={[styles.input, props.multiline && styles.inputMultiline]}
        value={props.value}
        onChangeText={props.onChange}
        placeholder={props.placeholder}
        placeholderTextColor={colors.muted}
        multiline={props.multiline}
        keyboardType={props.keyboardType ?? 'default'}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: space.lg, gap: space.sm, paddingBottom: space.lg * 2 },
  title: { color: colors.text, fontSize: 24, fontWeight: '800', marginBottom: space.xs },
  sub: { color: colors.muted, fontSize: 15, lineHeight: 21, marginBottom: space.md },
  field: { marginBottom: space.sm },
  label: { color: colors.text, fontSize: 14, fontWeight: '600', marginBottom: space.xs },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    color: colors.text,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    fontSize: 16,
  },
  inputMultiline: { minHeight: 80, textAlignVertical: 'top' },
  button: {
    backgroundColor: colors.user,
    borderRadius: radius.md,
    paddingVertical: space.md,
    alignItems: 'center',
    marginTop: space.md,
  },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  fine: { color: colors.muted, fontSize: 12, textAlign: 'center', marginTop: space.sm },
});

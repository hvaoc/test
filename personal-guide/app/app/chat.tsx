import { Link, Stack } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { chat as chatApi, extract as extractApi } from '../lib/api';
import { useMemory } from '../lib/store';
import type { ChatMessage } from '../lib/types';
import { colors, radius, space } from '../lib/theme';

export default function Chat() {
  const { state, getState, addMessage, applyExtraction } = useMemory();
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [offline, setOffline] = useState(false);
  const listRef = useRef<FlatList<ChatMessage>>(null);

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
  }, []);

  const onSend = async () => {
    const text = input.trim();
    if (!text || sending) return;

    const base = getState(); // capture profile/facts/followUps before mutating
    setInput('');
    setSending(true);
    const userMsg = addMessage('user', text);

    try {
      const res = await chatApi({
        profile: base.profile,
        facts: base.facts,
        followUps: base.followUps,
        messages: [...base.messages, userMsg],
      });
      setOffline(res.mock);
      addMessage('assistant', res.reply);

      // REMEMBER: extract durable memory from this exchange (non-blocking).
      extractApi({ profile: base.profile, userMessage: text, assistantMessage: res.reply })
        .then(applyExtraction)
        .catch(() => {});
    } catch {
      addMessage(
        'assistant',
        "I couldn't reach my brain just now. Make sure the Expo dev server is running, then try again.",
      );
    } finally {
      setSending(false);
    }
  };

  const openFollowUps = state.followUps.filter((f) => !f.done);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      <Stack.Screen
        options={{
          headerRight: () => (
            <Link href="/memory" style={styles.memoryLink}>
              🧠 Memory
            </Link>
          ),
        }}
      />

      {offline && (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>
            Offline demo mode — set ANTHROPIC_API_KEY for full frontier-LLM responses.
          </Text>
        </View>
      )}

      <FlatList
        ref={listRef}
        data={state.messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={styles.list}
        onContentSizeChange={scrollToEnd}
        ListHeaderComponent={
          state.messages.length === 0 ? (
            <Welcome name={state.profile.name} followUp={openFollowUps[0]?.text} />
          ) : null
        }
        renderItem={({ item }) => <Bubble message={item} />}
      />

      {sending && (
        <View style={styles.typing}>
          <ActivityIndicator color={colors.accent} size="small" />
          <Text style={styles.typingText}>Cairn is thinking…</Text>
        </View>
      )}

      <View style={styles.inputBar}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Tell Cairn what's going on…"
          placeholderTextColor={colors.muted}
          multiline
          onSubmitEditing={onSend}
        />
        <Pressable style={[styles.send, (!input.trim() || sending) && styles.sendDisabled]} onPress={onSend}>
          <Text style={styles.sendText}>Send</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function Welcome({ name, followUp }: { name?: string; followUp?: string }) {
  return (
    <View style={styles.welcome}>
      <Text style={styles.welcomeTitle}>{name ? `Hi ${name} 👋` : 'Hi 👋'}</Text>
      <Text style={styles.welcomeText}>
        I remember our context, so you don't have to re-explain yourself. What's on your mind?
      </Text>
      {followUp ? <Text style={styles.welcomeFollow}>Last time: {followUp}</Text> : null}
    </View>
  );
}

function Bubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <View style={[styles.row, isUser ? styles.rowUser : styles.rowGuide]}>
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleGuide]}>
        <Text style={isUser ? styles.bubbleTextUser : styles.bubbleTextGuide}>{message.text}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  memoryLink: { color: colors.accent, fontWeight: '700', paddingHorizontal: space.sm },
  banner: { backgroundColor: colors.accentSoft, paddingVertical: space.xs, paddingHorizontal: space.md },
  bannerText: { color: colors.text, fontSize: 12, textAlign: 'center' },
  list: { padding: space.md, gap: space.sm, flexGrow: 1 },
  welcome: { padding: space.md, marginBottom: space.sm },
  welcomeTitle: { color: colors.text, fontSize: 22, fontWeight: '800', marginBottom: space.xs },
  welcomeText: { color: colors.muted, fontSize: 15, lineHeight: 22 },
  welcomeFollow: { color: colors.accent, fontSize: 13, marginTop: space.sm },
  row: { flexDirection: 'row' },
  rowUser: { justifyContent: 'flex-end' },
  rowGuide: { justifyContent: 'flex-start' },
  bubble: { maxWidth: '85%', borderRadius: radius.lg, paddingHorizontal: space.md, paddingVertical: space.sm },
  bubbleUser: { backgroundColor: colors.user, borderBottomRightRadius: radius.sm },
  bubbleGuide: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderBottomLeftRadius: radius.sm },
  bubbleTextUser: { color: '#fff', fontSize: 16, lineHeight: 22 },
  bubbleTextGuide: { color: colors.text, fontSize: 16, lineHeight: 22 },
  typing: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingHorizontal: space.md, paddingBottom: space.xs },
  typingText: { color: colors.muted, fontSize: 13 },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    padding: space.sm,
    borderTopColor: colors.border,
    borderTopWidth: 1,
    backgroundColor: colors.surface,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    color: colors.text,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    fontSize: 16,
  },
  send: { backgroundColor: colors.user, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm + 2 },
  sendDisabled: { opacity: 0.5 },
  sendText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});

// On-device, per-user private memory store. Persisted to AsyncStorage and never
// uploaded — it is attached to a single LLM request as transient context only.
import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  EMPTY_MEMORY,
  type ChatMessage,
  type ChatRole,
  type ExtractResponse,
  type FactCategory,
  type MemoryState,
  type Profile,
} from './types';
import { uid } from './id';

const STORAGE_KEY = 'cairn.memory.v1';

type SeedFact = { text: string; category: FactCategory };

type MemoryApi = {
  ready: boolean;
  state: MemoryState;
  /** Latest state, read synchronously (avoids setState race during chat sends). */
  getState: () => MemoryState;
  completeOnboarding: (profile: Profile, seedFacts: SeedFact[]) => void;
  addMessage: (role: ChatRole, text: string) => ChatMessage;
  applyExtraction: (e: ExtractResponse) => void;
  deleteFact: (id: string) => void;
  toggleFollowUp: (id: string) => void;
  reset: () => void;
};

const MemoryContext = createContext<MemoryApi | null>(null);

function dedupe(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const k = x.trim().toLowerCase();
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(x.trim());
    }
  }
  return out;
}

function applyExtraction(s: MemoryState, e: ExtractResponse): MemoryState {
  const profile: Profile = { ...s.profile };
  const p = e.profilePatch ?? {};
  if (p.name) profile.name = p.name;
  if (p.age) profile.age = p.age;
  if (p.occupation) profile.occupation = p.occupation;
  if (p.education) profile.education = p.education;
  if (p.location) profile.location = p.location;
  if (p.interests?.length) profile.interests = dedupe([...profile.interests, ...p.interests]);
  if (p.goals?.length) profile.goals = dedupe([...profile.goals, ...p.goals]);

  const knownFacts = new Set(s.facts.map((f) => f.text.toLowerCase()));
  const facts = [...s.facts];
  for (const f of e.facts ?? []) {
    const text = (f.text ?? '').trim();
    if (text && !knownFacts.has(text.toLowerCase())) {
      knownFacts.add(text.toLowerCase());
      facts.push({ id: uid('f_'), text, category: f.category ?? 'other', source: 'chat', createdAt: Date.now() });
    }
  }

  const knownFu = new Set(s.followUps.map((f) => f.text.toLowerCase()));
  const followUps = [...s.followUps];
  for (const f of e.followUps ?? []) {
    const text = (f.text ?? '').trim();
    if (text && !knownFu.has(text.toLowerCase())) {
      knownFu.add(text.toLowerCase());
      followUps.push({ id: uid('u_'), text, dueHint: f.dueHint, createdAt: Date.now(), done: false });
    }
  }

  return { ...s, profile, facts, followUps };
}

export function MemoryProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<MemoryState>(EMPTY_MEMORY);
  const ref = useRef(state);
  ref.current = state;

  // Hydrate once.
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) setState({ ...EMPTY_MEMORY, ...JSON.parse(raw) });
      } catch {
        // Corrupt/empty store — start fresh.
      }
      setReady(true);
    })();
  }, []);

  // Persist on every change (after hydration).
  useEffect(() => {
    if (ready) AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state)).catch(() => {});
  }, [state, ready]);

  const api = useMemo<MemoryApi>(() => {
    const update = (fn: (s: MemoryState) => MemoryState) => setState((s) => fn(s));
    return {
      ready,
      state,
      getState: () => ref.current,
      completeOnboarding: (profile, seedFacts) =>
        update((s) => ({
          ...s,
          onboarded: true,
          profile,
          facts: [
            ...s.facts,
            ...seedFacts
              .filter((f) => f.text.trim())
              .map((f) => ({
                id: uid('f_'),
                text: f.text.trim(),
                category: f.category,
                source: 'onboarding' as const,
                createdAt: Date.now(),
              })),
          ],
        })),
      addMessage: (role, text) => {
        const msg: ChatMessage = { id: uid('m_'), role, text, ts: Date.now() };
        update((s) => ({ ...s, messages: [...s.messages, msg] }));
        return msg;
      },
      applyExtraction: (e) => update((s) => applyExtraction(s, e)),
      deleteFact: (id) => update((s) => ({ ...s, facts: s.facts.filter((f) => f.id !== id) })),
      toggleFollowUp: (id) =>
        update((s) => ({
          ...s,
          followUps: s.followUps.map((f) => (f.id === id ? { ...f, done: !f.done } : f)),
        })),
      reset: () => update(() => EMPTY_MEMORY),
    };
  }, [ready, state]);

  return <MemoryContext.Provider value={api}>{children}</MemoryContext.Provider>;
}

export function useMemory(): MemoryApi {
  const ctx = useContext(MemoryContext);
  if (!ctx) throw new Error('useMemory must be used within <MemoryProvider>');
  return ctx;
}

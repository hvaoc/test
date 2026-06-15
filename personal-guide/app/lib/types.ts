// Shared types for Cairn's memory model. Pure types only — safe to import on
// both the client and the server API routes.

export type FactCategory =
  | 'identity'
  | 'relationship'
  | 'goal'
  | 'event'
  | 'preference'
  | 'other';

/** Slow-changing core facts about who the user is. */
export type Profile = {
  name?: string;
  age?: string;
  occupation?: string;
  education?: string;
  location?: string;
  interests: string[];
  goals: string[];
};

/** A single durable thing Cairn remembers, with provenance. */
export type MemoryFact = {
  id: string;
  text: string;
  category: FactCategory;
  source: 'onboarding' | 'chat';
  createdAt: number;
};

/** An open loop the guide should proactively resurface. */
export type FollowUp = {
  id: string;
  text: string;
  dueHint?: string;
  createdAt: number;
  done: boolean;
};

export type ChatRole = 'user' | 'assistant';

export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  ts: number;
};

/** The complete on-device, per-user private memory. Never leaves the device
 *  except as transient context attached to a single LLM request. */
export type MemoryState = {
  onboarded: boolean;
  profile: Profile;
  facts: MemoryFact[];
  followUps: FollowUp[];
  messages: ChatMessage[];
};

export const EMPTY_PROFILE: Profile = {
  interests: [],
  goals: [],
};

export const EMPTY_MEMORY: MemoryState = {
  onboarded: false,
  profile: EMPTY_PROFILE,
  facts: [],
  followUps: [],
  messages: [],
};

// ---- Wire shapes shared by client <-> server API routes ----

/** What the client sends to /api/chat — a transient snapshot of memory used to
 *  ground this one reply. The server is stateless and stores none of it. */
export type ChatRequest = {
  profile: Profile;
  facts: MemoryFact[];
  followUps: FollowUp[];
  messages: ChatMessage[];
};

export type ChatResponse = {
  reply: string;
  /** true when answered by the deterministic mock (no API key configured). */
  mock: boolean;
};

export type ExtractRequest = {
  profile: Profile;
  userMessage: string;
  assistantMessage: string;
};

/** Memory updates proposed by the extraction pass. The client decides what to
 *  persist — extraction is always inspectable, never silent. */
export type ExtractResponse = {
  profilePatch: Partial<Pick<Profile, 'name' | 'age' | 'occupation' | 'education' | 'location'>> & {
    interests?: string[];
    goals?: string[];
  };
  facts: { text: string; category: FactCategory }[];
  followUps: { text: string; dueHint?: string }[];
  mock: boolean;
};

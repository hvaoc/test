// Pure prompt builders. No side effects, no secrets — safe to import anywhere.
import type { ChatRequest, Profile, MemoryFact, FollowUp } from './types';

function profileLines(p: Profile): string[] {
  const lines: string[] = [];
  if (p.name) lines.push(`Name: ${p.name}`);
  if (p.age) lines.push(`Age: ${p.age}`);
  if (p.occupation) lines.push(`Work: ${p.occupation}`);
  if (p.education) lines.push(`Education: ${p.education}`);
  if (p.location) lines.push(`Location: ${p.location}`);
  if (p.interests.length) lines.push(`Interests: ${p.interests.join(', ')}`);
  if (p.goals.length) lines.push(`Goals: ${p.goals.join(', ')}`);
  return lines;
}

/** Render the user's private memory into the grounding block for a chat turn. */
export function renderMemory(
  profile: Profile,
  facts: MemoryFact[],
  followUps: FollowUp[],
): string {
  const sections: string[] = [];

  const pl = profileLines(profile);
  sections.push(pl.length ? `PROFILE\n${pl.join('\n')}` : 'PROFILE\n(nothing yet)');

  if (facts.length) {
    const lines = facts
      .slice(-40)
      .map((f) => `- [${f.category}] ${f.text}`)
      .join('\n');
    sections.push(`THINGS I REMEMBER\n${lines}`);
  }

  const open = followUps.filter((f) => !f.done);
  if (open.length) {
    const lines = open
      .map((f) => `- ${f.text}${f.dueHint ? ` (${f.dueHint})` : ''}`)
      .join('\n');
    sections.push(`OPEN LOOPS TO FOLLOW UP ON\n${lines}`);
  }

  return sections.join('\n\n');
}

export const CHAT_SYSTEM_PREAMBLE = `You are Cairn, a warm, sharp personal guide who genuinely knows this one person.
You are NOT a generic assistant. You have an ongoing relationship with them and a
private memory of their life, shown below.

How to be a great guide:
- Ground every reply in what you remember. Be specific to THEIR situation; never give
  generic, lowest-common-denominator advice.
- Don't re-ask things you already know. Use the profile.
- If an open loop is relevant, bring it up naturally ("how did that go?").
- Be concise and human. Encourage, but be honest. You are a guide, not a yes-man.
- You are not a doctor, lawyer, or therapist. For crisis or clinical matters, gently
  encourage reaching out to a qualified professional or a helpline.

Everything below is private to this user and never shared with anyone else.`;

export function buildChatSystem(req: ChatRequest): string {
  return `${CHAT_SYSTEM_PREAMBLE}\n\n=== PRIVATE MEMORY ===\n${renderMemory(
    req.profile,
    req.facts,
    req.followUps,
  )}\n=== END MEMORY ===`;
}

export const EXTRACT_SYSTEM = `You extract durable memory from a single exchange between a user and their personal
guide. Return STRICT JSON only — no prose, no markdown fences.

Schema:
{
  "profilePatch": { "name"?, "age"?, "occupation"?, "education"?, "location"?,
                    "interests"?: string[], "goals"?: string[] },
  "facts": [ { "text": string, "category": "identity"|"relationship"|"goal"|"event"|"preference"|"other" } ],
  "followUps": [ { "text": string, "dueHint"?: string } ]
}

Rules:
- Only include genuinely NEW, durable information worth remembering long-term.
- "facts" are concise, third-person statements ("Studying for an actuarial exam in September").
- "followUps" are open loops the guide should resurface later ("Ask how the Monday interview went").
- interests/goals in profilePatch are additive lists of short phrases.
- If nothing is worth saving, return {"profilePatch":{},"facts":[],"followUps":[]}.`;

export function buildExtractUser(userMessage: string, assistantMessage: string): string {
  return `USER SAID:\n${userMessage}\n\nGUIDE REPLIED:\n${assistantMessage}\n\nReturn the JSON now.`;
}

// Server-only deterministic fallback used when no ANTHROPIC_API_KEY is set, so
// the app is ALWAYS demoable. The mock is intentionally simple but still
// "grounds" replies in the profile and grows memory via keyword heuristics, so
// the core loop (ground -> respond -> remember) is visible without any key.
import type { ChatRequest, ExtractResponse, FactCategory } from './types';

export function mockChatReply(req: ChatRequest): string {
  const last = [...req.messages].reverse().find((m) => m.role === 'user');
  const userText = last?.text ?? '';
  const name = req.profile.name ? `, ${req.profile.name}` : '';

  // Reference an open loop if one exists — demonstrates proactive follow-up.
  const open = req.followUps.find((f) => !f.done);
  const followUp = open ? ` Also — last time you mentioned "${open.text}". How's that going?` : '';

  // Reference a known goal/interest to show grounding.
  const goal = req.profile.goals[0];
  const grounded = goal
    ? ` Given your goal around "${goal}", here's a focused way to think about it.`
    : '';

  const reflection = userText
    ? `You said: "${truncate(userText, 140)}".`
    : `Tell me what's on your mind.`;

  return (
    `Hey${name} — I'm running in offline demo mode (no API key set), but I still ` +
    `remember you.${grounded} ${reflection} A real frontier model would reason on ` +
    `this in your full context; for now, here's a starting point: break it into the ` +
    `smallest next step you can take today, and tell me how it goes.${followUp}`
  ).trim();
}

const NAME_RE = /\b(?:my name is|i am|i'm|im)\s+([A-Z][a-z]+)\b/i;
const AGE_RE = /\b(\d{1,2})\s*(?:years old|yrs|yo)\b/i;

export function mockExtract(userMessage: string, assistantMessage: string): ExtractResponse {
  const text = userMessage.toLowerCase();
  const facts: { text: string; category: FactCategory }[] = [];
  const followUps: { text: string; dueHint?: string }[] = [];
  const profilePatch: ExtractResponse['profilePatch'] = {};

  const nameMatch = userMessage.match(NAME_RE);
  if (nameMatch) profilePatch.name = nameMatch[1];

  const ageMatch = userMessage.match(AGE_RE);
  if (ageMatch) profilePatch.age = ageMatch[1];

  if (/\b(exam|test|study|studying|revision|syllabus)\b/.test(text)) {
    facts.push({ text: `Is preparing for an exam (from: "${truncate(userMessage, 80)}")`, category: 'goal' });
    followUps.push({ text: 'Ask how exam prep is going', dueHint: 'soon' });
  }
  if (/\b(date|dating|crush|relationship|girlfriend|boyfriend|partner|tinder|hinge|bumble)\b/.test(text)) {
    facts.push({ text: `Mentioned something about dating / a relationship`, category: 'relationship' });
    followUps.push({ text: 'Ask how things went with the person they mentioned' });
  }
  if (/\b(job|interview|career|promotion|resume|cv|salary|offer)\b/.test(text)) {
    facts.push({ text: `Mentioned a job / career situation`, category: 'goal' });
    followUps.push({ text: 'Ask how the job/interview situation progressed' });
  }
  if (/\b(wedding|baby|moving|move|funeral|graduation|exam day)\b/.test(text)) {
    facts.push({ text: `Mentioned an upcoming life event`, category: 'event' });
  }

  return { profilePatch, facts, followUps, mock: true };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// Serverless function: POST /api/extract
// Pulls durable memory out of the latest exchange. Returns proposed updates;
// the client decides what to persist (extraction is inspectable, not silent).
import type { ExtractRequest, ExtractResponse } from '../../lib/types';
import { EXTRACT_SYSTEM, buildExtractUser } from '../../lib/prompts';
import { anthropicMessage, hasApiKey, MODELS } from '../../lib/llm.server';
import { mockExtract } from '../../lib/mock.server';

const EMPTY: ExtractResponse = { profilePatch: {}, facts: [], followUps: [], mock: false };

export async function POST(request: Request): Promise<Response> {
  let body: ExtractRequest;
  try {
    body = (await request.json()) as ExtractRequest;
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const userMessage = body.userMessage ?? '';
  const assistantMessage = body.assistantMessage ?? '';

  if (!hasApiKey()) {
    return Response.json(mockExtract(userMessage, assistantMessage));
  }

  try {
    const raw = await anthropicMessage({
      model: MODELS.extract,
      system: EXTRACT_SYSTEM,
      messages: [{ role: 'user', content: buildExtractUser(userMessage, assistantMessage) }],
      maxTokens: 512,
    });
    const parsed = safeParse(raw);
    return Response.json({ ...EMPTY, ...parsed, mock: false } satisfies ExtractResponse);
  } catch {
    // Degrade to the heuristic extractor rather than dropping the memory loop.
    return Response.json(mockExtract(userMessage, assistantMessage));
  }
}

/** Tolerant JSON parse — strips accidental markdown fences and trailing prose. */
function safeParse(raw: string): Partial<ExtractResponse> {
  const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return {};
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1));
    return {
      profilePatch: obj.profilePatch ?? {},
      facts: Array.isArray(obj.facts) ? obj.facts : [],
      followUps: Array.isArray(obj.followUps) ? obj.followUps : [],
    };
  } catch {
    return {};
  }
}

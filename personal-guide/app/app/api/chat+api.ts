// Serverless function: POST /api/chat
// Grounds a reply in the user's private memory and answers as their guide.
// Runs the frontier model when ANTHROPIC_API_KEY is set; otherwise a mock.
import type { ChatRequest, ChatResponse } from '../../lib/types';
import { buildChatSystem } from '../../lib/prompts';
import { anthropicMessage, hasApiKey, MODELS } from '../../lib/llm.server';
import { mockChatReply } from '../../lib/mock.server';

export async function POST(request: Request): Promise<Response> {
  let body: ChatRequest;
  try {
    body = (await request.json()) as ChatRequest;
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }

  if (!Array.isArray(body.messages)) {
    return Response.json({ error: 'messages[] required' }, { status: 400 });
  }

  if (!hasApiKey()) {
    const reply = mockChatReply(body);
    return Response.json({ reply, mock: true } satisfies ChatResponse);
  }

  try {
    const system = buildChatSystem(body);
    const reply = await anthropicMessage({
      model: MODELS.chat,
      system,
      // Keep a bounded window of recent turns for the conversational thread.
      messages: body.messages.slice(-20).map((m) => ({ role: m.role, content: m.text })),
      maxTokens: 1024,
    });
    return Response.json({ reply, mock: false } satisfies ChatResponse);
  } catch (err) {
    // Never break the demo: fall back to the mock on any upstream failure.
    const reply = mockChatReply(body);
    return Response.json({ reply, mock: true } satisfies ChatResponse);
  }
}

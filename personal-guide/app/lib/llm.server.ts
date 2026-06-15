// Server-only. Calls the Anthropic Messages API via fetch (no SDK dependency).
// Imported ONLY by the API routes (app/api/*+api.ts) so the key never reaches
// the client bundle. If ANTHROPIC_API_KEY is unset, callers fall back to mocks.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Tiered model strategy (see docs/PRODUCT.md §11):
//   - chat:    everyday conversational guide
//   - extract: high-volume, cheap memory extraction
export const MODELS = {
  chat: 'claude-sonnet-4-6',
  extract: 'claude-haiku-4-5-20251001',
} as const;

export function hasApiKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

type Msg = { role: 'user' | 'assistant'; content: string };

export async function anthropicMessage(opts: {
  model: string;
  system: string;
  messages: Msg[];
  maxTokens?: number;
}): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 1024,
      system: opts.system,
      messages: opts.messages,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Anthropic API error ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = (data.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim();
  return text;
}

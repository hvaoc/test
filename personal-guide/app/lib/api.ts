// Client-side calls to the serverless API routes. Resolves the dev-server origin
// so the same code works on web (relative) and native (full origin).
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import type { ChatRequest, ChatResponse, ExtractRequest, ExtractResponse } from './types';

function apiBase(): string {
  if (Platform.OS === 'web') return '';
  // On native, hit the Expo dev server that hosts the API routes, e.g. "10.0.0.4:8081".
  const hostUri = Constants.expoConfig?.hostUri;
  if (hostUri) return `http://${hostUri.split('/')[0]}`;
  return '';
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

export function chat(req: ChatRequest): Promise<ChatResponse> {
  return postJson<ChatResponse>('/api/chat', req);
}

export function extract(req: ExtractRequest): Promise<ExtractResponse> {
  return postJson<ExtractResponse>('/api/extract', req);
}

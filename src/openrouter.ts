import * as vscode from 'vscode';
import { AgentMode } from './agent';
import { pickAutoModel } from './autoModel';
import { ApiKeyStore } from './apiKeyStore';
import { AUTO_MODEL_ID, ModelStore } from './models';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AskOpenRouterOptions {
  modelStore?: ModelStore;
  apiKeyStore: ApiKeyStore;
  mode?: AgentMode;
  signal?: AbortSignal;
  stream?: boolean;
  onChunk?: (delta: string, accumulated: string) => void;
}

export class AskOpenRouterAbortedError extends Error {
  constructor() {
    super('Request aborted');
    this.name = 'AskOpenRouterAbortedError';
  }
}

export function isAskOpenRouterAborted(err: unknown): boolean {
  return (
    err instanceof AskOpenRouterAbortedError ||
    (err instanceof Error && err.name === 'AbortError')
  );
}

interface OpenRouterChoice {
  message?: { content?: string };
  delta?: { content?: string };
}

interface OpenRouterResponse {
  choices?: OpenRouterChoice[];
  error?: { message?: string; code?: number };
}

export function getModels(): string[] {
  const models = vscode.workspace
    .getConfiguration('openrouterAgent')
    .get<string[]>('models', [
      'z-ai/glm-4.5-air:free',
      'openrouter/owl-alpha',
    ]);
  return models.slice(0, 3);
}

function buildRequestBody(
  messages: ChatMessage[],
  modelStore?: ModelStore,
  mode: AgentMode = 'ask'
): Record<string, unknown> {
  const selectedId = modelStore?.getSelectedModelId() ?? AUTO_MODEL_ID;

  if (selectedId !== AUTO_MODEL_ID) {
    return { model: selectedId, messages };
  }

  const available = modelStore?.getAvailableModels() ?? getModels();
  if (available.length === 0) {
    return { messages };
  }

  const lastUser =
    [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const picked = pickAutoModel(available, {
    mode,
    userMessage: lastUser,
    conversationLength: messages.length,
  });

  if (!picked) {
    return { messages };
  }
  return { model: picked, messages };
}

function formatApiError(parsed: OpenRouterResponse & { message?: string }, status: number, statusText: string): string {
  const detail =
    parsed.error?.message ??
    parsed.message ??
    `HTTP ${status} ${statusText}`;
  return `**API Error:** ${detail}`;
}

async function readSseStream(
  response: Response,
  signal: AbortSignal | undefined,
  onChunk: (delta: string, accumulated: string) => void
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let accumulated = '';

  while (true) {
    if (signal?.aborted) {
      throw new AskOpenRouterAbortedError();
    }

    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) {
        continue;
      }

      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') {
        continue;
      }

      try {
        const parsed = JSON.parse(data) as OpenRouterResponse;
        const delta =
          parsed.choices?.[0]?.delta?.content ??
          parsed.choices?.[0]?.message?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          accumulated += delta;
          onChunk(delta, accumulated);
        }
      } catch {
        /* skip malformed SSE chunk */
      }
    }
  }

  return accumulated;
}

async function readJsonCompletion(response: Response): Promise<string> {
  const parsed = (await response.json()) as OpenRouterResponse & { message?: string };
  const content = parsed.choices?.[0]?.message?.content;
  if (content === undefined || content === null) {
    return '**Error:** OpenRouter returned an empty response.';
  }
  return content;
}

export async function askOpenRouter(
  messages: ChatMessage[],
  options: AskOpenRouterOptions
): Promise<string> {
  const apiKey = await options.apiKeyStore.get();
  if (!apiKey) {
    return (
      '**Error:** No API key configured. Run **OpenRouter: Set API Key** from the Command Palette ' +
      '(Ctrl+Shift+P). Get a key at https://openrouter.ai/keys'
    );
  }

  const body = buildRequestBody(messages, options.modelStore, options.mode ?? 'ask');
  if (!('model' in body) && !('models' in body)) {
    return '**Error:** No models configured. Add a model in chat or set `openrouterAgent.models` in Settings.';
  }

  const useStream = !!(options.stream && options.onChunk);

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/openrouter-agent',
        'X-Title': 'OpenRouter Agent VS Code Extension',
      },
      body: JSON.stringify(useStream ? { ...body, stream: true } : body),
      signal: options.signal,
    });

    if (options.signal?.aborted) {
      throw new AskOpenRouterAbortedError();
    }

    const contentType = response.headers.get('content-type') ?? '';

    if (!response.ok) {
      let parsed: OpenRouterResponse & { message?: string } = {};
      try {
        parsed = (await response.json()) as OpenRouterResponse & { message?: string };
      } catch {
        /* body may not be JSON */
      }
      return formatApiError(parsed, response.status, response.statusText);
    }

    if (useStream && contentType.includes('text/event-stream')) {
      const streamed = await readSseStream(response, options.signal, options.onChunk!);
      if (options.signal?.aborted) {
        throw new AskOpenRouterAbortedError();
      }
      if (streamed.length > 0) {
        return streamed;
      }
      return '**Error:** OpenRouter returned an empty response.';
    }

    if (useStream) {
      const text = await readJsonCompletion(response);
      if (text && !text.startsWith('**Error:**') && options.onChunk) {
        options.onChunk(text, text);
      }
      return text;
    }

    const content = await readJsonCompletion(response);
    if (options.signal?.aborted) {
      throw new AskOpenRouterAbortedError();
    }
    return content;
  } catch (err) {
    if (options.signal?.aborted || isAskOpenRouterAborted(err)) {
      throw new AskOpenRouterAbortedError();
    }
    const msg = err instanceof Error ? err.message : String(err);
    return `**Network Error:** ${msg}`;
  }
}

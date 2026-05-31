import * as vscode from 'vscode';
import { ApiKeyStore } from './apiKeyStore';
import { AUTO_MODEL_ID, ModelStore } from './models';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AskOpenRouterOptions {
  modelStore?: ModelStore;
  apiKeyStore: ApiKeyStore;
}

interface OpenRouterChoice {
  message?: { content?: string };
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
      'deepseek/deepseek-v4-flash',
    ]);
  return models.slice(0, 3);
}

function buildRequestBody(
  messages: ChatMessage[],
  modelStore?: ModelStore
): Record<string, unknown> {
  const selectedId = modelStore?.getSelectedModelId() ?? AUTO_MODEL_ID;

  if (selectedId !== AUTO_MODEL_ID) {
    return { model: selectedId, messages };
  }

  const fallbacks = modelStore?.getFallbackModels() ?? getModels();
  if (fallbacks.length === 0) {
    return { messages };
  }
  return { models: fallbacks.slice(0, 3), messages };
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

  const body = buildRequestBody(messages, options.modelStore);
  if (!('model' in body) && !('models' in body)) {
    return '**Error:** No models configured. Add a model in chat or set `openrouterAgent.models` in Settings.';
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/openrouter-agent',
        'X-Title': 'OpenRouter Agent VS Code Extension',
      },
      body: JSON.stringify(body),
    });

    const parsed = (await response.json()) as OpenRouterResponse & { message?: string };

    if (!response.ok) {
      const detail =
        parsed.error?.message ??
        parsed.message ??
        `HTTP ${response.status} ${response.statusText}`;
      return `**API Error:** ${detail}`;
    }

    const content = parsed.choices?.[0]?.message?.content;
    if (content === undefined || content === null) {
      return '**Error:** OpenRouter returned an empty response.';
    }

    return content;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `**Network Error:** ${msg}`;
  }
}

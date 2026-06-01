import { AgentMode } from './agent';
import { pickAutoModelForRequest } from './autoModel';
import { ApiKeyStore } from './apiKeyStore';
import {
  AUTO_MODEL_ID,
  DEFAULT_POOL_SEED_IDS,
  MIN_AUTO_POOL_SIZE,
  ModelStore,
} from './models';

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }
  | { type: 'file'; file: { filename: string; file_data: string } };

export type MessageContent = string | ContentPart[];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: MessageContent;
}

export interface AskOpenRouterOptions {
  modelStore?: ModelStore;
  apiKeyStore: ApiKeyStore;
  mode?: AgentMode;
  hasVisionAttachments?: boolean;
  signal?: AbortSignal;
  stream?: boolean;
  onChunk?: (delta: string, accumulated: string) => void;
}

/** Extract plain text from message content for heuristics and history display. */
export function messageContentToText(content: MessageContent): string {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
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

interface OpenRouterErrorMetadata {
  provider_name?: string;
  raw?: unknown;
}

interface OpenRouterResponse {
  choices?: OpenRouterChoice[];
  error?: {
    message?: string;
    code?: number;
    metadata?: OpenRouterErrorMetadata;
  };
}

export function getModels(): string[] {
  return DEFAULT_POOL_SEED_IDS.slice(0, MIN_AUTO_POOL_SIZE);
}

function buildRequestBody(
  messages: ChatMessage[],
  modelStore?: ModelStore,
  mode: AgentMode = 'ask',
  hasVisionAttachments = false
): Record<string, unknown> {
  const selectedId = modelStore?.getSelectedModelId() ?? AUTO_MODEL_ID;

  if (selectedId !== AUTO_MODEL_ID) {
    return { model: selectedId, messages };
  }

  const available = modelStore?.getAutoPoolModels() ?? getModels();
  if (available.length === 0) {
    return { messages };
  }

  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  const lastUser = lastUserMsg ? messageContentToText(lastUserMsg.content) : '';
  const picked = pickAutoModelForRequest(available, {
    mode,
    userMessage: lastUser,
    conversationLength: messages.length,
    hasVisionAttachments: hasVisionAttachments ?? false,
  });

  if (!picked) {
    return { messages };
  }
  return { model: picked, messages };
}

/** Pull a human-readable message from OpenRouter error.metadata.raw. */
function extractRawMessage(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      return undefined;
    }
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        return extractRawMessage(parsed) ?? trimmed;
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.message === 'string' && obj.message.trim()) {
      return obj.message.trim();
    }
    if (obj.error !== undefined) {
      const nested = extractRawMessage(obj.error);
      if (nested) {
        return nested;
      }
    }
    if (typeof obj.detail === 'string' && obj.detail.trim()) {
      return obj.detail.trim();
    }
  }
  return undefined;
}

function extractApiErrorDetail(
  parsed: OpenRouterResponse & { message?: string },
  status: number,
  statusText: string
): string {
  const top =
    parsed.error?.message ??
    parsed.message ??
    `HTTP ${status} ${statusText}`;
  const metadata = parsed.error?.metadata;
  const providerName = metadata?.provider_name?.trim();
  const rawMsg =
    metadata?.raw !== undefined ? extractRawMessage(metadata.raw) : undefined;

  if (rawMsg && rawMsg !== top && !top.toLowerCase().includes(rawMsg.toLowerCase())) {
    return providerName ? `[${providerName}] ${rawMsg}` : rawMsg;
  }
  if (providerName && /provider returned error/i.test(top)) {
    return `[${providerName}] ${top}`;
  }
  return top;
}

function formatModelIdForError(modelId: string): string {
  return modelId.length > 48 ? modelId.slice(0, 46) + '…' : modelId;
}

function appendProviderErrorHints(detail: string, status: number): string {
  if (/image input|vision|multimodal/i.test(detail)) {
    return (
      '\n\nSwitch to **Auto** with vision models enabled, or pick a vision-capable model (e.g. Gemini Flash, GPT-4o, Claude) from the model menu.'
    );
  }

  const d = detail.toLowerCase();
  const lines: string[] = ['\n\n**What you can try:**'];

  if (
    status === 402 ||
    /credit|balance|billing|payment|insufficient|afford/i.test(d)
  ) {
    return (
      '\n\nPaid models require a positive OpenRouter balance. Free models (names ending in `:free`, or the **Free** filter in the model menu) do not need paid credits the same way.' +
      '\n\n**What you can try:**' +
      '\n- This model is **paid** — add credits at [OpenRouter Credits](https://openrouter.ai/settings/credits) or choose a **free** model.' +
      '\n- Your API key is valid; the account balance is too low for this request.' +
      '\n- See [OpenRouter Activity](https://openrouter.ai/activity) for the exact charge attempt.'
    );
  }

  if (/rate limit|429|too many/i.test(d) || status === 429) {
    lines.push('- Wait a minute and retry, or switch to another model.');
    lines.push('- Enable **Auto** with several pool models to spread load.');
    return lines.join('\n');
  }

  if (/context|token|length|maximum/i.test(d)) {
    lines.push('- Shorten your message or start a new chat to reduce history size.');
    lines.push('- Pick a model with a larger context window.');
    return lines.join('\n');
  }

  if (
    status === 502 ||
    status === 503 ||
    status === 529 ||
    /unavailable|timeout|overloaded/i.test(d)
  ) {
    lines.push('- Temporary outage — retry in a minute.');
    lines.push('- Pick a different model from the model menu.');
    return lines.join('\n');
  }

  lines.push('- Pick a different model (this provider may be down for that model).');
  lines.push('- Enable **Auto** with several models so routing can try another on failure.');
  lines.push('- Open [OpenRouter Activity](https://openrouter.ai/activity) for the full upstream error.');
  lines.push('- Retry in a minute if this is a temporary outage.');
  return lines.join('\n');
}

function formatApiError(
  parsed: OpenRouterResponse & { message?: string },
  status: number,
  statusText: string,
  modelId?: string
): string {
  const detail = extractApiErrorDetail(parsed, status, statusText);
  const modelPrefix = modelId ? `(${formatModelIdForError(modelId)}) ` : '';
  return `**API Error:** ${modelPrefix}${detail}${appendProviderErrorHints(detail, status)}`;
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

// Maximum number of retry attempts (including initial attempt)
const MAX_RETRY_ATTEMPTS = 3;

// Base delay in milliseconds for exponential backoff
const BACKOFF_BASE_MS = 500;

/**
 * Ask OpenRouter with model fallback on error
 * Automatically retries with alternate models when using Auto mode
 */
export async function askOpenRouterWithFallback(
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

  const useStream = !!(options.stream && options.onChunk);
  let lastError: string | undefined;

  // Try up to MAX_RETRY_ATTEMPTS times with different models
  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
    // If this is a retry, try a different model
    let currentMessages = messages;
    let currentOptions = { ...options };

    if (attempt > 0 && options.modelStore) {
      // Get available models and try alternate ones
      const available = options.modelStore.getAutoPoolModels() ?? getModels();
      const currentModel = options.modelStore.getSelectedModelId();

      if (currentModel === AUTO_MODEL_ID && available.length > 1) {
        // For Auto mode, pick a different model for retry
        // Skip models we've already tried (simple approach: use index offset)
        const retryIndex = attempt % available.length;
        const newModel = available[retryIndex];
        currentOptions = {
          ...currentOptions,
          modelStore: {
            ...options.modelStore,
            getSelectedModelId: () => newModel,
          } as ModelStore,
        };
      }
    }

    const result = await askOpenRouterInternal(
      currentMessages,
      currentOptions,
      useStream,
      apiKey
    );

    // Check if result is an error that warrants a retry
    const isError = result.startsWith('**Error:**') || result.startsWith('**API Error:**') || result.startsWith('**Network Error:**');
    const isRateLimit = /rate limit|429|too many/i.test(result);
    const isServerErr = /5[0-9][0-9]/.test(result);
    const isProviderErr = /provider returned error/i.test(result);

    if (!isError) {
      // Success
      return result;
    }

    lastError = result;

    // Don't retry if user selected a specific model (not Auto)
    if (options.modelStore?.getSelectedModelId() !== AUTO_MODEL_ID) {
      break;
    }

    // Don't retry for certain errors that won't be fixed by changing models
    if (!isRateLimit && !isServerErr && !isProviderErr && !result.includes('model')) {
      break;
    }

    // Wait with exponential backoff before retrying
    if (attempt < MAX_RETRY_ATTEMPTS - 1) {
      const delay = BACKOFF_BASE_MS * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // All attempts failed, return the last error
  return lastError ?? '**Error:** Unknown error occurred';
}

async function askOpenRouterInternal(
  messages: ChatMessage[],
  options: AskOpenRouterOptions,
  useStream: boolean,
  apiKey: string
): Promise<string> {
  const body = buildRequestBody(
    messages,
    options.modelStore,
    options.mode ?? 'ask',
    options.hasVisionAttachments ?? false
  );
  if (!('model' in body) && !('models' in body)) {
    return '**Error:** No models configured. Open the model menu, turn on at least 3 models (teal switches), then Enable Auto — or pick a model by name.';
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
      const modelId = typeof body.model === 'string' ? body.model : undefined;
      return formatApiError(parsed, response.status, response.statusText, modelId);
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

export async function askOpenRouter(
  messages: ChatMessage[],
  options: AskOpenRouterOptions
): Promise<string> {
  // For now, just call the internal function directly
  // The fallback version is available as askOpenRouterWithFallback
  return askOpenRouterWithFallback(messages, options);
}

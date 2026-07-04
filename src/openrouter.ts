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

/** Native (OpenRouter/OpenAI) function call returned by tool-capable models. */
export interface NativeToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  /** Streaming-assembly index (present only on streamed deltas). */
  index?: number;
}

/** Native function/tool schema advertised in the request. */
export interface OpenRouterToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: MessageContent | null;
  /** Present on assistant turns that requested native tool calls. */
  tool_calls?: NativeToolCall[];
  /** Present on role:'tool' result messages. */
  tool_call_id?: string;
}

/** Content + any native tool calls the model requested this turn. */
export interface ToolAwareResult {
  content: string;
  toolCalls?: NativeToolCall[];
}

export interface AskOpenRouterOptions {
  modelStore?: ModelStore;
  apiKeyStore: ApiKeyStore;
  mode?: AgentMode;
  hasVisionAttachments?: boolean;
  signal?: AbortSignal;
  stream?: boolean;
  onChunk?: (delta: string, accumulated: string) => void;
  /** Native tool schemas to advertise (sent only to tool-capable models). */
  tools?: OpenRouterToolDef[];
  /** Predicate gating whether the chosen model gets the native `tools` array. */
  supportsTools?: (modelId: string) => boolean;
  /** Progress while a native tool call's arguments stream in (e.g. a large file write). */
  onToolProgress?: (info: { name?: string; bytes: number }) => void;
}

/** Extract plain text from message content for heuristics and history display. */
export function messageContentToText(content: MessageContent | null): string {
  if (content === null) {
    return '';
  }
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

interface StreamToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenRouterChoice {
  message?: { content?: string | null; tool_calls?: NativeToolCall[] };
  delta?: { content?: string | null; tool_calls?: StreamToolCallDelta[] };
  finish_reason?: string;
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

/** Attach the native `tools` array when the chosen model supports it. */
function attachTools(
  body: Record<string, unknown>,
  finalModel: string | undefined,
  options: Pick<AskOpenRouterOptions, 'tools' | 'supportsTools'>
): Record<string, unknown> {
  const tools = options.tools;
  if (!tools || tools.length === 0 || !finalModel) {
    return body;
  }
  if (options.supportsTools && !options.supportsTools(finalModel)) {
    return body;
  }
  body.tools = tools;
  body.tool_choice = 'auto';
  return body;
}

function buildRequestBody(
  messages: ChatMessage[],
  options: Pick<
    AskOpenRouterOptions,
    'modelStore' | 'mode' | 'hasVisionAttachments' | 'tools' | 'supportsTools'
  >
): Record<string, unknown> {
  const modelStore = options.modelStore;
  const mode = options.mode ?? 'ask';
  const hasVisionAttachments = options.hasVisionAttachments ?? false;
  const selectedId = modelStore?.getSelectedModelId() ?? AUTO_MODEL_ID;

  if (selectedId !== AUTO_MODEL_ID) {
    return attachTools({ model: selectedId, messages }, selectedId, options);
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
  return attachTools({ model: picked, messages }, picked, options);
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

  if (/unknown model|model not found|invalid model|does not exist/i.test(d)) {
    return (
      '\n\nThis model is no longer available. **What you can try:**' +
      '\n- Pick a different model from the model menu.' +
      '\n- Enable **Auto** with at least 3 models for automatic fallback routing.'
    );
  }

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

/**
 * Merge streamed tool-call fragments into an index-keyed accumulator.
 * OpenRouter/OpenAI stream tool calls as partial deltas: the id/name arrive once,
 * the JSON `arguments` string arrives in pieces that must be concatenated by index.
 * Pure (no I/O) so it can be unit-tested.
 */
export function assembleToolCallDeltas(
  acc: Map<number, NativeToolCall>,
  deltas: StreamToolCallDelta[] | undefined
): void {
  if (!deltas) {
    return;
  }
  for (const d of deltas) {
    const index = d.index ?? 0;
    let entry = acc.get(index);
    if (!entry) {
      entry = { id: d.id ?? '', type: 'function', function: { name: '', arguments: '' }, index };
      acc.set(index, entry);
    }
    if (d.id) {
      entry.id = d.id;
    }
    if (d.function?.name) {
      entry.function.name = d.function.name;
    }
    if (d.function?.arguments) {
      entry.function.arguments += d.function.arguments;
    }
  }
}

/** Flatten the accumulator into ordered, complete tool calls (filling missing ids). */
export function finalizeToolCalls(acc: Map<number, NativeToolCall>): NativeToolCall[] {
  return [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, v]) => ({
      id: v.id || `call_${index}`,
      type: 'function' as const,
      function: { name: v.function.name, arguments: v.function.arguments },
    }))
    .filter((tc) => tc.function.name.length > 0);
}

async function readSseStream(
  response: Response,
  signal: AbortSignal | undefined,
  onChunk: (delta: string, accumulated: string) => void,
  onToolProgress?: (info: { name?: string; bytes: number }) => void
): Promise<ToolAwareResult> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let accumulated = '';
  let finished = false;
  const toolAcc = new Map<number, NativeToolCall>();

  const emitToolProgress = (): void => {
    if (!onToolProgress || toolAcc.size === 0) {
      return;
    }
    let bytes = 0;
    let name: string | undefined;
    for (const tc of toolAcc.values()) {
      bytes += tc.function.arguments.length;
      if (tc.function.name) {
        name = tc.function.name;
      }
    }
    onToolProgress({ name, bytes });
  };

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
        const choice = parsed.choices?.[0];
        const delta = choice?.delta?.content ?? choice?.message?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          accumulated += delta;
          onChunk(delta, accumulated);
        }
        const beforeSize = toolAcc.size;
        let beforeBytes = 0;
        for (const tc of toolAcc.values()) {
          beforeBytes += tc.function.arguments.length;
        }
        assembleToolCallDeltas(toolAcc, choice?.delta?.tool_calls);
        // Some providers send a full message.tool_calls in a single SSE frame.
        if (choice?.message?.tool_calls?.length) {
          assembleToolCallDeltas(
            toolAcc,
            choice.message.tool_calls.map((tc, i) => ({
              index: tc.index ?? i,
              id: tc.id,
              function: tc.function,
            }))
          );
        }
        let afterBytes = 0;
        for (const tc of toolAcc.values()) {
          afterBytes += tc.function.arguments.length;
        }
        if (toolAcc.size !== beforeSize || afterBytes !== beforeBytes) {
          emitToolProgress();
        }
        // Generation finished. Many providers (e.g. owl-alpha) emit finish_reason
        // but keep the HTTP stream open for many seconds before [DONE]; stop now —
        // no displayed content comes after finish_reason, so this is lossless.
        if (choice?.finish_reason) {
          finished = true;
        }
      } catch {
        /* skip malformed SSE chunk */
      }
    }

    // Harmony turn-end token also marks completion (lossless: we only ever render
    // the final channel, and nothing the user sees follows <|return|>).
    if (!finished && TURN_END_RE.test(accumulated)) {
      finished = true;
    }
    if (finished) {
      try {
        await reader.cancel();
      } catch {
        /* already closing */
      }
      break;
    }
  }

  const toolCalls = finalizeToolCalls(toolAcc);
  return {
    content: accumulated,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

async function readJsonCompletion(response: Response): Promise<ToolAwareResult> {
  const parsed = (await response.json()) as OpenRouterResponse & { message?: string };
  const choice = parsed.choices?.[0];
  const content = choice?.message?.content;
  const rawToolCalls = choice?.message?.tool_calls;
  const toolCalls =
    rawToolCalls && rawToolCalls.length > 0
      ? rawToolCalls.map((tc, i) => ({
          id: tc.id || `call_${i}`,
          type: 'function' as const,
          function: tc.function,
        }))
      : undefined;

  if ((content === undefined || content === null) && !toolCalls) {
    return { content: '**Error:** OpenRouter returned an empty response.' };
  }
  return { content: content ?? '', toolCalls };
}

/** Harmony end-of-turn token (handles spaced pipe variants) — signals the model is done. */
const TURN_END_RE = /<\s*\|\s*return\s*\|\s*>/i;

// Maximum number of retry attempts (including initial attempt)
const MAX_RETRY_ATTEMPTS = 3;

// Base delay in milliseconds for exponential backoff
const BACKOFF_BASE_MS = 500;

function isErrorContent(content: string): boolean {
  return (
    content.startsWith('**Error:**') ||
    content.startsWith('**API Error:**') ||
    content.startsWith('**Network Error:**')
  );
}

/**
 * Ask OpenRouter with model fallback on error, returning content + any native
 * tool calls the model requested. Automatically retries alternate models in Auto.
 */
export async function askOpenRouterToolAware(
  messages: ChatMessage[],
  options: AskOpenRouterOptions
): Promise<ToolAwareResult> {
  const apiKey = await options.apiKeyStore.get();
  if (!apiKey) {
    return {
      content:
        '**Error:** No API key configured. Run **OpenRouter: Set API Key** from the Command Palette ' +
        '(Ctrl+Shift+P). Get a key at https://openrouter.ai/keys',
    };
  }

  const useStream = !!(options.stream && options.onChunk);
  let lastError: string | undefined;

  // Try up to MAX_RETRY_ATTEMPTS times with different models
  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
    // If this is a retry, try a different model
    const currentMessages = messages;
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
    const isError = isErrorContent(result.content);
    const isRateLimit = /rate limit|429|too many/i.test(result.content);
    const isServerErr = /5[0-9][0-9]/.test(result.content);
    const isProviderErr = /provider returned error/i.test(result.content);

    if (!isError) {
      // Success
      return result;
    }

    lastError = result.content;

    // Don't retry if user selected a specific model (not Auto)
    if (options.modelStore?.getSelectedModelId() !== AUTO_MODEL_ID) {
      break;
    }

    // Don't retry for certain errors that won't be fixed by changing models
    if (!isRateLimit && !isServerErr && !isProviderErr && !result.content.includes('model')) {
      break;
    }

    // Wait with exponential backoff before retrying
    if (attempt < MAX_RETRY_ATTEMPTS - 1) {
      const delay = BACKOFF_BASE_MS * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // All attempts failed, return the last error
  return { content: lastError ?? '**Error:** Unknown error occurred' };
}

/** @deprecated Use askOpenRouterToolAware; kept as a string-only wrapper. */
export async function askOpenRouterWithFallback(
  messages: ChatMessage[],
  options: AskOpenRouterOptions
): Promise<string> {
  return (await askOpenRouterToolAware(messages, options)).content;
}

async function askOpenRouterInternal(
  messages: ChatMessage[],
  options: AskOpenRouterOptions,
  useStream: boolean,
  apiKey: string
): Promise<ToolAwareResult> {
  const body = buildRequestBody(messages, options);
  if (!('model' in body) && !('models' in body)) {
    return {
      content:
        '**Error:** No models configured. Open the model menu, turn on at least 3 models (teal switches), then Enable Auto — or pick a model by name.',
    };
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
      return { content: formatApiError(parsed, response.status, response.statusText, modelId) };
    }

    if (useStream && contentType.includes('text/event-stream')) {
      const streamed = await readSseStream(
        response,
        options.signal,
        options.onChunk!,
        options.onToolProgress
      );
      if (options.signal?.aborted) {
        throw new AskOpenRouterAbortedError();
      }
      if (streamed.content.length > 0 || streamed.toolCalls?.length) {
        return streamed;
      }
      return { content: '**Error:** OpenRouter returned an empty response.' };
    }

    if (useStream) {
      const res = await readJsonCompletion(response);
      if (res.content && !isErrorContent(res.content) && options.onChunk) {
        options.onChunk(res.content, res.content);
      }
      return res;
    }

    const res = await readJsonCompletion(response);
    if (options.signal?.aborted) {
      throw new AskOpenRouterAbortedError();
    }
    return res;
  } catch (err) {
    if (options.signal?.aborted || isAskOpenRouterAborted(err)) {
      throw new AskOpenRouterAbortedError();
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `**Network Error:** ${msg}` };
  }
}

export async function askOpenRouter(
  messages: ChatMessage[],
  options: AskOpenRouterOptions
): Promise<string> {
  return (await askOpenRouterToolAware(messages, options)).content;
}

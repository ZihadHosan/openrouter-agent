import * as vscode from 'vscode';
import { AUTO_MODEL_ID } from './models';
import type { ApiKeyStore } from './apiKeyStore';

const MODELS_URL = 'https://openrouter.ai/api/v1/models';
const CATALOG_STATE_KEY = 'openrouterAgent.modelsCatalog';
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

export interface PricingSegment {
  text: string;
  /** When true, render with teal accent (price numerals). */
  teal?: boolean;
}

export type PricingCompact = 'free' | 'paid';

export interface ModelPricingDisplay {
  line: string;
  segments: PricingSegment[];
  /** Teal badge when composer footer is narrow; null for Auto / unknown. */
  compact: PricingCompact | null;
  title?: string;
}

export interface OpenRouterModelEntry {
  id: string;
  created?: number;
  contextLength?: number;
  promptPerToken: string;
  completionPerToken: string;
  imagePerUnit: string;
  supportsVision: boolean;
  /** True when the model advertises native function/tool calling. */
  supportsTools?: boolean;
}

export interface CatalogPickerItem {
  id: string;
  tier: PricingCompact;
  supportsVision: boolean;
}

interface StoredCatalog {
  fetchedAt: number;
  models: OpenRouterModelEntry[];
}

interface ApiModelRow {
  id?: string;
  created?: number;
  context_length?: number;
  architecture?: {
    input_modalities?: string[];
  };
  pricing?: {
    prompt?: string;
    completion?: string;
    image?: string;
  };
  supported_parameters?: string[];
}

/** Regex fallback when catalog entry is missing. */
export function modelSupportsVisionRegex(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return (
    /gemini|gpt-4o|gpt-4\.1|gpt-5|claude|llava|vision|pixtral|qwen-vl|internvl|glm-4v|moondream|llama-3\.2-vision|gpt-4-turbo/.test(
      id
    ) || id.includes(':vision')
  );
}

export function supportsVisionFromModalities(modalities: string[] | undefined): boolean {
  if (!modalities?.length) {
    return false;
  }
  return modalities.some((m) => m === 'image' || m === 'file');
}

function parsePerTokenUsd(value: string | undefined): number {
  const n = parseFloat(value ?? '');
  return Number.isFinite(n) ? n : 0;
}

/** USD per million tokens, OpenRouter-style: $0, $0.30, $10 */
export function formatUsdPerM(perToken: string | undefined): string {
  const perM = parsePerTokenUsd(perToken) * 1_000_000;
  if (perM === 0) {
    return '$0';
  }
  if (perM >= 100) {
    const rounded = Math.round(perM);
    return `$${rounded}`;
  }
  if (perM >= 1) {
    const s = perM.toFixed(2).replace(/\.?0+$/, '');
    return `$${s}`;
  }
  if (perM >= 0.01) {
    return `$${perM.toFixed(2).replace(/\.?0+$/, '')}`;
  }
  return `$${perM.toPrecision(2).replace(/\.?0+$/, '')}`;
}

export function formatContextLength(tokens: number | undefined): string | null {
  if (tokens === undefined || tokens <= 0 || !Number.isFinite(tokens)) {
    return null;
  }
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    if (m >= 10 || Math.abs(m - Math.round(m)) < 0.01) {
      return `${Math.round(m)}M context`;
    }
    const s = m.toFixed(2).replace(/\.?0+$/, '');
    return `${s}M context`;
  }
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}K context`;
  }
  return `${Math.round(tokens)} context`;
}

export function formatModelPricingDate(createdUnix: number | undefined): string | null {
  if (createdUnix === undefined || !Number.isFinite(createdUnix) || createdUnix <= 0) {
    return null;
  }
  return new Date(createdUnix * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function priceTokenSegments(
  perToken: string | undefined,
  suffix: string
): { part: string; segments: PricingSegment[] } {
  const label = formatUsdPerM(perToken);
  const num = label.startsWith('$') ? label.slice(1) : label;
  return {
    part: `${label}/M ${suffix}`,
    segments: [
      { text: '$' },
      { text: num, teal: true },
      { text: `/M ${suffix}` },
    ],
  };
}

/** Narrow-footer badge: free vs paid (image-priced models count as paid). */
export function computePricingCompact(
  entry: OpenRouterModelEntry,
  modelId: string
): PricingCompact {
  if (modelId.endsWith(':free')) {
    return 'free';
  }
  const promptN = parsePerTokenUsd(entry.promptPerToken);
  const completionN = parsePerTokenUsd(entry.completionPerToken);
  const imageN = parsePerTokenUsd(entry.imagePerUnit);
  if (imageN > 0 && promptN === 0 && completionN === 0) {
    return 'paid';
  }
  if (promptN === 0 && completionN === 0) {
    return 'free';
  }
  return 'paid';
}

/** Build composer pricing line (prices only — no date or context). */
export function buildPricingDisplay(
  entry: OpenRouterModelEntry,
  modelId: string
): ModelPricingDisplay {
  const isFreeId = modelId.endsWith(':free');
  const prompt = isFreeId ? '0' : entry.promptPerToken;
  const completion = isFreeId ? '0' : entry.completionPerToken;

  const promptN = parsePerTokenUsd(prompt);
  const completionN = parsePerTokenUsd(completion);
  const imageN = parsePerTokenUsd(entry.imagePerUnit);

  const useImageLine = imageN > 0 && promptN === 0 && completionN === 0;

  const lineParts: string[] = [];
  const segments: PricingSegment[] = [];

  if (useImageLine) {
    const imgLabel = formatUsdPerM(entry.imagePerUnit);
    const imgNum = imgLabel.startsWith('$') ? imgLabel.slice(1) : imgLabel;
    segments.push({ text: 'from ' });
    segments.push({ text: '$' });
    segments.push({ text: imgNum, teal: true });
    segments.push({ text: '/image' });
    lineParts.push(`from ${imgLabel}/image`);
  } else {
    const inSeg = priceTokenSegments(prompt, 'input tokens');
    segments.push(...inSeg.segments);
    lineParts.push(inSeg.part);

    const outSeg = priceTokenSegments(completion, 'output tokens');
    segments.push({ text: ' | ' });
    segments.push(...outSeg.segments);
    lineParts.push(outSeg.part);
  }

  const line = lineParts.join(' | ');
  const titleExtras: string[] = [];
  const date = formatModelPricingDate(entry.created);
  if (date) {
    titleExtras.push(date);
  }
  const ctx = formatContextLength(entry.contextLength);
  if (ctx) {
    titleExtras.push(ctx);
  }
  const title =
    titleExtras.length > 0
      ? `${line} · ${titleExtras.join(' · ')}`
      : 'Per-million token pricing from OpenRouter';

  return {
    line,
    segments,
    compact: computePricingCompact(entry, modelId),
    title,
  };
}

function rowToEntry(row: ApiModelRow): OpenRouterModelEntry | null {
  const id = row.id?.trim();
  if (!id) {
    return null;
  }
  const modalities = row.architecture?.input_modalities;
  const supportsVision =
    supportsVisionFromModalities(modalities) || modelSupportsVisionRegex(id);
  const params = row.supported_parameters;
  const supportsTools = Array.isArray(params)
    ? params.includes('tools')
    : undefined;
  return {
    id,
    created: row.created,
    contextLength: row.context_length,
    promptPerToken: row.pricing?.prompt ?? '0',
    completionPerToken: row.pricing?.completion ?? '0',
    imagePerUnit: row.pricing?.image ?? '0',
    supportsVision,
    supportsTools,
  };
}

export function getCatalogListForPicker(
  byId: Map<string, OpenRouterModelEntry>
): CatalogPickerItem[] {
  const items: CatalogPickerItem[] = [];
  for (const entry of byId.values()) {
    items.push({
      id: entry.id,
      tier: computePricingCompact(entry, entry.id),
      supportsVision: entry.supportsVision,
    });
  }
  items.sort((a, b) => a.id.localeCompare(b.id));
  return items;
}

export async function fetchModelsCatalog(apiKey?: string): Promise<Map<string, OpenRouterModelEntry>> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey?.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }

  const response = await fetch(MODELS_URL, { headers });
  if (!response.ok) {
    throw new Error(`Models API ${response.status}`);
  }

  const body = (await response.json()) as { data?: ApiModelRow[] };
  const map = new Map<string, OpenRouterModelEntry>();
  for (const row of body.data ?? []) {
    const entry = rowToEntry(row);
    if (entry) {
      map.set(entry.id, entry);
    }
  }
  return map;
}

export class ModelPricingCache {
  private byId = new Map<string, OpenRouterModelEntry>();
  private fetchedAt = 0;
  private loadPromise?: Promise<void>;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private isStale(): boolean {
    return this.fetchedAt === 0 || Date.now() - this.fetchedAt > CATALOG_TTL_MS;
  }

  private loadFromState(): void {
    const stored = this.context.globalState.get<StoredCatalog>(CATALOG_STATE_KEY);
    if (!stored?.models?.length) {
      return;
    }
    if (Date.now() - stored.fetchedAt > CATALOG_TTL_MS) {
      return;
    }
    this.byId.clear();
    for (const m of stored.models) {
      this.byId.set(m.id, normalizeCatalogEntry(m));
    }
    this.fetchedAt = stored.fetchedAt;
  }

  private async persist(): Promise<void> {
    await this.context.globalState.update(CATALOG_STATE_KEY, {
      fetchedAt: this.fetchedAt,
      models: [...this.byId.values()],
    } satisfies StoredCatalog);
  }

  async ensureLoaded(apiKeyStore: ApiKeyStore): Promise<void> {
    if (!this.isStale()) {
      return;
    }
    if (this.loadPromise) {
      return this.loadPromise;
    }

    this.loadPromise = (async () => {
      this.loadFromState();
      if (!this.isStale()) {
        return;
      }
      try {
        const key = await apiKeyStore.get();
        const map = await fetchModelsCatalog(key);
        this.byId = map;
        this.fetchedAt = Date.now();
        await this.persist();
      } catch {
        if (this.byId.size === 0) {
          this.loadFromState();
        }
      }
    })().finally(() => {
      this.loadPromise = undefined;
    });

    return this.loadPromise;
  }

  getCatalogIds(): Set<string> {
    return new Set(this.byId.keys());
  }

  getCatalogForPicker(): CatalogPickerItem[] {
    return getCatalogListForPicker(this.byId);
  }

  supportsVision(modelId: string): boolean {
    const entry = this.byId.get(modelId);
    if (entry) {
      return entry.supportsVision;
    }
    return modelSupportsVisionRegex(modelId);
  }

  /**
   * True when the model accepts a native `tools` array.
   * Defaults to true for unknown ids (frontier paid models all support it);
   * the catalog marks free/text-only ids false once loaded, routing them to the
   * prompt-based agent-tool fallback.
   */
  supportsTools(modelId: string): boolean {
    const entry = this.byId.get(modelId);
    if (entry && typeof entry.supportsTools === 'boolean') {
      return entry.supportsTools;
    }
    return true;
  }

  poolHasVisionModel(modelIds: string[]): boolean {
    return modelIds.some((id) => this.supportsVision(id));
  }

  getDisplayForModel(modelId: string): ModelPricingDisplay {
    if (modelId === AUTO_MODEL_ID) {
      return {
        line: 'varies by model',
        segments: [{ text: 'varies by model' }],
        compact: null,
        title: 'Auto picks a model from your list; pricing depends on selection',
      };
    }

    const entry = this.byId.get(modelId);
    if (!entry) {
      if (modelId.endsWith(':free')) {
        const synthetic: OpenRouterModelEntry = {
          id: modelId,
          promptPerToken: '0',
          completionPerToken: '0',
          imagePerUnit: '0',
          supportsVision: modelSupportsVisionRegex(modelId),
        };
        return buildPricingDisplay(synthetic, modelId);
      }
      return {
        line: '—',
        segments: [{ text: '—' }],
        compact: null,
        title: 'Model not found in OpenRouter catalog',
      };
    }

    return buildPricingDisplay(entry, modelId);
  }
}

let cacheInstance: ModelPricingCache | undefined;

export function getModelPricingCache(context: vscode.ExtensionContext): ModelPricingCache {
  if (!cacheInstance) {
    cacheInstance = new ModelPricingCache(context);
  }
  return cacheInstance;
}

function normalizeCatalogEntry(m: OpenRouterModelEntry): OpenRouterModelEntry {
  if (typeof m.supportsVision === 'boolean') {
    return m;
  }
  return {
    ...m,
    supportsVision: modelSupportsVisionRegex(m.id),
  };
}

export function isModelPricingEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('openrouterAgent')
    .get<boolean>('showModelPricing', true);
}

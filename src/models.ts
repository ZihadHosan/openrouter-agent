import * as vscode from 'vscode';

export const AUTO_MODEL_ID = '__auto__';
/** Default model when user has never chosen one (first install) and for every new chat. */
export const DEFAULT_FIRST_MODEL_ID = 'openrouter/owl-alpha';

const CUSTOM_MODELS_KEY = 'openrouterAgent.customModels';
const SELECTED_MODEL_KEY = 'openrouterAgent.selectedModel';
const AUTO_POOL_KEY = 'openrouterAgent.autoPoolEnabled';
const AUTO_POOL_MIGRATED_KEY = 'openrouterAgent.autoPoolMigrated';
const SELECTED_INITIALIZED_KEY = 'openrouterAgent.selectedModelInitialized';

export const MIN_AUTO_POOL_SIZE = 3;

/** First-install Auto pool seed (not exposed in VS Code Settings). */
export const DEFAULT_POOL_SEED_IDS = [
  DEFAULT_FIRST_MODEL_ID,
  'z-ai/glm-4.5-air:free',
  'openai/gpt-oss-20b:free',
];

export class ModelStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getCustomModels(): string[] {
    return this.context.globalState.get<string[]>(CUSTOM_MODELS_KEY, []);
  }

  /** True when globalState has never stored a selected model (first install). */
  hasStoredSelectedModel(): boolean {
    return this.context.globalState.get<boolean>(SELECTED_INITIALIZED_KEY, false);
  }

  getSelectedModelId(): string {
    const initialized = this.context.globalState.get<boolean>(SELECTED_INITIALIZED_KEY, false);
    if (!initialized) {
      return DEFAULT_FIRST_MODEL_ID;
    }
    return this.context.globalState.get<string>(SELECTED_MODEL_KEY, AUTO_MODEL_ID);
  }

  getAutoPoolEnabled(): string[] {
    return this.context.globalState.get<string[]>(AUTO_POOL_KEY, []);
  }

  /** Models Auto may choose from (enabled toggles only). */
  getAutoPoolModels(): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const m of this.getAutoPoolEnabled()) {
      const trimmed = m.trim();
      if (!trimmed || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      result.push(trimmed);
    }
    return result;
  }

  isAutoPoolValid(): boolean {
    return this.getAutoPoolModels().length >= MIN_AUTO_POOL_SIZE;
  }

  /** @deprecated Use getAutoPoolModels for Auto; kept for migration seeding. */
  getAvailableModels(): string[] {
    return this.getAutoPoolModels();
  }

  getActiveModelLabel(): string {
    const id = this.getSelectedModelId();
    return id === AUTO_MODEL_ID ? 'Auto' : id;
  }

  async setSelectedModelId(modelId: string): Promise<void> {
    await this.context.globalState.update(SELECTED_MODEL_KEY, modelId);
    await this.context.globalState.update(SELECTED_INITIALIZED_KEY, true);
  }

  async setAutoPoolEnabled(ids: string[]): Promise<void> {
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const m of ids) {
      const trimmed = m.trim();
      if (!trimmed || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      deduped.push(trimmed);
    }
    await this.context.globalState.update(AUTO_POOL_KEY, deduped);
  }

  async toggleAutoPoolModel(
    modelId: string,
    enabled: boolean
  ): Promise<{ ok: boolean; error?: string }> {
    const trimmed = modelId.trim();
    if (!trimmed) {
      return { ok: false, error: 'Model id cannot be empty.' };
    }
    const pool = this.getAutoPoolEnabled();
    const has = pool.includes(trimmed);
    if (enabled && !has) {
      await this.setAutoPoolEnabled([...pool, trimmed]);
      return { ok: true };
    }
    if (!enabled && has) {
      if (
        this.getSelectedModelId() === AUTO_MODEL_ID &&
        pool.length <= MIN_AUTO_POOL_SIZE
      ) {
        return {
          ok: false,
          error: 'Keep at least 3 models on for Auto.',
        };
      }
      await this.setAutoPoolEnabled(pool.filter((m) => m !== trimmed));
      return { ok: true };
    }
    return { ok: true };
  }

  /**
   * One-time: seed Auto pool from settings + legacy custom models.
   * First install: selected model + pool with 2 defaults ON.
   */
  async ensureAutoPoolMigrated(): Promise<void> {
    const migrated = this.context.globalState.get<boolean>(AUTO_POOL_MIGRATED_KEY, false);
    if (migrated) {
      return;
    }

    const custom = this.getCustomModels();
    const seed = [...DEFAULT_POOL_SEED_IDS, ...custom].filter(
      (m, i, a) => m.trim() && a.indexOf(m) === i
    );

    const pool =
      seed.length >= MIN_AUTO_POOL_SIZE ? seed : [...DEFAULT_POOL_SEED_IDS];

    await this.setAutoPoolEnabled(pool);

    const selectedInitialized = this.context.globalState.get<boolean>(
      SELECTED_INITIALIZED_KEY,
      false
    );
    if (!selectedInitialized) {
      await this.context.globalState.update(SELECTED_MODEL_KEY, DEFAULT_FIRST_MODEL_ID);
      await this.context.globalState.update(SELECTED_INITIALIZED_KEY, true);
    }

    await this.context.globalState.update(AUTO_POOL_MIGRATED_KEY, true);
  }

  /** Remove pool ids not present in catalog (after refresh). */
  async pruneAutoPoolToCatalog(validIds: Set<string>): Promise<void> {
    const pool = this.getAutoPoolEnabled().filter((id) => validIds.has(id));
    if (pool.length !== this.getAutoPoolEnabled().length) {
      await this.setAutoPoolEnabled(pool);
    }
  }

  getStateForWebview(): {
    selectedModelId: string;
    autoPoolEnabled: string[];
    autoPoolValid: boolean;
  } {
    return {
      selectedModelId: this.getSelectedModelId(),
      autoPoolEnabled: this.getAutoPoolEnabled(),
      autoPoolValid: this.isAutoPoolValid(),
    };
  }
}

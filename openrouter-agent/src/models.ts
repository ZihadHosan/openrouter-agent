import * as vscode from 'vscode';

export const AUTO_MODEL_ID = '__auto__';
export const ADD_MODEL_OPTION = '__add_model__';

const CUSTOM_MODELS_KEY = 'openrouterAgent.customModels';
const SELECTED_MODEL_KEY = 'openrouterAgent.selectedModel';

export class ModelStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getSettingsModels(): string[] {
    return vscode.workspace
      .getConfiguration('openrouterAgent')
      .get<string[]>('models', [
        'z-ai/glm-4.5-air:free',
        'openrouter/owl-alpha',
        'deepseek/deepseek-v4-flash',
      ])
      .slice(0, 3);
  }

  getCustomModels(): string[] {
    return this.context.globalState.get<string[]>(CUSTOM_MODELS_KEY, []);
  }

  getSelectedModelId(): string {
    return this.context.globalState.get<string>(SELECTED_MODEL_KEY, AUTO_MODEL_ID);
  }

  /** All models shown in the chat dropdown (deduped). */
  getAvailableModels(): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const m of [...this.getSettingsModels(), ...this.getCustomModels()]) {
      const trimmed = m.trim();
      if (!trimmed || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      result.push(trimmed);
    }
    return result;
  }

  /** Models sent to OpenRouter when Auto is selected (max 3). */
  getFallbackModels(): string[] {
    const available = this.getAvailableModels();
    if (available.length > 0) {
      return available.slice(0, 3);
    }
    return this.getSettingsModels();
  }

  getActiveModelLabel(): string {
    const id = this.getSelectedModelId();
    return id === AUTO_MODEL_ID ? 'Auto (fallbacks)' : id;
  }

  async setSelectedModelId(modelId: string): Promise<void> {
    await this.context.globalState.update(SELECTED_MODEL_KEY, modelId);
  }

  async addCustomModel(model: string): Promise<{ ok: boolean; error?: string }> {
    const trimmed = model.trim();
    if (!trimmed) {
      return { ok: false, error: 'Model id cannot be empty.' };
    }
    if (trimmed.length > 200) {
      return { ok: false, error: 'Model id is too long.' };
    }
    const all = this.getAvailableModels();
    if (all.includes(trimmed)) {
      return { ok: false, error: 'Model already in the list.' };
    }
    const custom = [...this.getCustomModels(), trimmed];
    await this.context.globalState.update(CUSTOM_MODELS_KEY, custom);
    return { ok: true };
  }

  getStateForWebview(): {
    availableModels: string[];
    customModels: string[];
    selectedModelId: string;
    settingsModels: string[];
  } {
    return {
      availableModels: this.getAvailableModels(),
      customModels: this.getCustomModels(),
      selectedModelId: this.getSelectedModelId(),
      settingsModels: this.getSettingsModels(),
    };
  }
}

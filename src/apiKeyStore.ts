import * as vscode from 'vscode';

const SECRET_KEY = 'openrouterAgent.apiKey';
const LEGACY_SETTING = 'apiKey';

export class ApiKeyStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async get(): Promise<string> {
    return (await this.context.secrets.get(SECRET_KEY))?.trim() ?? '';
  }

  async hasKey(): Promise<boolean> {
    return (await this.get()).length > 0;
  }

  async set(value: string): Promise<void> {
    const trimmed = value.trim();
    if (trimmed) {
      await this.context.secrets.store(SECRET_KEY, trimmed);
    } else {
      await this.context.secrets.delete(SECRET_KEY);
    }
  }

  async clear(): Promise<void> {
    await this.context.secrets.delete(SECRET_KEY);
  }

  /** Move key from plain settings (older versions) into secure storage; remove Settings field. */
  async migrateFromSettingsIfNeeded(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('openrouterAgent');
    const inspected = cfg.inspect<string>(LEGACY_SETTING);
    if (!inspected) {
      return;
    }

    const legacy = String(
      inspected.globalValue ?? inspected.workspaceValue ?? ''
    ).trim();

    if (legacy && !(await this.hasKey())) {
      await this.set(legacy);
    }

    if (inspected.globalValue !== undefined) {
      await cfg.update(LEGACY_SETTING, undefined, vscode.ConfigurationTarget.Global);
    }
    if (inspected.workspaceValue !== undefined) {
      await cfg.update(LEGACY_SETTING, undefined, vscode.ConfigurationTarget.Workspace);
    }
  }

  async promptSetApiKey(): Promise<boolean> {
    const hasKey = await this.hasKey();
    const value = await vscode.window.showInputBox({
      title: 'OpenRouter API Key',
      prompt: hasKey
        ? 'Enter a new key to replace the saved one (stored securely, hidden like a password).'
        : 'Paste your API key from https://openrouter.ai/keys',
      placeHolder: 'sk-or-v1-…',
      password: true,
      ignoreFocusOut: true,
    });

    if (value === undefined) {
      return false;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      void vscode.window.showWarningMessage('OpenRouter Agent: API key was not changed (empty input).');
      return false;
    }

    await this.set(trimmed);
    void vscode.window.showInformationMessage(
      'OpenRouter Agent: API key saved securely (not shown in Settings).'
    );
    return true;
  }
}

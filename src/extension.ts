import * as vscode from 'vscode';
import { AttachmentStore } from './attachments';
import { ApiKeyStore } from './apiKeyStore';
import { buildPrompt, gatherContext, prefetchContext } from './agent';
import { ChatHistoryStore } from './chatHistory';
import { ChatViewProvider } from './chatView';
import { ModelStore } from './models';
import { askOpenRouter } from './openrouter';
import { promptPermissionMode } from './permissions';
import { getWorkspaceIndexer } from './workspaceIndexer';
let chatProvider: ChatViewProvider;
let modelStore: ModelStore;
let apiKeyStore: ApiKeyStore;
let attachmentStore: AttachmentStore;

/**
 * Prefetch context data in background for faster first response
 */
function backgroundPrefetch(): void {
  // Small delay to allow extension to fully activate
  setTimeout(() => {
    void prefetchContext();
  }, 2000);
}

export function activate(context: vscode.ExtensionContext): void {
  modelStore = new ModelStore(context);
  apiKeyStore = new ApiKeyStore(context);
  attachmentStore = new AttachmentStore(context);
  const historyStore = new ChatHistoryStore(context);
  chatProvider = new ChatViewProvider(
    context.extensionUri,
    modelStore,
    historyStore,
    apiKeyStore,
    attachmentStore
  );

  void apiKeyStore.migrateFromSettingsIfNeeded();

  chatProvider.refreshWebviewIfOpen();

  // Start workspace indexing in background for faster search
  void getWorkspaceIndexer().startIndexing();

  // Prefetch context in background for faster first response
  backgroundPrefetch();

  const chatStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    200
  );
  chatStatusBar.command = 'openrouterAgent.openChat';
  chatStatusBar.text = '$(comment-discussion) OpenRouter';
  chatStatusBar.tooltip = 'Open OpenRouter Chat (Ctrl+Alt+L)';
  chatStatusBar.backgroundColor = new vscode.ThemeColor(
    'statusBarItem.prominentBackground'
  );
  chatStatusBar.color = new vscode.ThemeColor('statusBarItem.prominentForeground');
  chatStatusBar.show();
  context.subscriptions.push(chatStatusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('openrouterAgent.openChat', async () => {
      await chatProvider.focus();
    }),

    vscode.commands.registerCommand('openrouterAgent.setPermissions', () => {
      void promptPermissionMode();
    }),

    vscode.commands.registerCommand('openrouterAgent.setApiKey', () => {
      void apiKeyStore.promptSetApiKey();
    }),
    vscode.commands.registerCommand('openrouterAgent.clearApiKey', async () => {
      if (!(await apiKeyStore.hasKey())) {
        void vscode.window.showInformationMessage('OpenRouter Agent: No API key is stored.');
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        'Remove the saved OpenRouter API key?',
        { modal: true },
        'Remove',
        'Cancel'
      );
      if (choice === 'Remove') {
        await apiKeyStore.clear();
        void vscode.window.showInformationMessage('OpenRouter Agent: API key removed.');
      }
    }),

    vscode.commands.registerCommand('openrouterAgent.askCurrentFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showErrorMessage('OpenRouter Agent: No active editor.');
        return;
      }
      const fileName = editor.document.fileName;
      const content = editor.document.getText();
      const prompt =
        `I have opened the file "${fileName}". ` +
        `Please summarize what this file does and ask what I would like to do with it.\n\n` +
        `File content:\n\`\`\`\n${content.slice(0, 12000)}\n\`\`\``;
      void chatProvider.focus();
      await chatProvider.sendExternalMessage(prompt, 'ask');
    }),

    vscode.commands.registerCommand('openrouterAgent.explainSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        void vscode.window.showErrorMessage(
          'OpenRouter Agent: Select some text to explain.'
        );
        return;
      }
      const selected = editor.document.getText(editor.selection);
      const prompt = `Explain the following code in clear terms:\n\n\`\`\`\n${selected}\n\`\`\``;
      void chatProvider.focus();
      await chatProvider.sendExternalMessage(prompt, 'ask');
    }),

    vscode.commands.registerCommand('openrouterAgent.fixSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        void vscode.window.showErrorMessage(
          'OpenRouter Agent: Select some text to fix or improve.'
        );
        return;
      }

      const selected = editor.document.getText(editor.selection);
      const ctx = await gatherContext();
      const messages = buildPrompt(
        'ask',
        `Fix or improve the following code. Return ONLY the improved code replacement, without markdown fences or explanation unless necessary.\n\n\`\`\`\n${selected}\n\`\`\``,
        ctx
      );

      const response = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'OpenRouter Agent: Fixing selection…',
        },
        () => askOpenRouter(messages, { modelStore, apiKeyStore, mode: 'ask' })
      );

      if (
        response.startsWith('**Error:**') ||
        response.startsWith('**API Error:**') ||
        response.startsWith('**Network Error:**')
      ) {
        void chatProvider.focus();
        await chatProvider.sendExternalMessage(
          `Fix selection failed:\n${response}`,
          'ask'
        );
        return;
      }

      let proposed = response.trim();
      const fenceMatch = proposed.match(/^```[\w]*\n([\s\S]*?)```$/);
      if (fenceMatch) {
        proposed = fenceMatch[1].trim();
      }

      const preview =
        proposed.length > 600 ? proposed.slice(0, 600) + '\n…' : proposed;

      const choice = await vscode.window.showInformationMessage(
        'OpenRouter Agent: Apply proposed fix to selection?',
        { modal: true, detail: `Preview:\n${preview}` },
        'Apply',
        'Cancel'
      );

      if (choice !== 'Apply') {
        return;
      }

      await editor.edit((eb) => {
        eb.replace(editor.selection, proposed);
      });
      void vscode.window.showInformationMessage('OpenRouter Agent: Selection updated.');
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('openrouterAgent.chatFontSize')) {
        chatProvider.refreshWebview();
      }
    })
  );
}

export function deactivate(): void {}
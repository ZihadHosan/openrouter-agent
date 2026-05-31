import * as vscode from 'vscode';
import { AgentMode, buildMessagesWithHistory, gatherContext } from './agent';
import { ApiKeyStore } from './apiKeyStore';
import { ApprovalBridge, PermissionChoice } from './approvalBridge';
import { ChatHistoryStore } from './chatHistory';
import type { ChatSessionMessage, ToolDetailEntry } from './chatHistory';
import { ADD_MODEL_OPTION, AUTO_MODEL_ID, ModelStore } from './models';

export type { ChatSessionMessage, ToolDetailEntry };
import { askOpenRouter, ChatMessage } from './openrouter';
import {
  describeProcessDone,
  describeProcessStep,
  cleanAssistantVisibleText,
  describeToolCall,
  handleToolCall,
  hasToolCallMarkup,
  isReadOnlyTool,
  parseToolCall,
  stripToolBlock,
} from './tools';

const MAX_AGENT_ITERATIONS = 8;

/** Single chat UI — one WebviewPanel on the right (no sidebar duplicate). */
export class ChatViewProvider {
  public static readonly panelType = 'openrouterAgent.chatPanel';

  private panel?: vscode.WebviewPanel;
  private history: ChatSessionMessage[] = [];
  private mode: AgentMode = 'ask';
  private processing = false;
  private pendingUserMessage: string | null = null;
  private readonly approvalBridge: ApprovalBridge;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly modelStore: ModelStore,
    private readonly historyStore: ChatHistoryStore,
    private readonly apiKeyStore: ApiKeyStore
  ) {
    this.approvalBridge = new ApprovalBridge((msg) => this.post(msg));
  }

  private loadActiveSession(): void {
    const session = this.historyStore.getActive();
    this.history = [...session.messages];
    this.mode = session.mode;
    void this.modelStore.setSelectedModelId(session.modelId);
  }

  private async persistSession(titleFromMessage?: string): Promise<void> {
    await this.historyStore.updateActive({
      messages: this.history,
      mode: this.mode,
      modelId: this.modelStore.getSelectedModelId(),
      titleFromMessage,
    });
  }

  private applySessionToUi(session: {
    messages: ChatSessionMessage[];
    mode: AgentMode;
    modelId: string;
  }): void {
    this.history = [...session.messages];
    this.mode = session.mode;
    void this.modelStore.setSelectedModelId(session.modelId);
    this.syncState();
  }

  private getWebview(): vscode.Webview | undefined {
    return this.panel?.webview;
  }

  private async getRightViewColumn(): Promise<vscode.ViewColumn> {
    const groups = vscode.window.tabGroups.all;
    if (groups.length >= 2) {
      const rightmost = groups[groups.length - 1];
      if (rightmost.viewColumn !== undefined) {
        return rightmost.viewColumn;
      }
    }

    try {
      await vscode.commands.executeCommand('workbench.action.splitEditorRight');
    } catch {
      /* no active editor */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));

    const updated = vscode.window.tabGroups.all;
    if (updated.length >= 2) {
      const rightmost = updated[updated.length - 1];
      if (rightmost.viewColumn !== undefined) {
        return rightmost.viewColumn;
      }
    }

    return vscode.ViewColumn.Two;
  }

  private attachWebview(webview: vscode.Webview): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webview.html = this.getHtml();
    webview.onDidReceiveMessage((msg) => {
      void this.handleWebviewMessage(msg);
    });
  }

  private async openPanelOnRight(): Promise<void> {
    const column = await this.getRightViewColumn();

    if (this.panel) {
      this.panel.reveal(column, true);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      ChatViewProvider.panelType,
      'OpenRouter Chat',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      }
    );

    this.panel.iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, 'media', 'icon-light.svg'),
      dark: vscode.Uri.joinPath(this.extensionUri, 'media', 'icon-dark.svg'),
    };

    this.attachWebview(this.panel.webview);

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  async focus(): Promise<void> {
    await this.openPanelOnRight();
  }

  private async handleWebviewMessage(msg: {
    type: string;
    text?: string;
    mode?: string;
    modelId?: string;
    sessionId?: string;
    model?: string;
    id?: string;
    choice?: string;
  }): Promise<void> {
    switch (msg.type) {
      case 'send':
        await this.handleSend(
          String(msg.text ?? ''),
          msg.mode as AgentMode,
          String(msg.modelId ?? AUTO_MODEL_ID)
        );
        break;
      case 'clear':
        this.history = [];
        await this.persistSession();
        this.post({ type: 'cleared' });
        break;
      case 'newSession':
        if (this.processing) {
          break;
        }
        await this.persistSession();
        this.applySessionToUi(await this.historyStore.newSession());
        break;
      case 'switchSession': {
        if (this.processing) {
          break;
        }
        const id = String(msg.sessionId ?? '');
        await this.persistSession();
        const session = await this.historyStore.switchSession(id);
        if (session) {
          this.applySessionToUi(session);
        }
        break;
      }
      case 'deleteSession': {
        if (this.processing) {
          break;
        }
        const id = String(msg.sessionId ?? '');
        const choice = await vscode.window.showWarningMessage(
          'Delete this chat from history?',
          { modal: true },
          'Delete',
          'Cancel'
        );
        if (choice !== 'Delete') {
          this.post({
            type: 'sessions',
            sessions: this.historyStore.listSessions(),
            activeSessionId: this.historyStore.getActiveId(),
          });
          break;
        }
        const session = await this.historyStore.deleteSession(id);
        this.applySessionToUi(session);
        break;
      }
      case 'setMode':
        if (msg.mode === 'ask' || msg.mode === 'plan' || msg.mode === 'agent') {
          this.mode = msg.mode;
          await this.persistSession();
        }
        break;
      case 'setModel':
        await this.modelStore.setSelectedModelId(String(msg.modelId ?? AUTO_MODEL_ID));
        await this.persistSession();
        break;
      case 'addModel': {
        const result = await this.modelStore.addCustomModel(String(msg.model ?? ''));
        if (result.ok) {
          const id = String(msg.model ?? '').trim();
          await this.modelStore.setSelectedModelId(id);
          this.post({ type: 'modelAdded', modelId: id, ...this.modelStore.getStateForWebview() });
        } else {
          this.post({ type: 'error', message: result.error ?? 'Could not add model.' });
        }
        break;
      }
      case 'promptAddModel': {
        const model = await vscode.window.showInputBox({
          title: 'Add OpenRouter Model',
          prompt: 'Model id from openrouter.ai/models',
          placeHolder: 'anthropic/claude-3.5-sonnet',
          ignoreFocusOut: true,
        });
        if (!model?.trim()) {
          this.post({ type: 'models', ...this.modelStore.getStateForWebview() });
          break;
        }
        const result = await this.modelStore.addCustomModel(model);
        if (result.ok) {
          const id = model.trim();
          await this.modelStore.setSelectedModelId(id);
          this.post({ type: 'modelAdded', modelId: id, ...this.modelStore.getStateForWebview() });
        } else {
          void vscode.window.showWarningMessage(
            `OpenRouter Agent: ${result.error ?? 'Could not add model.'}`
          );
          this.post({ type: 'models', ...this.modelStore.getStateForWebview() });
        }
        break;
      }
      case 'ready':
        this.loadActiveSession();
        this.syncState();
        if (this.pendingUserMessage) {
          const text = this.pendingUserMessage;
          this.pendingUserMessage = null;
          await this.handleSend(text, this.mode, this.modelStore.getSelectedModelId());
        }
        break;
      case 'toolApprovalResponse':
        this.approvalBridge.respond(
          String(msg.id ?? ''),
          (msg.choice === 'once' || msg.choice === 'always' || msg.choice === 'skip'
            ? msg.choice
            : 'skip') as PermissionChoice
        );
        break;
    }
  }

  async sendExternalMessage(text: string, mode?: AgentMode): Promise<void> {
    if (mode) {
      this.mode = mode;
    }
    if (this.getWebview()) {
      await this.handleSend(text, this.mode, this.modelStore.getSelectedModelId());
    } else {
      this.pendingUserMessage = text;
      await this.focus();
    }
  }

  private syncState(): void {
    this.post({
      type: 'init',
      history: this.history,
      mode: this.mode,
      processing: this.processing,
      sessions: this.historyStore.listSessions(),
      activeSessionId: this.historyStore.getActiveId(),
      ...this.modelStore.getStateForWebview(),
    });
  }

  private post(message: unknown): void {
    void this.getWebview()?.postMessage(message);
  }

  private setLoading(
    loading: boolean,
    label?: string,
    process?: { completed: string[]; current: string; thought?: string }
  ): void {
    this.post({
      type: 'loading',
      loading,
      label: label ?? 'Thinking…',
      process,
    });
  }

  private updateProcess(
    completed: string[],
    current: string,
    thought?: string
  ): void {
    this.setLoading(true, current, {
      completed,
      current,
      thought: thought?.trim() || undefined,
    });
  }

  private async handleSend(
    text: string,
    mode: AgentMode,
    modelId: string
  ): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.processing) {
      return;
    }

    const needsWorkspace = mode === 'agent' || mode === 'ask';
    if (needsWorkspace && !vscode.workspace.workspaceFolders?.length) {
      this.post({
        type: 'error',
        message:
          mode === 'agent'
            ? 'Agent mode requires an open workspace folder.'
            : 'Open a workspace folder to list or read project files.',
      });
      return;
    }

    await this.modelStore.setSelectedModelId(modelId);

    this.processing = true;
    this.mode = mode;
    this.history.push({ role: 'user', content: trimmed });
    await this.persistSession(trimmed);
    this.post({ type: 'userMessage', content: trimmed });
    this.post({
      type: 'sessions',
      sessions: this.historyStore.listSessions(),
      activeSessionId: this.historyStore.getActiveId(),
    });

    const modelLabel =
      modelId === AUTO_MODEL_ID
        ? 'Auto'
        : modelId.length > 28
          ? modelId.slice(0, 28) + '…'
          : modelId;
    this.setLoading(true, `Step 1: Thinking with ${modelLabel}…`, {
      completed: [],
      current: `Step 1: Thinking with ${modelLabel}…`,
    });

    try {
      const context = await gatherContext();
      const apiHistory: ChatMessage[] = this.history
        .slice(0, -1)
        .map((m) => ({ role: m.role, content: m.content }));

      let response: string;
      const conversation = buildMessagesWithHistory(mode, trimmed, context, apiHistory);

      if (mode === 'plan') {
        this.updateProcess(
          [],
          'Step 1: Planning…',
          'Reviewing your request and drafting a plan…'
        );
        response = await askOpenRouter(conversation, {
          modelStore: this.modelStore,
          apiKeyStore: this.apiKeyStore,
        });
        if (hasToolCallMarkup(response)) {
          const visible = stripToolBlock(response);
          response =
            (visible || '') +
            '\n\n💡 **Plan mode** does not run tools. Switch to **Agent** (or **Ask** for read-only) to explore files.';
        }
      } else {
        const out = await this.runToolLoop(conversation, mode === 'agent');
        response = out.content;
        this.history.push({ role: 'assistant', content: response, details: out.details });
        await this.persistSession();
        this.post({
          type: 'assistantMessage',
          content: response,
          details: out.details,
        });
        this.post({
          type: 'sessions',
          sessions: this.historyStore.listSessions(),
          activeSessionId: this.historyStore.getActiveId(),
        });
        return;
      }

      this.history.push({ role: 'assistant', content: response });
      await this.persistSession();
      this.post({ type: 'assistantMessage', content: response });
      this.post({
        type: 'sessions',
        sessions: this.historyStore.listSessions(),
        activeSessionId: this.historyStore.getActiveId(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.post({ type: 'error', message: msg });
    } finally {
      this.processing = false;
      this.setLoading(false);
    }
  }

  private async runToolLoop(
    conversation: ChatMessage[],
    allowWrites: boolean
  ): Promise<{ content: string; details: ToolDetailEntry[] }> {
    const displayParts: string[] = [];
    const details: ToolDetailEntry[] = [];
    const completedSteps: string[] = [];
    let lastAssistant = '';
    let stepNum = 0;

    for (let i = 0; i < MAX_AGENT_ITERATIONS; i++) {
      stepNum++;
      const thinkStep = describeProcessStep(stepNum, 'thinking');
      this.updateProcess(completedSteps, thinkStep);

      const raw = await askOpenRouter(conversation, {
        modelStore: this.modelStore,
        apiKeyStore: this.apiKeyStore,
      });
      lastAssistant = raw;

      if (
        raw.startsWith('**Error:**') ||
        raw.startsWith('**API Error:**') ||
        raw.startsWith('**Network Error:**')
      ) {
        return { content: raw, details };
      }

      const toolCall = parseToolCall(raw);
      const visible = cleanAssistantVisibleText(raw);

      if (visible && toolCall) {
        this.updateProcess(completedSteps, thinkStep.replace(/…$/, '') + '…', visible);
      }

      if (!toolCall) {
        completedSteps.push(
          thinkStep.replace(/…$/, '').replace(/\.+$/, '') + ' — done'
        );
        if (visible) {
          displayParts.push(visible);
        } else if (hasToolCallMarkup(raw)) {
          displayParts.push(
            '_Could not run a tool call from the model. Try again or switch models._'
          );
        }
        break;
      }

      if (!allowWrites && !isReadOnlyTool(toolCall.tool)) {
        completedSteps.push(thinkStep.replace(/…$/, '') + ' — done');
        if (visible) {
          displayParts.push(visible);
        }
        displayParts.push(
          '\n\n💡 **Switch to Agent mode** to write files or run terminal commands.'
        );
        break;
      }

      completedSteps.push(thinkStep.replace(/…$/, '') + ' — done');

      stepNum++;
      const toolStep = describeProcessStep(stepNum, 'tool', toolCall);
      this.updateProcess(completedSteps, toolStep, visible);

      const { result, displayNote } = await handleToolCall(toolCall, {
        onPropose: () => {
          /* approval card shown in chat */
        },
        requestApproval: (req) => this.approvalBridge.request(req),
        terminalCallbacks: {
          onStart: (info) => {
            this.post({
              type: 'terminalRunStart',
              runId: info.runId,
              command: info.command,
              cwd: info.cwd,
              shell: info.shell,
              background: info.background,
            });
          },
          onOutput: (info) => {
            this.post({
              type: 'terminalRunUpdate',
              runId: info.runId,
              stdout: info.stdout,
              stderr: info.stderr,
            });
          },
          onComplete: (run) => {
            this.post({
              type: 'terminalRunEnd',
              runId: run.runId,
              command: run.command,
              cwd: run.cwd,
              shell: run.shell,
              stdout: run.stdout,
              stderr: run.stderr,
              exitCode: run.exitCode,
              timedOut: run.timedOut,
              success: run.success,
              background: run.background,
              running: run.running,
            });
          },
        },
        onTerminalOutput: () => {
          /* terminal UI driven by terminalCallbacks */
        },
      });

      const resultPreview =
        result.length > 6000 ? result.slice(0, 6000) + '\n… [truncated]' : result;
      details.push({
        step: stepNum,
        title: displayNote ?? describeToolCall(toolCall),
        result: resultPreview,
      });

      completedSteps.push(
        describeProcessDone(stepNum, toolCall, displayNote)
      );

      conversation.push({ role: 'assistant', content: raw });
      conversation.push({
        role: 'user',
        content: `Tool result for ${toolCall.tool}:\n\`\`\`json\n${result}\n\`\`\``,
      });
    }

    if (displayParts.length > 0) {
      return { content: displayParts.join('\n\n'), details };
    }

    const fallback = cleanAssistantVisibleText(lastAssistant) || stripToolBlock(lastAssistant);
    if (fallback) {
      return { content: fallback, details };
    }

    if (details.length > 0) {
      const content = await this.fetchFinalSummary(conversation, completedSteps);
      return { content, details };
    }

    return {
      content:
        '_No response from the model. Check your API key and model, then try again._',
      details,
    };
  }

  private async fetchFinalSummary(
    conversation: ChatMessage[],
    completedSteps: string[]
  ): Promise<string> {
    const step = completedSteps.length + 1;
    this.updateProcess(
      completedSteps,
      `Step ${step}: Writing your answer…`,
      'Summarizing what was found in your project…'
    );

    conversation.push({
      role: 'user',
      content:
        'You have finished running tools. Reply to the user now with a clear, helpful answer ' +
        'based on everything you read. Use markdown if helpful. ' +
        'Do NOT call any more tools. Do NOT use XML tool_call tags or agent-tool JSON blocks.',
    });

    const raw = await askOpenRouter(conversation, {
      modelStore: this.modelStore,
      apiKeyStore: this.apiKeyStore,
    });
    if (
      raw.startsWith('**Error:**') ||
      raw.startsWith('**API Error:**') ||
      raw.startsWith('**Network Error:**')
    ) {
      return raw;
    }

    const visible = cleanAssistantVisibleText(raw);
    if (visible) {
      return visible;
    }

    if (!parseToolCall(raw)) {
      return stripToolBlock(raw) || raw;
    }

    return (
      '_Tools completed successfully. Expand **Show details** below for raw results, ' +
      'or send a follow-up message like “summarize what you found”._'
    );
  }

  private getHtml(): string {
    const nonce = getNonce();
    const addModelOption = ADD_MODEL_OPTION;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>OpenRouter Chat</title>
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
    }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
    }
    .history-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
      background: var(--vscode-sideBar-background);
    }
    .history-label {
      font-size: 0.7em;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      opacity: 0.65;
      white-space: nowrap;
    }
    .history-select {
      flex: 1;
      min-width: 0;
      font-family: inherit;
      font-size: 0.8em;
      color: var(--vscode-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 6px;
      padding: 5px 8px;
      cursor: pointer;
    }
    .header-btn {
      font-family: inherit;
      font-size: 0.8em;
      background: transparent;
      color: var(--vscode-foreground);
      border: none;
      border-radius: 4px;
      padding: 4px 8px;
      cursor: pointer;
      opacity: 0.8;
    }
    .header-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
    button:disabled, select:disabled, textarea:disabled { opacity: 0.45; cursor: not-allowed; }
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-height: 0;
    }
    .msg {
      padding: 8px 10px;
      border-radius: 6px;
      line-height: 1.45;
      word-break: break-word;
      white-space: pre-wrap;
    }
    .msg.user {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      align-self: flex-end;
      max-width: 95%;
    }
    .msg.assistant {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      align-self: flex-start;
      max-width: 100%;
    }
    .msg.error {
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      color: var(--vscode-errorForeground);
    }
    .msg.thinking {
      background: var(--vscode-editor-background);
      border: 1px dashed var(--vscode-focusBorder);
      align-self: flex-start;
      max-width: 100%;
      opacity: 1;
      animation: thinkingIn 0.2s ease;
    }
    @keyframes thinkingIn {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .msg.thinking.thinking-fade-out {
      animation: thinkingOut 0.3s ease forwards;
    }
    @keyframes thinkingOut {
      to { opacity: 0; transform: translateY(-6px); max-height: 0; margin: 0; padding: 0; overflow: hidden; }
    }
    .thinking-subtitle {
      font-size: 0.72em;
      opacity: 0.6;
      font-weight: normal;
      text-transform: none;
      margin-top: 2px;
    }
    .thinking-thought {
      font-style: italic;
      opacity: 0.88;
      font-size: 0.9em;
      line-height: 1.4;
      padding: 8px 0 2px;
      margin-top: 6px;
      border-top: 1px dashed var(--vscode-panel-border);
    }
    .msg .role {
      font-size: 0.75em;
      font-weight: 600;
      text-transform: uppercase;
      opacity: 0.7;
      margin-bottom: 4px;
    }
    .thinking-body {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .thinking-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .process-log {
      margin: 0;
      padding: 0 0 0 4px;
      list-style: none;
      font-size: 0.85em;
      opacity: 0.9;
    }
    .process-log li {
      padding: 2px 0;
      line-height: 1.35;
    }
    .process-log li.done {
      opacity: 0.65;
    }
    .process-log li.done::before {
      content: '✓ ';
      color: var(--vscode-testing-iconPassed, #89d185);
    }
    .process-log li.current {
      font-weight: 600;
      opacity: 1;
    }
    .tool-details {
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid var(--vscode-panel-border);
      font-size: 0.85em;
    }
    .tool-details summary {
      cursor: pointer;
      opacity: 0.85;
      user-select: none;
    }
    .tool-details summary:hover {
      opacity: 1;
      color: var(--vscode-textLink-foreground);
    }
    .tool-details[open] summary {
      margin-bottom: 8px;
    }
    .tool-detail-block {
      margin-bottom: 10px;
    }
    .tool-detail-block:last-child {
      margin-bottom: 0;
    }
    .tool-detail-title {
      font-weight: 600;
      margin-bottom: 4px;
      opacity: 0.9;
    }
    .tool-detail-block pre {
      margin: 0;
      max-height: 200px;
      overflow: auto;
      font-size: 0.9em;
    }
    .thinking-dots {
      display: inline-flex;
      gap: 4px;
    }
    .thinking-dots span {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--vscode-progressBar-background, var(--vscode-focusBorder));
      animation: bounce 1.2s infinite ease-in-out;
    }
    .thinking-dots span:nth-child(2) { animation-delay: 0.15s; }
    .thinking-dots span:nth-child(3) { animation-delay: 0.3s; }
    @keyframes bounce {
      0%, 80%, 100% { transform: scale(0.6); opacity: 0.5; }
      40% { transform: scale(1); opacity: 1; }
    }
    .msg code {
      font-family: var(--vscode-editor-font-family);
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 4px;
      border-radius: 3px;
    }
    .msg pre {
      overflow-x: auto;
      background: var(--vscode-textCodeBlock-background);
      padding: 8px;
      border-radius: 4px;
      margin: 6px 0;
    }
    .composer-wrap {
      padding: 8px 10px 10px;
      border-top: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
      background: var(--vscode-sideBar-background);
    }
    .composer {
      display: flex;
      flex-direction: column;
      border: 1px solid var(--vscode-input-border);
      border-radius: 10px;
      background: var(--vscode-input-background);
      overflow: hidden;
    }
    .composer:focus-within {
      border-color: var(--vscode-focusBorder);
      outline: 1px solid var(--vscode-focusBorder);
    }
    #input {
      width: 100%;
      min-height: 56px;
      max-height: 160px;
      resize: none;
      font-family: inherit;
      font-size: inherit;
      line-height: 1.45;
      color: var(--vscode-input-foreground);
      background: transparent;
      border: none;
      padding: 10px 12px 4px;
      outline: none;
    }
    #input::placeholder {
      color: var(--vscode-input-placeholderForeground);
      opacity: 0.75;
    }
    .composer-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 8px 8px;
    }
    .composer-left {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .composer-right {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    .pill-select {
      font-family: inherit;
      font-size: 0.8em;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 14px;
      padding: 4px 26px 4px 10px;
      max-width: 140px;
      cursor: pointer;
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath fill='%23999' d='M0 0l5 6 5-6z'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 8px center;
    }
    .pill-select:hover:not(:disabled) {
      border-color: var(--vscode-focusBorder);
    }
    #modelSelect { max-width: 160px; }
    .send-spinner {
      width: 18px;
      height: 18px;
      border: 2px solid var(--vscode-panel-border);
      border-top-color: var(--vscode-foreground);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
      flex-shrink: 0;
    }
    .send-spinner.hidden { display: none; }
    .send-btn {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      border: none;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      font-size: 14px;
      line-height: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .send-btn:hover:not(:disabled) {
      filter: brightness(1.08);
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .approval-card {
      margin: 8px 0;
      padding: 12px;
      border-radius: 8px;
      border: 1px solid var(--vscode-inputValidation-warningBorder, #cca700);
      background: var(--vscode-inputValidation-warningBackground, rgba(204, 167, 0, 0.12));
    }
    .approval-card.destructive {
      border-color: var(--vscode-inputValidation-errorBorder);
      background: var(--vscode-inputValidation-errorBackground);
    }
    .approval-title {
      font-weight: 600;
      margin-bottom: 8px;
    }
    .approval-detail {
      font-family: var(--vscode-editor-font-family);
      font-size: 0.85em;
      background: var(--vscode-textCodeBlock-background);
      padding: 8px;
      border-radius: 4px;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 160px;
      overflow: auto;
      margin-bottom: 10px;
    }
    .approval-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .approval-select {
      flex: 1;
      min-width: 140px;
      font-family: inherit;
      font-size: 0.85em;
      padding: 6px 8px;
      border-radius: 6px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-foreground);
    }
    .approval-run-btn {
      font-family: inherit;
      font-size: 0.85em;
      padding: 6px 14px;
      border-radius: 6px;
      border: none;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      cursor: pointer;
    }
    .approval-run-btn:hover { filter: brightness(1.08); }
    .approval-run-btn.skip {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .terminal-block {
      margin: 8px 0;
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-terminal-background, #1e1e1e);
      font-family: var(--vscode-editor-font-family);
      font-size: 0.82em;
    }
    .terminal-header {
      padding: 6px 10px;
      background: var(--vscode-titleBar-activeBackground, #333);
      color: var(--vscode-terminal-foreground, #ccc);
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .terminal-header-title {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .terminal-header::before {
      content: '⌘';
      opacity: 0.7;
    }
    .terminal-output {
      margin: 0;
      padding: 10px;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 280px;
      overflow: auto;
      color: var(--vscode-terminal-foreground, #cccccc);
    }
    .terminal-footer {
      padding: 4px 10px;
      font-size: 0.85em;
      opacity: 0.75;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .terminal-footer.error { color: var(--vscode-errorForeground); }
    .terminal-footer.ok { color: var(--vscode-testing-iconPassed, #89d185); }
    .terminal-footer.running { color: var(--vscode-progressBar-background, #007acc); }
    .terminal-block.running { border-color: var(--vscode-progressBar-background, #007acc); }
    .terminal-status {
      margin-left: auto;
      font-size: 0.9em;
      opacity: 0.9;
    }
    .terminal-status.running::before { content: '● '; color: var(--vscode-progressBar-background, #007acc); }
    .terminal-status.ok::before { content: '✓ '; }
    .terminal-status.error::before { content: '✗ '; }
  </style>
</head>
<body>
  <div class="history-bar">
    <span class="history-label">History</span>
    <select id="sessionSelect" class="history-select" title="Switch chat"></select>
    <button type="button" id="newSessionBtn" class="header-btn" title="New chat">+</button>
    <button type="button" id="deleteSessionBtn" class="header-btn" title="Delete chat">Del</button>
    <button type="button" id="clearBtn" class="header-btn" title="Clear messages">Clear</button>
  </div>
  <div id="messages"></div>
  <div class="composer-wrap">
    <div class="composer">
      <textarea id="input" rows="3" placeholder="Ask, Plan, or Agent — Ctrl+Enter to send"></textarea>
      <div class="composer-footer">
        <div class="composer-left">
          <select id="mode" class="pill-select" title="Mode">
            <option value="ask">Ask</option>
            <option value="plan">Plan</option>
            <option value="agent">Agent</option>
          </select>
          <select id="modelSelect" class="pill-select" title="Model"></select>
        </div>
        <div class="composer-right">
          <div id="sendSpinner" class="send-spinner hidden" title="Working…"></div>
          <button type="button" id="sendBtn" class="send-btn" title="Send (Ctrl+Enter)">↑</button>
        </div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const AUTO_MODEL = '${AUTO_MODEL_ID}';
    const ADD_MODEL = '${addModelOption}';
    const messagesEl = document.getElementById('messages');
    const inputEl = document.getElementById('input');
    const sendBtn = document.getElementById('sendBtn');
    const sendSpinner = document.getElementById('sendSpinner');
    const clearBtn = document.getElementById('clearBtn');
    const sessionSelectEl = document.getElementById('sessionSelect');
    const newSessionBtn = document.getElementById('newSessionBtn');
    const deleteSessionBtn = document.getElementById('deleteSessionBtn');
    const modeEl = document.getElementById('mode');
    const modelSelectEl = document.getElementById('modelSelect');

    let processing = false;
    let thinkingEl = null;
    let approvalPending = false;

    function escapeHtml(text) {
      const d = document.createElement('div');
      d.textContent = text;
      return d.innerHTML;
    }

    function formatContent(text) {
      let html = escapeHtml(text);
      html = html.replace(/\`\`\`([\\w]*)\\n([\\s\\S]*?)\`\`\`/g, (_, lang, code) => {
        return '<pre><code>' + code + '</code></pre>';
      });
      html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
      html = html.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
      return html;
    }

    function appendToolDetails(parent, details) {
      if (!details || !details.length) return;
      const det = document.createElement('details');
      det.className = 'tool-details';
      const sum = document.createElement('summary');
      sum.textContent = 'Show details (' + details.length + ' tool' + (details.length === 1 ? '' : 's') + ')';
      det.appendChild(sum);
      details.forEach((d) => {
        const block = document.createElement('div');
        block.className = 'tool-detail-block';
        const title = document.createElement('div');
        title.className = 'tool-detail-title';
        title.textContent = (d.step ? 'Step ' + d.step + ': ' : '') + d.title;
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = d.result || '';
        pre.appendChild(code);
        block.appendChild(title);
        block.appendChild(pre);
        det.appendChild(block);
      });
      parent.appendChild(det);
    }

    const terminalBlocks = new Map();

    function terminalFooterText(exitCode, timedOut, success, background, running) {
      if (running) {
        return background ? 'Running in background' : 'Running…';
      }
      if (timedOut) {
        return 'Timed out';
      }
      if (success || exitCode === 0) {
        return 'Success';
      }
      return 'Failed (exit ' + exitCode + ')';
    }

    function terminalFooterClass(exitCode, timedOut, success, running) {
      if (running) {
        return 'terminal-footer running';
      }
      if (timedOut || (!success && exitCode !== 0)) {
        return 'terminal-footer error';
      }
      return 'terminal-footer ok';
    }

    function createTerminalBlock(runId, command, cwd, shell, background) {
      const div = document.createElement('div');
      div.className = 'terminal-block running';
      div.dataset.runId = runId;

      const header = document.createElement('div');
      header.className = 'terminal-header';
      const shellName = shell ? shell.replace(/^.*[\\\\/]/, '') : 'shell';
      const title = document.createElement('span');
      title.className = 'terminal-header-title';
      title.textContent = shellName + ' › ' + (cwd ? cwd + ' › ' : '') + command;
      header.appendChild(title);

      const status = document.createElement('span');
      status.className = 'terminal-status running';
      status.textContent = background ? 'Starting…' : 'Running…';
      header.appendChild(status);

      const pre = document.createElement('pre');
      pre.className = 'terminal-output';
      pre.textContent = '(waiting for output…)';

      const footer = document.createElement('div');
      footer.className = 'terminal-footer running';
      footer.textContent = background ? 'Starting in background…' : 'Running…';

      div.appendChild(header);
      div.appendChild(pre);
      div.appendChild(footer);
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;

      terminalBlocks.set(runId, { div, pre, footer, status });
      return div;
    }

    function updateTerminalBlock(runId, stdout, stderr) {
      const block = terminalBlocks.get(runId);
      if (!block) {
        return;
      }
      const out = [stdout, stderr].filter(Boolean).join(stderr && stdout ? '\\n' : '');
      block.pre.textContent = out || '(no output yet)';
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function finishTerminalBlock(runId, stdout, stderr, exitCode, timedOut, success, background, running) {
      let block = terminalBlocks.get(runId);
      if (!block) {
        createTerminalBlock(runId, '', '', '', !!background);
        block = terminalBlocks.get(runId);
      }
      if (!block) {
        return;
      }

      const out = [stdout, stderr].filter(Boolean).join(stderr && stdout ? '\\n' : '');
      block.pre.textContent = out || '(no output)';

      block.footer.className = terminalFooterClass(exitCode, timedOut, success, !!running);
      block.footer.textContent = terminalFooterText(exitCode, timedOut, success, background, running);

      block.status.className = 'terminal-status ' + (running ? 'running' : success ? 'ok' : 'error');
      block.status.textContent = running ? 'Background' : success ? 'Success' : 'Failed';

      if (running) {
        block.div.classList.add('running');
      } else {
        block.div.classList.remove('running');
        terminalBlocks.delete(runId);
      }

      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function appendTerminalBlock(command, cwd, shell, stdout, stderr, exitCode, timedOut) {
      const runId = 'legacy-' + Date.now();
      createTerminalBlock(runId, command, cwd, shell, false);
      finishTerminalBlock(runId, stdout, stderr, exitCode, timedOut, exitCode === 0 && !timedOut, false, false);
    }

    function showApprovalCard(msg) {
      const div = document.createElement('div');
      div.className = 'approval-card' + (msg.destructive ? ' destructive' : '');
      div.dataset.approvalId = msg.id;

      const title = document.createElement('div');
      title.className = 'approval-title';
      title.textContent = msg.title || 'Allow action?';

      const detail = document.createElement('div');
      detail.className = 'approval-detail';
      detail.textContent = msg.detail || '';

      const actions = document.createElement('div');
      actions.className = 'approval-actions';

      const select = document.createElement('select');
      select.className = 'approval-select';
      [
        { v: 'once', l: 'Run this time only' },
        { v: 'always', l: 'Always allow' },
        { v: 'skip', l: 'Skip' }
      ].forEach((o) => {
        const opt = document.createElement('option');
        opt.value = o.v;
        opt.textContent = o.l;
        select.appendChild(opt);
      });

      const runBtn = document.createElement('button');
      runBtn.type = 'button';
      runBtn.className = 'approval-run-btn';
      runBtn.textContent = 'Run';

      const skipBtn = document.createElement('button');
      skipBtn.type = 'button';
      skipBtn.className = 'approval-run-btn skip';
      skipBtn.textContent = 'Skip';

      function submit(choice) {
        vscode.postMessage({ type: 'toolApprovalResponse', id: msg.id, choice });
        div.remove();
      }

      runBtn.addEventListener('click', () => submit(select.value));
      skipBtn.addEventListener('click', () => submit('skip'));

      actions.appendChild(select);
      actions.appendChild(runBtn);
      actions.appendChild(skipBtn);
      div.appendChild(title);
      div.appendChild(detail);
      div.appendChild(actions);
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function appendMessage(role, content, extraClass, details) {
      const div = document.createElement('div');
      div.className = 'msg ' + role + (extraClass ? ' ' + extraClass : '');
      const label = role === 'user' ? 'You' : role === 'error' ? 'Error' : 'Assistant';
      const body = document.createElement('div');
      body.className = 'msg-body';
      body.innerHTML = formatContent(content);
      div.innerHTML = '<div class="role">' + label + '</div>';
      div.appendChild(body);
      if (role === 'assistant') {
        appendToolDetails(div, details);
      }
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return div;
    }

    function renderProcessHtml(completed, current, thought) {
      let html = '';
      if (completed && completed.length) {
        html += '<ul class="process-log">';
        completed.forEach((s) => {
          html += '<li class="done">' + escapeHtml(s) + '</li>';
        });
        html += '</ul>';
      }
      html +=
        '<div class="thinking-row">' +
        '<div class="thinking-dots"><span></span><span></span><span></span></div>' +
        '<span class="thinking-label">' + escapeHtml(current || 'Thinking…') + '</span></div>';
      if (thought) {
        html += '<div class="thinking-thought">' + escapeHtml(thought) + '</div>';
      }
      return html;
    }

    function showThinking(label, process) {
      removeThinking(true);
      thinkingEl = document.createElement('div');
      thinkingEl.className = 'msg thinking';
      thinkingEl.id = 'thinking-indicator';
      const completed = process && process.completed ? process.completed : [];
      const current = (process && process.current) || label || 'Thinking…';
      const thought = process && process.thought ? process.thought : '';
      thinkingEl.innerHTML =
        '<div class="role">Thinking<div class="thinking-subtitle">Hidden when the answer is ready</div></div>' +
        '<div class="thinking-body">' +
        renderProcessHtml(completed, current, thought) +
        '</div>';
      messagesEl.appendChild(thinkingEl);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function updateThinking(label, process) {
      const completed = process && process.completed ? process.completed : [];
      const current = (process && process.current) || label || 'Thinking…';
      const thought = process && process.thought ? process.thought : '';
      if (!thinkingEl) {
        showThinking(label, process);
        return;
      }
      const body = thinkingEl.querySelector('.thinking-body');
      if (body) {
        body.innerHTML = renderProcessHtml(completed, current, thought);
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function removeThinking(instant) {
      const el = thinkingEl || document.getElementById('thinking-indicator');
      if (!el || el.classList.contains('thinking-fade-out')) {
        thinkingEl = null;
        return;
      }
      thinkingEl = null;
      if (instant) {
        el.remove();
        return;
      }
      el.classList.add('thinking-fade-out');
      setTimeout(() => {
        if (el.parentNode) el.remove();
      }, 300);
    }

    function shortModelLabel(id) {
      if (id === AUTO_MODEL) return 'Auto';
      if (id.length > 24) return id.slice(0, 22) + '…';
      return id;
    }

    function getSelectedModelId() {
      const v = modelSelectEl.value;
      if (v === ADD_MODEL) {
        return modelSelectEl.dataset.lastValue || AUTO_MODEL;
      }
      return v;
    }

    function formatSessionTime(ts) {
      const d = new Date(ts);
      const now = new Date();
      const sameDay = d.toDateString() === now.toDateString();
      if (sameDay) {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }

    function populateSessions(sessions, activeId) {
      sessionSelectEl.innerHTML = '';
      (sessions || []).forEach((s) => {
        const opt = document.createElement('option');
        opt.value = s.id;
        const count = s.messageCount ? ' (' + s.messageCount + ')' : '';
        opt.textContent = s.title + ' · ' + formatSessionTime(s.updatedAt) + count;
        opt.title = s.title;
        sessionSelectEl.appendChild(opt);
      });
      if (activeId) {
        sessionSelectEl.value = activeId;
      }
    }

    function populateModels(state) {
      const models = state.availableModels || [];
      const selected = state.selectedModelId || AUTO_MODEL;
      modelSelectEl.innerHTML = '';
      const autoOpt = document.createElement('option');
      autoOpt.value = AUTO_MODEL;
      autoOpt.textContent = 'Auto';
      modelSelectEl.appendChild(autoOpt);
      models.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = shortModelLabel(m);
        opt.title = m;
        modelSelectEl.appendChild(opt);
      });
      const sep = document.createElement('option');
      sep.disabled = true;
      sep.textContent = '──────────';
      modelSelectEl.appendChild(sep);
      const addOpt = document.createElement('option');
      addOpt.value = ADD_MODEL;
      addOpt.textContent = 'Add model…';
      modelSelectEl.appendChild(addOpt);
      if (selected === AUTO_MODEL || models.includes(selected)) {
        modelSelectEl.value = selected;
      } else if (models.length) {
        modelSelectEl.value = models[0];
      } else {
        modelSelectEl.value = AUTO_MODEL;
      }
      modelSelectEl.dataset.lastValue = modelSelectEl.value;
    }

    function setLoading(loading, label, process) {
      processing = loading;
      sendBtn.disabled = loading || approvalPending;
      inputEl.disabled = loading || approvalPending;
      modeEl.disabled = loading || approvalPending;
      modelSelectEl.disabled = loading || approvalPending;
      sessionSelectEl.disabled = loading || approvalPending;
      newSessionBtn.disabled = loading || approvalPending;
      deleteSessionBtn.disabled = loading || approvalPending;
      clearBtn.disabled = loading || approvalPending;
      if (loading) {
        sendSpinner.classList.remove('hidden');
        if (thinkingEl) {
          updateThinking(label, process);
        } else {
          showThinking(label, process);
        }
      } else {
        sendSpinner.classList.add('hidden');
      }
    }

    function send() {
      const text = inputEl.value.trim();
      if (!text || processing) return;
      const modelId = getSelectedModelId();
      vscode.postMessage({
        type: 'send',
        text,
        mode: modeEl.value,
        modelId
      });
      inputEl.value = '';
    }

    sendBtn.addEventListener('click', send);
    clearBtn.addEventListener('click', () => {
      if (processing) return;
      vscode.postMessage({ type: 'clear' });
      messagesEl.innerHTML = '';
      removeThinking(true);
    });
    newSessionBtn.addEventListener('click', () => {
      if (processing) return;
      vscode.postMessage({ type: 'newSession' });
    });
    sessionSelectEl.addEventListener('change', () => {
      if (processing) return;
      vscode.postMessage({ type: 'switchSession', sessionId: sessionSelectEl.value });
    });
    deleteSessionBtn.addEventListener('click', () => {
      if (processing) return;
      vscode.postMessage({ type: 'deleteSession', sessionId: sessionSelectEl.value });
    });
    modeEl.addEventListener('change', () => {
      vscode.postMessage({ type: 'setMode', mode: modeEl.value });
    });
    modelSelectEl.addEventListener('change', () => {
      if (modelSelectEl.value === ADD_MODEL) {
        const prev = modelSelectEl.dataset.lastValue || AUTO_MODEL;
        modelSelectEl.value = prev;
        vscode.postMessage({ type: 'promptAddModel' });
        return;
      }
      modelSelectEl.dataset.lastValue = modelSelectEl.value;
      vscode.postMessage({ type: 'setModel', modelId: modelSelectEl.value });
    });
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        send();
      }
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'init':
          messagesEl.innerHTML = '';
          removeThinking(true);
          modeEl.value = msg.mode || 'ask';
          populateModels(msg);
          populateSessions(msg.sessions, msg.activeSessionId);
          (msg.history || []).forEach((m) => appendMessage(m.role, m.content, '', m.details));
          setLoading(!!msg.processing, msg.label);
          break;
        case 'sessions':
          populateSessions(msg.sessions, msg.activeSessionId);
          break;
        case 'models':
          populateModels(msg);
          break;
        case 'modelAdded':
          populateModels(msg);
          if (msg.modelId) {
            modelSelectEl.value = msg.modelId;
            modelSelectEl.dataset.lastValue = msg.modelId;
          }
          break;
        case 'userMessage':
          appendMessage('user', msg.content);
          messagesEl.scrollTop = messagesEl.scrollHeight;
          break;
        case 'assistantMessage':
          removeThinking(false);
          setTimeout(() => {
            appendMessage('assistant', msg.content, '', msg.details);
          }, 280);
          break;
        case 'assistantPartial':
          break;
        case 'error':
          removeThinking(false);
          setTimeout(() => {
            appendMessage('error', msg.content || msg.message, 'error');
          }, 280);
          break;
        case 'loading':
          if (msg.loading) {
            setLoading(true, msg.label, msg.process);
          } else {
            setLoading(false);
          }
          break;
        case 'cleared':
          messagesEl.innerHTML = '';
          removeThinking();
          break;
        case 'toolApproval':
          showApprovalCard(msg);
          break;
        case 'approvalPending':
          approvalPending = !!msg.pending;
          if (approvalPending) {
            sendBtn.disabled = true;
            inputEl.disabled = true;
          } else if (!processing) {
            sendBtn.disabled = false;
            inputEl.disabled = false;
          }
          break;
        case 'terminalRunStart':
          createTerminalBlock(
            msg.runId || ('run-' + Date.now()),
            msg.command || '',
            msg.cwd || '',
            msg.shell || '',
            !!msg.background
          );
          break;
        case 'terminalRunUpdate':
          updateTerminalBlock(msg.runId, msg.stdout || '', msg.stderr || '');
          break;
        case 'terminalRunEnd':
          finishTerminalBlock(
            msg.runId,
            msg.stdout || '',
            msg.stderr || '',
            msg.exitCode ?? 1,
            !!msg.timedOut,
            !!msg.success,
            !!msg.background,
            !!msg.running
          );
          break;
        case 'terminalRun':
          appendTerminalBlock(
            msg.command || '',
            msg.cwd || '',
            msg.shell || '',
            msg.stdout || '',
            msg.stderr || '',
            msg.exitCode ?? 1,
            !!msg.timedOut
          );
          break;
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

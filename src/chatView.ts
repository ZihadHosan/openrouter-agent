import * as vscode from 'vscode';
import { AgentMode, buildMessagesWithHistory, gatherContext } from './agent';
import { ApiKeyStore } from './apiKeyStore';
import { ApprovalBridge, PermissionChoice } from './approvalBridge';
import { ChatHistoryStore } from './chatHistory';
import type { ChatSessionMessage, ToolDetailEntry } from './chatHistory';
import { ADD_MODEL_OPTION, AUTO_MODEL_ID, ModelStore } from './models';

export type { ChatSessionMessage, ToolDetailEntry };
import { askOpenRouter, AskOpenRouterAbortedError, ChatMessage } from './openrouter';
import {
  describeProcessDone,
  describeProcessStep,
  cleanAssistantVisibleText,
  describeToolCall,
  buildAutoToolCall,
  detectUserFileIntent,
  handleToolCall,
  hasToolCallMarkup,
  isReadOnlyTool,
  mentionsFileExistence,
  parseToolCall,
  requiresFileVerification,
  resolveToolCall,
  stripToolBlock,
  type ToolCall,
} from './tools';

const MAX_AGENT_ITERATIONS = 16;
const MAX_PARSE_RETRIES = 2;
const MAX_UNVERIFIED_RETRIES = 2;
const STOPPED_MESSAGE = '_Stopped._';

/** Single chat UI — one WebviewPanel on the right (no sidebar duplicate). */
export class ChatViewProvider {
  public static readonly panelType = 'openrouterAgent.chatPanel';

  private panel?: vscode.WebviewPanel;
  private history: ChatSessionMessage[] = [];
  private mode: AgentMode = 'ask';
  private processing = false;
  private pendingUserMessage: string | null = null;
  private activeAbortController?: AbortController;
  private streamActiveForUi = false;
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
    webview.html = this.getHtml(webview);
    webview.onDidReceiveMessage((msg) => {
      void this.handleWebviewMessage(msg);
    });
  }

  private getChatFontSize(): number {
    return vscode.workspace.getConfiguration('openrouterAgent').get<number>('chatFontSize', 0);
  }

  private getStreamEnabled(): boolean {
    return vscode.workspace
      .getConfiguration('openrouterAgent')
      .get<boolean>('streamResponses', true);
  }

  refreshWebview(): void {
    const webview = this.getWebview();
    if (webview) {
      webview.html = this.getHtml(webview);
    }
  }

  /** Reload webview HTML when extension updates (avoids stale CSS with retainContextWhenHidden). */
  refreshWebviewIfOpen(): void {
    if (this.panel) {
      this.refreshWebview();
    }
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
    url?: string;
  }): Promise<void> {
    switch (msg.type) {
      case 'openLink': {
        const url = String(msg.url ?? '').trim();
        if (url.startsWith('http://') || url.startsWith('https://')) {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        }
        break;
      }
      case 'send':
        await this.handleSend(
          String(msg.text ?? ''),
          msg.mode as AgentMode,
          String(msg.modelId ?? AUTO_MODEL_ID)
        );
        break;
      case 'stop':
        this.handleStop();
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
      chatFontSize: this.getChatFontSize(),
      ...this.modelStore.getStateForWebview(),
    });
  }

  private post(message: unknown): void {
    void this.getWebview()?.postMessage(message);
  }

  private beginRequest(): AbortSignal {
    this.activeAbortController?.abort();
    this.activeAbortController = new AbortController();
    return this.activeAbortController.signal;
  }

  private routerOptions(): {
    modelStore: ModelStore;
    apiKeyStore: ApiKeyStore;
    signal?: AbortSignal;
  } {
    return {
      modelStore: this.modelStore,
      apiKeyStore: this.apiKeyStore,
      signal: this.activeAbortController?.signal,
    };
  }

  private isAborted(): boolean {
    return this.activeAbortController?.signal.aborted ?? false;
  }

  private handleStop(): void {
    if (!this.processing) {
      return;
    }
    this.activeAbortController?.abort();
    this.approvalBridge.cancelAll();
    this.cancelStreamUi();
    this.setLoading(true, 'Stopping…');
  }

  private async callOpenRouter(conversation: ChatMessage[]): Promise<string> {
    return askOpenRouter(conversation, this.routerOptions());
  }

  private cancelStreamUi(): void {
    if (this.streamActiveForUi) {
      this.post({ type: 'assistantStreamCancel' });
      this.streamActiveForUi = false;
    }
  }

  private async callOpenRouterStreaming(
    conversation: ChatMessage[],
    forwardToUi: boolean
  ): Promise<string> {
    if (!this.getStreamEnabled() || !forwardToUi) {
      return this.callOpenRouter(conversation);
    }

    let streamStarted = false;
    const result = await askOpenRouter(conversation, {
      ...this.routerOptions(),
      stream: true,
      onChunk: (_delta, accumulated) => {
        if (!streamStarted) {
          streamStarted = true;
          this.streamActiveForUi = true;
          this.post({ type: 'assistantStreamStart' });
        }
        this.post({ type: 'assistantPartial', content: accumulated });
      },
    });

    if (!streamStarted) {
      this.streamActiveForUi = false;
    }

    return result;
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
    this.beginRequest();
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
        response = await this.callOpenRouterStreaming(conversation, true);
        if (this.isAborted()) {
          this.cancelStreamUi();
          response = STOPPED_MESSAGE;
        } else if (hasToolCallMarkup(response)) {
          const visible = stripToolBlock(response);
          response =
            (visible || '') +
            '\n\n💡 **Plan mode** does not run tools. Switch to **Agent** (or **Ask** for read-only) to explore files.';
        }
      } else {
        const out = await this.runToolLoop(conversation, mode === 'agent', trimmed);
        response = out.content;
        this.history.push({ role: 'assistant', content: response, details: out.details });
        await this.persistSession();
        this.post({
          type: 'assistantMessage',
          content: response,
          details: out.details,
          finalizeStream: this.streamActiveForUi,
        });
        this.streamActiveForUi = false;
        this.post({
          type: 'sessions',
          sessions: this.historyStore.listSessions(),
          activeSessionId: this.historyStore.getActiveId(),
        });
        return;
      }

      this.history.push({ role: 'assistant', content: response });
      await this.persistSession();
      this.post({
        type: 'assistantMessage',
        content: response,
        finalizeStream: this.streamActiveForUi,
      });
      this.streamActiveForUi = false;
      this.post({
        type: 'sessions',
        sessions: this.historyStore.listSessions(),
        activeSessionId: this.historyStore.getActiveId(),
      });
    } catch (err) {
      this.cancelStreamUi();
      if (err instanceof AskOpenRouterAbortedError || this.isAborted()) {
        this.history.push({ role: 'assistant', content: STOPPED_MESSAGE });
        await this.persistSession();
        this.post({ type: 'assistantMessage', content: STOPPED_MESSAGE });
        this.post({
          type: 'sessions',
          sessions: this.historyStore.listSessions(),
          activeSessionId: this.historyStore.getActiveId(),
        });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        this.post({ type: 'error', message: msg });
      }
    } finally {
      this.processing = false;
      this.activeAbortController = undefined;
      this.streamActiveForUi = false;
      this.setLoading(false);
    }
  }

  private async runToolLoop(
    conversation: ChatMessage[],
    allowWrites: boolean,
    userText: string
  ): Promise<{ content: string; details: ToolDetailEntry[] }> {
    if (this.isAborted()) {
      return { content: STOPPED_MESSAGE, details: [] };
    }

    const displayParts: string[] = [];
    const details: ToolDetailEntry[] = [];
    const completedSteps: string[] = [];
    let lastAssistant = '';
    let stepNum = 0;
    let toolsRun = 0;
    let parseRetries = 0;
    let unverifiedRetries = 0;
    const needsVerification = requiresFileVerification(userText);

    const autoCall = buildAutoToolCall(detectUserFileIntent(userText));
    if (autoCall && !this.isAborted()) {
      const resolved = resolveToolCall(autoCall);
      stepNum++;
      const toolStep = describeProcessStep(stepNum, 'tool', resolved);
      this.updateProcess(completedSteps, toolStep, 'Checking workspace files…');
      const ran = await this.runOneTool(
        resolved,
        '(auto)',
        conversation,
        details,
        completedSteps,
        stepNum,
        allowWrites
      );
      if (ran) {
        toolsRun++;
      }
    }

    for (let i = 0; i < MAX_AGENT_ITERATIONS; i++) {
      if (this.isAborted()) {
        return { content: STOPPED_MESSAGE, details };
      }

      stepNum++;
      const thinkStep = describeProcessStep(stepNum, 'thinking');
      this.updateProcess(completedSteps, thinkStep);

      let raw: string;
      try {
        raw = await this.callOpenRouterStreaming(conversation, true);
      } catch (err) {
        if (err instanceof AskOpenRouterAbortedError || this.isAborted()) {
          this.cancelStreamUi();
          return { content: STOPPED_MESSAGE, details };
        }
        throw err;
      }
      lastAssistant = raw;

      if (this.isAborted()) {
        this.cancelStreamUi();
        return { content: STOPPED_MESSAGE, details };
      }

      if (
        raw.startsWith('**Error:**') ||
        raw.startsWith('**API Error:**') ||
        raw.startsWith('**Network Error:**')
      ) {
        this.cancelStreamUi();
        return { content: raw, details };
      }

      const toolCall = parseToolCall(raw);
      const visible = cleanAssistantVisibleText(raw);

      if (toolCall) {
        this.cancelStreamUi();
      }

      if (visible && toolCall) {
        this.updateProcess(completedSteps, thinkStep.replace(/…$/, '') + '…', visible);
      }

      if (!toolCall) {
        if (hasToolCallMarkup(raw) && parseRetries < MAX_PARSE_RETRIES) {
          parseRetries++;
          completedSteps.push(thinkStep.replace(/…$/, '') + ' — retrying tool…');
          conversation.push({ role: 'assistant', content: raw });
          conversation.push({
            role: 'user',
            content:
              'Your tool call could not be parsed. Use exactly:\n```agent-tool\n{"tool":"read_file","path":"relative/path.md"}\n```',
          });
          continue;
        }

        const guessedAboutFiles =
          needsVerification &&
          toolsRun === 0 &&
          (visible || mentionsFileExistence(raw) || hasToolCallMarkup(raw));

        if (guessedAboutFiles && unverifiedRetries < MAX_UNVERIFIED_RETRIES) {
          unverifiedRetries++;
          completedSteps.push(thinkStep.replace(/…$/, '') + ' — verifying files…');
          const fallbackAuto = buildAutoToolCall(detectUserFileIntent(userText));
          if (fallbackAuto) {
            const resolved = resolveToolCall(fallbackAuto);
            stepNum++;
            const toolStep = describeProcessStep(stepNum, 'tool', resolved);
            this.updateProcess(completedSteps, toolStep);
            const ran = await this.runOneTool(
              resolved,
              raw,
              conversation,
              details,
              completedSteps,
              stepNum,
              allowWrites
            );
            if (ran) {
              toolsRun++;
              continue;
            }
          }
          conversation.push({ role: 'assistant', content: raw });
          conversation.push({
            role: 'user',
            content:
              'Do NOT guess about files. You must call read_file, list_files, or read_glob and use the JSON tool result before answering.',
          });
          continue;
        }

        completedSteps.push(
          thinkStep.replace(/…$/, '').replace(/\.+$/, '') + ' — done'
        );
        if (visible && !(needsVerification && toolsRun === 0)) {
          displayParts.push(visible);
        } else if (needsVerification && toolsRun === 0) {
          displayParts.push(
            '_Could not verify files in the workspace. Try again, open the correct folder, or switch models._'
          );
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
          `\n\n💡 **Ask mode is read-only.** Switch to **Agent mode** to run \`${toolCall.tool}\`.`
        );
        break;
      }

      completedSteps.push(thinkStep.replace(/…$/, '') + ' — done');

      stepNum++;
      const toolStep = describeProcessStep(stepNum, 'tool', toolCall);
      this.updateProcess(completedSteps, toolStep, visible);

      const ran = await this.runOneTool(
        toolCall,
        raw,
        conversation,
        details,
        completedSteps,
        stepNum,
        allowWrites
      );
      if (!ran) {
        break;
      }
      toolsRun++;

      if (this.isAborted()) {
        return { content: STOPPED_MESSAGE, details };
      }
    }

    if (displayParts.length > 0) {
      return { content: displayParts.join('\n\n'), details };
    }

    const fallback = cleanAssistantVisibleText(lastAssistant) || stripToolBlock(lastAssistant);
    if (fallback && !(needsVerification && toolsRun === 0)) {
      return { content: fallback, details };
    }

    if (details.length > 0) {
      if (this.isAborted()) {
        return { content: STOPPED_MESSAGE, details };
      }
      try {
        const content = await this.fetchFinalSummary(conversation, completedSteps, needsVerification);
        return { content, details };
      } catch (err) {
        if (err instanceof AskOpenRouterAbortedError || this.isAborted()) {
          return { content: STOPPED_MESSAGE, details };
        }
        throw err;
      }
    }

    return {
      content:
        needsVerification && toolsRun === 0
          ? '_Could not verify files in the workspace. Open the correct folder and try again._'
          : '_No response from the model. Check your API key and model, then try again._',
      details,
    };
  }

  private async runOneTool(
    toolCall: ToolCall,
    assistantRaw: string,
    conversation: ChatMessage[],
    details: ToolDetailEntry[],
    completedSteps: string[],
    stepNum: number,
    allowWrites: boolean
  ): Promise<boolean> {
    if (!toolCall) {
      return false;
    }

    if (!allowWrites && !isReadOnlyTool(toolCall.tool)) {
      return false;
    }

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

    completedSteps.push(describeProcessDone(stepNum, toolCall, displayNote));

    if (assistantRaw !== '(auto)') {
      conversation.push({ role: 'assistant', content: assistantRaw });
    } else {
      const autoPayload: Record<string, unknown> = { tool: toolCall.tool };
      if (toolCall.path) {
        autoPayload.path = toolCall.path;
      }
      if (toolCall.pattern) {
        autoPayload.pattern = toolCall.pattern;
      }
      if (toolCall.maxFiles) {
        autoPayload.maxFiles = toolCall.maxFiles;
      }
      conversation.push({
        role: 'assistant',
        content: `\`\`\`agent-tool\n${JSON.stringify(autoPayload)}\n\`\`\``,
      });
    }
    conversation.push({
      role: 'user',
      content: `Tool result for ${toolCall.tool}:\n\`\`\`json\n${result}\n\`\`\``,
    });
    return true;
  }

  private async fetchFinalSummary(
    conversation: ChatMessage[],
    completedSteps: string[],
    needsVerification: boolean
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
        'Do NOT call any more tools. Do NOT use XML tool_call tags or agent-tool JSON blocks.' +
        (needsVerification
          ? ' Only claim a file exists or does not exist if the tool JSON results prove it.'
          : ''),
    });

    let raw: string;
    try {
      raw = await this.callOpenRouterStreaming(conversation, true);
    } catch (err) {
      if (err instanceof AskOpenRouterAbortedError || this.isAborted()) {
        this.cancelStreamUi();
        return STOPPED_MESSAGE;
      }
      throw err;
    }
    if (this.isAborted()) {
      this.cancelStreamUi();
      return STOPPED_MESSAGE;
    }
    if (
      raw.startsWith('**Error:**') ||
      raw.startsWith('**API Error:**') ||
      raw.startsWith('**Network Error:**')
    ) {
      this.cancelStreamUi();
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

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const addModelOption = ADD_MODEL_OPTION;
    const markedUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'marked.min.js')
    );
    const chatFontSize = this.getChatFontSize();
    const fontSizeCss =
      chatFontSize > 0 ? `${chatFontSize}px` : '14px';
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>OpenRouter Chat</title>
  <style>
    :root {
      --chat-font-size: ${fontSizeCss};
      --chat-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      --chat-surface: var(--vscode-panel-background, var(--vscode-editor-background, var(--vscode-sideBar-background)));
      --chat-user-bg: color-mix(in srgb, var(--vscode-foreground) 10%, var(--chat-surface));
      --chat-user-border: color-mix(in srgb, var(--vscode-foreground) 18%, var(--chat-surface));
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      color-scheme: light dark;
    }
    body.vscode-dark { color-scheme: dark; }
    body.vscode-light { color-scheme: light; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--chat-surface);
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
    }
    .history-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
      background: var(--chat-surface);
    }
    .history-label {
      font-size: 0.7em;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      opacity: 0.65;
      white-space: nowrap;
    }
    .custom-dropdown {
      position: relative;
      display: inline-flex;
      align-items: center;
      min-width: 0;
    }
    .custom-dropdown.history-dropdown {
      flex: 1;
      width: 100%;
    }
    .dropdown-trigger {
      font-family: inherit;
      font-size: 0.85em;
      font-weight: 500;
      color: var(--vscode-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 6px;
      padding: 6px 10px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      width: 100%;
      min-width: 0;
      text-align: left;
      line-height: 1.2;
    }
    .dropdown-trigger.pill-trigger {
      border-radius: 14px;
      border-color: var(--vscode-widget-border, var(--vscode-panel-border));
      padding: 6px 10px 6px 12px;
      min-width: 72px;
      max-width: 180px;
      width: auto;
    }
    .dropdown-trigger.model-trigger {
      max-width: 200px;
    }
    .dropdown-trigger:hover:not(:disabled) {
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-toolbar-hoverBackground);
    }
    .dropdown-trigger:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }
    .dropdown-trigger:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .dropdown-label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .dropdown-chevron-wrap {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      opacity: 0.75;
      transition: opacity 0.15s ease;
    }
    .dropdown-chevron {
      width: 14px;
      height: 14px;
      display: block;
      transition: transform 0.15s ease;
    }
    .custom-dropdown.open .dropdown-chevron {
      transform: rotate(180deg);
    }
    .custom-dropdown.open .dropdown-chevron-wrap,
    .dropdown-trigger:hover:not(:disabled) .dropdown-chevron-wrap {
      opacity: 1;
    }
    .dropdown-menu {
      position: fixed;
      z-index: 1000;
      min-width: 120px;
      max-height: 280px;
      overflow-y: auto;
      background: var(--vscode-dropdown-background, var(--vscode-input-background));
      color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
      border-radius: 6px;
      box-shadow: 0 4px 12px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.35));
      padding: 4px 0;
    }
    .dropdown-item {
      display: block;
      width: 100%;
      font-family: inherit;
      font-size: 0.85em;
      text-align: left;
      color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
      background: transparent;
      border: none;
      padding: 7px 12px;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .dropdown-item:hover,
    .dropdown-item:focus-visible {
      background: var(--vscode-list-hoverBackground, var(--vscode-toolbar-hoverBackground));
      outline: none;
    }
    .dropdown-item.selected {
      background: var(--vscode-list-activeSelectionBackground, var(--vscode-focusBorder));
      color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
    }
    .dropdown-separator {
      height: 1px;
      margin: 4px 8px;
      background: var(--vscode-panel-border);
    }
    .header-btn {
      font-family: inherit;
      font-size: 0.85em;
      font-weight: 500;
      background: var(--vscode-input-background);
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 6px;
      padding: 5px 10px;
      cursor: pointer;
      opacity: 1;
      line-height: 1.2;
    }
    .header-icon-btn {
      width: 30px;
      height: 30px;
      min-width: 30px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      font-weight: 600;
      line-height: 1;
    }
    .header-icon-btn .icon-plus {
      font-size: 22px;
      margin-top: -1px;
    }
    .header-icon-btn-danger:hover {
      border-color: var(--vscode-inputValidation-errorBorder);
      color: var(--vscode-errorForeground);
    }
    .header-btn:hover:not(:disabled) {
      background: var(--vscode-toolbar-hoverBackground);
      border-color: var(--vscode-focusBorder);
    }
    button:disabled, select:disabled, textarea:disabled { opacity: 0.45; cursor: not-allowed; }
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      min-height: 0;
    }
    .msg {
      padding: 0;
      border-radius: 8px;
      word-break: break-word;
      overflow-wrap: anywhere;
      white-space: normal;
    }
    .msg.error {
      padding: 12px 16px;
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      color: var(--vscode-errorForeground);
    }
    .msg-body {
      font-family: var(--chat-font-family);
      font-size: var(--chat-font-size);
      line-height: 1.65;
      letter-spacing: 0;
      font-weight: 400;
      font-variant-ligatures: common-ligatures;
      text-rendering: optimizeLegibility;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    .msg-body p,
    .msg-body li,
    .msg-body td,
    .msg-body th,
    .msg-body blockquote {
      font-family: inherit;
      letter-spacing: inherit;
    }
    .msg-body > *:first-child { margin-top: 0; }
    .msg-body > *:last-child { margin-bottom: 0; }
    .msg-body p { margin: 0 0 0.85em; }
    .msg-body h1, .msg-body h2, .msg-body h3, .msg-body h4 {
      margin: 1.1em 0 0.45em;
      font-weight: 600;
      line-height: 1.35;
      letter-spacing: -0.02em;
      font-family: inherit;
    }
    .msg-body h1 { font-size: 1.35em; }
    .msg-body h2 { font-size: 1.2em; }
    .msg-body h3 { font-size: 1.08em; }
    .msg-body h4 { font-size: 1em; }
    .msg-body ul, .msg-body ol {
      margin: 0.5em 0 0.75em;
      padding-left: 1.5em;
    }
    .msg-body li { margin: 0.5em 0; }
    .msg-body li > p { margin: 0.25em 0; }
    .msg-body hr {
      margin: 1em 0;
      border: none;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .msg-body a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }
    .msg-body a:hover { text-decoration: underline; }
    .msg-body blockquote {
      margin: 0.75em 0;
      padding: 0.25em 0 0.25em 12px;
      border-left: 3px solid var(--vscode-focusBorder);
    }
    .msg-body table {
      border-collapse: collapse;
      width: 100%;
      margin: 0;
      font-size: 0.95em;
      display: table;
      table-layout: auto;
    }
    .msg-body .table-wrap {
      overflow-x: auto;
      margin: 0.75em 0;
      max-width: 100%;
    }
    .msg-body thead { font-weight: 600; }
    .msg-body tbody tr:nth-child(even) {
      background: color-mix(in srgb, var(--vscode-foreground) 4%, transparent);
    }
    .msg-body th, .msg-body td {
      border: 1px solid var(--vscode-panel-border);
      padding: 10px 12px;
      text-align: left;
      vertical-align: top;
      line-height: 1.55;
    }
    .msg-body th {
      background: var(--vscode-input-background);
      font-weight: 600;
    }
    .msg.user {
      width: 100%;
      align-self: stretch;
      max-width: 100%;
      text-align: left;
      white-space: pre-wrap;
      line-height: 1.55;
      color: var(--vscode-foreground);
      background: var(--chat-user-bg, var(--vscode-input-background));
      border: 1px solid var(--chat-user-border, var(--vscode-input-border, var(--vscode-panel-border)));
      border-radius: 8px;
      padding: 10px 14px;
    }
    .msg.user .msg-body {
      font-family: var(--chat-font-family);
      font-size: var(--chat-font-size);
      line-height: 1.55;
      background: transparent;
    }
    .msg.assistant {
      color: var(--vscode-foreground);
      background: none !important;
      background-color: transparent !important;
      border: none;
      border-radius: 0;
      padding: 6px 0 14px;
      align-self: stretch;
      width: 100%;
      max-width: 100%;
      box-shadow: none;
    }
    .msg.assistant .msg-body {
      background: none !important;
      background-color: transparent !important;
    }
    .msg.assistant.msg-enter {
      animation: msgIn 0.25s ease-out;
    }
    @keyframes msgIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .msg.assistant.streaming {
      animation: none;
    }
    .stream-cursor {
      display: inline;
      color: var(--vscode-focusBorder);
      animation: cursorBlink 1s step-end infinite;
      font-weight: 400;
      margin-left: 1px;
    }
    @keyframes cursorBlink {
      50% { opacity: 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      .msg.assistant.msg-enter,
      .msg.thinking {
        animation: none !important;
      }
      .stream-cursor {
        animation: none;
        opacity: 0.75;
      }
    }
    .msg.thinking {
      color: var(--vscode-descriptionForeground);
      background: transparent;
      border: 1px dashed var(--vscode-panel-border);
      border-radius: 8px;
      align-self: stretch;
      width: 100%;
      max-width: 100%;
      padding: 10px 14px;
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
      color: var(--vscode-descriptionForeground);
      font-weight: normal;
      text-transform: none;
      margin-top: 2px;
    }
    .thinking-thought {
      font-style: italic;
      color: var(--vscode-descriptionForeground);
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
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
    }
    .msg.error .role {
      display: block;
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
      color: var(--vscode-textLink-foreground);
      user-select: none;
      list-style: none;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .tool-details summary::-webkit-details-marker { display: none; }
    .tool-details summary::before {
      content: '';
      flex-shrink: 0;
      border-left: 5px solid transparent;
      border-right: 5px solid transparent;
      border-top: 6px solid var(--vscode-textLink-foreground);
      transition: transform 0.15s ease;
    }
    .tool-details[open] summary::before {
      transform: rotate(180deg);
    }
    .tool-details summary:hover {
      text-decoration: underline;
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
    .msg-body :not(pre) > code {
      font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
      font-size: 0.88em;
      color: var(--vscode-textPreformat-foreground, var(--vscode-foreground));
      background: transparent;
      border: 1px solid var(--vscode-panel-border);
      padding: 0.08em 0.35em;
      border-radius: 4px;
      letter-spacing: normal;
    }
    .msg-body pre,
    .msg pre {
      font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
      overflow-x: auto;
      color: var(--vscode-editor-foreground, var(--vscode-foreground));
      background: var(--vscode-textCodeBlock-background);
      border: 1px solid var(--vscode-panel-border);
      padding: 12px 14px;
      border-radius: 6px;
      margin: 0.75em 0;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
      letter-spacing: normal;
    }
    .msg-body pre code {
      font-family: inherit;
      padding: 0;
      border: none;
      background: transparent;
      color: inherit;
      font-size: inherit;
      white-space: pre-wrap;
    }
    .composer-wrap {
      padding: 8px 10px 10px;
      border-top: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
      background: var(--chat-surface);
      overflow: visible;
    }
    .composer {
      display: flex;
      flex-direction: column;
      border: 1px solid var(--vscode-input-border);
      border-radius: 10px;
      background: var(--vscode-input-background);
      overflow: visible;
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
    }
    .composer-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 8px 8px;
      overflow: visible;
    }
    .composer-left {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .composer-right {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
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
      width: 32px;
      height: 32px;
      border-radius: 50%;
      border: none;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      font-size: 16px;
      font-weight: 700;
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
    .send-btn.stop {
      background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
      color: var(--vscode-errorForeground, #f48771);
      font-size: 11px;
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
    <div id="sessionDropdown" class="custom-dropdown history-dropdown"></div>
    <button type="button" id="newSessionBtn" class="header-btn header-icon-btn" title="New chat" aria-label="New chat"><span class="icon-plus" aria-hidden="true">+</span></button>
    <button type="button" id="deleteSessionBtn" class="header-btn header-icon-btn-danger" title="Delete chat" aria-label="Delete chat">Del</button>
    <button type="button" id="clearBtn" class="header-btn" title="Clear messages">Clear</button>
  </div>
  <div id="messages"></div>
  <div class="composer-wrap">
    <div class="composer">
      <textarea id="input" rows="3" placeholder="Ask, Plan, or Agent — Enter to send, Shift+Enter for new line"></textarea>
      <div class="composer-footer">
        <div class="composer-left">
          <div id="modeDropdown"></div>
          <div id="modelDropdown"></div>
        </div>
        <div class="composer-right">
          <div id="sendSpinner" class="send-spinner hidden" title="Working…"></div>
          <button type="button" id="sendBtn" class="send-btn" title="Send (Enter)">↑</button>
        </div>
      </div>
    </div>
  </div>
  <script src="${markedUri}"></script>
  <script nonce="${nonce}">
    marked.use({ breaks: true, gfm: true });

    const vscode = acquireVsCodeApi();
    const AUTO_MODEL = '${AUTO_MODEL_ID}';
    const ADD_MODEL = '${addModelOption}';
    const messagesEl = document.getElementById('messages');
    const inputEl = document.getElementById('input');
    const sendBtn = document.getElementById('sendBtn');
    const sendSpinner = document.getElementById('sendSpinner');
    const clearBtn = document.getElementById('clearBtn');
    const newSessionBtn = document.getElementById('newSessionBtn');
    const deleteSessionBtn = document.getElementById('deleteSessionBtn');

    let processing = false;
    let thinkingEl = null;
    let streamingEl = null;
    let streamingBody = null;
    let streamText = '';
    let streamRenderTimer = null;
    const STREAM_RENDER_MS = 80;
    let approvalPending = false;
    let lastModelId = AUTO_MODEL;

    var CHEVRON_HTML = '<svg class="dropdown-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var openDropdown = null;

    function createCustomDropdown(root, settings) {
      settings = settings || {};
      root.classList.add('custom-dropdown');
      if (settings.extraClass) {
        root.classList.add(settings.extraClass);
      }

      var trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'dropdown-trigger ' + (settings.triggerClass || '');
      trigger.title = settings.title || '';
      trigger.setAttribute('aria-haspopup', 'listbox');
      trigger.setAttribute('aria-expanded', 'false');

      var labelEl = document.createElement('span');
      labelEl.className = 'dropdown-label';
      var chevronWrap = document.createElement('span');
      chevronWrap.className = 'dropdown-chevron-wrap';
      chevronWrap.innerHTML = CHEVRON_HTML;
      trigger.appendChild(labelEl);
      trigger.appendChild(chevronWrap);

      var menu = document.createElement('div');
      menu.className = 'dropdown-menu';
      menu.hidden = true;
      menu.setAttribute('role', 'listbox');

      root.appendChild(trigger);
      root.appendChild(menu);

      var options = [];
      var value = settings.value || '';
      var disabled = false;

      function findLabel(val) {
        for (var i = 0; i < options.length; i++) {
          if (!options[i].separator && options[i].value === val) {
            return options[i].label;
          }
        }
        return val;
      }

      function updateTrigger() {
        labelEl.textContent = findLabel(value) || value || settings.placeholder || 'Select';
      }

      function renderMenu() {
        menu.innerHTML = '';
        options.forEach(function(opt) {
          if (opt.separator) {
            var sep = document.createElement('div');
            sep.className = 'dropdown-separator';
            sep.setAttribute('role', 'separator');
            menu.appendChild(sep);
            return;
          }
          var item = document.createElement('button');
          item.type = 'button';
          item.className = 'dropdown-item';
          item.setAttribute('role', 'option');
          item.dataset.value = opt.value;
          item.textContent = opt.label;
          if (opt.title) {
            item.title = opt.title;
          }
          if (opt.value === value) {
            item.classList.add('selected');
            item.setAttribute('aria-selected', 'true');
          } else {
            item.setAttribute('aria-selected', 'false');
          }
          item.addEventListener('click', function(e) {
            e.stopPropagation();
            if (settings.onBeforeSelect && settings.onBeforeSelect(opt, value) === false) {
              close();
              return;
            }
            var prev = value;
            value = opt.value;
            updateTrigger();
            close();
            if (settings.onChange) {
              settings.onChange(value, prev);
            }
          });
          menu.appendChild(item);
        });
      }

      function clearMenuPosition() {
        menu.style.top = '';
        menu.style.bottom = '';
        menu.style.left = '';
        menu.style.width = '';
        menu.style.minWidth = '';
        menu.style.maxHeight = '';
      }

      function positionMenu() {
        var rect = trigger.getBoundingClientRect();
        var gap = 4;
        var maxMenuHeight = 280;
        var minOpen = 80;
        var spaceBelow = window.innerHeight - rect.bottom - gap - 8;
        var spaceAbove = rect.top - gap - 8;
        var contentHeight = menu.scrollHeight || 0;
        var openBelow = spaceBelow >= minOpen || spaceBelow >= spaceAbove;

        root.classList.remove('open-above');
        menu.style.position = 'fixed';
        menu.style.left = rect.left + 'px';
        menu.style.width = rect.width + 'px';
        menu.style.minWidth = rect.width + 'px';

        if (openBelow) {
          menu.style.top = (rect.bottom + gap) + 'px';
          menu.style.bottom = 'auto';
          menu.style.maxHeight = Math.min(maxMenuHeight, Math.max(48, spaceBelow)) + 'px';
        } else {
          root.classList.add('open-above');
          var maxH = Math.min(maxMenuHeight, Math.max(48, spaceAbove));
          menu.style.maxHeight = maxH + 'px';
          menu.style.bottom = (window.innerHeight - rect.top + gap) + 'px';
          menu.style.top = 'auto';
        }
      }

      function open() {
        if (disabled) {
          return;
        }
        if (openDropdown && openDropdown !== api) {
          openDropdown.close();
        }
        openDropdown = api;
        root.classList.add('open');
        trigger.setAttribute('aria-expanded', 'true');
        menu.hidden = false;
        if (menu.parentNode !== document.body) {
          document.body.appendChild(menu);
        }
        renderMenu();
        requestAnimationFrame(function() {
          positionMenu();
        });
      }

      function close() {
        root.classList.remove('open');
        root.classList.remove('open-above');
        trigger.setAttribute('aria-expanded', 'false');
        menu.hidden = true;
        clearMenuPosition();
        if (menu.parentNode === document.body) {
          root.appendChild(menu);
        }
        if (openDropdown === api) {
          openDropdown = null;
        }
      }

      trigger.addEventListener('click', function(e) {
        e.stopPropagation();
        if (disabled) {
          return;
        }
        if (root.classList.contains('open')) {
          close();
        } else {
          open();
        }
      });

      trigger.addEventListener('keydown', function(e) {
        if (disabled) {
          return;
        }
        if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (!root.classList.contains('open')) {
            open();
          }
        } else if (e.key === 'Escape') {
          close();
        }
      });

      var api = {
        setOptions: function(opts) {
          options = opts || [];
          updateTrigger();
          if (root.classList.contains('open')) {
            renderMenu();
            requestAnimationFrame(function() {
              positionMenu();
            });
          }
        },
        setValue: function(v) {
          value = v;
          updateTrigger();
          if (root.classList.contains('open')) {
            renderMenu();
          }
        },
        getValue: function() {
          return value;
        },
        setDisabled: function(d) {
          disabled = !!d;
          trigger.disabled = disabled;
          if (disabled) {
            close();
          }
        },
        close: close
      };

      if (settings.options) {
        api.setOptions(settings.options);
      }
      if (settings.value) {
        api.setValue(settings.value);
      } else {
        updateTrigger();
      }

      return api;
    }

    document.addEventListener('click', function() {
      if (openDropdown) {
        openDropdown.close();
      }
    });

    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && openDropdown) {
        openDropdown.close();
      }
    });

    const sessionDropdown = createCustomDropdown(document.getElementById('sessionDropdown'), {
      triggerClass: 'history-trigger',
      title: 'Switch chat',
      placeholder: 'No chats',
      onChange: function(sessionId) {
        if (processing) {
          return;
        }
        vscode.postMessage({ type: 'switchSession', sessionId: sessionId });
      }
    });

    const modeDropdown = createCustomDropdown(document.getElementById('modeDropdown'), {
      triggerClass: 'pill-trigger',
      title: 'Mode',
      value: 'ask',
      options: [
        { value: 'ask', label: 'Ask' },
        { value: 'plan', label: 'Plan' },
        { value: 'agent', label: 'Agent' }
      ],
      onChange: function(mode) {
        vscode.postMessage({ type: 'setMode', mode: mode });
      }
    });

    const modelDropdown = createCustomDropdown(document.getElementById('modelDropdown'), {
      triggerClass: 'pill-trigger model-trigger',
      title: 'Model',
      value: AUTO_MODEL,
      onBeforeSelect: function(opt) {
        if (opt.value === ADD_MODEL) {
          vscode.postMessage({ type: 'promptAddModel' });
          return false;
        }
        return true;
      },
      onChange: function(modelId) {
        lastModelId = modelId;
        vscode.postMessage({ type: 'setModel', modelId: modelId });
      }
    });

    function escapeHtml(text) {
      const d = document.createElement('div');
      d.textContent = text;
      return d.innerHTML;
    }

    function isPipeRow(line) {
      return /^\\|.+\\|$/.test(line.trim());
    }

    function isSeparatorRow(line) {
      return /^\\|[\\s\\-:|]+\\|$/.test(line.trim());
    }

    function pipeColCount(line) {
      return line.trim().split('|').filter(function(part) {
        return part.trim() !== '';
      }).length;
    }

    function makeHeaderRow(cols) {
      var labels = ['Item', 'Status', 'Details', 'Notes', 'Info'];
      var cells = [];
      for (var c = 0; c < cols; c++) {
        cells.push(labels[c] || ('Col ' + (c + 1)));
      }
      return '| ' + cells.join(' | ') + ' |';
    }

    function makeSepRow(cols) {
      var cells = [];
      for (var c = 0; c < cols; c++) {
        cells.push('---');
      }
      return '| ' + cells.join(' | ') + ' |';
    }

    function normalizePipeTables(text) {
      var lines = text.split('\\n');
      var out = [];
      var i = 0;
      while (i < lines.length) {
        if (!isPipeRow(lines[i])) {
          out.push(lines[i]);
          i++;
          continue;
        }
        var block = [];
        while (i < lines.length && isPipeRow(lines[i])) {
          block.push(lines[i]);
          i++;
        }
        var hasSeparator = block.some(isSeparatorRow);
        if (!hasSeparator && block.length > 0) {
          var cols = pipeColCount(block[0]);
          if (cols > 0) {
            out.push(makeHeaderRow(cols));
            out.push(makeSepRow(cols));
          }
        }
        block.forEach(function(row) {
          out.push(row);
        });
      }
      return out.join('\\n');
    }

    function unwrapFullMessageFence(text) {
      var trimmed = text.trim();
      var match = trimmed.match(/^\\x60\\x60\\x60(?:[\\w-]*)?\\s*\\n([\\s\\S]*?)\\n\\x60\\x60\\x60\\s*$/);
      if (match) {
        return match[1].trim();
      }
      match = trimmed.match(/^\\x60\\x60\\x60(?:[\\w-]*)?\\s*\\n([\\s\\S]*?)\\x60\\x60\\x60\\s*$/);
      if (match) {
        return match[1].trim();
      }
      return text;
    }

    function formatContent(text, role) {
      if (!text) return '';
      if (role === 'user' || role === 'error') {
        return escapeHtml(text);
      }
      try {
        return marked.parse(normalizePipeTables(unwrapFullMessageFence(text)));
      } catch {
        return escapeHtml(text);
      }
    }

    function applyChatFontSize(px) {
      const size = Number(px) > 0 ? px + 'px' : '';
      if (size) {
        document.documentElement.style.setProperty('--chat-font-size', size);
      } else {
        document.documentElement.style.setProperty('--chat-font-size', '14px');
      }
    }

    function bindMessageLinks(body) {
      body.addEventListener('click', (e) => {
        const anchor = e.target.closest('a');
        if (!anchor || !anchor.href) return;
        e.preventDefault();
        vscode.postMessage({ type: 'openLink', url: anchor.href });
      });
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
      scrollMessageIntoView(div, 'start');

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
      scrollMessageIntoView(block.div, 'end');
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

      scrollMessageIntoView(block.div, 'end');
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
      scrollMessageIntoView(div, 'start');
    }

    function wrapTables(body) {
      body.querySelectorAll('table').forEach((table) => {
        if (table.parentElement && table.parentElement.classList.contains('table-wrap')) {
          return;
        }
        const wrap = document.createElement('div');
        wrap.className = 'table-wrap';
        table.parentNode.insertBefore(wrap, table);
        wrap.appendChild(table);
      });
    }

    function scrollMessageIntoView(el, block) {
      if (!el) return;
      const align = block || 'start';
      requestAnimationFrame(function() {
        requestAnimationFrame(function() {
          el.scrollIntoView({ block: align, behavior: 'auto' });
        });
      });
    }

    function prefersReducedMotion() {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    function removeStreamUi(removeNode) {
      if (streamRenderTimer) {
        clearTimeout(streamRenderTimer);
        streamRenderTimer = null;
      }
      if (removeNode && streamingEl) {
        streamingEl.remove();
      }
      streamingEl = null;
      streamingBody = null;
      streamText = '';
    }

    function scrollStreamIntoView() {
      if (!streamingEl) {
        return;
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function morphThinkingToStream() {
      removeStreamUi(false);
      var div = thinkingEl || document.getElementById('thinking-indicator');
      if (div) {
        thinkingEl = null;
        div.classList.remove('thinking', 'thinking-fade-out');
        div.classList.add('assistant', 'streaming');
        div.removeAttribute('id');
        div.innerHTML = '';
        streamingBody = document.createElement('div');
        streamingBody.className = 'msg-body';
        var cursor = document.createElement('span');
        cursor.className = 'stream-cursor';
        cursor.textContent = '▍';
        streamingBody.appendChild(cursor);
        div.appendChild(streamingBody);
        streamingEl = div;
      } else {
        removeThinking(true);
        streamingEl = document.createElement('div');
        streamingEl.className = 'msg assistant streaming';
        streamingBody = document.createElement('div');
        streamingBody.className = 'msg-body';
        var cursorEl = document.createElement('span');
        cursorEl.className = 'stream-cursor';
        cursorEl.textContent = '▍';
        streamingBody.appendChild(cursorEl);
        streamingEl.appendChild(streamingBody);
        messagesEl.appendChild(streamingEl);
      }
      streamText = '';
      scrollMessageIntoView(streamingEl, 'start');
    }

    function flushStreamRender() {
      if (!streamingBody) {
        return;
      }
      streamRenderTimer = null;
      streamingBody.innerHTML = formatContent(streamText, 'assistant');
      var cursor = document.createElement('span');
      cursor.className = 'stream-cursor';
      cursor.textContent = '▍';
      streamingBody.appendChild(cursor);
      bindMessageLinks(streamingBody);
      wrapTables(streamingBody);
      scrollStreamIntoView();
    }

    function scheduleStreamRender() {
      if (streamRenderTimer) {
        return;
      }
      var delay = prefersReducedMotion() ? 0 : STREAM_RENDER_MS;
      streamRenderTimer = setTimeout(flushStreamRender, delay);
    }

    function updateAssistantPartial(content) {
      if (!streamingEl) {
        morphThinkingToStream();
      } else {
        removeThinking(true);
      }
      streamText = content || '';
      scheduleStreamRender();
    }

    function cancelAssistantStream() {
      removeStreamUi(true);
    }

    function finishAssistantStream(content, details) {
      removeThinking(true);
      if (streamRenderTimer) {
        clearTimeout(streamRenderTimer);
        streamRenderTimer = null;
      }
      if (streamingEl && streamingBody) {
        streamingEl.classList.remove('streaming');
        streamingEl.classList.add('msg-enter');
        streamingBody.innerHTML = formatContent(content, 'assistant');
        bindMessageLinks(streamingBody);
        wrapTables(streamingBody);
        appendToolDetails(streamingEl, details);
        scrollMessageIntoView(streamingEl, 'start');
        streamingEl = null;
        streamingBody = null;
        streamText = '';
        return;
      }
      appendMessage('assistant', content, 'msg-enter', details);
    }

    function appendMessage(role, content, extraClass, details) {
      const div = document.createElement('div');
      div.className = 'msg ' + role + (extraClass ? ' ' + extraClass : '');
      const body = document.createElement('div');
      body.className = 'msg-body';
      body.innerHTML = formatContent(content, role);
      bindMessageLinks(body);
      wrapTables(body);
      if (role === 'error') {
        const label = document.createElement('div');
        label.className = 'role';
        label.textContent = 'Error';
        div.appendChild(label);
      }
      div.appendChild(body);
      if (role === 'assistant') {
        appendToolDetails(div, details);
      }
      messagesEl.appendChild(div);
      scrollMessageIntoView(div, 'start');
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
        '<div class="thinking-body">' +
        renderProcessHtml(completed, current, thought) +
        '</div>';
      messagesEl.appendChild(thinkingEl);
      scrollMessageIntoView(thinkingEl, 'end');
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
      scrollMessageIntoView(thinkingEl, 'end');
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
      return modelDropdown.getValue() || lastModelId || AUTO_MODEL;
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
      var opts = (sessions || []).map(function(s) {
        var count = s.messageCount ? ' (' + s.messageCount + ')' : '';
        return {
          value: s.id,
          label: s.title + ' · ' + formatSessionTime(s.updatedAt) + count,
          title: s.title
        };
      });
      sessionDropdown.setOptions(opts);
      if (activeId) {
        sessionDropdown.setValue(activeId);
      } else if (opts.length) {
        sessionDropdown.setValue(opts[0].value);
      }
    }

    function populateModels(state) {
      const models = state.availableModels || [];
      const selected = state.selectedModelId || AUTO_MODEL;
      var opts = [{ value: AUTO_MODEL, label: 'Auto' }];
      models.forEach(function(m) {
        opts.push({ value: m, label: shortModelLabel(m), title: m });
      });
      opts.push({ separator: true });
      opts.push({ value: ADD_MODEL, label: 'Add model…' });
      var val = selected;
      if (selected !== AUTO_MODEL && models.indexOf(selected) === -1) {
        val = models.length ? models[0] : AUTO_MODEL;
      }
      modelDropdown.setOptions(opts);
      modelDropdown.setValue(val);
      lastModelId = val;
    }

    function updateSendButton() {
      if (processing) {
        sendBtn.classList.add('stop');
        sendBtn.textContent = '■';
        sendBtn.title = 'Stop';
        sendBtn.disabled = false;
      } else {
        sendBtn.classList.remove('stop');
        sendBtn.textContent = '↑';
        sendBtn.title = 'Send (Enter)';
        sendBtn.disabled = approvalPending;
      }
    }

    function setLoading(loading, label, process) {
      processing = loading;
      inputEl.disabled = loading || approvalPending;
      modeDropdown.setDisabled(loading || approvalPending);
      modelDropdown.setDisabled(loading || approvalPending);
      sessionDropdown.setDisabled(loading || approvalPending);
      newSessionBtn.disabled = loading || approvalPending;
      deleteSessionBtn.disabled = loading || approvalPending;
      clearBtn.disabled = loading || approvalPending;
      updateSendButton();
      if (loading) {
        sendSpinner.classList.remove('hidden');
        if (streamingEl) {
          return;
        }
        if (thinkingEl) {
          updateThinking(label, process);
        } else {
          showThinking(label, process);
        }
      } else {
        sendSpinner.classList.add('hidden');
        removeThinking(false);
      }
    }

    function send() {
      const text = inputEl.value.trim();
      if (!text || processing) return;
      const modelId = getSelectedModelId();
      vscode.postMessage({
        type: 'send',
        text,
        mode: modeDropdown.getValue(),
        modelId
      });
      inputEl.value = '';
    }

    function stop() {
      if (!processing) return;
      vscode.postMessage({ type: 'stop' });
    }

    sendBtn.addEventListener('click', () => {
      if (processing) {
        stop();
      } else {
        send();
      }
    });
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
    deleteSessionBtn.addEventListener('click', () => {
      if (processing) return;
      vscode.postMessage({ type: 'deleteSession', sessionId: sessionDropdown.getValue() });
    });
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!processing) {
          send();
        }
      }
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'init':
          messagesEl.innerHTML = '';
          removeThinking(true);
          applyChatFontSize(msg.chatFontSize || 0);
          modeDropdown.setValue(msg.mode || 'ask');
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
            modelDropdown.setValue(msg.modelId);
            lastModelId = msg.modelId;
          }
          break;
        case 'userMessage':
          appendMessage('user', msg.content);
          break;
        case 'assistantStreamStart':
          morphThinkingToStream();
          break;
        case 'assistantPartial':
          updateAssistantPartial(msg.content);
          break;
        case 'assistantStreamCancel':
          cancelAssistantStream();
          break;
        case 'assistantMessage':
          if (msg.finalizeStream && streamingEl) {
            removeThinking(false);
            finishAssistantStream(msg.content, msg.details);
          } else {
            removeStreamUi(true);
            removeThinking(false);
            setTimeout(function() {
              appendMessage('assistant', msg.content, 'msg-enter', msg.details);
            }, 280);
          }
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
          removeStreamUi(true);
          break;
        case 'toolApproval':
          showApprovalCard(msg);
          break;
        case 'approvalPending':
          approvalPending = !!msg.pending;
          inputEl.disabled = processing || approvalPending;
          if (!processing) {
            modeDropdown.setDisabled(approvalPending);
            modelDropdown.setDisabled(approvalPending);
          }
          updateSendButton();
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

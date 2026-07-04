import * as vscode from 'vscode';
import {
  AgentMode,
  buildMessagesWithHistory,
  gatherContext,
  sessionMessageToApiMessage,
} from './agent';
import {
  AttachmentMeta,
  AttachmentStore,
  attachmentAnalysisLabel,
  hasTextAttachments,
  hasVisionAttachments,
} from './attachments';
import { formatAutoModelLabel, pickAutoModelForRequest } from './autoModel';
import { ApiKeyStore } from './apiKeyStore';
import { ApprovalBridge, PermissionChoice } from './approvalBridge';
import { ChatHistoryStore } from './chatHistory';
import type { ChatSessionMessage, ToolDetailEntry } from './chatHistory';
import { AUTO_MODEL_ID, ModelStore } from './models';

export type { ChatSessionMessage, ToolDetailEntry };
import {
  askOpenRouterToolAware,
  AskOpenRouterAbortedError,
  ChatMessage,
  NativeToolCall,
  OpenRouterToolDef,
  ToolAwareResult,
} from './openrouter';
import {
  getAccountBalanceForWebview,
  getOpenRouterBalanceCache,
} from './openrouterBalance';
import {
  getModelPricingCache,
  isModelPricingEnabled,
} from './openrouterModels';
import {
  describeProcessDone,
  describeProcessStep,
  cleanAssistantVisibleText,
  describeToolCall,
  buildAutoToolCall,
  buildAutoToolCalls,
  buildVerificationFallbackTools,
  canParallelizeReadTools,
  detectUserFileIntent,
  executeReadToolsInParallel,
  FILE_ACCESS_REFUSAL_RETRY_PROMPT,
  getToolDefsForMode,
  handleToolCall,
  parseNativeToolCall,
  type ToolHandlerContext,
  hasToolCallMarkup,
  hasToolInterruptionArtifact,
  isReadOnlyTool,
  mentionsFileAccessRefusal,
  mentionsFileExistence,
  parseAllToolCalls,
  parseToolCall,
  requiresFileVerification,
  resolveExistingWorkspaceFile,
  resolveToolCall,
  shouldSuppressVisibleAsFinal,
  stripToolBlock,
  sanitizeModelOutput,
  TOOL_INTERRUPTION_RETRY_PROMPT,
  TOOL_PARSE_FAILED_MESSAGE,
  VERIFICATION_TOOLS_FAILED_MESSAGE,
  clearToolResultCache,
  type ToolCall,
} from './tools';

import { stopAllRunningProcesses } from './terminalRunner';
import { PerfSpan } from './perf';
import { getModelPickerWebviewScript } from './modelPickerWebviewScript';

const STREAM_POST_THROTTLE_MS = 100;

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
  private hasVisionInRequest = false;
  private stripToolLeaksInStream = false;
  /** Native tool schemas advertised for the in-flight request (empty in plan mode). */
  private currentToolDefs: OpenRouterToolDef[] = [];
  private balanceRefreshTimer?: ReturnType<typeof setInterval>;
  private readonly approvalBridge: ApprovalBridge;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly modelStore: ModelStore,
    private readonly historyStore: ChatHistoryStore,
    private readonly apiKeyStore: ApiKeyStore,
    private readonly attachmentStore: AttachmentStore
  ) {
    this.approvalBridge = new ApprovalBridge((msg) => this.post(msg));
  }

  private async loadActiveSession(): Promise<void> {
    const session = this.historyStore.getActive();
    this.history = [...session.messages];
    this.mode = session.mode;
    await this.modelStore.setSelectedModelId(session.modelId);
  }

  private async persistSession(titleFromMessage?: string): Promise<void> {
    await this.historyStore.updateActive({
      messages: this.history,
      mode: this.mode,
      modelId: this.modelStore.getSelectedModelId(),
      titleFromMessage,
    });
  }

  private async applySessionToUi(session: {
    messages: ChatSessionMessage[];
    mode: AgentMode;
    modelId: string;
  }): Promise<void> {
    this.attachmentStore.clearPending();
    this.history = [...session.messages];
    this.mode = session.mode;
    await this.modelStore.setSelectedModelId(session.modelId);
    await this.syncState();
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
      localResourceRoots: [this.context.extensionUri],
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
        localResourceRoots: [this.context.extensionUri],
      }
    );

    this.panel.iconPath = {
      light: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'openrouter-agent-logo', 'logo.svg'),
      dark: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'openrouter-agent-logo', 'logo.svg'),
    };

    this.attachWebview(this.panel.webview);

    this.panel.onDidDispose(() => {
      this.stopBalanceRefresh();
      this.panel = undefined;
    });

    this.startBalanceRefresh();
  }

  async focus(): Promise<void> {
    await this.openPanelOnRight();
    // Prefetch context when panel is revealed
    const { prefetchContext } = await import('./agent');
    void prefetchContext();
  }

  private async handleWebviewMessage(msg: {
    type: string;
    enabled?: boolean;
    catalog?: { id: string; tier: string; supportsVision: boolean }[];
    autoPoolEnabled?: string[];
    selectedModelId?: string;
    visible?: boolean;
    message?: string;
    text?: string;
    mode?: string;
    modelId?: string;
    sessionId?: string;
    model?: string;
    id?: string;
    choice?: string;
    url?: string;
    files?: { name: string; mimeType: string; base64: string }[];
    attachmentIds?: string[];
    path?: string;
    paths?: string[];
  }): Promise<void> {
    switch (msg.type) {
      case 'openFile':
        await this.openWorkspaceFile(String(msg.path ?? ''));
        break;
      case 'resolveFiles':
        await this.resolveFileMentions(Array.isArray(msg.paths) ? msg.paths : []);
        break;
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
      case 'pickAttachments':
        if (this.processing) {
          break;
        }
        await this.handlePickAttachments();
        break;
      case 'addAttachments': {
        if (this.processing) {
          break;
        }
        const files = msg.files ?? [];
        const { added, errors } = await this.attachmentStore.addFromBase64Payload(files);
        if (errors.length) {
          void vscode.window.showWarningMessage(
            `OpenRouter Agent: ${errors.slice(0, 2).join(' ')}`
          );
        }
        if (added.length) {
          this.postAttachmentsUpdated();
        }
        break;
      }
      case 'removeAttachment':
        if (this.processing) {
          break;
        }
        await this.attachmentStore.removePending(String(msg.id ?? ''));
        this.postAttachmentsUpdated();
        break;
      case 'stop':
        this.handleStop();
        break;
      case 'clear':
        this.history = [];
        clearToolResultCache();
        await this.persistSession();
        this.post({ type: 'cleared' });
        break;
      case 'newSession':
        if (this.processing) {
          break;
        }
        clearToolResultCache();
        await this.persistSession();
        await this.applySessionToUi(await this.historyStore.newSession());
        break;
      case 'switchSession': {
        if (this.processing) {
          break;
        }
        clearToolResultCache();
        const id = String(msg.sessionId ?? '');
        await this.persistSession();
        const session = await this.historyStore.switchSession(id);
        if (session) {
          await this.applySessionToUi(session);
        }
        break;
      }
      case 'deleteSession': {
        if (this.processing) {
          break;
        }
        const id = String(msg.sessionId ?? '');
        const deleteItem: vscode.MessageItem = { title: 'Delete' };
        const cancelDelete: vscode.MessageItem = { title: 'Cancel', isCloseAffordance: true };
        const choice = await vscode.window.showWarningMessage(
          'Delete this chat from history?',
          { modal: true },
          deleteItem,
          cancelDelete
        );
        if (choice !== deleteItem) {
          this.post({
            type: 'sessions',
            sessions: this.historyStore.listSessions(),
            activeSessionId: this.historyStore.getActiveId(),
          });
          break;
        }
        const session = await this.historyStore.deleteSession(id);
        await this.applySessionToUi(session);
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
        await this.postModelState();
        await this.syncModelPricing();
        await this.syncAccountBalance(true);
        await this.syncModelCapability();
        break;
      case 'setAutoPoolModel': {
        const enabled = msg.enabled === true;
        const result = await this.modelStore.toggleAutoPoolModel(
          String(msg.modelId ?? ''),
          enabled
        );
        if (!result.ok) {
          this.post({ type: 'error', message: result.error ?? 'Could not update Auto pool.' });
        }
        await this.postModelState();
        await this.syncModelCapability();
        break;
      }
      case 'ready':
        await this.loadActiveSession();
        await this.syncState();
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

  /** Open an existing workspace file in a regular editor tab (beside the chat). */
  private async openWorkspaceFile(filePath: string): Promise<void> {
    const resolved = await resolveExistingWorkspaceFile(filePath);
    if (!resolved) {
      void vscode.window.showInformationMessage(
        `OpenRouter Agent: "${filePath}" was not found in the workspace.`
      );
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(resolved.uri);
      await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
        preserveFocus: false,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`OpenRouter Agent: Could not open file. ${detail}`);
    }
  }

  /** Validate candidate file mentions; reply with the subset that really exists. */
  private async resolveFileMentions(candidates: string[]): Promise<void> {
    const seen = new Set<string>();
    const existing: { input: string; path: string }[] = [];
    for (const raw of candidates.slice(0, 80)) {
      const input = String(raw ?? '').trim();
      if (!input || seen.has(input)) {
        continue;
      }
      seen.add(input);
      const resolved = await resolveExistingWorkspaceFile(input);
      if (resolved) {
        existing.push({ input, path: resolved.relative });
      }
    }
    this.post({ type: 'filesResolved', files: existing });
  }

  private postAttachmentsUpdated(): void {
    void this.postPendingAttachmentPreviews();
  }

  private async postPendingAttachmentPreviews(): Promise<void> {
    const pending = this.attachmentStore.getPending();
    const previews: {
      id: string;
      name: string;
      kind: string;
      mimeType: string;
      previewUrl?: string;
    }[] = [];
    for (const a of pending) {
      const previewUrl =
        a.kind === 'image'
          ? await this.attachmentStore.getPreviewDataUrl('_pending', a)
          : undefined;
      previews.push({
        id: a.id,
        name: a.name,
        kind: a.kind,
        mimeType: a.mimeType,
        previewUrl,
      });
    }
    this.post({ type: 'attachmentsUpdated', pending: previews });
  }

  private async handlePickAttachments(): Promise<void> {
    const { added, errors } = await this.attachmentStore.pickFilesDialog();
    if (errors.length) {
      void vscode.window.showWarningMessage(
        `OpenRouter Agent: ${errors.slice(0, 2).join(' ')}`
      );
    }
    if (added.length) {
      this.postAttachmentsUpdated();
    }
  }

  private async syncState(): Promise<void> {
    const sessionId = this.historyStore.getActiveId();
    const attachmentPreviews = await this.attachmentStore.enrichHistoryForWebview(
      sessionId,
      this.history
    );
    const pending = this.attachmentStore.getPending();
    const pendingPreviews: {
      id: string;
      name: string;
      kind: string;
      mimeType: string;
      previewUrl?: string;
    }[] = [];
    for (const a of pending) {
      const previewUrl =
        a.kind === 'image'
          ? await this.attachmentStore.getPreviewDataUrl('_pending', a)
          : undefined;
      pendingPreviews.push({
        id: a.id,
        name: a.name,
        kind: a.kind,
        mimeType: a.mimeType,
        previewUrl,
      });
    }
    this.post({
      type: 'init',
      history: this.history,
      historyAttachments: attachmentPreviews,
      pendingAttachments: pendingPreviews,
      mode: this.mode,
      processing: this.processing,
      sessions: this.historyStore.listSessions(),
      activeSessionId: sessionId,
      chatFontSize: this.getChatFontSize(),
      ...this.modelStore.getStateForWebview(),
    });
    await this.postModelCatalog();
    await this.syncModelPricing();
    await this.syncAccountBalance();
    await this.syncModelCapability();
  }

  /** Public so commands can refresh after API key changes. */
  async syncAccountBalance(force = false): Promise<void> {
    const display = await getAccountBalanceForWebview(this.apiKeyStore, force);
    this.post({ type: 'accountBalance', ...display });
  }

  private refreshBalanceAfterPrompt(): void {
    getOpenRouterBalanceCache().invalidate();
    void this.syncAccountBalance(true);
  }

  private startBalanceRefresh(): void {
    this.stopBalanceRefresh();
    void this.syncAccountBalance();
    this.balanceRefreshTimer = setInterval(() => {
      void this.syncAccountBalance();
    }, 60_000);
  }

  private stopBalanceRefresh(): void {
    if (this.balanceRefreshTimer !== undefined) {
      clearInterval(this.balanceRefreshTimer);
      this.balanceRefreshTimer = undefined;
    }
  }

  private getPricingCache() {
    return getModelPricingCache(this.context);
  }

  private supportsVision(modelId: string): boolean {
    return this.getPricingCache().supportsVision(modelId);
  }

  private buildCapabilityHint(): { visible: boolean; message: string } {
    const selected = this.modelStore.getSelectedModelId();
    if (selected === AUTO_MODEL_ID) {
      const pool = this.modelStore.getAutoPoolModels();
      if (!this.getPricingCache().poolHasVisionModel(pool)) {
        return {
          visible: true,
          message:
            'None of your Auto models can read images or PDFs. Turn on a vision model in the model menu, or select one directly.',
        };
      }
      return { visible: false, message: '' };
    }
    if (!this.supportsVision(selected)) {
      return {
        visible: true,
        message:
          'This model is text only — it cannot read images or PDFs. Choose a vision-capable model for photos and PDFs.',
      };
    }
    return { visible: false, message: '' };
  }

  private async syncModelCapability(): Promise<void> {
    const hint = this.buildCapabilityHint();
    this.post({ type: 'modelCapability', ...hint });
  }

  private async postModelState(): Promise<void> {
    this.post({ type: 'models', ...this.modelStore.getStateForWebview() });
  }

  private async postModelCatalog(): Promise<void> {
    const cache = this.getPricingCache();
    try {
      await cache.ensureLoaded(this.apiKeyStore);
    } catch {
      // use stale cache if any
    }
    const catalogIds = cache.getCatalogIds();
    await this.modelStore.pruneAutoPoolToCatalog(catalogIds);
    await this.modelStore.validateSelectedModelOrFallback(catalogIds);
    this.post({
      type: 'modelCatalog',
      catalog: cache.getCatalogForPicker(),
      ...this.modelStore.getStateForWebview(),
    });
    await this.syncModelCapability();
  }

  private async syncModelPricing(): Promise<void> {
    if (!isModelPricingEnabled()) {
      this.post({ type: 'modelPricing', hidden: true });
      return;
    }
    const cache = getModelPricingCache(this.context);
    try {
      await cache.ensureLoaded(this.apiKeyStore);
    } catch {
      // use stale cache if any
    }
    const modelId = this.modelStore.getSelectedModelId();
    const display = cache.getDisplayForModel(modelId);
    this.post({
      type: 'modelPricing',
      line: display.line,
      segments: display.segments,
      compact: display.compact,
      title: display.title,
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
    mode: AgentMode;
    hasVisionAttachments?: boolean;
    signal?: AbortSignal;
    tools?: OpenRouterToolDef[];
    supportsTools?: (modelId: string) => boolean;
  } {
    return {
      modelStore: this.modelStore,
      apiKeyStore: this.apiKeyStore,
      mode: this.mode,
      hasVisionAttachments: this.hasVisionInRequest,
      signal: this.activeAbortController?.signal,
      tools: this.currentToolDefs.length > 0 ? this.currentToolDefs : undefined,
      supportsTools: (id) => this.getPricingCache().supportsTools(id),
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
    // Stop all running terminal processes
    stopAllRunningProcesses();
  }

  private async callOpenRouterToolAware(
    conversation: ChatMessage[]
  ): Promise<ToolAwareResult> {
    const res = await askOpenRouterToolAware(conversation, this.routerOptions());
    return { content: sanitizeModelOutput(res.content), toolCalls: res.toolCalls };
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
  ): Promise<ToolAwareResult> {
    if (!this.getStreamEnabled() || !forwardToUi) {
      return this.callOpenRouterToolAware(conversation);
    }

    let streamStarted = false;
    let lastPostAt = 0;
    let pendingContent = '';
    let throttleTimer: ReturnType<typeof setTimeout> | undefined;

    const flushPartial = (): void => {
      if (!pendingContent) {
        return;
      }
      if (!streamStarted) {
        streamStarted = true;
        this.streamActiveForUi = true;
        this.post({ type: 'assistantStreamStart' });
      }
      this.post({ type: 'assistantPartial', content: pendingContent });
      lastPostAt = Date.now();
      pendingContent = '';
    };

    const schedulePartial = (content: string): void => {
      pendingContent = content;
      const elapsed = Date.now() - lastPostAt;
      if (elapsed >= STREAM_POST_THROTTLE_MS) {
        if (throttleTimer) {
          clearTimeout(throttleTimer);
          throttleTimer = undefined;
        }
        flushPartial();
        return;
      }
      if (throttleTimer) {
        return;
      }
      throttleTimer = setTimeout(() => {
        throttleTimer = undefined;
        flushPartial();
      }, STREAM_POST_THROTTLE_MS - elapsed);
    };

    const apiSpan = new PerfSpan('apiRequest');
    let firstTokenLogged = false;
    let lastToolProgressAt = 0;

    const result = await askOpenRouterToolAware(conversation, {
      ...this.routerOptions(),
      stream: true,
      onChunk: (_delta, accumulated) => {
        // Never stream raw tool JSON to the chat — only user-visible prose
        const content = cleanAssistantVisibleText(sanitizeModelOutput(accumulated));
        if (!content) {
          return;
        }
        if (!firstTokenLogged) {
          firstTokenLogged = true;
          apiSpan.end('→ first token');
        }
        schedulePartial(content);
      },
      onToolProgress: (info) => {
        // Surfaces silent native tool-call generation (e.g. a large file write)
        // so the user always sees motion. Throttled to avoid message spam.
        const now = Date.now();
        if (now - lastToolProgressAt < STREAM_POST_THROTTLE_MS) {
          return;
        }
        lastToolProgressAt = now;
        this.post({ type: 'toolProgress', name: info.name, bytes: info.bytes });
      },
    });

    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = undefined;
    }
    if (pendingContent) {
      flushPartial();
    }

    if (!streamStarted) {
      this.streamActiveForUi = false;
    }

    let finalText = sanitizeModelOutput(result.content);
    if (this.stripToolLeaksInStream) {
      finalText = stripToolBlock(finalText);
    }
    if (!firstTokenLogged) {
      apiSpan.end('→ complete (no stream chunks)');
    }
    return { content: finalText, toolCalls: result.toolCalls };
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
    const pending = this.attachmentStore.getPending();
    if ((!trimmed && pending.length === 0) || this.processing) {
      return;
    }

    // Extract and process @file mentions
    const { parseFileMentions, stripFileMentions, readMentionedFiles } = await import(
      './fileMentions'
    );
    const mentions = parseFileMentions(trimmed);
    const visibleText = stripFileMentions(trimmed);
    const mentionedFilesPaths = mentions.map((m) => m.path);
    const mentionedFilesContext = await readMentionedFiles(mentionedFilesPaths);
    const fullContent = visibleText + mentionedFilesContext;

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

    if (
      modelId !== AUTO_MODEL_ID &&
      hasTextAttachments(pending) &&
      /:free|owl-alpha|glm-4\.5-air/i.test(modelId)
    ) {
      void vscode.window.showInformationMessage(
        'OpenRouter Agent: For attached file analysis, Auto or a stronger model may give cleaner results.'
      );
    }

    if (
      modelId !== AUTO_MODEL_ID &&
      hasVisionAttachments(pending) &&
      !this.supportsVision(modelId)
    ) {
      const useAutoItem: vscode.MessageItem = { title: 'Use Auto' };
      const sendAnywayItem: vscode.MessageItem = { title: 'Send anyway' };
      const cancelVision: vscode.MessageItem = { title: 'Cancel', isCloseAffordance: true };
      const choice = await vscode.window.showWarningMessage(
        'The selected model may not support images or PDFs. Use Auto or a vision-capable model?',
        { modal: true },
        useAutoItem,
        sendAnywayItem,
        cancelVision
      );
      if (!choice || choice === cancelVision) {
        return;
      }
      if (choice === useAutoItem) {
        modelId = AUTO_MODEL_ID;
      } else if (choice !== sendAnywayItem) {
        return;
      }
    }

    const pool = this.modelStore.getAutoPoolModels();
    const visionFn = (id: string) => this.supportsVision(id);

    if (modelId === AUTO_MODEL_ID && !this.modelStore.isAutoPoolValid()) {
      this.post({
        type: 'error',
        message:
          'Turn on at least 3 models for Auto (use the switches in the model menu), then Enable Auto.',
      });
      return;
    }

    if (modelId === AUTO_MODEL_ID && hasVisionAttachments(pending)) {
      const visionPick = pickAutoModelForRequest(
        pool,
        {
          mode,
          userMessage: trimmed,
          conversationLength: this.history.length,
          hasVisionAttachments: true,
        },
        visionFn
      );
      if (!visionPick) {
        this.post({
          type: 'error',
          message:
            'No vision-capable model is enabled for Auto. Turn on a vision model in the model menu (e.g. google/gemini-2.0-flash-001), or pick one directly.',
        });
        return;
      }
    }

    await this.modelStore.setSelectedModelId(modelId);
    if (modelId === AUTO_MODEL_ID) {
      await this.postModelState();
    }

    const sessionId = this.historyStore.getActiveId();
    const committed = await this.attachmentStore.commitPendingToSession(sessionId);
    this.postAttachmentsUpdated();

    this.processing = true;
    this.mode = mode;
    this.hasVisionInRequest = hasVisionAttachments(committed);
    // Advertise native tool schemas (read tools in Ask, +write/run in Agent, none in Plan).
    this.currentToolDefs = getToolDefsForMode(mode, mode === 'agent');
    // Strip tool markup from streamed tokens in Ask/Agent (models like owl-alpha emit many blocks)
    this.stripToolLeaksInStream =
      committed.length > 0 || mode === 'ask' || mode === 'agent';
    this.beginRequest();

    const userMsg: ChatSessionMessage = {
      role: 'user',
      content: fullContent,
      attachments: committed.length ? committed : undefined,
    };
    this.history.push(userMsg);
    await this.persistSession(visibleText || committed[0]?.name);

    const userAttachmentsForUi = await this.enrichAttachmentsForUi(sessionId, committed);
    this.post({
      type: 'userMessage',
      content: visibleText,
      attachments: userAttachmentsForUi,
    });
    this.post({
      type: 'sessions',
      sessions: this.historyStore.listSessions(),
      activeSessionId: sessionId,
    });

    const modelLabel =
      modelId === AUTO_MODEL_ID
        ? formatAutoModelLabel(
            pickAutoModelForRequest(
              pool,
              {
                mode,
                userMessage: visibleText,
                conversationLength: this.history.length,
                hasVisionAttachments: this.hasVisionInRequest,
              },
              visionFn
            ) || '…'
          )
        : modelId.length > 28
          ? modelId.slice(0, 28) + '…'
          : modelId;
    const attachLabel =
      committed.length > 0 ? attachmentAnalysisLabel(committed) : '';
    const initialStep =
      attachLabel.length > 0
        ? `Analyzing ${attachLabel}…`
        : `Step 1: Thinking with ${modelLabel}…`;
    this.setLoading(true, initialStep, {
      completed: [],
      current: initialStep,
    });

    try {
      this.updateProcess([], 'Gathering context…', 'Reading workspace and editor state…');
      const contextSpan = new PerfSpan('contextGather');
      const context = await gatherContext();
      contextSpan.end(context.incomplete ? '(incomplete)' : undefined);

      const apiHistory: ChatMessage[] = [];
      for (const m of this.history.slice(0, -1)) {
        if (m.role === 'user' && m.attachments?.length) {
          const resolved = await this.attachmentStore.loadResolved(sessionId, m.attachments);
          apiHistory.push(sessionMessageToApiMessage(m, resolved));
        } else {
          apiHistory.push({ role: m.role, content: m.content });
        }
      }

      const currentResolved = committed.length
        ? await this.attachmentStore.loadResolved(sessionId, committed)
        : [];

      let response: string;
      const conversation = buildMessagesWithHistory(
        mode,
        trimmed,
        context,
        apiHistory,
        currentResolved
      );

      if (mode === 'plan') {
        this.updateProcess(
          [],
          'Step 1: Planning…',
          'Reviewing your request and drafting a plan…'
        );
        response = (await this.callOpenRouterStreaming(conversation, true)).content;
        if (this.isAborted()) {
          this.cancelStreamUi();
          response = STOPPED_MESSAGE;
        } else {
          const hadToolMarkup = hasToolCallMarkup(response);
          if (this.stripToolLeaksInStream || hadToolMarkup) {
            response = stripToolBlock(response) || response;
          }
          if (hadToolMarkup) {
            response +=
              '\n\n💡 **Plan mode** does not run tools. Switch to **Agent** (or **Ask** for read-only) to explore files.';
          }
        }
      } else {
        const out = await this.runToolLoop(conversation, mode === 'agent', trimmed, {
          hasAttachments: committed.length > 0,
          attachmentLabel: attachLabel,
        });
        response = this.stripToolLeaksInStream
          ? stripToolBlock(sanitizeModelOutput(out.content))
          : sanitizeModelOutput(out.content);
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
        this.refreshBalanceAfterPrompt();
        return;
      }

      response = sanitizeModelOutput(response);
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
      this.refreshBalanceAfterPrompt();
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
      this.hasVisionInRequest = false;
      this.stripToolLeaksInStream = false;
      this.currentToolDefs = [];
      this.activeAbortController = undefined;
      this.streamActiveForUi = false;
      this.setLoading(false);
      this.refreshBalanceAfterPrompt();
    }
  }

  private async enrichAttachmentsForUi(
    sessionId: string,
    metas: AttachmentMeta[]
  ): Promise<
    { id: string; name: string; kind: string; mimeType: string; previewUrl?: string }[]
  > {
    const row: { id: string; name: string; kind: string; mimeType: string; previewUrl?: string }[] =
      [];
    for (const a of metas) {
      const previewUrl =
        a.kind === 'image' ? await this.attachmentStore.getPreviewDataUrl(sessionId, a) : undefined;
      row.push({
        id: a.id,
        name: a.name,
        kind: a.kind,
        mimeType: a.mimeType,
        previewUrl,
      });
    }
    return row;
  }

  private async runToolLoop(
    conversation: ChatMessage[],
    allowWrites: boolean,
    userText: string,
    options: { hasAttachments?: boolean; attachmentLabel?: string } = {}
  ): Promise<{ content: string; details: ToolDetailEntry[] }> {
    if (this.isAborted()) {
      return { content: STOPPED_MESSAGE, details: [] };
    }

    const hasAttachments = options.hasAttachments ?? false;
    const displayParts: string[] = [];
    const details: ToolDetailEntry[] = [];
    const completedSteps: string[] = [];
    let lastAssistant = '';
    let stepNum = 0;
    let toolsRun = 0;
    let parseRetries = 0;
    let unverifiedRetries = 0;
    let verificationFallbackAttempted = false;
    const needsVerification = requiresFileVerification(userText, { hasAttachments });

    const runVerificationFallbackBatch = async (
      assistantRaw: string,
      statusLabel: string
    ): Promise<boolean> => {
      if (
        verificationFallbackAttempted ||
        hasAttachments ||
        !needsVerification ||
        this.isAborted()
      ) {
        return false;
      }
      const fallback = buildVerificationFallbackTools(userText);
      if (fallback.length === 0) {
        return false;
      }
      verificationFallbackAttempted = true;
      if (fallback.length >= 2 && canParallelizeReadTools(fallback)) {
        const resolvedBatch = fallback.map((c) => resolveToolCall(c));
        stepNum++;
        const batchStep = `Step ${stepNum}: ${statusLabel} (${resolvedBatch.length} files)…`;
        this.updateProcess(completedSteps, batchStep, 'Reading workspace files…');
        const ran = await this.runReadToolsInParallel(
          resolvedBatch,
          assistantRaw,
          conversation,
          details,
          completedSteps,
          stepNum
        );
        if (ran) {
          toolsRun += resolvedBatch.length;
        }
        return ran;
      }
      const resolved = resolveToolCall(fallback[0]);
      stepNum++;
      const toolStep = describeProcessStep(stepNum, 'tool', resolved);
      this.updateProcess(completedSteps, toolStep);
      const ran = await this.runOneTool(
        resolved,
        assistantRaw,
        conversation,
        details,
        completedSteps,
        stepNum,
        allowWrites,
        this.activeAbortController?.signal
      );
      if (ran) {
        toolsRun++;
      }
      return ran;
    };

    let autoCalls = hasAttachments ? [] : buildAutoToolCalls(detectUserFileIntent(userText));
    let autoCallsFromVerificationFallback = false;
    if (!hasAttachments && autoCalls.length === 0 && needsVerification) {
      autoCalls = buildVerificationFallbackTools(userText);
      autoCallsFromVerificationFallback = autoCalls.length > 0;
    }
    if (autoCalls.length >= 2 && canParallelizeReadTools(autoCalls) && !this.isAborted()) {
      if (autoCallsFromVerificationFallback) {
        verificationFallbackAttempted = true;
      }
      const resolvedBatch = autoCalls.map((c) => resolveToolCall(c));
      stepNum++;
      const batchStep = `Step ${stepNum}: Reading ${resolvedBatch.length} project files…`;
      this.updateProcess(completedSteps, batchStep, 'Checking project files…');
      const ran = await this.runReadToolsInParallel(
        resolvedBatch,
        '(auto)',
        conversation,
        details,
        completedSteps,
        stepNum
      );
      if (ran) {
        toolsRun += resolvedBatch.length;
      }
    } else if (autoCalls.length === 1 && !this.isAborted()) {
      if (autoCallsFromVerificationFallback) {
        verificationFallbackAttempted = true;
      }
      const resolved = resolveToolCall(autoCalls[0]);
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
        allowWrites,
        this.activeAbortController?.signal
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
      const thinkStep = hasAttachments && stepNum === 1 && options.attachmentLabel
        ? `Analyzing ${options.attachmentLabel}…`
        : describeProcessStep(stepNum, 'thinking');
      this.updateProcess(completedSteps, thinkStep);

      let res: ToolAwareResult;
      try {
        res = await this.callOpenRouterStreaming(conversation, true);
      } catch (err) {
        if (err instanceof AskOpenRouterAbortedError || this.isAborted()) {
          this.cancelStreamUi();
          return { content: STOPPED_MESSAGE, details };
        }
        throw err;
      }
      const raw = res.content;
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

      // Native tool calls (Claude/GPT/Gemini) take priority over text agent-tool blocks.
      const nativeToolCalls = res.toolCalls ?? [];
      if (nativeToolCalls.length > 0) {
        this.cancelStreamUi();
        const visibleNative = cleanAssistantVisibleText(raw);
        if (visibleNative) {
          this.updateProcess(completedSteps, thinkStep.replace(/…$/, '') + '…', visibleNative);
        }
        completedSteps.push(thinkStep.replace(/…$/, '') + ' — done');
        const { ran, nextStep } = await this.runNativeToolCalls(
          nativeToolCalls,
          raw,
          conversation,
          details,
          completedSteps,
          stepNum,
          allowWrites,
          this.activeAbortController?.signal
        );
        stepNum = nextStep;
        toolsRun += ran;
        if (this.isAborted()) {
          return { content: STOPPED_MESSAGE, details };
        }
        continue;
      }

      const toolCalls = parseAllToolCalls(raw);
      const hasTools = toolCalls.length > 0;
      const visible = cleanAssistantVisibleText(raw);

      if (hasTools) {
        this.cancelStreamUi();
      }

      if (visible && hasTools) {
        this.updateProcess(completedSteps, thinkStep.replace(/…$/, '') + '…', visible);
      }

      if (!hasTools) {
        if (hasToolInterruptionArtifact(raw) && parseRetries < MAX_PARSE_RETRIES) {
          parseRetries++;
          completedSteps.push(thinkStep.replace(/…$/, '') + ' — retrying tool format…');
          conversation.push({ role: 'assistant', content: raw });
          conversation.push({ role: 'user', content: TOOL_INTERRUPTION_RETRY_PROMPT });
          continue;
        }

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

        if (
          toolsRun === 0 &&
          needsVerification &&
          mentionsFileAccessRefusal(raw) &&
          unverifiedRetries < MAX_UNVERIFIED_RETRIES
        ) {
          unverifiedRetries++;
          completedSteps.push(thinkStep.replace(/…$/, '') + ' — retrying after file-access refusal…');
          const refusalAuto = buildVerificationFallbackTools(userText);
          if (refusalAuto.length >= 2 && canParallelizeReadTools(refusalAuto)) {
            const resolvedBatch = refusalAuto.map((c) => resolveToolCall(c));
            stepNum++;
            const batchStep = describeProcessStep(stepNum, 'tool', resolvedBatch[0]);
            this.updateProcess(completedSteps, batchStep);
            const ran = await this.runReadToolsInParallel(
              resolvedBatch,
              raw,
              conversation,
              details,
              completedSteps,
              stepNum
            );
            if (ran) {
              toolsRun += resolvedBatch.length;
              continue;
            }
          } else if (refusalAuto.length === 1) {
            const resolved = resolveToolCall(refusalAuto[0]);
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
              allowWrites,
              this.activeAbortController?.signal
            );
            if (ran) {
              toolsRun++;
              continue;
            }
          }
          conversation.push({ role: 'assistant', content: raw });
          conversation.push({ role: 'user', content: FILE_ACCESS_REFUSAL_RETRY_PROMPT });
          continue;
        }

        const guessedAboutFiles =
          needsVerification &&
          toolsRun === 0 &&
          (visible || mentionsFileExistence(raw) || hasToolCallMarkup(raw));

        if (guessedAboutFiles && unverifiedRetries < MAX_UNVERIFIED_RETRIES) {
          unverifiedRetries++;
          completedSteps.push(thinkStep.replace(/…$/, '') + ' — verifying files…');
          const ranFallback = await runVerificationFallbackBatch(raw, 'Verifying workspace');
          if (ranFallback) {
            continue;
          }
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
              allowWrites,
              this.activeAbortController?.signal
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

        if (needsVerification && toolsRun === 0) {
          const ranLastChance = await runVerificationFallbackBatch(raw, 'Auto-reading project');
          if (ranLastChance) {
            continue;
          }
        }

        completedSteps.push(
          thinkStep.replace(/…$/, '').replace(/\.+$/, '') + ' — done'
        );
        const suppressVisible = shouldSuppressVisibleAsFinal(visible, raw, {
          needsVerification,
          toolsRun,
        });
        if (
          visible &&
          !(needsVerification && toolsRun === 0) &&
          !suppressVisible
        ) {
          displayParts.push(visible);
        } else if (needsVerification && toolsRun === 0) {
          if (displayParts.length > 0) {
            displayParts.length = 0;
          }
          displayParts.push(VERIFICATION_TOOLS_FAILED_MESSAGE);
        } else if (hasToolCallMarkup(raw)) {
          displayParts.push(TOOL_PARSE_FAILED_MESSAGE);
        }
        break;
      }

      const hasWriteTool = toolCalls.some((c) => !isReadOnlyTool(c.tool));
      if (!allowWrites && hasWriteTool) {
        completedSteps.push(thinkStep.replace(/…$/, '') + ' — done');
        if (visible) {
          displayParts.push(visible);
        }
        const blocked = toolCalls.find((c) => !isReadOnlyTool(c.tool));
        displayParts.push(
          `\n\n💡 **Ask mode is read-only.** Switch to **Agent mode** to run \`${blocked?.tool ?? 'write/command tools'}\`.`
        );
        break;
      }

      completedSteps.push(thinkStep.replace(/…$/, '') + ' — done');

      if (canParallelizeReadTools(toolCalls)) {
        stepNum++;
        const batchStep = `Step ${stepNum}: Reading ${toolCalls.length} files in parallel…`;
        this.updateProcess(completedSteps, batchStep, visible);

        const ran = await this.runReadToolsInParallel(
          toolCalls,
          raw,
          conversation,
          details,
          completedSteps,
          stepNum
        );
        if (!ran) {
          break;
        }
        toolsRun += toolCalls.length;
      } else if (toolCalls.length > 1) {
        conversation.push({ role: 'assistant', content: raw });
        let ranAny = false;
        for (const tc of toolCalls) {
          if (!allowWrites && !isReadOnlyTool(tc.tool)) {
            continue;
          }
          stepNum++;
          const toolStep = describeProcessStep(stepNum, 'tool', tc);
          this.updateProcess(completedSteps, toolStep);
          const ran = await this.runOneTool(
            tc,
            raw,
            conversation,
            details,
            completedSteps,
            stepNum,
            allowWrites,
            this.activeAbortController?.signal,
            { skipAssistantPush: true }
          );
          if (ran) {
            ranAny = true;
            toolsRun++;
          }
        }
        if (!ranAny) {
          break;
        }
      } else {
        const toolCall = toolCalls[0];
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
          allowWrites,
          this.activeAbortController?.signal
        );
        if (!ran) {
          break;
        }
        toolsRun++;
      }

      if (this.isAborted()) {
        return { content: STOPPED_MESSAGE, details };
      }
    }

    if (displayParts.length > 0) {
      const joined = displayParts.join('\n\n');
      return {
        content: hasAttachments ? stripToolBlock(joined) || joined : joined,
        details,
      };
    }

    const fallback =
      cleanAssistantVisibleText(lastAssistant) || stripToolBlock(lastAssistant);
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
          ? VERIFICATION_TOOLS_FAILED_MESSAGE
          : '_No response from the model. Check your API key and model, then try again._',
      details,
    };
  }

  private async runReadToolsInParallel(
    toolCalls: ToolCall[],
    assistantRaw: string,
    conversation: ChatMessage[],
    details: ToolDetailEntry[],
    completedSteps: string[],
    stepNum: number
  ): Promise<boolean> {
    if (toolCalls.length < 2) {
      return false;
    }

    const results = await executeReadToolsInParallel(toolCalls);

    conversation.push({ role: 'assistant', content: assistantRaw });

    for (const { tool, result, displayNote } of results) {
      const resultPreview =
        result.length > 6000 ? result.slice(0, 6000) + '\n… [truncated]' : result;
      details.push({
        step: stepNum,
        title: displayNote ?? describeToolCall(tool),
        result: resultPreview,
      });
      conversation.push({
        role: 'user',
        content: `Tool result for ${tool.tool}:\n\`\`\`json\n${result}\n\`\`\``,
      });
    }

    completedSteps.push(
      describeProcessDone(stepNum, toolCalls[0], `Read ${results.length} files in parallel`)
    );
    return true;
  }

  private async runOneTool(
    toolCall: ToolCall,
    assistantRaw: string,
    conversation: ChatMessage[],
    details: ToolDetailEntry[],
    completedSteps: string[],
    stepNum: number,
    allowWrites: boolean,
    signal?: AbortSignal,
    options?: { skipAssistantPush?: boolean }
  ): Promise<boolean> {
    if (!toolCall) {
      return false;
    }

    if (!allowWrites && !isReadOnlyTool(toolCall.tool)) {
      return false;
    }

    const { result, displayNote } = await handleToolCall(
      toolCall,
      this.buildToolCtx(),
      signal
    );

    const resultPreview =
      result.length > 6000 ? result.slice(0, 6000) + '\n… [truncated]' : result;
    details.push({
      step: stepNum,
      title: displayNote ?? describeToolCall(toolCall),
      result: resultPreview,
    });

    completedSteps.push(describeProcessDone(stepNum, toolCall, displayNote));

    if (!options?.skipAssistantPush) {
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
    }
    conversation.push({
      role: 'user',
      content: `Tool result for ${toolCall.tool}:\n\`\`\`json\n${result}\n\`\`\``,
    });
    return true;
  }

  /** Tool-handler context: in-chat approvals + terminal output forwarded to the webview. */
  private buildToolCtx(): ToolHandlerContext {
    return {
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
    };
  }

  /**
   * Execute native (OpenRouter/OpenAI) tool calls and append the required
   * assistant `tool_calls` turn + one `role:'tool'` result per call.
   * Every tool_call_id MUST be answered, so unparseable/blocked calls get an error result.
   */
  private async runNativeToolCalls(
    nativeCalls: NativeToolCall[],
    assistantContent: string,
    conversation: ChatMessage[],
    details: ToolDetailEntry[],
    completedSteps: string[],
    startStep: number,
    allowWrites: boolean,
    signal?: AbortSignal
  ): Promise<{ ran: number; nextStep: number }> {
    const visible = cleanAssistantVisibleText(assistantContent);
    conversation.push({
      role: 'assistant',
      content: visible || null,
      tool_calls: nativeCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: tc.function,
      })),
    });

    let ran = 0;
    let step = startStep;

    for (const native of nativeCalls) {
      if (this.isAborted()) {
        break;
      }
      const parsed = parseNativeToolCall(native);
      step++;

      if (!parsed || (!allowWrites && !isReadOnlyTool(parsed.tool))) {
        const message = !parsed
          ? `Unsupported or unparseable tool: ${native.function?.name ?? 'unknown'}`
          : `${parsed.tool} is not allowed in this mode. Switch to Agent mode for writes and commands.`;
        conversation.push({
          role: 'tool',
          tool_call_id: native.id,
          content: JSON.stringify({ error: message }),
        });
        completedSteps.push(
          `Step ${step}: ${parsed ? `Skipped ${parsed.tool}` : 'Unsupported tool'}`
        );
        continue;
      }

      const toolStep = describeProcessStep(step, 'tool', parsed);
      this.updateProcess(completedSteps, toolStep);

      const { result, displayNote } = await handleToolCall(
        parsed,
        this.buildToolCtx(),
        signal
      );

      const resultPreview =
        result.length > 6000 ? result.slice(0, 6000) + '\n… [truncated]' : result;
      details.push({
        step,
        title: displayNote ?? describeToolCall(parsed),
        result: resultPreview,
      });
      completedSteps.push(describeProcessDone(step, parsed, displayNote));

      conversation.push({
        role: 'tool',
        tool_call_id: native.id,
        content: result,
      });
      ran++;
    }

    return { ran, nextStep: step };
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
      raw = (await this.callOpenRouterStreaming(conversation, true)).content;
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
    const markedUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'marked.min.js')
    );
    const hljsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'highlight.min.js')
    );
    const highlightCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'highlight-vscode.css')
    );
    const chatFontSize = this.getChatFontSize();
    const fontSizeCss =
      chatFontSize > 0 ? `${chatFontSize}px` : '14px';
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob: ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>OpenRouter Chat</title>
  <link rel="stylesheet" href="${highlightCssUri}" />
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
      min-width: 88px;
      max-width: 160px;
      width: auto;
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
    .dropdown-menu[hidden],
    .dropdown-menu.is-closed {
      display: none !important;
      pointer-events: none;
      visibility: hidden;
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
    .dropdown-menu-wide {
      min-width: 280px;
      max-width: min(420px, calc(100vw - 16px));
    }
    .dropdown-menu-wide .dropdown-item {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.8em;
    }
    .model-picker {
      display: inline-flex;
      align-items: center;
      min-width: 0;
    }
    .model-capability-hint {
      flex: 0 1 auto;
      width: fit-content;
      max-width: calc(100% - 6.5rem);
      font-size: 0.7em;
      line-height: 1.35;
      font-weight: 400;
      color: var(--vscode-editorWarning-foreground, #d19a2e);
      background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #d19a2e) 10%, transparent);
      border-radius: 6px;
      padding: 6px 10px;
      margin: 0;
    }
    .model-capability-hint.hidden {
      display: none;
    }
    .model-picker-menu {
      width: 380px;
      min-width: 380px;
      max-width: min(380px, calc(100vw - 16px));
      max-height: 380px;
      display: flex;
      flex-direction: column;
      gap: 0;
      padding: 0;
      overflow: hidden;
    }
    .model-picker-auto-header {
      padding: 8px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.08));
    }
    .model-picker-auto-title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 6px;
    }
    .model-picker-auto-title {
      font-weight: 600;
      font-size: 0.9em;
    }
    .model-picker-auto-action {
      font-family: inherit;
      font-size: 0.78em;
      font-weight: 500;
      padding: 4px 10px;
      border-radius: 12px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-foreground);
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .model-picker-auto-action.enable.ready {
      background: #2dd4bf;
      border-color: #2dd4bf;
      color: #0f172a;
    }
    .model-picker-auto-action.enable:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .model-picker-auto-action.disable:hover {
      border-color: var(--vscode-focusBorder);
    }
    .model-picker-auto-hint,
    .model-picker-auto-status {
      font-size: 0.72em;
      line-height: 1.4;
      color: var(--vscode-descriptionForeground);
    }
    .model-picker-pick-section {
      display: flex;
      flex-direction: column;
      min-height: 0;
      flex: 1 1 auto;
    }
    .model-picker-toolbar {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 6px;
      padding: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .model-picker-search {
      flex: 1;
      min-width: 0;
      box-sizing: border-box;
      font-family: inherit;
      font-size: 0.85em;
      padding: 5px 8px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
      -webkit-appearance: none;
      appearance: none;
    }
    .model-picker-tags {
      display: flex;
      flex-shrink: 0;
      gap: 4px;
      align-items: center;
    }
    .model-picker-tag {
      font-family: inherit;
      font-size: 0.72em;
      font-weight: 500;
      padding: 2px 8px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-foreground);
      border-radius: 10px;
      cursor: pointer;
      line-height: 1.4;
      white-space: nowrap;
    }
    .model-picker-tag:hover {
      border-color: var(--vscode-focusBorder);
    }
    .model-picker-tag.active {
      background: #2dd4bf;
      border-color: #2dd4bf;
      color: #0f172a;
    }
    .model-picker-list {
      overflow-y: auto;
      flex: 1 1 auto;
      min-height: 48px;
      max-height: 300px;
    }
    .model-picker-row {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 2px 6px 2px 4px;
    }
    .model-picker-row-id-btn {
      flex: 1;
      min-width: 0;
      text-align: left;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.78em;
      padding: 5px 8px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .model-picker-row-id-btn:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .model-picker-row-id-btn.selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .model-pool-switch {
      flex-shrink: 0;
      width: 32px;
      height: 18px;
      border-radius: 9px;
      border: none;
      padding: 0;
      background: var(--vscode-input-border);
      cursor: pointer;
      position: relative;
    }
    .model-pool-switch.on {
      background: #2dd4bf;
    }
    .model-pool-switch::after {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--vscode-editor-background, #fff);
      transition: left 0.15s ease;
    }
    .model-pool-switch.on::after {
      left: 16px;
    }
    .model-picker-empty {
      padding: 12px 10px;
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground);
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
    .messages-panel {
      flex: 1;
      min-height: 0;
      position: relative;
      display: flex;
      flex-direction: column;
    }
    .jump-to-bottom {
      position: absolute;
      bottom: 10px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 5;
      font-family: inherit;
      font-size: 0.78em;
      font-weight: 500;
      color: var(--vscode-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 14px;
      padding: 5px 12px;
      cursor: pointer;
      box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.35));
      opacity: 0.95;
    }
    .jump-to-bottom:hover {
      background: var(--vscode-toolbar-hoverBackground);
      border-color: var(--vscode-focusBorder);
    }
    .jump-to-bottom.hidden {
      display: none;
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
    /* Inline "still working" chip shown at the end of a streamed message while the
       model is busy but not producing visible text (reading files, finishing up). */
    .stream-working {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      margin-top: 6px;
      font-size: 0.86em;
      color: var(--vscode-charts-teal, #4ec9b0);
      vertical-align: baseline;
    }
    .stream-working .thinking-dots span {
      width: 5px;
      height: 5px;
      background: var(--vscode-charts-teal, #4ec9b0);
    }
    .stream-working-label {
      color: var(--vscode-descriptionForeground);
    }
    @media (prefers-reduced-motion: reduce) {
      .stream-working .thinking-dots span { animation: none; opacity: 0.7; }
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
      .composer.composer-busy {
        border-color: var(--vscode-focusBorder);
        outline: 1px solid var(--vscode-focusBorder);
        background: var(--vscode-input-background);
      }
      .composer.composer-busy::before {
        content: none;
        animation: none;
      }
    }
    .msg.thinking {
      color: var(--vscode-foreground);
      background: var(--vscode-editorWidget-background, rgba(127,127,127,0.06));
      border: 1px solid var(--vscode-panel-border);
      border-radius: 10px;
      align-self: stretch;
      width: 100%;
      max-width: 100%;
      padding: 10px 12px;
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
    /* --- Modern agent activity log --- */
    .activity-header {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.9em;
      min-width: 0;
    }
    .activity-cur-icon {
      display: inline-flex;
      flex-shrink: 0;
      color: var(--vscode-descriptionForeground);
    }
    .activity-cur-label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .activity-elapsed {
      margin-left: auto;
      flex-shrink: 0;
      font-variant-numeric: tabular-nums;
      font-size: 0.82em;
      opacity: 0.7;
      color: var(--vscode-descriptionForeground);
    }
    .step-icon {
      width: 14px;
      height: 14px;
      flex-shrink: 0;
      vertical-align: middle;
    }
    .step-icon-check { color: var(--vscode-testing-iconPassed, #89d185); }
    .step-path {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.92em;
      background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.14));
      padding: 0 4px;
      border-radius: 4px;
    }
    .activity-collapse { margin-top: 8px; }
    .activity-toggle, .activity-summary > summary {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      list-style: none;
      font-size: 0.82em;
      color: var(--vscode-descriptionForeground);
      user-select: none;
    }
    .activity-toggle::-webkit-details-marker,
    .activity-summary > summary::-webkit-details-marker { display: none; }
    .activity-toggle:hover, .activity-summary > summary:hover {
      color: var(--vscode-foreground);
    }
    .activity-chevron {
      width: 0;
      height: 0;
      border-left: 4px solid transparent;
      border-right: 4px solid transparent;
      border-top: 5px solid currentColor;
      transition: transform 0.15s ease;
    }
    .activity-collapse[open] > .activity-toggle .activity-chevron,
    .activity-summary[open] > summary .activity-chevron { transform: rotate(180deg); }
    .activity-steps {
      list-style: none;
      margin: 6px 0 0;
      padding: 0;
      max-height: 168px;
      overflow-y: auto;
      -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 10px, #000 calc(100% - 6px), transparent 100%);
      mask-image: linear-gradient(to bottom, transparent 0, #000 10px, #000 calc(100% - 6px), transparent 100%);
    }
    .activity-step {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 2.5px 2px;
      font-size: 0.85em;
      line-height: 1.35;
      color: var(--vscode-descriptionForeground);
    }
    .activity-step .step-icon { opacity: 0.85; }
    .activity-step-text {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .activity-step-count { opacity: 0.6; font-size: 0.9em; }
    .activity-summary {
      margin: 0 0 10px;
    }
    .activity-summary[open] > summary { margin-bottom: 6px; }
    @media (prefers-reduced-motion: reduce) {
      .activity-chevron { transition: none; }
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
    .msg-body a[data-href] {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      text-decoration: none;
    }
    .msg-body a[data-href]:hover { text-decoration: underline; }
    /* Inline code that is a verified, openable workspace file — plain teal link, no box */
    code.file-link {
      cursor: pointer;
      color: var(--vscode-charts-teal, #4ec9b0);
      background: transparent;
      border: none;
      padding: 0;
      border-radius: 0;
      text-decoration: underline;
      text-underline-offset: 2px;
      transition: color 0.12s ease;
    }
    code.file-link:hover {
      color: var(--vscode-charts-teal, #4ec9b0);
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    code.file-link:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
      border-radius: 3px;
    }
    code.file-link .step-icon {
      width: 0.9em;
      height: 0.9em;
      margin-right: 3px;
      vertical-align: -0.13em;
      opacity: 0.9;
    }
    .msg.assistant .msg-body .code-editor-block {
      --code-block-bg: color-mix(in srgb, var(--vscode-foreground) 5%, var(--chat-surface));
      --code-block-border: color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
      margin: 0.75em 0;
      border: 1px solid var(--code-block-border);
      border-radius: 8px;
      overflow: hidden;
      background: var(--code-block-bg);
      font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
      font-size: var(--vscode-editor-font-size, 13px);
      line-height: 1.5;
    }
    .msg.assistant .msg-body .code-editor-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 8px 4px 12px;
      background: var(--code-block-bg);
      font-size: 0.78em;
      user-select: none;
    }
    .msg.assistant .msg-body .code-editor-lang {
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      text-transform: lowercase;
      opacity: 0.85;
    }
    .msg.assistant .msg-body .code-editor-copy {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      flex-shrink: 0;
      color: var(--vscode-foreground);
      opacity: 0.65;
      background: transparent;
      border: none;
      padding: 0;
      border-radius: 6px;
      cursor: pointer;
    }
    .msg.assistant .msg-body .code-editor-copy svg {
      width: 16px;
      height: 16px;
    }
    .msg.assistant .msg-body .code-editor-copy:hover {
      opacity: 1;
      background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
    }
    .msg.assistant .msg-body .code-editor-copy .code-editor-check-icon {
      display: none;
      color: var(--vscode-testing-iconPassed, var(--vscode-charts-green, #73c991));
    }
    .msg.assistant .msg-body .code-editor-copy.copied .code-editor-copy-icon {
      display: none;
    }
    .msg.assistant .msg-body .code-editor-copy.copied .code-editor-check-icon {
      display: block;
    }
    .msg.assistant .msg-body .code-editor-copy.copied {
      opacity: 1;
    }
    .msg.assistant .msg-body .code-editor-scroll {
      overflow-x: auto;
      max-width: 100%;
      padding: 4px 0 8px;
      background: var(--code-block-bg);
    }
    .msg.assistant .msg-body .code-editor-table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    .msg.assistant .msg-body .code-editor-gutter {
      width: 3em;
      min-width: 3em;
      padding: 0 10px 0 8px;
      text-align: right;
      vertical-align: top;
      color: var(--vscode-editorLineNumber-foreground, var(--vscode-descriptionForeground));
      background: transparent;
      user-select: none;
      opacity: 0.55;
      white-space: nowrap;
    }
    .msg.assistant .msg-body .code-editor-line {
      padding: 0 12px 0 0;
      vertical-align: top;
      white-space: pre;
      width: 100%;
    }
    .msg.assistant .msg-body .code-editor-line code {
      font-family: inherit;
      font-size: inherit;
      background: transparent;
      border: none;
      padding: 0;
      white-space: pre;
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
      container-type: inline-size;
      container-name: composer;
      display: flex;
      flex-direction: column;
      border: 1px solid var(--vscode-input-border);
      border-radius: 10px;
      background: var(--vscode-input-background);
      overflow: visible;
    }
    .composer-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 0;
    }
    .composer-top:has(.model-capability-hint:not(.hidden)),
    .composer-top:has(.account-balance:not(.hidden)) {
      padding: 6px 8px 0;
    }
    .composer-top:has(.model-capability-hint.hidden) .account-balance:not(.hidden) {
      margin-left: auto;
    }
    .account-balance {
      flex: 0 0 auto;
      align-self: center;
      font-size: 0.72em;
      line-height: 1.2;
      pointer-events: auto;
      white-space: nowrap;
    }
    .account-balance .balance-short {
      display: none;
    }
    @container composer (max-width: 360px) {
      .account-balance .balance-full {
        display: none;
      }
      .account-balance .balance-short {
        display: inline;
      }
    }
    .account-balance.hidden {
      display: none;
    }
    .account-balance.positive {
      font-weight: 700;
      color: var(--vscode-charts-teal, #4ec9b0);
    }
    .account-balance.zero {
      font-weight: 700;
      color: var(--vscode-editorWarning-foreground, #cca700);
    }
    .composer:focus-within {
      border-color: var(--vscode-focusBorder);
      outline: 1px solid var(--vscode-focusBorder);
    }
    @property --composer-snake-angle {
      syntax: '<angle>';
      initial-value: 0deg;
      inherits: false;
    }
    @keyframes composerSnakeTravel {
      to {
        --composer-snake-angle: 360deg;
      }
    }
    .composer.composer-busy {
      position: relative;
      border-color: transparent;
      outline: none;
      background: var(--vscode-input-background);
    }
    .composer.composer-busy::before {
      content: '';
      position: absolute;
      inset: -1px;
      border-radius: 11px;
      z-index: 0;
      pointer-events: none;
      transform: none;
      --composer-snake-angle: 0deg;
      background: conic-gradient(
        from var(--composer-snake-angle),
        transparent 0deg,
        transparent 180deg,
        var(--vscode-focusBorder) 186deg,
        color-mix(in srgb, var(--vscode-charts-teal, #4ec9b0) 50%, white) 270deg,
        var(--vscode-charts-teal, #4ec9b0) 306deg,
        var(--vscode-focusBorder) 324deg,
        transparent 360deg
      );
      animation: composerSnakeTravel 5s linear infinite;
      padding: 1px;
      -webkit-mask:
        linear-gradient(#fff 0 0) content-box,
        linear-gradient(#fff 0 0);
      -webkit-mask-composite: xor;
      mask:
        linear-gradient(#fff 0 0) content-box,
        linear-gradient(#fff 0 0);
      mask-composite: exclude;
    }
    .composer.composer-busy > * {
      position: relative;
      z-index: 1;
    }
    .composer.composer-busy:focus-within {
      outline: none;
      border-color: transparent;
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
      container-type: inline-size;
      container-name: composerFooter;
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
    .model-pricing {
      flex: 1;
      min-width: 0;
      text-align: center;
      font-size: 0.72em;
      line-height: 1.3;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      opacity: 0.9;
    }
    .model-pricing.hidden {
      display: none;
    }
    .model-pricing-compact {
      display: inline;
      color: var(--vscode-charts-teal, #4ec9b0);
      font-weight: 500;
      text-transform: lowercase;
    }
    .model-pricing-compact:empty {
      display: none;
    }
    .model-pricing-full {
      display: none;
    }
    .model-pricing-full .model-pricing-muted {
      color: var(--vscode-descriptionForeground);
      opacity: 0.85;
    }
    .model-pricing-full .model-pricing-sep {
      color: var(--vscode-descriptionForeground);
      opacity: 0.65;
    }
    .model-pricing-full .model-pricing-value {
      color: var(--vscode-charts-teal, #4ec9b0);
      font-weight: 500;
    }
    @container composerFooter (min-width: 300px) {
      .model-pricing-compact {
        display: none;
      }
      .model-pricing-full {
        display: inline;
      }
    }
    .composer-right {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    /* --- Always-visible "working" status (center of composer footer) --- */
    .work-status {
      display: none;
      align-items: center;
      gap: 8px;
      flex: 1;
      min-width: 0;
      font-size: 0.74em;
      color: var(--vscode-charts-teal, #4ec9b0);
    }
    .composer-footer.working .model-pricing { display: none !important; }
    .composer-footer.working .work-status { display: inline-flex; }
    .work-text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .work-time {
      margin-left: auto;
      flex-shrink: 0;
      font-variant-numeric: tabular-nums;
      opacity: 0.85;
    }
    .work-spinner {
      width: 12px;
      height: 12px;
      flex-shrink: 0;
      border-radius: 50%;
      border: 2px solid currentColor;
      border-top-color: transparent;
      opacity: 0.75;
      animation: workspin 0.8s linear infinite;
    }
    @keyframes workspin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) {
      .work-spinner { animation: none; border-top-color: currentColor; opacity: 0.5; }
    }
    .composer.drag-over {
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder);
    }
    .attachment-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 8px 10px 0;
      min-height: 0;
    }
    .attachment-bar:empty {
      display: none;
    }
    .attachment-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 200px;
      font-size: 0.75em;
      padding: 4px 8px 4px 4px;
      border-radius: 8px;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-inactiveSelectionBackground, var(--vscode-input-background));
      color: var(--vscode-foreground);
    }
    .attachment-chip img {
      width: 28px;
      height: 28px;
      object-fit: cover;
      border-radius: 4px;
      flex-shrink: 0;
    }
    .attachment-chip-icon {
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      background: var(--vscode-panel-border);
      font-size: 0.85em;
      flex-shrink: 0;
    }
    .attachment-chip-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .attachment-chip-remove {
      border: none;
      background: transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
      padding: 0 2px;
      opacity: 0.7;
      font-size: 1.1em;
      line-height: 1;
    }
    .attachment-chip-remove:hover {
      opacity: 1;
    }
    .attach-btn {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-foreground);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      padding: 0;
      line-height: 0;
    }
    .attach-btn:hover:not(:disabled) {
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-toolbar-hoverBackground);
    }
    .attach-btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .attach-btn svg {
      display: block;
      width: 16px;
      height: 16px;
      flex-shrink: 0;
    }
    .msg-attachments {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 8px;
    }
    .msg-attachment {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-width: 140px;
    }
    .msg-attachment img {
      max-width: 140px;
      max-height: 100px;
      border-radius: 6px;
      border: 1px solid var(--vscode-panel-border);
      object-fit: contain;
    }
    .msg-attachment-label {
      font-size: 0.72em;
      color: var(--vscode-descriptionForeground);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
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
  <div class="messages-panel">
    <div id="messages"></div>
    <button type="button" id="jumpToBottomBtn" class="jump-to-bottom hidden" title="Jump to latest">↓ Latest</button>
  </div>
  <div class="composer-wrap">
    <div class="composer" id="composer">
      <div class="composer-top">
        <div id="modelCapabilityHint" class="model-capability-hint hidden" role="status"></div>
        <div id="accountBalance" class="account-balance hidden" role="status" aria-live="polite"></div>
      </div>
      <div id="attachmentBar" class="attachment-bar"></div>
      <textarea id="input" rows="3" placeholder="Ask, Plan, or Agent — attach, paste, or drop images — Enter to send"></textarea>
      <div class="composer-footer">
        <div class="composer-left">
          <div id="modeDropdown"></div>
          <div class="model-picker">
            <div id="modelDropdown"></div>
          </div>
        </div>
        <div id="modelPricing" class="model-pricing hidden" aria-live="polite">
          <span class="model-pricing-compact"></span>
          <span class="model-pricing-full"></span>
        </div>
        <div id="workStatus" class="work-status" aria-live="polite">
          <span class="work-spinner" aria-hidden="true"></span>
          <span class="work-text">Working…</span>
          <span class="work-time"></span>
        </div>
        <div class="composer-right">
          <button type="button" id="attachBtn" class="attach-btn" title="Add files or images" aria-label="Add files">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.5 4.5l-5.2 5.2a2.12 2.12 0 102.99 2.99l5.8-5.8a3.12 3.12 0 10-4.41-4.41L4.5 9.6" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>
          </button>
          <div id="sendSpinner" class="send-spinner hidden" title="Working…"></div>
          <button type="button" id="sendBtn" class="send-btn" title="Send (Enter)">↑</button>
        </div>
      </div>
    </div>
  </div>
  <script src="${hljsUri}"></script>
  <script src="${markedUri}"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const AUTO_MODEL = '${AUTO_MODEL_ID}';
    const messagesEl = document.getElementById('messages');
    const modelCapabilityHintEl = document.getElementById('modelCapabilityHint');
    const jumpToBottomBtn = document.getElementById('jumpToBottomBtn');
    const inputEl = document.getElementById('input');
    const composerEl = document.getElementById('composer');
    const attachmentBar = document.getElementById('attachmentBar');
    const modelPricingEl = document.getElementById('modelPricing');
    const accountBalanceEl = document.getElementById('accountBalance');
    const attachBtn = document.getElementById('attachBtn');
    const sendBtn = document.getElementById('sendBtn');
    const sendSpinner = document.getElementById('sendSpinner');
    const workStatusEl = document.getElementById('workStatus');
    const composerFooterEl = document.querySelector('.composer-footer');
    const clearBtn = document.getElementById('clearBtn');
    const newSessionBtn = document.getElementById('newSessionBtn');
    const deleteSessionBtn = document.getElementById('deleteSessionBtn');

    let processing = false;
    let thinkingEl = null;
    // Request-level work clock — one continuous timer from send → final message,
    // so the elapsed time and "working" indicator never disappear mid-request.
    let workStartedAt = 0;
    let workTimerId = null;
    let working = false;
    let workPhase = '';
    let workDetail = '';
    let streamIdleTimer = null;
    let streamCursorWorking = false;
    const STREAM_IDLE_FINISHING_MS = 1200;
    // Gentle, honest reassurance shown inline while the model wraps up (the footer
    // keeps the steady "Finishing up…"). Cycling keeps the wait feeling alive.
    const FINISHING_PHRASES = [
      'Working through the details…',
      'Still working…',
      'Almost there…',
      'Polishing the response…',
      'Wrapping things up…',
    ];
    let finishingIdx = 0;
    let finishingTimer = null;
    const FINISHING_CYCLE_MS = 3500;
    let activityExpanded = null;
    let lastActivity = null;
    let streamingEl = null;
    let streamingBody = null;
    let streamText = '';
    let streamRenderTimer = null;
    let streamRenderGeneration = 0;
    const STREAM_RENDER_MS = 80;
    const SCROLL_BOTTOM_THRESHOLD = 48;
    let stickToBottom = true;
    let programmaticScroll = false;
    let approvalPending = false;
    let lastModelId = AUTO_MODEL;
    let pendingAttachments = [];

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

      function findOption(val) {
        for (var i = 0; i < options.length; i++) {
          if (!options[i].separator && options[i].value === val) {
            return options[i];
          }
        }
        return null;
      }

      function findLabel(val) {
        var opt = findOption(val);
        if (opt) {
          return opt.shortLabel || opt.label;
        }
        return val;
      }

      function updateTrigger() {
        var opt = findOption(value);
        labelEl.textContent = findLabel(value) || value || settings.placeholder || 'Select';
        if (opt && opt.title) {
          trigger.title = opt.title;
        } else if (settings.title) {
          trigger.title = settings.title;
        }
        if (settings.onUpdateTrigger) {
          settings.onUpdateTrigger(value, opt);
        }
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

        if (settings.wideMenu) {
          menu.classList.add('dropdown-menu-wide');
          menu.style.width = 'auto';
          menu.style.minWidth = Math.max(280, Math.round(rect.width)) + 'px';
          menu.style.maxWidth = '';
        } else {
          menu.classList.remove('dropdown-menu-wide');
          menu.style.width = rect.width + 'px';
          menu.style.minWidth = rect.width + 'px';
          menu.style.maxWidth = '';
        }

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

    ${getModelPickerWebviewScript()}
    const modelDropdown = createModelPickerDropdown(document.getElementById('modelDropdown'));

    function escapeHtml(text) {
      const d = document.createElement('div');
      d.textContent = text;
      return d.innerHTML;
    }

    function renderCodeEditorBlock(code, lang) {
      if (!String(code).trim()) {
        return '';
      }
      var language = (lang || 'plaintext').trim().toLowerCase();
      var langLabel = language || 'plaintext';
      if (language === 'text') {
        language = 'plaintext';
        langLabel = 'plaintext';
      }
      var lines = String(code).replace(/\\r\\n/g, '\\n').split('\\n');
      var rows = lines.map(function(line, i) {
        var highlighted;
        try {
          if (language !== 'plaintext' && typeof hljs !== 'undefined' && hljs.getLanguage(language)) {
            highlighted = hljs.highlight(line || ' ', { language: language }).value;
          } else {
            highlighted = escapeHtml(line || ' ');
          }
        } catch (e) {
          highlighted = escapeHtml(line || ' ');
        }
        return '<tr><td class="code-editor-gutter">' + (i + 1) + '</td>' +
          '<td class="code-editor-line"><code class="hljs">' + highlighted + '</code></td></tr>';
      }).join('');
      var encoded = encodeURIComponent(String(code));
      var copyBtn =
        '<button type="button" class="code-editor-copy" title="Copy code" aria-label="Copy code">' +
        '<svg class="code-editor-copy-icon" viewBox="0 0 16 16" aria-hidden="true">' +
        '<rect x="5" y="5" width="9" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.25"/>' +
        '<path d="M4 11V3a1 1 0 011-1h6" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>' +
        '</svg>' +
        '<svg class="code-editor-check-icon" viewBox="0 0 16 16" aria-hidden="true">' +
        '<path d="M3.5 8.5l3 3 6-6.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
        '</svg>' +
        '</button>';
      return '<div class="code-editor-block" data-lang="' + escapeHtml(langLabel) + '" data-code="' + encoded + '">' +
        '<div class="code-editor-header">' +
        '<span class="code-editor-lang">' + escapeHtml(langLabel) + '</span>' +
        copyBtn +
        '</div>' +
        '<div class="code-editor-scroll">' +
        '<table class="code-editor-table"><tbody>' + rows + '</tbody></table>' +
        '</div></div>';
    }

    marked.use({
      breaks: true,
      gfm: true,
      renderer: {
        code: function(token) {
          var text = token.text;
          var lang = token.lang;
          if (typeof text !== 'string') {
            text = String(text);
          }
          if (!text.trim()) {
            return '';
          }
          return renderCodeEditorBlock(text, lang);
        }
      }
    });

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

    // Move http(s) href -> data-href so the webview can't auto-open the link on click;
    // opening is then handled only by our click handler (which shows the confirm dialog).
    function neutralizeExternalLinks(root) {
      if (!root) return;
      root.querySelectorAll('a[href]').forEach(function (a) {
        const href = a.getAttribute('href') || '';
        if (/^https?:/i.test(href)) {
          a.setAttribute('data-href', href);
          a.removeAttribute('href');
        }
      });
    }

    function bindMessageLinks(body) {
      if (!body) return;
      neutralizeExternalLinks(body); // every call — re-renders produce fresh anchors
      // Bind the click listener once per element (flushStreamRender re-runs this each tick).
      if (body.dataset.linksBound === '1') return;
      body.dataset.linksBound = '1';
      body.addEventListener('click', (e) => {
        const anchor = e.target.closest('a[data-href]');
        if (!anchor) return;
        e.preventDefault();
        const href = anchor.getAttribute('data-href');
        if (href) vscode.postMessage({ type: 'openLink', url: href });
      });
    }

    // --- Clickable file mentions (verified to exist in the workspace) ---
    const knownFiles = new Map(); // token written by the model -> canonical workspace path

    function isFileToken(t) {
      if (!t || t.length > 200 || /\\s/.test(t)) return false;
      return /^(?:\\.\\/)?(?:[\\w.\\-]+\\/)*[\\w.\\-]+\\.[A-Za-z0-9]{1,12}$/.test(t);
    }

    function collectCodeFileSpans(root) {
      const spans = [];
      root.querySelectorAll('code').forEach(function (c) {
        if (c.closest('pre')) return;            // skip fenced code blocks
        if (c.classList.contains('file-link')) return;
        const t = (c.textContent || '').trim();
        if (isFileToken(t)) spans.push({ el: c, token: t });
      });
      return spans;
    }

    function applyFileLinkTo(el, token) {
      const path = knownFiles.get(token);
      if (!path) return;
      el.classList.add('file-link');
      el.setAttribute('data-path', path);
      el.setAttribute('title', 'Open ' + path);
      el.setAttribute('role', 'link');
      el.setAttribute('tabindex', '0');
      el.insertAdjacentHTML('afterbegin', stepIcon('read'));
    }

    function requestResolveFiles(tokens) {
      const uniq = [];
      const seen = {};
      tokens.forEach(function (t) {
        if (!seen[t] && !knownFiles.has(t)) { seen[t] = 1; uniq.push(t); }
      });
      if (uniq.length) vscode.postMessage({ type: 'resolveFiles', paths: uniq });
    }

    function linkifyFileMentions(root) {
      if (!root) return;
      const spans = collectCodeFileSpans(root);
      if (!spans.length) return;
      const unknown = [];
      spans.forEach(function (s) {
        if (knownFiles.has(s.token)) applyFileLinkTo(s.el, s.token);
        else unknown.push(s.token);
      });
      requestResolveFiles(unknown);
    }

    function applyKnownFileLinksEverywhere() {
      collectCodeFileSpans(messagesEl).forEach(function (s) {
        if (knownFiles.has(s.token)) applyFileLinkTo(s.el, s.token);
      });
    }

    function openFileLink(el) {
      const p = el && el.getAttribute('data-path');
      if (p) vscode.postMessage({ type: 'openFile', path: p });
    }

    messagesEl.addEventListener('click', function (e) {
      const link = e.target.closest('.file-link');
      if (!link) return;
      e.preventDefault();
      openFileLink(link);
    });
    messagesEl.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const link = e.target.closest('.file-link');
      if (!link) return;
      e.preventDefault();
      openFileLink(link);
    });

    messagesEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.code-editor-copy');
      if (!btn) return;
      const block = btn.closest('.code-editor-block');
      if (!block) return;
      e.preventDefault();
      var raw = '';
      try {
        raw = decodeURIComponent(block.getAttribute('data-code') || '');
      } catch (err) {
        raw = '';
      }
      if (!raw) {
        return;
      }
      if (!navigator.clipboard || !navigator.clipboard.writeText) {
        return;
      }
      navigator.clipboard.writeText(raw).then(function() {
        btn.classList.add('copied');
        btn.setAttribute('title', 'Copied');
        btn.setAttribute('aria-label', 'Copied');
        setTimeout(function() {
          btn.classList.remove('copied');
          btn.setAttribute('title', 'Copy code');
          btn.setAttribute('aria-label', 'Copy code');
        }, 1500);
      }).catch(function() {
        /* clipboard denied */
      });
    });

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

    function distanceFromBottom() {
      return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    }

    function isNearBottom() {
      return distanceFromBottom() <= SCROLL_BOTTOM_THRESHOLD;
    }

    function updateJumpToBottomButton() {
      if (!jumpToBottomBtn) {
        return;
      }
      const show = !stickToBottom && (processing || !!streamingEl);
      jumpToBottomBtn.classList.toggle('hidden', !show);
    }

    function scrollToBottom(force) {
      if (!force && !stickToBottom) {
        return;
      }
      programmaticScroll = true;
      messagesEl.scrollTop = messagesEl.scrollHeight;
      requestAnimationFrame(function() {
        requestAnimationFrame(function() {
          programmaticScroll = false;
          if (force) {
            stickToBottom = true;
          }
          updateJumpToBottomButton();
        });
      });
    }

    function scrollMessageIntoView(el, block, force) {
      if (!el) {
        return;
      }
      if (!force && processing && !stickToBottom) {
        return;
      }
      const align = block || 'start';
      programmaticScroll = true;
      requestAnimationFrame(function() {
        requestAnimationFrame(function() {
          el.scrollIntoView({ block: align, behavior: 'auto' });
          requestAnimationFrame(function() {
            programmaticScroll = false;
            if (force) {
              stickToBottom = true;
            }
            updateJumpToBottomButton();
          });
        });
      });
    }

    messagesEl.addEventListener('scroll', function() {
      if (programmaticScroll) {
        return;
      }
      stickToBottom = isNearBottom();
      updateJumpToBottomButton();
    }, { passive: true });

    if (jumpToBottomBtn) {
      jumpToBottomBtn.addEventListener('click', function() {
        stickToBottom = true;
        scrollToBottom(true);
      });
    }

    function prefersReducedMotion() {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    function bumpStreamRenderGeneration() {
      streamRenderGeneration += 1;
    }

    function removeStreamUi(removeNode) {
      bumpStreamRenderGeneration();
      streamCursorWorking = false;
      clearStreamIdleTimer();
      stopFinishingCycle();
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
      updateJumpToBottomButton();
    }

    function scrollStreamIntoView() {
      if (!streamingEl) {
        return;
      }
      scrollToBottom(false);
    }

    // The end-of-stream marker: a blinking caret while text is flowing, or — when the
    // stream goes quiet but the model is still working (reading files, draining hidden
    // reasoning) — an inline animated "working" chip showing the live phase.
    function streamWorkingLabel() {
      // Real action (reading/writing) shows verbatim; the idle "finishing" tail
      // cycles gentle reassurance to keep the wait engaging.
      if (workPhase === 'Finishing up…') {
        return FINISHING_PHRASES[finishingIdx % FINISHING_PHRASES.length];
      }
      return workPhase || 'Working';
    }

    function makeStreamCursor() {
      if (streamCursorWorking) {
        var chip = document.createElement('span');
        chip.className = 'stream-working';
        chip.innerHTML =
          '<span class="thinking-dots"><span></span><span></span><span></span></span>' +
          '<span class="stream-working-label">' + escapeHtml(streamWorkingLabel()) + '</span>';
        return chip;
      }
      var cursor = document.createElement('span');
      cursor.className = 'stream-cursor';
      cursor.textContent = '▍';
      return cursor;
    }

    function startFinishingCycle() {
      if (finishingTimer) return;
      finishingIdx = 0;
      finishingTimer = setInterval(function () {
        finishingIdx = (finishingIdx + 1) % FINISHING_PHRASES.length;
        if (streamCursorWorking && workPhase === 'Finishing up…') refreshStreamCursor();
        else stopFinishingCycle();
      }, FINISHING_CYCLE_MS);
    }

    function stopFinishingCycle() {
      if (finishingTimer) { clearInterval(finishingTimer); finishingTimer = null; }
    }

    function refreshStreamCursor() {
      if (!streamingBody) return;
      var old = streamingBody.querySelector('.stream-cursor, .stream-working');
      var next = makeStreamCursor();
      if (old) old.replaceWith(next);
      else streamingBody.appendChild(next);
    }

    function setStreamCursorWorking(on) {
      if (!on) stopFinishingCycle();
      if (streamCursorWorking === on) {
        if (on) refreshStreamCursor(); // label may have changed
        return;
      }
      streamCursorWorking = on;
      refreshStreamCursor();
    }

    function morphThinkingToStream() {
      removeStreamUi(false);
      streamCursorWorking = false;
      var div = thinkingEl || document.getElementById('thinking-indicator');
      if (div) {
        thinkingEl = null;
        div.classList.remove('thinking', 'thinking-fade-out');
        div.classList.add('assistant', 'streaming');
        div.removeAttribute('id');
        div.innerHTML = '';
        streamingBody = document.createElement('div');
        streamingBody.className = 'msg-body';
        streamingBody.appendChild(makeStreamCursor());
        div.appendChild(streamingBody);
        streamingEl = div;
      } else {
        removeThinking(true);
        streamingEl = document.createElement('div');
        streamingEl.className = 'msg assistant streaming';
        streamingBody = document.createElement('div');
        streamingBody.className = 'msg-body';
        streamingBody.appendChild(makeStreamCursor());
        streamingEl.appendChild(streamingBody);
        messagesEl.appendChild(streamingEl);
      }
      streamText = '';
      scrollMessageIntoView(streamingEl, 'start', stickToBottom);
    }

    function flushStreamRender() {
      if (!streamingBody) {
        return;
      }
      streamRenderTimer = null;
      var body = streamingBody;
      var text = streamText;
      var gen = streamRenderGeneration;
      var doRender = function() {
        if (gen !== streamRenderGeneration || !streamingBody || body !== streamingBody) {
          return;
        }
        body.innerHTML = formatContent(text, 'assistant');
        body.appendChild(makeStreamCursor());
        bindMessageLinks(body);
        wrapTables(body);
        scrollStreamIntoView();
      };
      if (prefersReducedMotion()) {
        doRender();
      } else {
        requestAnimationFrame(doRender);
      }
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
      setWorkPhase('Generating answer', '');
      setStreamCursorWorking(false);
      armStreamIdleFinishing();
      streamText = content || '';
      scheduleStreamRender();
    }

    function cancelAssistantStream() {
      clearStreamIdleTimer();
      bumpStreamRenderGeneration();
      removeStreamUi(true);
    }

    function finishAssistantStream(content, details) {
      removeThinking(true);
      bumpStreamRenderGeneration();
      streamCursorWorking = false;
      clearStreamIdleTimer();
      stopFinishingCycle();
      if (streamRenderTimer) {
        clearTimeout(streamRenderTimer);
        streamRenderTimer = null;
      }
      if (streamingEl && streamingBody) {
        var el = streamingEl;
        var body = streamingBody;
        el.classList.remove('streaming');
        el.classList.add('msg-enter');
        body.innerHTML = formatContent(content, 'assistant');
        var stray = body.querySelector('.stream-cursor, .stream-working');
        if (stray) {
          stray.remove();
        }
        bindMessageLinks(body);
        wrapTables(body);
        linkifyFileMentions(body);
        buildActivitySummary(el);
        lastActivity = null;
        appendToolDetails(el, details);
        scrollMessageIntoView(el, 'start', stickToBottom);
        streamingEl = null;
        streamingBody = null;
        streamText = '';
        return;
      }
      appendMessage('assistant', content, 'msg-enter', details);
      updateJumpToBottomButton();
    }

    function appendMessage(role, content, extraClass, details, attachments) {
      const div = document.createElement('div');
      div.className = 'msg ' + role + (extraClass ? ' ' + extraClass : '');
      if (attachments && attachments.length) {
        const attWrap = document.createElement('div');
        attWrap.className = 'msg-attachments';
        attachments.forEach(function(a) {
          const item = document.createElement('div');
          item.className = 'msg-attachment';
          if (a.previewUrl) {
            const img = document.createElement('img');
            img.src = a.previewUrl;
            img.alt = a.name;
            item.appendChild(img);
          } else {
            const icon = document.createElement('div');
            icon.className = 'attachment-chip-icon';
            icon.textContent = a.kind === 'pdf' ? 'PDF' : 'TXT';
            item.appendChild(icon);
          }
          const label = document.createElement('div');
          label.className = 'msg-attachment-label';
          label.textContent = a.name;
          label.title = a.name;
          item.appendChild(label);
          attWrap.appendChild(item);
        });
        div.appendChild(attWrap);
      }
      const body = document.createElement('div');
      body.className = 'msg-body';
      if (role === 'error') {
        const label = document.createElement('div');
        label.className = 'role';
        label.textContent = 'Error';
        div.appendChild(label);
      }
      if (content) {
        body.innerHTML = formatContent(content, role);
        bindMessageLinks(body);
        wrapTables(body);
        linkifyFileMentions(body);
        div.appendChild(body);
      }
      if (role === 'assistant') {
        buildActivitySummary(div);
        lastActivity = null;
        appendToolDetails(div, details);
      }
      messagesEl.appendChild(div);
      scrollMessageIntoView(div, role === 'user' ? 'end' : 'start', role === 'user');
      return div;
    }

    function formatElapsed(ms) {
      const s = Math.max(0, Math.round(ms / 1000));
      const m = Math.floor(s / 60);
      const sec = s % 60;
      return m + ':' + (sec < 10 ? '0' : '') + sec;
    }

    const STEP_KIND_RULES = [
      { re: /^(reading all|read matching|reading matching)/i, kind: 'glob' },
      { re: /matching files|files matching/i, kind: 'glob' },
      { re: /^(reading) .*\\bfiles\\b/i, kind: 'read' },
      { re: /^(reading|read) /i, kind: 'read' },
      { re: /^(exploring|explored)/i, kind: 'search' },
      { re: /^(preparing|updated|writing|wrote|file written)/i, kind: 'write' },
      { re: /^(running|ran|started in background)/i, kind: 'run' },
      { re: /^(thinking|understanding|writing your answer|summariz|planning|gathering|verifying|auto-reading|checking)/i, kind: 'think' },
    ];

    function stepKind(text) {
      for (let i = 0; i < STEP_KIND_RULES.length; i++) {
        if (STEP_KIND_RULES[i].re.test(text)) return STEP_KIND_RULES[i].kind;
      }
      return 'dot';
    }

    function cleanStepText(raw) {
      let t = String(raw || '').trim();
      t = t.replace(/^Step\\s+\\d+:\\s*/i, '');
      t = t.replace(/\\s*—\\s*done\\s*$/i, '');
      t = t.replace(/…+$/, '').trim();
      return t;
    }

    // Escape, then monospace any inline \`code\` and trailing file paths / globs.
    function highlightStepPath(text) {
      let esc = escapeHtml(text);
      esc = esc.replace(/\`([^\`]+)\`/g, '<span class="step-path">$1</span>');
      esc = esc.replace(
        /(^|[\\s(])((?:[\\w.\\-]+\\/)*[\\w.\\-]+\\.[\\w]+|\\*\\*\\/[\\w*.\\/\\-]+|[\\w\\-]+\\/\\*\\*)(?=$|[\\s,.)])/g,
        function (m, pre, p) { return pre + '<span class="step-path">' + p + '</span>'; }
      );
      return esc;
    }

    function formatStep(raw) {
      const text = cleanStepText(raw);
      return { kind: stepKind(text), text: text, html: highlightStepPath(text) };
    }

    // Collapse consecutive identical steps into one entry with a ×count.
    function dedupeSteps(rawList) {
      const out = [];
      (rawList || []).forEach(function (raw) {
        const f = formatStep(raw);
        if (!f.text) return;
        const last = out[out.length - 1];
        if (last && last.text === f.text) { last.count++; }
        else { out.push({ kind: f.kind, text: f.text, html: f.html, count: 1 }); }
      });
      return out;
    }

    function stepIcon(kind) {
      const paths = {
        think: '<path d="M8 1.8l1.3 4.9 4.9 1.3-4.9 1.3L8 14.2 6.7 9.3 1.8 8l4.9-1.3z"/>',
        search: '<circle cx="7" cy="7" r="4.3"/><line x1="10.2" y1="10.2" x2="14" y2="14"/>',
        read: '<path d="M4 1.7h5l3.3 3.3v9H4z"/><path d="M9 1.7V5h3.3"/>',
        glob: '<path d="M5.5 3.2h4.2l2.8 2.8v6.3H5.5z"/><path d="M3.2 5.2v7.6h6"/>',
        write: '<path d="M2.2 11.6l7.2-7.2 2.2 2.2-7.2 7.2H2.2z"/><path d="M8.6 3l2.2 2.2"/>',
        run: '<rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1.6"/><path d="M4.3 6.2l2.4 1.9-2.4 1.9"/><line x1="7.8" y1="10.3" x2="10.8" y2="10.3"/>',
        check: '<path d="M3 8.4l3 3 7-7"/>',
        dot: '<circle cx="8" cy="8" r="2.4"/>'
      };
      const inner = paths[kind] || paths.dot;
      return '<svg class="step-icon step-icon-' + kind + '" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
    }

    function stepListHtml(steps) {
      let html = '<ul class="activity-steps">';
      steps.forEach(function (s) {
        html += '<li class="activity-step">' + stepIcon(s.kind) +
          '<span class="activity-step-text">' + s.html +
          (s.count > 1 ? ' <span class="activity-step-count">×' + s.count + '</span>' : '') +
          '</span></li>';
      });
      html += '</ul>';
      return html;
    }

    function renderProcessHtml(completed, current, thought) {
      const steps = dedupeSteps(completed);
      // Stash the latest activity so a summary can be shown on the finished message.
      lastActivity = { steps: steps, startedAt: workStartedAt };
      const cur = formatStep(current || 'Thinking…');
      const elapsed = workStartedAt ? formatElapsed(Date.now() - workStartedAt) : '';
      let html =
        '<div class="activity-header">' +
        '<span class="activity-cur-icon">' + stepIcon(cur.kind) + '</span>' +
        '<span class="activity-cur-label">' + (cur.html || 'Thinking…') + '</span>' +
        '<span class="thinking-dots"><span></span><span></span><span></span></span>' +
        '<span class="activity-elapsed"' + (elapsed ? '' : ' style="display:none"') + '>' + elapsed + '</span>' +
        '</div>';
      if (steps.length) {
        html +=
          '<details class="activity-collapse">' +
          '<summary class="activity-toggle"><span class="activity-chevron"></span>' +
          steps.length + ' step' + (steps.length === 1 ? '' : 's') + '</summary>' +
          stepListHtml(steps) +
          '</details>';
      }
      if (thought) {
        html += '<div class="thinking-thought">' + escapeHtml(thought) + '</div>';
      }
      return html;
    }

    function wireActivityToggle(root) {
      const det = root.querySelector('.activity-collapse');
      if (!det) return;
      const count = det.querySelectorAll('.activity-step').length;
      det.open = activityExpanded === null ? count <= 3 : activityExpanded;
      det.addEventListener('toggle', function () { activityExpanded = det.open; });
    }

    function formatBytes(n) {
      if (!n || n < 0) return '';
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      return (n / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function toolProgressLabel(name) {
      switch (name) {
        case 'propose_write_file': return 'Writing file';
        case 'run_command': return 'Preparing command';
        case 'read_file':
        case 'read_glob':
        case 'list_files': return 'Reading workspace';
        default: return 'Working';
      }
    }

    // One request-level heartbeat: keeps the composer timer and the inline
    // thinking timer ticking continuously, even through silent stretches.
    function workHeartbeat() {
      renderWorkStatus();
      if (thinkingEl && workStartedAt) {
        const el = thinkingEl.querySelector('.activity-elapsed');
        if (el) {
          el.textContent = formatElapsed(Date.now() - workStartedAt);
          el.style.display = '';
        }
      }
    }

    function renderWorkStatus() {
      if (!workStatusEl || !working) return;
      const txt = workStatusEl.querySelector('.work-text');
      const tm = workStatusEl.querySelector('.work-time');
      if (txt) txt.textContent = (workPhase || 'Working…') + (workDetail ? ' · ' + workDetail : '');
      if (tm) tm.textContent = workStartedAt ? formatElapsed(Date.now() - workStartedAt) : '';
    }

    function startWork() {
      if (!working) {
        working = true;
        workStartedAt = Date.now();
        activityExpanded = null;
        workPhase = '';
        workDetail = '';
      }
      if (composerFooterEl) composerFooterEl.classList.add('working');
      if (!workTimerId) workTimerId = setInterval(workHeartbeat, 1000);
      renderWorkStatus();
    }

    function stopWork() {
      working = false;
      clearStreamIdleTimer();
      stopFinishingCycle();
      if (workTimerId) { clearInterval(workTimerId); workTimerId = null; }
      if (composerFooterEl) composerFooterEl.classList.remove('working');
    }

    function setWorkPhase(phase, detail) {
      if (!working) return;
      if (phase != null) workPhase = phase;
      workDetail = detail != null ? detail : '';
      if (workPhase !== 'Finishing up…') stopFinishingCycle();
      renderWorkStatus();
      if (streamCursorWorking) refreshStreamCursor();
    }

    function clearStreamIdleTimer() {
      if (streamIdleTimer) { clearTimeout(streamIdleTimer); streamIdleTimer = null; }
    }

    // The visible answer streams as the model's final channel; some models
    // (e.g. owl-alpha) keep emitting hidden reasoning afterwards, which we strip.
    // When visible output goes quiet but the request is still open, say "Finishing up..."
    // rather than leaving "Generating answer" - honest, and never truncates the model.
    function armStreamIdleFinishing() {
      clearStreamIdleTimer();
      streamIdleTimer = setTimeout(function () {
        streamIdleTimer = null;
        if (!(working && streamingEl)) return;
        // Only relabel the composer when we were streaming the answer (final tail).
        // Tool phases ("Reading workspace" / "Writing file") must stay as-is.
        if (workPhase === 'Generating answer') setWorkPhase('Finishing up…', '');
        setStreamCursorWorking(true);
        if (workPhase === 'Finishing up…') startFinishingCycle();
      }, STREAM_IDLE_FINISHING_MS);
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
      wireActivityToggle(thinkingEl);
      messagesEl.appendChild(thinkingEl);
      scrollMessageIntoView(thinkingEl, 'end', stickToBottom);
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
        wireActivityToggle(thinkingEl);
      }
      scrollMessageIntoView(thinkingEl, 'end', stickToBottom);
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

    // Slim "Worked for Xs · N steps" collapsible, prepended to a finished assistant message.
    function buildActivitySummary(parent) {
      if (!lastActivity || !lastActivity.steps || !lastActivity.steps.length) return;
      const steps = lastActivity.steps;
      const elapsed = lastActivity.startedAt ? formatElapsed(Date.now() - lastActivity.startedAt) : '';
      const det = document.createElement('details');
      det.className = 'activity-summary';
      const sum = document.createElement('summary');
      sum.innerHTML = stepIcon('check') +
        '<span class="activity-summary-label">Worked' + (elapsed ? ' for ' + elapsed : '') +
        ' · ' + steps.length + ' step' + (steps.length === 1 ? '' : 's') + '</span>' +
        '<span class="activity-chevron"></span>';
      det.appendChild(sum);
      const wrap = document.createElement('div');
      wrap.innerHTML = stepListHtml(steps);
      const ul = wrap.firstChild;
      if (ul) det.appendChild(ul);
      parent.insertBefore(det, parent.firstChild);
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

    function updateModelPricing(msg) {
      if (!modelPricingEl) return;
      var compactEl = modelPricingEl.querySelector('.model-pricing-compact');
      var fullEl = modelPricingEl.querySelector('.model-pricing-full');
      if (msg.hidden) {
        modelPricingEl.classList.add('hidden');
        if (compactEl) compactEl.textContent = '';
        if (fullEl) fullEl.textContent = '';
        return;
      }
      modelPricingEl.classList.remove('hidden');
      modelPricingEl.title = msg.title || msg.line || 'Pricing from OpenRouter catalog';
      if (compactEl) {
        compactEl.textContent = msg.compact || '';
      }
      if (!fullEl) return;
      fullEl.textContent = '';
      var segs = msg.segments || [];
      if (!segs.length && msg.line) {
        fullEl.textContent = msg.line;
        return;
      }
      segs.forEach(function(seg) {
        var span = document.createElement('span');
        span.textContent = seg.text || '';
        if (seg.teal) {
          span.className = 'model-pricing-value';
        } else if (seg.text === ' | ') {
          span.className = 'model-pricing-sep';
        } else {
          span.className = 'model-pricing-muted';
        }
        fullEl.appendChild(span);
      });
    }

    function applyModelState(state) {
      if (state.catalog) {
        modelDropdown.setCatalog(state.catalog);
      }
      modelDropdown.applyState(state);
    }

    function updateModelCapability(msg) {
      if (!modelCapabilityHintEl) return;
      if (msg.visible && msg.message) {
        modelCapabilityHintEl.textContent = msg.message;
        modelCapabilityHintEl.classList.remove('hidden');
      } else {
        modelCapabilityHintEl.textContent = '';
        modelCapabilityHintEl.classList.add('hidden');
      }
    }

    function updateAccountBalance(msg) {
      if (!accountBalanceEl) return;
      if (!msg.visible || !msg.label) {
        accountBalanceEl.innerHTML = '';
        accountBalanceEl.title = '';
        accountBalanceEl.classList.add('hidden');
        accountBalanceEl.classList.remove('positive', 'zero');
        return;
      }
      accountBalanceEl.innerHTML = '';
      var fullEl = document.createElement('span');
      fullEl.className = 'balance-full';
      fullEl.textContent = msg.label;
      var shortEl = document.createElement('span');
      shortEl.className = 'balance-short';
      shortEl.textContent = msg.shortLabel || msg.label;
      accountBalanceEl.appendChild(fullEl);
      accountBalanceEl.appendChild(shortEl);
      accountBalanceEl.title = msg.title || msg.label;
      accountBalanceEl.classList.remove('hidden');
      accountBalanceEl.classList.toggle('positive', !msg.isZero);
      accountBalanceEl.classList.toggle('zero', !!msg.isZero);
    }

    function renderPendingAttachments() {
      if (!attachmentBar) return;
      attachmentBar.innerHTML = '';
      pendingAttachments.forEach(function(a) {
        var chip = document.createElement('div');
        chip.className = 'attachment-chip';
        if (a.previewUrl) {
          var img = document.createElement('img');
          img.src = a.previewUrl;
          img.alt = a.name;
          chip.appendChild(img);
        } else {
          var icon = document.createElement('span');
          icon.className = 'attachment-chip-icon';
          icon.textContent = a.kind === 'pdf' ? 'PDF' : a.kind === 'image' ? 'IMG' : 'TXT';
          chip.appendChild(icon);
        }
        var name = document.createElement('span');
        name.className = 'attachment-chip-name';
        name.textContent = a.name;
        name.title = a.name;
        chip.appendChild(name);
        var rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'attachment-chip-remove';
        rm.textContent = '×';
        rm.title = 'Remove';
        rm.addEventListener('click', function(e) {
          e.stopPropagation();
          vscode.postMessage({ type: 'removeAttachment', id: a.id });
        });
        chip.appendChild(rm);
        attachmentBar.appendChild(chip);
      });
    }

    function clipMimeToExt(mime) {
      if (mime === 'image/png') return 'png';
      if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
      if (mime === 'image/webp') return 'webp';
      if (mime === 'image/gif') return 'gif';
      if (mime === 'application/pdf') return 'pdf';
      return 'png';
    }

    function screenshotFilename(mime) {
      var d = new Date();
      var pad = function(n) { return String(n).padStart(2, '0'); };
      var stamp =
        d.getFullYear() +
        pad(d.getMonth() + 1) +
        pad(d.getDate()) +
        '-' +
        pad(d.getHours()) +
        pad(d.getMinutes()) +
        pad(d.getSeconds());
      return 'Screenshot-' + stamp + '.' + clipMimeToExt(mime);
    }

    function needsPastedFilename(name) {
      if (!name) return true;
      var lower = name.toLowerCase();
      return lower === 'image.png' || lower === 'blob' || lower === 'image.jpg' || lower === 'image.jpeg';
    }

    function addFilesFromList(fileList) {
      var files = Array.from(fileList || []);
      if (!files.length) return;
      var pending = [];
      var done = 0;
      files.forEach(function(file) {
        var reader = new FileReader();
        reader.onload = function() {
          pending.push({
            name: file.name,
            mimeType: file.type || 'application/octet-stream',
            base64: String(reader.result || '')
          });
          done++;
          if (done === files.length) {
            vscode.postMessage({ type: 'addAttachments', files: pending });
          }
        };
        reader.onerror = function() {
          done++;
          if (done === files.length && pending.length) {
            vscode.postMessage({ type: 'addAttachments', files: pending });
          }
        };
        reader.readAsDataURL(file);
      });
    }

    function readFilesAsPayload(fileList) {
      addFilesFromList(fileList);
    }

    function handlePasteAttachments(e) {
      if (processing || approvalPending) return;
      var cd = e.clipboardData;
      if (!cd || !cd.items) return;
      var attachable = [];
      for (var i = 0; i < cd.items.length; i++) {
        var item = cd.items[i];
        if (item.kind !== 'file') continue;
        var mime = item.type || '';
        if (mime.indexOf('image/') !== 0 && mime !== 'application/pdf') continue;
        var raw = item.getAsFile();
        if (!raw) continue;
        var name = needsPastedFilename(raw.name) ? screenshotFilename(mime) : raw.name;
        attachable.push(new File([raw], name, { type: mime || raw.type }));
      }
      if (!attachable.length) return;
      e.preventDefault();
      addFilesFromList(attachable);
    }

    if (attachBtn) {
      attachBtn.addEventListener('click', function() {
        if (processing || approvalPending) return;
        vscode.postMessage({ type: 'pickAttachments' });
      });
    }

    if (composerEl) {
      composerEl.addEventListener('dragover', function(e) {
        e.preventDefault();
        composerEl.classList.add('drag-over');
      });
      composerEl.addEventListener('dragleave', function() {
        composerEl.classList.remove('drag-over');
      });
      composerEl.addEventListener('drop', function(e) {
        e.preventDefault();
        composerEl.classList.remove('drag-over');
        if (processing || approvalPending) return;
        readFilesAsPayload(e.dataTransfer && e.dataTransfer.files);
      });
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
      if (composerEl) {
        composerEl.classList.toggle('composer-busy', loading);
      }
      inputEl.disabled = loading || approvalPending;
      if (attachBtn) attachBtn.disabled = loading || approvalPending;
      modeDropdown.setDisabled(loading || approvalPending);
      modelDropdown.setDisabled(loading || approvalPending);
      sessionDropdown.setDisabled(loading || approvalPending);
      newSessionBtn.disabled = loading || approvalPending;
      deleteSessionBtn.disabled = loading || approvalPending;
      clearBtn.disabled = loading || approvalPending;
      updateSendButton();
      if (loading) {
        startWork();
        const phaseRaw = (process && process.current) || label || '';
        if (phaseRaw) setWorkPhase(cleanStepText(phaseRaw), '');
        if (streamingEl) {
          updateJumpToBottomButton();
          return;
        }
        if (thinkingEl) {
          updateThinking(label, process);
        } else {
          showThinking(label, process);
        }
      } else {
        stopWork();
        removeThinking(false);
      }
      updateJumpToBottomButton();
    }

    function send() {
      const text = inputEl.value.trim();
      if ((!text && !pendingAttachments.length) || processing) return;
      stickToBottom = true;
      const modelId = getSelectedModelId();
      vscode.postMessage({
        type: 'send',
        text,
        mode: modeDropdown.getValue(),
        modelId
      });
      inputEl.value = '';
      pendingAttachments = [];
      renderPendingAttachments();
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
    inputEl.addEventListener('paste', handlePasteAttachments);

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'init':
          messagesEl.innerHTML = '';
          removeThinking(true);
          applyChatFontSize(msg.chatFontSize || 0);
          modeDropdown.setValue(msg.mode || 'ask');
          applyModelState(msg);
          populateSessions(msg.sessions, msg.activeSessionId);
          pendingAttachments = msg.pendingAttachments || [];
          renderPendingAttachments();
          (msg.history || []).forEach(function(m, i) {
            var atts = (msg.historyAttachments && msg.historyAttachments[i]) || m.attachments || [];
            appendMessage(m.role, m.content, '', m.details, atts);
          });
          setLoading(!!msg.processing, msg.label);
          break;
        case 'attachmentsUpdated':
          pendingAttachments = msg.pending || [];
          renderPendingAttachments();
          break;
        case 'sessions':
          populateSessions(msg.sessions, msg.activeSessionId);
          break;
        case 'models':
          applyModelState(msg);
          break;
        case 'modelCatalog':
          applyModelState(msg);
          break;
        case 'modelCapability':
          updateModelCapability(msg);
          break;
        case 'modelPricing':
          updateModelPricing(msg);
          break;
        case 'accountBalance':
          updateAccountBalance(msg);
          break;
        case 'userMessage':
          stickToBottom = true;
          appendMessage('user', msg.content, '', undefined, msg.attachments || []);
          break;
        case 'assistantStreamStart':
          morphThinkingToStream();
          setWorkPhase('Generating answer', '');
          updateJumpToBottomButton();
          break;
        case 'assistantPartial':
          updateAssistantPartial(msg.content);
          break;
        case 'toolProgress':
          setWorkPhase(toolProgressLabel(msg.name), formatBytes(msg.bytes));
          if (streamingEl) setStreamCursorWorking(true);
          break;
        case 'filesResolved':
          (msg.files || []).forEach(function (f) {
            if (f && f.input && f.path) knownFiles.set(f.input, f.path);
          });
          applyKnownFileLinksEverywhere();
          break;
        case 'assistantStreamCancel':
          cancelAssistantStream();
          updateJumpToBottomButton();
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
          stickToBottom = true;
          updateJumpToBottomButton();
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

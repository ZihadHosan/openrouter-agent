import * as vscode from 'vscode';
import {
  buildUserMessageContent,
  ResolvedAttachment,
} from './attachments';
import { ChatMessage } from './openrouter';
import { getContextCache } from './contextCache';

export type AgentMode = 'ask' | 'plan' | 'agent';

export type { ResolvedAttachment };

export interface ReasoningStep {
  type: 'reasoning' | 'self-critique' | 'chain-of-thought';
  content: string;
}

const MAX_FILE_CHARS = 12000;

export interface PromptContext {
  workspaceName: string;
  activeFilePath: string;
  selectedText: string;
  fileContent: string;
  /** True when context gathering hit the time limit. */
  incomplete?: boolean;
}

const CONTEXT_GATHER_TIMEOUT_MS = 1500;

/**
 * Generate a cache key based on context-relevant state
 */
function generateContextKey(): string {
  const editor = vscode.window.activeTextEditor;
  const document = editor?.document;
  const keyParts: string[] = [];

  // Include workspace count (changes when folders added/removed)
  keyParts.push(`ws:${vscode.workspace.workspaceFolders?.length ?? 0}`);

  // Include active editor info
  if (document) {
    keyParts.push(`doc:${document.uri.fsPath}`);
    keyParts.push(`ver:${document.version}`);
  }

  // Include selection info
  const selection = editor?.selection;
  if (selection && !selection.isEmpty) {
    keyParts.push(`sel:${selection.start.line}:${selection.start.character}:${selection.end.line}:${selection.end.character}`);
  }

  return keyParts.join('|');
}

function gatherContextSync(): PromptContext {
  const folders = vscode.workspace.workspaceFolders;
  const workspaceName = folders?.[0]?.name ?? '(no workspace)';

  const editor = vscode.window.activeTextEditor;
  const activeFilePath = editor?.document.uri.fsPath ?? '';
  const selection = editor?.selection;
  const selectedText =
    selection && !selection.isEmpty
      ? editor!.document.getText(selection)
      : '';

  let fileContent = '';
  if (editor && !selectedText) {
    // Parallelize: read file content in background while collecting other info
    fileContent = editor.document.getText();
    fileContent = truncateContent(fileContent, MAX_FILE_CHARS);
  }

  return { workspaceName, activeFilePath, selectedText, fileContent };
}

/**
 * Prefetch common context data in parallel
 * Returns a promise that resolves when prefetching is complete
 */
export async function prefetchContext(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  // Prefetch file content for the active editor (triggers internal caching)
  void editor.document.getText();

  // Prefetch workspace folder info (triggers internal caching)
  void vscode.workspace.workspaceFolders;

  // Small delay to allow the editor to finish rendering
  await new Promise((resolve) => setTimeout(resolve, 50));
}

export async function gatherContext(): Promise<PromptContext> {
  const timeoutMs = vscode.workspace
    .getConfiguration('openrouterAgent')
    .get<number>('contextGatherTimeoutMs', CONTEXT_GATHER_TIMEOUT_MS);

  // Try to get cached context first
  const cache = getContextCache();
  const cacheKey = generateContextKey();
  const cached = cache.get(cacheKey);
  if (cached) {
    // Convert CachedContext to PromptContext (exclude timestamp)
    const { timestamp, fileVersion, ...promptContext } = cached;
    return promptContext;
  }

  try {
    const context = await Promise.race([
      Promise.resolve(gatherContextSync()),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('__CONTEXT_TIMEOUT__')), Math.max(timeoutMs, 500));
      }),
    ]);

    // Cache the result
    cache.set(cacheKey, { ...context, timestamp: Date.now() });
    return context;
  } catch (err) {
    // Try to use cached context even if gathering failed (stale but better than nothing)
    const cached = cache.get(cacheKey);
    if (cached) {
      // Convert CachedContext to PromptContext (exclude timestamp)
      const { timestamp, fileVersion, ...promptContext } = cached;
      return promptContext;
    }

    if (err instanceof Error && err.message === '__CONTEXT_TIMEOUT__') {
      const folders = vscode.workspace.workspaceFolders;
      return {
        workspaceName: folders?.[0]?.name ?? '(no workspace)',
        activeFilePath: '',
        selectedText: '',
        fileContent: '',
        incomplete: true,
      };
    }
    throw err;
  }
}

function truncateContent(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const half = Math.floor(max / 2);
  return (
    text.slice(0, half) +
    '\n\n... [truncated] ...\n\n' +
    text.slice(text.length - half)
  );
}

const MARKDOWN_FORMAT = `
FORMATTING:
- Use markdown for replies (headings, bullet/numbered lists, tables when helpful).
- Do NOT wrap your entire reply in one code fence (\`\`\`); only fence real code snippets.
- Write normal prose outside code blocks so it renders as readable chat text.
- For tables, always include a header row and a separator row (| --- | --- |) before data rows.
- Never output special delimiter tokens (e.g. <|channel|>, <|message|>, <|start|>, <|end|>). Reply with plain markdown only.`;

const ATTACHMENT_SYSTEM = `

ATTACHED FILES (this message):
- The user attached file(s) with FULL CONTENT already included in their message below the [ATTACHED FILES] header.
- Analyze, summarize, or answer questions about that content DIRECTLY — do not ask which file they mean.
- Do NOT call read_file, list_files, or read_glob for attached filenames unless the user explicitly asks to compare with workspace copies or read other paths.
- Never show raw tool JSON (e.g. \`\`\`agent-tool or {"tool":"read_file"...}) in your reply to the user.`;

const ASK_SYSTEM = `You are a helpful coding assistant in VS Code ASK MODE.

You can read ANY file in the workspace automatically (read-only). Use tools to list or read files when the user asks about them.

Preferred tool format:

\`\`\`agent-tool
{"tool":"read_file","path":"README.md"}
\`\`\`

Tools (read-only, run immediately in Ask mode):
- read_file — one file: {"tool":"read_file","path":"path/to/file.md"} (several read_file blocks in one message are OK)
- list_files — find paths: {"tool":"list_files","pattern":"**/*.md","maxResults":200}
- read_glob — read many files at once: {"tool":"read_glob","pattern":"**/*.md","maxFiles":30}

Put any explanation BEFORE tool blocks, not inside them. Tool JSON must not appear in streamed chat text.

TOOL FORMAT:
- If your API supports native function/tool calling, call the tools directly (read_file, list_files, read_glob) — that is preferred.
- Otherwise, emit text \`\`\`agent-tool\`\`\` JSON blocks.
- Multiple read-only tools per message are supported (they run in parallel).
- Never output "Response interrupted by a tool use result" or similar meta messages.
- You CAN read the workspace via tools; workspace root is in context. Never say you cannot access project files without calling read_file, list_files, or read_glob first.

IMPORTANT glob rules:
- Use "**/*.md" to match markdown in ALL subfolders. NEVER use "*.md" alone (root only).
- To read all markdown files, use read_glob with pattern "**/*.md".

STRICT FILE RULES:
- NEVER say a file exists or does not exist without a successful tool result in this turn.
- If unsure, call list_files or read_glob first.

Do NOT use write or terminal tools in Ask mode; tell the user to switch to Agent mode for those.${MARKDOWN_FORMAT}`;

const PLAN_SYSTEM = `You are a planning assistant in VS Code PLAN MODE.

STRICT RULES:
- Do NOT edit files, run commands, or claim you made changes.
- Produce a clear step-by-step plan only.
- Mention likely files to change.
- Mention risks and commands the user should run manually.
- Be practical and ordered.${MARKDOWN_FORMAT}`;

const AGENT_SYSTEM = `You are a cautious local coding agent in VS Code AGENT MODE.

STRICT RULES:
- Never claim you modified files or ran commands unless the user confirmed an action.
- Explain what you want to do BEFORE requesting write or run actions.
- File access is limited to the workspace.

AVAILABLE TOOLS — call them via native function/tool calling when your API supports it (preferred). Otherwise use exactly this text format (no XML, no other tags):

\`\`\`agent-tool
{"tool":"read_file","path":"relative/path.md"}
\`\`\`

Tools:
1. list_files — {"tool":"list_files","pattern":"**/*","maxResults":200}
2. read_file — {"tool":"read_file","path":"path/to/file"}
3. read_glob — {"tool":"read_glob","pattern":"**/*.md","maxFiles":30}  (list + read many files; use **/ for subfolders)
4. propose_write_file — {"tool":"propose_write_file","path":"path","content":"full file text"}
5. run_command — {"tool":"run_command","command":"npm test","cwd":"optional/subfolder","background":false}

REASONING STEPS (optional, but recommended for complex tasks):
- Before tool calls, you may add reasoning steps to think through the problem:
  1. chain-of-thought: Break down the problem into steps
  2. self-critique: Review your plan and identify potential issues
- Format: Start with "THOUGHT:" followed by your reasoning
- After reasoning, proceed with tool calls as normal

Rules:
- Use "**/*.md" not "*.md" when searching subfolders.
- NEVER claim a file exists or is missing without tool JSON proof.
- Commands run in the chat terminal. Short commands wait for completion and show Success or Failed.
- Long-running commands (npm run dev, npm start, watch, serve) auto-run in background unless "background":false.
- Use "background":true explicitly for dev servers; initial output is captured then the process keeps running.
- Use \`\`\`agent-tool JSON blocks (no XML like <tool_call>).
- Put any explanation BEFORE the tool blocks, not inside them.
- For reading multiple files, you may emit several read_file blocks in one message (they run in parallel).
- Do NOT combine read_file with write or run_command in the same message — one write/command per turn.
- Prefer native function/tool calling when your API supports it; otherwise use \`\`\`agent-tool\`\`\` JSON blocks (no XML like <tool_call>). Never output "Response interrupted" meta messages.
- You CAN read the workspace via tools; workspace root is in context. Never claim you cannot access files without calling read_file, list_files, or read_glob first.
- After list_files/read_file you will receive JSON results; then continue or answer the user.${MARKDOWN_FORMAT}`;

export function buildPrompt(
  mode: AgentMode,
  userText: string,
  context: PromptContext,
  attachments: ResolvedAttachment[] = []
): ChatMessage[] {
  const baseSystem =
    mode === 'plan' ? PLAN_SYSTEM : mode === 'agent' ? AGENT_SYSTEM : ASK_SYSTEM;
  const systemContent =
    attachments.length > 0 ? baseSystem + ATTACHMENT_SYSTEM : baseSystem;

  const contextBlock = buildContextBlock(context);
  const userContent = buildUserMessageContent(userText, attachments, contextBlock || null);

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ];
}

function buildContextBlock(ctx: PromptContext): string {
  const parts: string[] = [];
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  parts.push(`- Workspace: ${ctx.workspaceName}`);
  if (ctx.incomplete) {
    parts.push('- Note: Editor context was limited (timeout); use tools to read files if needed.');
  }
  if (root) {
    parts.push(`- Workspace root: ${root}`);
  }
  if (ctx.activeFilePath) {
    parts.push(`- Active file: ${ctx.activeFilePath}`);
  }
  if (ctx.selectedText) {
    parts.push(`- Selected text:\n\`\`\`\n${ctx.selectedText}\n\`\`\``);
  } else if (ctx.fileContent) {
    parts.push(`- Current file content (truncated):\n\`\`\`\n${ctx.fileContent}\n\`\`\``);
  }
  return parts.join('\n');
}

export function buildMessagesWithHistory(
  mode: AgentMode,
  userText: string,
  context: PromptContext,
  history: ChatMessage[],
  attachments: ResolvedAttachment[] = []
): ChatMessage[] {
  const base = buildPrompt(mode, userText, context, attachments);
  if (history.length === 0) {
    return base;
  }
  const system = base[0];
  const rest = history.filter((m) => m.role !== 'system');
  return [system, ...rest, base[1]];
}

/** Build API history from stored session messages (text-only assistant; user may be multimodal). */
export function sessionMessageToApiMessage(
  m: { role: 'user' | 'assistant'; content: string },
  resolvedAttachments: ResolvedAttachment[]
): ChatMessage {
  if (m.role === 'assistant' || resolvedAttachments.length === 0) {
    return { role: m.role, content: m.content };
  }
  const content = buildUserMessageContent(m.content, resolvedAttachments, null);
  return { role: 'user', content };
}

/**
 * Extract reasoning steps from assistant message content
 */
export function extractReasoningSteps(content: string): ReasoningStep[] {
  const steps: ReasoningStep[] = [];
  
  // Pattern to match "THOUGHT:" sections
  const thoughtPattern = /THOUGHT:\s*([\s\S]*?)(?=(\nTHOUGHT:|\n\`\`\`agent-tool|^$))/gi;
  let match;
  
  while ((match = thoughtPattern.exec(content)) !== null) {
    const thoughtContent = match[1].trim();
    
    // Determine the type of reasoning
    let type: ReasoningStep['type'] = 'reasoning';
    const lower = thoughtContent.toLowerCase();
    
    if (lower.includes('self-critique') || lower.includes('review') || lower.includes('critique')) {
      type = 'self-critique';
    } else if (lower.includes('chain') || lower.includes('step') || lower.includes('breakdown')) {
      type = 'chain-of-thought';
    }
    
    steps.push({ type, content: thoughtContent });
  }
  
  return steps;
}

/**
 * Pre-filter tools based on user intent and mode
 * Returns a list of tool names that are relevant to the user's request
 */
export function preFilterToolsBasedOnIntent(
  userText: string,
  mode: AgentMode
): string[] {
  const text = userText.toLowerCase();
  const allowedTools = new Set<string>();

  // Read-only tools (allowed in all modes)
  if (mode !== 'plan') {
    allowedTools.add('read_file');
    allowedTools.add('list_files');
    allowedTools.add('read_glob');
  }

  // Mode-specific tools
  if (mode === 'agent') {
    allowedTools.add('propose_write_file');
    allowedTools.add('run_command');
  }

  // Based on user intent patterns in the text
  if (/\b(read|show|list|find|get|summarize)\b/i.test(text)) {
    // User wants to read/list files
    allowedTools.delete('propose_write_file');
    allowedTools.delete('run_command');
  }

  if (/\b(create|write|edit|update|modify|add|change)\b/i.test(text)) {
    // User wants to create/modify files - only Agent mode
    if (mode === 'agent') {
      allowedTools.add('propose_write_file');
    } else {
      allowedTools.delete('read_file');
      allowedTools.delete('list_files');
      allowedTools.delete('read_glob');
    }
  }

  if (/\b(run|execute|build|test|start|server|command)\b/i.test(text)) {
    // User wants to run commands - only Agent mode
    if (mode === 'agent') {
      allowedTools.add('run_command');
    } else {
      allowedTools.clear();
    }
  }

  if (/\b(debug|fix|error|bug)\b/i.test(text)) {
    // User wants to debug/fix - prefer read tools
    allowedTools.clear();
    allowedTools.add('read_file');
    if (mode === 'agent') {
      allowedTools.add('propose_write_file');
      allowedTools.add('run_command');
    }
  }

  // If no specific intent found, use defaults based on mode
  if (allowedTools.size === 0) {
    if (mode === 'ask') {
      allowedTools.add('read_file');
      allowedTools.add('list_files');
      allowedTools.add('read_glob');
    } else if (mode === 'agent') {
      allowedTools.add('read_file');
      allowedTools.add('list_files');
      allowedTools.add('read_glob');
      allowedTools.add('propose_write_file');
      allowedTools.add('run_command');
    }
  }

  return Array.from(allowedTools);
}

/**
 * Build a hint string about available tools based on pre-filtering
 */
export function buildToolHint(allowedTools: string[]): string {
  if (allowedTools.length === 0) {
    return '';
  }

  const toolNames: Record<string, string> = {
    read_file: 'read_file (single file)',
    list_files: 'list_files (find paths)',
    read_glob: 'read_glob (many files)',
    propose_write_file: 'propose_write_file',
    run_command: 'run_command',
  };

  const names = allowedTools
    .map((t) => toolNames[t])
    .filter(Boolean)
    .join(', ');

  return `Available tools (based on your request): ${names}`;
}

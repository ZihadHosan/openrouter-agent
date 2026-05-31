import * as vscode from 'vscode';
import { ChatMessage } from './openrouter';

export type AgentMode = 'ask' | 'plan' | 'agent';

const MAX_FILE_CHARS = 12000;

export interface PromptContext {
  workspaceName: string;
  activeFilePath: string;
  selectedText: string;
  fileContent: string;
}

export async function gatherContext(): Promise<PromptContext> {
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
    const full = editor.document.getText();
    fileContent = truncateContent(full, MAX_FILE_CHARS);
  }

  return { workspaceName, activeFilePath, selectedText, fileContent };
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
- For tables, always include a header row and a separator row (| --- | --- |) before data rows.`;

const ASK_SYSTEM = `You are a helpful coding assistant in VS Code ASK MODE.

You can read ANY file in the workspace automatically (read-only). Use tools to list or read files when the user asks about them.

Preferred tool format:

\`\`\`agent-tool
{"tool":"read_file","path":"README.md"}
\`\`\`

Tools (read-only, run immediately in Ask mode):
- read_file — one file: {"tool":"read_file","path":"path/to/file.md"}
- list_files — find paths: {"tool":"list_files","pattern":"**/*.md","maxResults":200}
- read_glob — read many files at once: {"tool":"read_glob","pattern":"**/*.md","maxFiles":30}

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

AVAILABLE TOOLS — you MUST use exactly this format (no XML, no other tags):

\`\`\`agent-tool
{"tool":"read_file","path":"relative/path.md"}
\`\`\`

Tools:
1. list_files — {"tool":"list_files","pattern":"**/*","maxResults":200}
2. read_file — {"tool":"read_file","path":"path/to/file"}
3. read_glob — {"tool":"read_glob","pattern":"**/*.md","maxFiles":30}  (list + read many files; use **/ for subfolders)
4. propose_write_file — {"tool":"propose_write_file","path":"path","content":"full file text"}
5. run_command — {"tool":"run_command","command":"npm test","cwd":"optional/subfolder","background":false}

Rules:
- Use "**/*.md" not "*.md" when searching subfolders.
- NEVER claim a file exists or is missing without tool JSON proof.
- Commands run in the chat terminal. Short commands wait for completion and show Success or Failed.
- Long-running commands (npm run dev, npm start, watch, serve) auto-run in background unless "background":false.
- Use "background":true explicitly for dev servers; initial output is captured then the process keeps running.
- Output ONLY one \`\`\`agent-tool JSON block when calling a tool (no XML like <tool_call>).
- Put any explanation BEFORE the code block, not inside it.
- After list_files/read_file you will receive JSON results; then continue or answer the user.
- One tool per message. Wait for results before the next tool.${MARKDOWN_FORMAT}`;

export function buildPrompt(
  mode: AgentMode,
  userText: string,
  context: PromptContext
): ChatMessage[] {
  const systemContent =
    mode === 'plan' ? PLAN_SYSTEM : mode === 'agent' ? AGENT_SYSTEM : ASK_SYSTEM;

  const contextBlock = buildContextBlock(context);
  const userContent = contextBlock
    ? `${userText}\n\n---\n**Context:**\n${contextBlock}`
    : userText;

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ];
}

function buildContextBlock(ctx: PromptContext): string {
  const parts: string[] = [];
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  parts.push(`- Workspace: ${ctx.workspaceName}`);
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
  history: ChatMessage[]
): ChatMessage[] {
  const base = buildPrompt(mode, userText, context);
  if (history.length === 0) {
    return base;
  }
  const system = base[0];
  const rest = history.filter((m) => m.role !== 'system');
  return [system, ...rest, base[1]];
}

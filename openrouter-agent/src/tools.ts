import * as path from 'path';
import * as vscode from 'vscode';
import type { ApprovalRequest, PermissionChoice } from './approvalBridge';
import {
  rememberApproval,
  shouldAutoApproveCommand,
  shouldAutoApproveWrite,
} from './permissions';
import {
  formatTerminalResultForAgent,
  isBackgroundCommand,
  runCommandInWorkspace,
  type TerminalRunCallbacks,
  type TerminalRunResult,
} from './terminalRunner';

export interface ToolHandlerContext {
  onPropose: (description: string) => void;
  requestApproval?: (request: ApprovalRequest) => Promise<PermissionChoice>;
  onTerminalOutput?: (result: TerminalRunResult) => void;
  terminalCallbacks?: TerminalRunCallbacks;
}

export interface ToolCall {
  tool: string;
  pattern?: string;
  maxResults?: number;
  path?: string;
  content?: string;
  command?: string;
  cwd?: string;
  background?: boolean;
}

const DESTRUCTIVE_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|-[a-zA-Z]*r[a-zA-Z]*\s+).*(-[a-zA-Z]*r[a-zA-Z]*\s+|-[a-zA-Z]*f[a-zA-Z]*\s+)/i,
  /\brm\s+-rf\b/i,
  /\bdel\s+\/s\b/i,
  /\bformat\s+[a-z]:/i,
  /\bshutdown\b/i,
  /\bgit\s+reset\s+--hard\b/i,
];

const TOOL_ALIASES: Record<string, string> = {
  ls: 'list_files',
  dir: 'list_files',
  list: 'list_files',
  listdir: 'list_files',
  list_dir: 'list_files',
  list_directory: 'list_files',
  glob: 'list_files',
  find: 'list_files',
  search: 'list_files',
  tree: 'list_files',
  files: 'list_files',
  read: 'read_file',
  cat: 'read_file',
  type: 'read_file',
  open: 'read_file',
  write: 'propose_write_file',
  edit: 'propose_write_file',
  patch: 'propose_write_file',
  save: 'propose_write_file',
  bash: 'run_command',
  shell: 'run_command',
  terminal: 'run_command',
  exec: 'run_command',
  run: 'run_command',
};

function normalizeToolName(name: string): string {
  return name.trim().replace(/-/g, '_').toLowerCase();
}

export function resolveToolCall(call: ToolCall): ToolCall {
  const key = normalizeToolName(call.tool);
  const resolved = TOOL_ALIASES[key] ?? key;
  const out: ToolCall = { ...call, tool: resolved };

  if (resolved === 'list_files') {
    if (!out.pattern && out.path && (key === 'glob' || key === 'find' || key === 'search')) {
      out.pattern = out.path;
      delete out.path;
    }
    if (!out.pattern) {
      out.pattern = '**/*';
    }
    if (!out.maxResults) {
      out.maxResults = 150;
    }
  }

  return out;
}

export function isReadOnlyTool(tool: string): boolean {
  return tool === 'list_files' || tool === 'read_file';
}

export function hasToolCallMarkup(text: string): boolean {
  return (
    /```agent-tool/i.test(text) ||
    /<[a-zA-Z0-9_-]*tool_call>/i.test(text) ||
    /\{[\s\S]*?"(?:tool|name)"\s*:\s*"[\w_-]+"/i.test(text)
  );
}

function mapArgsToToolCall(tool: string, args: Record<string, string>): ToolCall {
  const call: ToolCall = { tool };
  if (args.path !== undefined) {
    call.path = args.path;
  }
  if (args.pattern !== undefined) {
    call.pattern = args.pattern;
  }
  if (args.content !== undefined) {
    call.content = args.content;
  }
  if (args.command !== undefined) {
    call.command = args.command;
  }
  if (args.cwd !== undefined) {
    call.cwd = args.cwd;
  }
  if (args.maxResults !== undefined) {
    const n = parseInt(args.maxResults, 10);
    if (!Number.isNaN(n)) {
      call.maxResults = n;
    }
  }
  if (args.background !== undefined) {
    call.background = args.background === 'true';
  }
  return call;
}

function parseJsonToolObject(obj: Record<string, unknown>): ToolCall | null {
  const tool =
    (typeof obj.tool === 'string' && obj.tool) ||
    (typeof obj.name === 'string' && obj.name) ||
    '';
  if (!tool) {
    return null;
  }
  const args =
    obj.arguments && typeof obj.arguments === 'object' && !Array.isArray(obj.arguments)
      ? (obj.arguments as Record<string, unknown>)
      : obj;
  const strArgs: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === 'tool' || k === 'name') {
      continue;
    }
    if (typeof v === 'boolean' && k === 'background') {
      strArgs[k] = v ? 'true' : 'false';
    } else if (typeof v === 'string' || typeof v === 'number') {
      strArgs[k] = String(v);
    }
  }
  return mapArgsToToolCall(normalizeToolName(tool), strArgs);
}

function parseAgentToolJson(text: string): ToolCall | null {
  const blockMatch = text.match(/```agent-tool\s*\n([\s\S]*?)```/);
  const jsonStr = blockMatch?.[1]?.trim();
  if (jsonStr) {
    try {
      const obj = JSON.parse(jsonStr) as Record<string, unknown>;
      return parseJsonToolObject(obj);
    } catch {
      return null;
    }
  }
  const inline = text.match(/\{[\s\S]*?"(?:tool|name)"\s*:\s*"[\w_-]+"[\s\S]*?\}/);
  if (!inline) {
    return null;
  }
  try {
    const obj = JSON.parse(inline[0]) as Record<string, unknown>;
    return parseJsonToolObject(obj);
  } catch {
    return null;
  }
}

function parseXmlToolArgs(inner: string): Record<string, string> {
  const args: Record<string, string> = {};
  const pairRe =
    /<[a-zA-Z0-9_]*arg_key>\s*([^<]+?)\s*<\/[a-zA-Z0-9_]*arg_key>\s*<[a-zA-Z0-9_]*arg_value>\s*([\s\S]*?)\s*<\/[a-zA-Z0-9_]*arg_value>/gi;
  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(inner)) !== null) {
    args[m[1].trim()] = m[2].trim();
  }
  const simpleRe = /<([a-zA-Z_][\w]*)>\s*([\s\S]*?)\s*<\/\1>/g;
  let s: RegExpExecArray | null;
  while ((s = simpleRe.exec(inner)) !== null) {
    const key = s[1].trim();
    if (!key.includes('arg_') && key !== 'tool_call') {
      args[key] = s[2].trim();
    }
  }
  return args;
}

function parseXmlToolCall(text: string): ToolCall | null {
  const blockRe =
    /<[a-zA-Z0-9_-]*tool_call>\s*([\w-]+)\s*([\s\S]*?)<\/[a-zA-Z0-9_-]*tool_call>/gi;
  const match = blockRe.exec(text);
  if (!match) {
    return null;
  }
  const tool = normalizeToolName(match[1]);
  const args = parseXmlToolArgs(match[2]);
  return mapArgsToToolCall(tool, args);
}

/** Handles malformed XML (wrong closing tag, missing closes) from some OpenRouter models. */
function parseXmlToolCallLoose(text: string): ToolCall | null {
  const open = /<[a-zA-Z0-9_-]*tool_call>\s*([\w-]+)/i.exec(text);
  if (!open) {
    return null;
  }
  const tool = normalizeToolName(open[1]);
  let inner = text.slice(open.index! + open[0].length);
  const cut = inner.search(/<[a-zA-Z0-9_-]*tool_call>/i);
  if (cut >= 0) {
    inner = inner.slice(0, cut);
  }

  const args = parseXmlToolArgs(inner);
  const loosePair =
    /<[a-zA-Z0-9_]*arg_key>\s*([^<]+?)\s*(?:<\/[a-zA-Z0-9_]*arg_key>)?\s*<[a-zA-Z0-9_]*arg_value>\s*([^<]*)/gi;
  let lm: RegExpExecArray | null;
  while ((lm = loosePair.exec(inner)) !== null) {
    const key = lm[1].trim();
    if (key && args[key] === undefined) {
      args[key] = lm[2].trim();
    }
  }

  return mapArgsToToolCall(tool, args);
}

export function parseToolCall(text: string): ToolCall | null {
  const raw =
    parseAgentToolJson(text) ?? parseXmlToolCall(text) ?? parseXmlToolCallLoose(text);
  if (!raw) {
    return null;
  }
  const resolved = resolveToolCall(raw);
  const known = ['list_files', 'read_file', 'propose_write_file', 'run_command'];
  if (!known.includes(resolved.tool)) {
    return null;
  }
  return resolved;
}

export function stripToolBlock(text: string): string {
  return text
    .replace(/```agent-tool\s*\n[\s\S]*?```/g, '')
    .replace(/<[a-zA-Z0-9_-]*tool_call>[\s\S]*?<\/[a-zA-Z0-9_-]*tool_call>/gi, '')
    .replace(
      /<[a-zA-Z0-9_-]*tool_call>[\s\S]*?(?=<[a-zA-Z0-9_-]*tool_call>|$)/gi,
      ''
    )
    .replace(/<[a-zA-Z0-9_-]*arg_key>[\s\S]*?<\/[a-zA-Z0-9_-]*arg_value>/gi, '')
    .replace(/<[a-zA-Z0-9_-]*(?:tool_call|arg_key|arg_value)[^>]*>/gi, '')
    .replace(/<\/[a-zA-Z0-9_-]*(?:tool_call|arg_key|arg_value)>/gi, '')
    .replace(/```json\s*\n[\s\S]*?"tool"[\s\S]*?```/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function cleanAssistantVisibleText(text: string): string {
  const stripped = stripToolBlock(text);
  if (!stripped || hasToolCallMarkup(stripped)) {
    return '';
  }
  return stripped;
}

export function describeToolCall(call: ToolCall): string {
  switch (call.tool) {
    case 'list_files':
      return `list_files (${call.pattern ?? '**/*'})`;
    case 'read_file':
      return `read_file → ${call.path ?? '?'}`;
    case 'propose_write_file':
      return `propose_write_file → ${call.path ?? '?'}`;
    case 'run_command':
      return `run_command → ${call.command ?? '?'}`;
    default:
      return call.tool;
  }
}

/** User-facing process line (no JSON / tool ids). */
export function describeProcessStep(
  step: number,
  phase: 'thinking' | 'tool',
  call?: ToolCall
): string {
  if (phase === 'thinking') {
    return step === 1
      ? `Step ${step}: Understanding your request…`
      : `Step ${step}: Thinking…`;
  }
  if (!call) {
    return `Step ${step}: Working…`;
  }
  switch (call.tool) {
    case 'list_files': {
      const p = call.pattern ?? '**/*';
      const short =
        p === '**/*' ? 'project files' : p.replace(/^\*\*\//, '').replace(/\/\*\*$/, '');
      return `Step ${step}: Exploring ${short}…`;
    }
    case 'read_file':
      return `Step ${step}: Reading ${call.path ?? 'file'}…`;
    case 'propose_write_file':
      return `Step ${step}: Preparing changes to ${call.path ?? 'file'}…`;
    case 'run_command': {
      const cmd = call.command ?? 'command';
      const short = cmd.length > 40 ? cmd.slice(0, 40) + '…' : cmd;
      return `Step ${step}: Running \`${short}\`…`;
    }
    default:
      return `Step ${step}: Working…`;
  }
}

export function describeProcessDone(step: number, call: ToolCall, note?: string): string {
  if (note) {
    return `Step ${step}: ${note}`;
  }
  switch (call.tool) {
    case 'list_files':
      return `Step ${step}: Explored files`;
    case 'read_file':
      return `Step ${step}: Read ${call.path ?? 'file'}`;
    case 'propose_write_file':
      return `Step ${step}: Updated ${call.path ?? 'file'}`;
    case 'run_command':
      return `Step ${step}: Ran command`;
    default:
      return `Step ${step}: Done`;
  }
}

function getWorkspaceRoot(): vscode.Uri | null {
  const folders = vscode.workspace.workspaceFolders;
  return folders?.[0]?.uri ?? null;
}

export function resolveWorkspacePath(relativeOrAbsolute: string): vscode.Uri | null {
  const root = getWorkspaceRoot();
  if (!root) {
    return null;
  }

  const rootPath = root.fsPath;
  let target: string;

  if (path.isAbsolute(relativeOrAbsolute)) {
    target = path.normalize(relativeOrAbsolute);
  } else {
    target = path.normalize(path.join(rootPath, relativeOrAbsolute));
  }

  const relative = path.relative(rootPath, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }

  return vscode.Uri.file(target);
}

export async function executeListFiles(
  pattern: string = '**/*',
  maxResults: number = 100
): Promise<string> {
  if (!getWorkspaceRoot()) {
    return JSON.stringify({ error: 'No workspace folder open.' });
  }

  const capped = Math.min(Math.max(maxResults, 1), 500);
  const uris = await vscode.workspace.findFiles(
    pattern,
    '**/{node_modules,.git,dist,out,build}/**',
    capped
  );

  const root = getWorkspaceRoot()!.fsPath;
  const files = uris.map((u) => path.relative(root, u.fsPath).replace(/\\/g, '/'));
  return JSON.stringify({ files, count: files.length }, null, 2);
}

export async function executeReadFile(filePath: string): Promise<string> {
  const uri = resolveWorkspacePath(filePath);
  if (!uri) {
    return JSON.stringify({
      error: 'Invalid path or path outside workspace. Use a path relative to the workspace root.',
    });
  }

  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const content = new TextDecoder().decode(bytes);
    const max = 50000;
    const truncated =
      content.length > max
        ? content.slice(0, max) + '\n... [truncated at 50000 chars]'
        : content;
    return JSON.stringify({ path: uri.fsPath, content: truncated }, null, 2);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: msg });
  }
}

export async function confirmWriteFile(
  filePath: string,
  content: string,
  ctx?: ToolHandlerContext
): Promise<boolean> {
  if (shouldAutoApproveWrite()) {
    return true;
  }

  const uri = resolveWorkspacePath(filePath);
  if (!uri) {
    vscode.window.showErrorMessage('OpenRouter Agent: Path is outside the workspace.');
    return false;
  }

  const preview =
    content.length > 800 ? content.slice(0, 800) + '\n... [truncated preview]' : content;

  const choice = await resolveApproval(
    {
      kind: 'propose_write_file',
      title: 'Allow file write?',
      detail: preview,
      path: uri.fsPath,
    },
    ctx,
    async () => {
      const picked = await vscode.window.showWarningMessage(
        `OpenRouter Agent wants to write file:\n${uri.fsPath}`,
        { modal: true, detail: `Preview:\n${preview}` },
        'Confirm Write',
        'Cancel'
      );
      return picked === 'Confirm Write' ? 'once' : 'skip';
    }
  );

  return choice !== 'skip';
}

async function resolveApproval(
  request: ApprovalRequest,
  ctx: ToolHandlerContext | undefined,
  fallback: () => Promise<PermissionChoice>
): Promise<PermissionChoice> {
  if (ctx?.requestApproval) {
    const choice = await ctx.requestApproval(request);
    rememberApproval(request.kind, choice, request.command, request.destructive);
    return choice;
  }
  const choice = await fallback();
  rememberApproval(request.kind, choice, request.command, request.destructive);
  return choice;
}

export async function applyWriteFile(filePath: string, content: string): Promise<string> {
  const uri = resolveWorkspacePath(filePath);
  if (!uri) {
    return JSON.stringify({ error: 'Path outside workspace.' });
  }

  const dir = vscode.Uri.file(path.dirname(uri.fsPath));
  try {
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
    return JSON.stringify({ success: true, path: uri.fsPath });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: msg });
  }
}

export function isDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
}

export async function confirmRunCommand(
  command: string,
  ctx?: ToolHandlerContext
): Promise<boolean> {
  const destructive = isDestructiveCommand(command);
  if (shouldAutoApproveCommand(command, destructive)) {
    return true;
  }

  const title = destructive
    ? '⚠️ Allow destructive command?'
    : 'Allow terminal command?';

  const choice = await resolveApproval(
    {
      kind: 'run_command',
      title,
      detail: command,
      command,
      destructive,
    },
    ctx,
    async () => {
      const message = destructive
        ? `⚠️ DESTRUCTIVE COMMAND — OpenRouter Agent wants to run:\n${command}\n\nThis may delete data or be irreversible.`
        : `OpenRouter Agent wants to run command:\n${command}`;
      const choices = destructive
        ? (['Run Anyway (Dangerous)', 'Cancel'] as const)
        : (['Confirm Run', 'Cancel'] as const);
      const picked = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        ...choices
      );
      if (destructive) {
        return picked === 'Run Anyway (Dangerous)' ? 'once' : 'skip';
      }
      return picked === 'Confirm Run' ? 'once' : 'skip';
    }
  );

  return choice !== 'skip';
}

export async function executeRunCommand(
  command: string,
  cwd?: string,
  ctx?: ToolHandlerContext,
  background?: boolean
): Promise<string> {
  const root = getWorkspaceRoot();
  if (!root) {
    return JSON.stringify({ error: 'No workspace folder open.' });
  }

  let workDir = root.fsPath;
  if (cwd) {
    const resolved = resolveWorkspacePath(cwd);
    if (!resolved) {
      return JSON.stringify({ error: 'cwd outside workspace.' });
    }
    workDir = resolved.fsPath;
  }

  const runBackground = background ?? isBackgroundCommand(command);
  const callbacks = ctx?.terminalCallbacks;
  const result = await runCommandInWorkspace(command, workDir, callbacks, {
    background: runBackground,
  });
  ctx?.onTerminalOutput?.(result);
  return formatTerminalResultForAgent(result);
}

export async function handleToolCall(
  call: ToolCall,
  ctx: ToolHandlerContext
): Promise<{ result: string; needsFollowUp: boolean; displayNote?: string }> {
  switch (call.tool) {
    case 'list_files': {
      const result = await executeListFiles(call.pattern, call.maxResults);
      return { result, needsFollowUp: true };
    }
    case 'read_file': {
      if (!call.path) {
        return {
          result: JSON.stringify({ error: 'read_file requires "path".' }),
          needsFollowUp: true,
        };
      }
      const result = await executeReadFile(call.path);
      return { result, needsFollowUp: true };
    }
    case 'propose_write_file': {
      if (!call.path || call.content === undefined) {
        return {
          result: JSON.stringify({ error: 'propose_write_file requires "path" and "content".' }),
          needsFollowUp: false,
          displayNote: 'Invalid propose_write_file call.',
        };
      }
      ctx.onPropose(`Proposing write to: ${call.path}`);
      const confirmed = await confirmWriteFile(call.path, call.content, ctx);
      if (!confirmed) {
        return {
          result: JSON.stringify({ cancelled: true, message: 'User declined file write.' }),
          needsFollowUp: true,
          displayNote: 'File write skipped by user.',
        };
      }
      const result = await applyWriteFile(call.path, call.content);
      return { result, needsFollowUp: true, displayNote: `File written: ${call.path}` };
    }
    case 'run_command': {
      if (!call.command) {
        return {
          result: JSON.stringify({ error: 'run_command requires "command".' }),
          needsFollowUp: false,
        };
      }
      ctx.onPropose(`Proposing command: ${call.command}`);
      const confirmed = await confirmRunCommand(call.command, ctx);
      if (!confirmed) {
        return {
          result: JSON.stringify({ cancelled: true, message: 'User declined command.' }),
          needsFollowUp: true,
          displayNote: 'Command skipped by user.',
        };
      }
      const result = await executeRunCommand(call.command, call.cwd, ctx, call.background);
      const note = call.background || isBackgroundCommand(call.command)
        ? `Started in background: ${call.command}`
        : `Ran: ${call.command}`;
      return {
        result,
        needsFollowUp: true,
        displayNote: note,
      };
    }
    default:
      return {
        result: JSON.stringify({ error: `Unknown tool: ${call.tool}` }),
        needsFollowUp: false,
      };
  }
}

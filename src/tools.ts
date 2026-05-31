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
  maxFiles?: number;
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
  read_glob: 'read_glob',
  readglob: 'read_glob',
  read_files: 'read_glob',
  readfiles: 'read_glob',
  read_all: 'read_glob',
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

// Ensure globs search subfolders (e.g. star-dot-md → recursive match).
export function normalizeGlobPattern(pattern: string): string {
  const p = pattern.trim().replace(/\\/g, '/');
  if (!p) {
    return '**/*';
  }
  if (p.includes('**')) {
    return p;
  }
  if (p.startsWith('*/')) {
    return `**/${p.slice(2)}`;
  }
  if (p.startsWith('*.')) {
    return `**/${p}`;
  }
  if (p.includes('/') && p.includes('*')) {
    return `**/${p}`;
  }
  return p;
}

export type UserFileIntentKind =
  | 'read_all_markdown'
  | 'read_glob'
  | 'read_single_file'
  | null;

export interface UserFileIntent {
  kind: UserFileIntentKind;
  pattern?: string;
  filename?: string;
}

export function detectUserFileIntent(userText: string): UserFileIntent {
  const text = userText.trim();

  if (
    /\b(read|show|list|get|summarize|summarise)\b[\s\S]{0,40}\b(all|every|each)\b[\s\S]{0,40}\b(markdown|\.md)\b/i.test(
      text
    ) ||
    /\b(all|every|each)\b[\s\S]{0,30}\b(markdown|\.md)\b[\s\S]{0,20}\bfiles?\b/i.test(text) ||
    /\b(all|every)\b[\s\S]{0,20}\.md\b/i.test(text)
  ) {
    return { kind: 'read_all_markdown', pattern: '**/*.md' };
  }

  const allExt = text.match(
    /\b(?:read|show|list|all|every)\b[\s\S]{0,30}\b(\*\*\/[\w*./-]+|\*\.[\w]+|[\w.-]*\/\*\.[\w]+)\b/i
  );
  if (allExt) {
    return {
      kind: 'read_glob',
      pattern: normalizeGlobPattern(allExt[1]),
    };
  }

  const named =
    text.match(
      /(?:what about|tell me about|read|open|show|check|look at)\s+[`"']?([\w./\\-]+\.\w{1,12})[`"']?/i
    ) || text.match(/\b([A-Za-z0-9_./\\-]+\.(?:md|markdown|txt|json|ts|tsx|js|jsx|py|yaml|yml|toml))\b/i);

  if (named?.[1]) {
    return { kind: 'read_single_file', filename: named[1].replace(/\\/g, '/') };
  }

  return { kind: null };
}

export function buildAutoToolCall(intent: UserFileIntent): ToolCall | null {
  switch (intent.kind) {
    case 'read_all_markdown':
      return { tool: 'read_glob', pattern: '**/*.md', maxFiles: 30 };
    case 'read_glob':
      return { tool: 'read_glob', pattern: intent.pattern ?? '**/*', maxFiles: 30 };
    case 'read_single_file':
      if (!intent.filename) {
        return null;
      }
      return { tool: 'read_file', path: intent.filename };
    default:
      return null;
  }
}

export function requiresFileVerification(userText: string): boolean {
  if (detectUserFileIntent(userText).kind !== null) {
    return true;
  }
  return /\b(file|files|exist|readme|changelog|\.md\b|\.ts\b|\.json\b|workspace)\b/i.test(
    userText
  );
}

export function mentionsFileExistence(text: string): boolean {
  return /\b(doesn't exist|does not exist|do not exist|not exist|no such file|cannot find|can't find|file not found|isn't in|is not in the workspace|couldn't find|could not find)\b/i.test(
    text
  );
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
    out.pattern = normalizeGlobPattern(out.pattern);
    if (!out.maxResults) {
      out.maxResults = 200;
    }
  }

  if (resolved === 'read_glob') {
    if (!out.pattern && out.path) {
      out.pattern = out.path;
      delete out.path;
    }
    if (!out.pattern) {
      out.pattern = '**/*';
    }
    out.pattern = normalizeGlobPattern(out.pattern);
    if (!out.maxFiles) {
      out.maxFiles = 25;
    }
  }

  return out;
}

export function isReadOnlyTool(tool: string): boolean {
  return tool === 'list_files' || tool === 'read_file' || tool === 'read_glob';
}

export function hasToolCallMarkup(text: string): boolean {
  const normalized = normalizeModelToolSyntax(text);
  return (
    /```agent-tool/i.test(text) ||
    /<[a-zA-Z0-9_-]*tool_call>/i.test(text) ||
    /function_call_begin|function_calls_begin/i.test(normalized) ||
    /\{[\s\S]*?"(?:tool|name|path|pattern)"\s*:\s*"/i.test(text)
  );
}

/** Collapse spaced pipe tokens: `< | function_call_begin | >` → `<|function_call_begin|>`. */
export function normalizeModelToolSyntax(text: string): string {
  return text.replace(/<\s*\|\s*([^|>]+?)\s*\|\s*>/g, '<|$1|>');
}

/** Remove harmony/channel delimiters (e.g. openrouter/owl-alpha `<|channel|>final<|message|>`). */
export function sanitizeModelOutput(text: string): string {
  const normalized = normalizeModelToolSyntax(text);
  if (!/<\|channel\|>/i.test(normalized)) {
    return normalized;
  }

  const finalParts: string[] = [];
  const finalRe = /<\|channel\|>final<\|message\|>([\s\S]*?)(?=<\|channel\|>|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = finalRe.exec(normalized)) !== null) {
    finalParts.push(match[1]);
  }
  if (finalParts.length > 0) {
    return finalParts.join('\n\n').trim();
  }

  return normalized
    .replace(/<\|channel\|>[^<\n]*<\|message\|>/gi, '')
    .replace(/<\|end\|>/gi, '')
    .replace(/<\|start\|>/gi, '')
    .trim();
}

function jsonObjectToStrArgs(obj: Record<string, unknown>): Record<string, string> {
  const strArgs: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'tool' || k === 'name') {
      continue;
    }
    if (typeof v === 'boolean' && k === 'background') {
      strArgs[k] = v ? 'true' : 'false';
    } else if (typeof v === 'string' || typeof v === 'number') {
      strArgs[k] = String(v);
    }
  }
  return strArgs;
}

/** Owl-alpha / OpenRouter function-calls format: `<|function_call_begin|>read_file<|function_sep|>{"path":"..."}`. */
function parseFunctionCallsFormat(text: string): ToolCall | null {
  const normalized = normalizeModelToolSyntax(text);
  const callRe =
    /(?:<\|function_calls_begin\|>\s*)?<\|function_call_begin\|>\s*([\w-]+)\s*<\|function_sep\|>\s*(\{[\s\S]*?\})\s*(?:<\|function_call_end\|>(?:\s*<\|function_calls_end\|>)?)?/i;
  const match = callRe.exec(normalized);
  if (!match) {
    const looseRe =
      /<\|function_call_begin\|>\s*([\w-]+)\s*<\|function_sep\|>\s*(\{[\s\S]*?\})/i;
    const loose = looseRe.exec(normalized);
    if (!loose) {
      return null;
    }
    return parseFunctionCallMatch(loose[1], loose[2]);
  }
  return parseFunctionCallMatch(match[1], match[2]);
}

function parseFunctionCallMatch(toolRaw: string, jsonStr: string): ToolCall | null {
  try {
    const obj = JSON.parse(jsonStr) as Record<string, unknown>;
    const toolFromJson =
      (typeof obj.tool === 'string' && obj.tool) ||
      (typeof obj.name === 'string' && obj.name) ||
      '';
    const tool = normalizeToolName(toolFromJson || toolRaw);
    return mapArgsToToolCall(tool, jsonObjectToStrArgs(obj));
  } catch {
    return null;
  }
}

/** OpenAI-style nested function call JSON. */
function parseOpenAiFunctionFormat(text: string): ToolCall | null {
  const match = text.match(
    /\{[\s\S]*?"function"\s*:\s*\{[\s\S]*?"name"\s*:\s*"([\w-]+)"[\s\S]*?"arguments"\s*:\s*"((?:\\.|[^"\\])*)"[\s\S]*?\}[\s\S]*?\}/
  );
  if (!match) {
    return null;
  }
  try {
    const tool = normalizeToolName(match[1]);
    const argsJson = JSON.parse(match[2]) as Record<string, unknown>;
    return mapArgsToToolCall(tool, jsonObjectToStrArgs(argsJson));
  } catch {
    return null;
  }
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
  if (args.maxFiles !== undefined) {
    const n = parseInt(args.maxFiles, 10);
    if (!Number.isNaN(n)) {
      call.maxFiles = n;
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
  const normalized = normalizeModelToolSyntax(text);
  const raw =
    parseFunctionCallsFormat(normalized) ??
    parseAgentToolJson(normalized) ??
    parseOpenAiFunctionFormat(normalized) ??
    parseXmlToolCall(normalized) ??
    parseXmlToolCallLoose(normalized);
  if (!raw) {
    return null;
  }
  const resolved = resolveToolCall(raw);
  const known = ['list_files', 'read_file', 'read_glob', 'propose_write_file', 'run_command'];
  if (!known.includes(resolved.tool)) {
    return null;
  }
  return resolved;
}

export function stripToolBlock(text: string): string {
  const normalized = sanitizeModelOutput(text);
  return normalized
    .replace(/```agent-tool\s*\n[\s\S]*?```/g, '')
    .replace(/<\|function_calls_begin\|>[\s\S]*?<\|function_calls_end\|>/gi, '')
    .replace(/<\|function_call_begin\|>[\s\S]*?<\|function_call_end\|>/gi, '')
    .replace(/<\|function_call_begin\|>[\s\S]*?<\|function_sep\|>\s*\{[\s\S]*?\}/gi, '')
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
    case 'read_glob':
      return `read_glob (${call.pattern ?? '**/*'})`;
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
    case 'read_glob': {
      const p = call.pattern ?? '**/*';
      const short = p.replace(/^\*\*\//, '').replace(/\/\*\*$/, '') || 'files';
      return `Step ${step}: Reading all ${short}…`;
    }
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
    case 'read_glob':
      return `Step ${step}: Read matching files`;
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

  const normalized = normalizeGlobPattern(pattern);
  const capped = Math.min(Math.max(maxResults, 1), 500);
  const uris = await vscode.workspace.findFiles(
    normalized,
    '**/{node_modules,.git,dist,out,build}/**',
    capped
  );

  const root = getWorkspaceRoot()!.fsPath;
  const files = uris.map((u) => path.relative(root, u.fsPath).replace(/\\/g, '/'));
  return JSON.stringify({ pattern: normalized, files, count: files.length }, null, 2);
}

const READ_GLOB_MAX_FILES = 40;
const READ_GLOB_CHARS_PER_FILE = 12_000;

export async function executeReadGlob(
  pattern: string,
  maxFiles: number = 25,
  maxCharsPerFile: number = READ_GLOB_CHARS_PER_FILE
): Promise<string> {
  if (!getWorkspaceRoot()) {
    return JSON.stringify({ error: 'No workspace folder open.' });
  }

  const normalized = normalizeGlobPattern(pattern);
  const cappedFiles = Math.min(Math.max(maxFiles, 1), READ_GLOB_MAX_FILES);
  const listJson = JSON.parse(await executeListFiles(normalized, cappedFiles)) as {
    error?: string;
    files?: string[];
    count?: number;
    pattern?: string;
  };

  if (listJson.error) {
    return JSON.stringify(listJson);
  }

  const matched = listJson.files ?? [];
  const results: Array<{ path: string; content?: string; error?: string }> = [];

  for (const rel of matched.slice(0, cappedFiles)) {
    const readJson = JSON.parse(await executeReadFile(rel)) as {
      path?: string;
      content?: string;
      error?: string;
    };
    if (readJson.error) {
      results.push({ path: rel, error: readJson.error });
      continue;
    }
    let content = readJson.content ?? '';
    if (content.length > maxCharsPerFile) {
      content = content.slice(0, maxCharsPerFile) + '\n... [truncated per file]';
    }
    results.push({ path: readJson.path ?? rel, content });
  }

  return JSON.stringify(
    {
      pattern: normalized,
      count: results.length,
      totalMatched: listJson.count ?? matched.length,
      truncated: (listJson.count ?? matched.length) > cappedFiles,
      files: results,
    },
    null,
    2
  );
}

export async function executeReadFile(filePath: string): Promise<string> {
  const uri = await resolveReadableFileUri(filePath);
  if (!uri) {
    return JSON.stringify({
      error: 'Invalid path, path outside workspace, or file not found. Use a path relative to the workspace root.',
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
    const root = getWorkspaceRoot()!.fsPath;
    const relative = path.relative(root, uri.fsPath).replace(/\\/g, '/');
    return JSON.stringify({ path: relative, content: truncated }, null, 2);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: msg });
  }
}

/** Resolve a workspace file, with case-insensitive fallback on Windows/macOS. */
async function resolveReadableFileUri(filePath: string): Promise<vscode.Uri | null> {
  const direct = resolveWorkspacePath(filePath);
  if (!direct) {
    return null;
  }

  try {
    const stat = await vscode.workspace.fs.stat(direct);
    if (stat.type === vscode.FileType.File) {
      return direct;
    }
  } catch {
    /* try case-insensitive match */
  }

  const root = getWorkspaceRoot();
  if (!root) {
    return null;
  }

  const targetBase = path.basename(direct.fsPath).toLowerCase();
  const parentRel = path.relative(root.fsPath, path.dirname(direct.fsPath));
  const searchRoot =
    parentRel && !parentRel.startsWith('..')
      ? vscode.Uri.file(path.join(root.fsPath, parentRel))
      : root;

  const found = await findFileCaseInsensitive(searchRoot, targetBase);
  if (found) {
    return found;
  }

  if (filePath.includes('/') || filePath.includes('\\')) {
    return null;
  }

  return findFileCaseInsensitive(root, targetBase);
}

async function findFileCaseInsensitive(
  dirUri: vscode.Uri,
  baseNameLower: string
): Promise<vscode.Uri | null> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(dirUri);
    for (const [name, type] of entries) {
      if (type === vscode.FileType.File && name.toLowerCase() === baseNameLower) {
        return vscode.Uri.file(path.join(dirUri.fsPath, name));
      }
    }
    for (const [name, type] of entries) {
      if (type === vscode.FileType.Directory && !name.startsWith('.')) {
        const hit = await findFileCaseInsensitive(
          vscode.Uri.file(path.join(dirUri.fsPath, name)),
          baseNameLower
        );
        if (hit) {
          return hit;
        }
      }
    }
  } catch {
    return null;
  }
  return null;
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
    case 'read_glob': {
      const result = await executeReadGlob(
        call.pattern ?? '**/*',
        call.maxFiles ?? 25
      );
      return {
        result,
        needsFollowUp: true,
        displayNote: `Read files matching ${call.pattern ?? '**/*'}`,
      };
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

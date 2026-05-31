import * as vscode from 'vscode';
import { ContentPart } from './openrouter';

export type AttachmentKind = 'image' | 'pdf' | 'text';

export interface AttachmentMeta {
  id: string;
  name: string;
  kind: AttachmentKind;
  mimeType: string;
  sizeBytes: number;
}

export interface ResolvedAttachment extends AttachmentMeta {
  dataUrl?: string;
  textContent?: string;
}

export interface AttachmentLimits {
  maxCount: number;
  maxImageBytes: number;
  maxPdfBytes: number;
  maxTextBytes: number;
}

const IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
]);

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.yaml', '.yml', '.xml', '.csv',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.cs', '.cpp', '.c', '.h',
  '.html', '.htm', '.css', '.scss', '.less', '.sql', '.sh', '.bash', '.ps1',
  '.toml', '.ini', '.env', '.gitignore', '.dockerfile',
]);

const PENDING_SESSION = '_pending';

export function getAttachmentLimits(): AttachmentLimits {
  const cfg = vscode.workspace.getConfiguration('openrouterAgent');
  return {
    maxCount: cfg.get<number>('maxAttachments', 5),
    maxImageBytes: cfg.get<number>('maxImageSizeMb', 4) * 1024 * 1024,
    maxPdfBytes: cfg.get<number>('maxPdfSizeMb', 10) * 1024 * 1024,
    maxTextBytes: 120 * 1024,
  };
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

export function classifyAttachment(
  name: string,
  mimeType: string
): { kind: AttachmentKind } | { error: string } {
  const mime = (mimeType || '').toLowerCase().split(';')[0].trim();
  const ext = extOf(name);

  if (IMAGE_MIMES.has(mime) || ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) {
    return { kind: 'image' };
  }
  if (mime === 'application/pdf' || ext === '.pdf') {
    return { kind: 'pdf' };
  }
  if (mime.startsWith('text/') || mime === 'application/json' || TEXT_EXTENSIONS.has(ext)) {
    return { kind: 'text' };
  }
  return { error: `Unsupported file type: ${name} (${mime || 'unknown'}). Use images, PDF, or text/code files.` };
}

export function hasVisionAttachments(attachments: AttachmentMeta[]): boolean {
  return attachments.some((a) => a.kind === 'image' || a.kind === 'pdf');
}

export function hasTextAttachments(
  attachments: Pick<AttachmentMeta, 'kind'>[]
): boolean {
  return attachments.some((a) => a.kind === 'text' || a.kind === 'pdf');
}

export function formatAttachmentTextBlock(a: ResolvedAttachment): string {
  if (a.kind === 'text' && a.textContent !== undefined) {
    return `--- ${a.name} ---\n${a.textContent}\n--- end ${a.name} ---`;
  }
  if (a.kind === 'pdf') {
    return `--- ${a.name} (PDF attached separately) ---`;
  }
  return '';
}

export function formatInlineAttachmentSection(attachments: ResolvedAttachment[]): string {
  const textBlocks = attachments
    .filter((a) => a.kind === 'text' || a.kind === 'pdf')
    .map(formatAttachmentTextBlock)
    .filter(Boolean);
  if (textBlocks.length === 0) {
    return '';
  }
  const names = attachments
    .filter((a) => a.kind === 'text' || a.kind === 'pdf')
    .map((a) => a.name)
    .join(', ');
  return (
    `[ATTACHED FILES — full content below for: ${names}. ` +
    `Analyze these directly; do NOT use read_file/list_files for these filenames unless the user asks to compare with workspace copies.]\n\n` +
    textBlocks.join('\n\n')
  );
}

export function attachmentAnalysisLabel(attachments: AttachmentMeta[]): string {
  const names = attachments.map((a) => a.name);
  if (names.length === 1) {
    return names[0];
  }
  return `${names.length} files`;
}

export function modelSupportsVision(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return (
    /gemini|gpt-4o|gpt-4\.1|gpt-5|claude|llava|vision|pixtral|qwen-vl|internvl|glm-4v|moondream|llama-3\.2-vision|gpt-4-turbo/.test(
      id
    ) || id.includes(':vision')
  );
}

export function buildUserMessageContent(
  userText: string,
  attachments: ResolvedAttachment[],
  contextBlock: string | null
): string | ContentPart[] {
  const text = userText.trim();
  const images = attachments.filter((a) => a.kind === 'image');
  const pdfs = attachments.filter((a) => a.kind === 'pdf' && a.dataUrl);
  const inlineSection = formatInlineAttachmentSection(attachments);

  const textParts: string[] = [];
  if (inlineSection) {
    textParts.push(inlineSection);
  }
  if (text) {
    textParts.push(`User request: ${text}`);
  } else if (inlineSection) {
    textParts.push('User request: analyze the attached file(s).');
  }
  if (contextBlock) {
    textParts.push(`---\n**Context:**\n${contextBlock}`);
  }

  const flatText = textParts.join('\n\n').trim();
  const visionParts: ContentPart[] = [];

  for (const a of images) {
    if (a.dataUrl) {
      visionParts.push({ type: 'image_url', image_url: { url: a.dataUrl } });
    }
  }
  for (const a of pdfs) {
    if (a.dataUrl) {
      visionParts.push({
        type: 'file',
        file: { filename: a.name, file_data: a.dataUrl },
      });
    }
  }

  if (visionParts.length === 0) {
    return flatText;
  }

  const parts: ContentPart[] = [];
  if (flatText) {
    parts.push({ type: 'text', text: flatText });
  }
  parts.push(...visionParts);
  return parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts;
}

function newAttachmentId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
}

export class AttachmentStore {
  private pending: AttachmentMeta[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {}

  private baseDir(sessionId: string): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'attachments', sessionId);
  }

  private fileUri(sessionId: string, id: string): vscode.Uri {
    return vscode.Uri.joinPath(this.baseDir(sessionId), id);
  }

  private metaUri(sessionId: string, id: string): vscode.Uri {
    return vscode.Uri.joinPath(this.baseDir(sessionId), `${id}.meta.json`);
  }

  getPending(): AttachmentMeta[] {
    return [...this.pending];
  }

  clearPending(): void {
    this.pending = [];
    void this.clearSessionFiles(PENDING_SESSION);
  }

  private async clearSessionFiles(sessionId: string): Promise<void> {
    try {
      const dir = this.baseDir(sessionId);
      await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false });
    } catch {
      /* may not exist */
    }
  }

  async removePending(id: string): Promise<void> {
    this.pending = this.pending.filter((a) => a.id !== id);
    try {
      await vscode.workspace.fs.delete(this.fileUri(PENDING_SESSION, id));
      await vscode.workspace.fs.delete(this.metaUri(PENDING_SESSION, id));
    } catch {
      /* ignore */
    }
  }

  private async writeAttachment(
    sessionId: string,
    name: string,
    mimeType: string,
    bytes: Uint8Array
  ): Promise<{ meta: AttachmentMeta } | { error: string }> {
    const limits = getAttachmentLimits();
    const classified = classifyAttachment(name, mimeType);
    if ('error' in classified) {
      return classified;
    }

    const kind = classified.kind;
    if (kind === 'image' && bytes.length > limits.maxImageBytes) {
      return { error: `Image too large (${name}). Max ${limits.maxImageBytes / (1024 * 1024)} MB.` };
    }
    if (kind === 'pdf' && bytes.length > limits.maxPdfBytes) {
      return { error: `PDF too large (${name}). Max ${limits.maxPdfBytes / (1024 * 1024)} MB.` };
    }
    if (kind === 'text' && bytes.length > limits.maxTextBytes) {
      return { error: `File too large (${name}). Max ${limits.maxTextBytes / 1024} KB for text files.` };
    }

    const id = newAttachmentId();
    const meta: AttachmentMeta = {
      id,
      name,
      kind,
      mimeType: mimeType.split(';')[0].trim() || 'application/octet-stream',
      sizeBytes: bytes.length,
    };

    const dir = this.baseDir(sessionId);
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(this.fileUri(sessionId, id), bytes);
    await vscode.workspace.fs.writeFile(
      this.metaUri(sessionId, id),
      Buffer.from(JSON.stringify(meta), 'utf8')
    );

    return { meta };
  }

  async addFromBytes(
    name: string,
    mimeType: string,
    bytes: Uint8Array
  ): Promise<{ meta: AttachmentMeta } | { error: string }> {
    const limits = getAttachmentLimits();
    if (this.pending.length >= limits.maxCount) {
      return { error: `Maximum ${limits.maxCount} attachments per message.` };
    }
    const result = await this.writeAttachment(PENDING_SESSION, name, mimeType, bytes);
    if ('error' in result) {
      return result;
    }
    this.pending.push(result.meta);
    return result;
  }

  async addFromBase64Payload(
    files: { name: string; mimeType: string; base64: string }[]
  ): Promise<{ added: AttachmentMeta[]; errors: string[] }> {
    const added: AttachmentMeta[] = [];
    const errors: string[] = [];
    for (const f of files) {
      try {
        const raw = f.base64.includes(',') ? f.base64.split(',')[1] : f.base64;
        const bytes = Buffer.from(raw, 'base64');
        const result = await this.addFromBytes(f.name, f.mimeType, bytes);
        if ('error' in result) {
          errors.push(result.error);
        } else {
          added.push(result.meta);
        }
      } catch {
        errors.push(`Could not read file: ${f.name}`);
      }
    }
    return { added, errors };
  }

  async pickFilesDialog(): Promise<{ added: AttachmentMeta[]; errors: string[] }> {
    const limits = getAttachmentLimits();
    const remaining = limits.maxCount - this.pending.length;
    if (remaining <= 0) {
      return { added: [], errors: [`Maximum ${limits.maxCount} attachments per message.`] };
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Attach',
      title: 'Attach files or images',
      defaultUri: workspaceRoot,
      filters: {
        'All supported': ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf', 'txt', 'md', 'json', 'ts', 'tsx', 'js', 'jsx', 'py', 'css', 'html', 'xml', 'yaml', 'yml', 'csv'],
        Images: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
        PDF: ['pdf'],
      },
    });

    if (!uris?.length) {
      return { added: [], errors: [] };
    }

    const added: AttachmentMeta[] = [];
    const errors: string[] = [];
    for (const uri of uris.slice(0, remaining)) {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const name = uri.path.split(/[/\\]/).pop() ?? 'file';
        const ext = extOf(name);
        let mime = 'application/octet-stream';
        if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) {
          mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        } else if (ext === '.pdf') {
          mime = 'application/pdf';
        } else {
          mime = 'text/plain';
        }
        const result = await this.addFromBytes(name, mime, bytes);
        if ('error' in result) {
          errors.push(result.error);
        } else {
          added.push(result.meta);
        }
      } catch {
        errors.push(`Could not read: ${uri.fsPath}`);
      }
    }
    return { added, errors };
  }

  async commitPendingToSession(sessionId: string): Promise<AttachmentMeta[]> {
    if (this.pending.length === 0) {
      return [];
    }

    const dir = this.baseDir(sessionId);
    await vscode.workspace.fs.createDirectory(dir);

    const committed: AttachmentMeta[] = [];
    for (const meta of this.pending) {
      const src = this.fileUri(PENDING_SESSION, meta.id);
      const dest = this.fileUri(sessionId, meta.id);
      try {
        const bytes = await vscode.workspace.fs.readFile(src);
        await vscode.workspace.fs.writeFile(dest, bytes);
        await vscode.workspace.fs.writeFile(
          this.metaUri(sessionId, meta.id),
          Buffer.from(JSON.stringify(meta), 'utf8')
        );
        committed.push(meta);
      } catch {
        /* skip broken attachment */
      }
    }

    this.pending = [];
    void this.clearSessionFiles(PENDING_SESSION);
    return committed;
  }

  async loadResolved(sessionId: string, metas: AttachmentMeta[]): Promise<ResolvedAttachment[]> {
    const resolved: ResolvedAttachment[] = [];
    for (const meta of metas) {
      const r = await this.loadOne(sessionId, meta);
      if (r) {
        resolved.push(r);
      }
    }
    return resolved;
  }

  private async loadOne(
    sessionId: string,
    meta: AttachmentMeta
  ): Promise<ResolvedAttachment | null> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.fileUri(sessionId, meta.id));
      if (meta.kind === 'text') {
        return {
          ...meta,
          textContent: Buffer.from(bytes).toString('utf8'),
        };
      }
      const mime =
        meta.kind === 'pdf' ? 'application/pdf' : meta.mimeType || 'image/png';
      return {
        ...meta,
        dataUrl: bytesToDataUrl(bytes, mime),
      };
    } catch {
      return null;
    }
  }

  async getPreviewDataUrl(
    sessionId: string,
    meta: AttachmentMeta
  ): Promise<string | undefined> {
    if (meta.kind !== 'image') {
      return undefined;
    }
    const one = await this.loadOne(sessionId, meta);
    return one?.dataUrl;
  }

  async enrichHistoryForWebview(
    sessionId: string,
    messages: { attachments?: AttachmentMeta[] }[]
  ): Promise<{ id: string; name: string; kind: AttachmentKind; mimeType: string; previewUrl?: string }[][]> {
    const result: { id: string; name: string; kind: AttachmentKind; mimeType: string; previewUrl?: string }[][] = [];
    for (const m of messages) {
      if (!m.attachments?.length) {
        result.push([]);
        continue;
      }
      const row: { id: string; name: string; kind: AttachmentKind; mimeType: string; previewUrl?: string }[] = [];
      for (const a of m.attachments) {
        const previewUrl =
          a.kind === 'image' ? await this.getPreviewDataUrl(sessionId, a) : undefined;
        row.push({
          id: a.id,
          name: a.name,
          kind: a.kind,
          mimeType: a.mimeType,
          previewUrl,
        });
      }
      result.push(row);
    }
    return result;
  }
}

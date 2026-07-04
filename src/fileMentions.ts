import * as vscode from 'vscode';

export interface FileMention {
  path: string;
  startIdx: number;
  endIdx: number;
}

/**
 * Parse file mentions in format @path/to/file.ts
 * Matches @path patterns only after whitespace or start of text.
 * Returns sorted mentions (by startIdx).
 */
export function parseFileMentions(text: string): FileMention[] {
  const mentions: FileMention[] = [];
  // Match @path patterns: @ followed by non-whitespace until end or whitespace/newline
  // Only match @ after start of string or whitespace
  const regex = /(^|[\s\n])@([^\s\n]+)/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const atIdx = match.index + match[1].length; // Position of @
    const pathEnd = match.index + match[0].length; // End of match
    const path = match[2];

    mentions.push({
      path,
      startIdx: atIdx,
      endIdx: pathEnd,
    });
  }

  return mentions.sort((a, b) => a.startIdx - b.startIdx);
}

/**
 * Remove @mentions from text, keeping the rest intact.
 * Works in reverse order to preserve indices.
 */
export function stripFileMentions(text: string): string {
  const mentions = parseFileMentions(text);
  let result = text;
  for (let i = mentions.length - 1; i >= 0; i--) {
    const m = mentions[i];
    result = result.slice(0, m.startIdx) + result.slice(m.endIdx);
  }
  return result;
}

/**
 * Find workspace files matching the partial pattern.
 * Returns up to maxResults matches, sorted alphabetically.
 */
export async function findWorkspaceFiles(
  partial: string,
  maxResults: number = 20
): Promise<string[]> {
  if (!vscode.workspace.workspaceFolders?.length) {
    return [];
  }

  try {
    // Escape special glob characters in partial but allow wildcards
    const pattern = `**/${partial}*`;
    const uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**', maxResults);
    const paths = uris
      .map((uri) => {
        const wsFolder = vscode.workspace.getWorkspaceFolder(uri);
        if (wsFolder) {
          return vscode.workspace.asRelativePath(uri, false);
        }
        return uri.fsPath;
      })
      .sort();

    return paths;
  } catch {
    return [];
  }
}

/**
 * Resolve file paths (checking existence and readability).
 * Returns array of resolved paths (only those that exist).
 */
export async function resolveFilePaths(paths: string[]): Promise<string[]> {
  const resolved: string[] = [];

  for (const path of paths) {
    if (!path.trim()) continue;

    // Try relative to workspace first
    if (vscode.workspace.workspaceFolders?.length) {
      for (const folder of vscode.workspace.workspaceFolders) {
        const uri = vscode.Uri.joinPath(folder.uri, path);
        try {
          await vscode.workspace.fs.stat(uri);
          resolved.push(path);
          break;
        } catch {
          // File not found, try next folder or continue
        }
      }
    }
  }

  return resolved;
}

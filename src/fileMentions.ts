import * as vscode from 'vscode';

export interface FileMention {
  path: string;
  startIdx: number;
  endIdx: number;
}

/** Parse @file mentions from text. */
export function parseFileMentions(text: string): FileMention[] {
  const mentions: FileMention[] = [];
  const regex = /(^|[\s\n])@([^\s\n]+)/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const leadingChar = match[1];
    const atIdx = match.index + leadingChar.length;
    const pathEnd = match.index + match[0].length;
    const path = match[2];

    mentions.push({
      path,
      startIdx: atIdx,
      endIdx: pathEnd,
    });
  }

  return mentions;
}

/** Remove @file mentions from text. */
export function stripFileMentions(text: string): string {
  const mentions = parseFileMentions(text);
  let result = text;

  for (let i = mentions.length - 1; i >= 0; i--) {
    const m = mentions[i];
    result = result.slice(0, m.startIdx) + result.slice(m.endIdx);
  }

  return result;
}

/** Find workspace files matching a query pattern. */
export async function findWorkspaceFiles(query: string, maxResults: number = 20): Promise<string[]> {
  if (!vscode.workspace.workspaceFolders?.length) {
    return [];
  }

  try {
    const pattern = `**/${query}*`;
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

/** Read file contents from workspace. */
export async function readMentionedFiles(paths: string[]): Promise<string> {
  if (!paths.length || !vscode.workspace.workspaceFolders?.length) {
    return '';
  }

  const contents: string[] = [];

  for (const path of paths) {
    if (!path.trim()) continue;

    for (const folder of vscode.workspace.workspaceFolders) {
      const uri = vscode.Uri.joinPath(folder.uri, path);
      try {
        const data = await vscode.workspace.fs.readFile(uri);
        const text = new TextDecoder().decode(data);
        contents.push(`File: ${path}\n\`\`\`\n${text}\n\`\`\``);
        break;
      } catch {
        // Not found in this folder
      }
    }
  }

  if (!contents.length) {
    return '';
  }

  return '\n\nMentioned files:\n' + contents.join('\n\n');
}

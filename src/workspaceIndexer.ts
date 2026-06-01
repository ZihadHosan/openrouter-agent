import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Simple workspace indexer that scans files and builds an in-memory index
 * for fast text search across the workspace.
 */
export class WorkspaceIndexer {
  private index = new Map<string, IndexedFile>();
  private fileWatchers: vscode.FileSystemWatcher[] = [];
  private isIndexing = false;
  private lastIndexedAt: number | null = null;

  /**
   * Start background indexing of the workspace
   */
  public async startIndexing(): Promise<void> {
    if (this.isIndexing) {
      return;
    }
    this.isIndexing = true;
    try {
      await this.indexWorkspace();
    } finally {
      this.isIndexing = false;
    }
  }

  /**
   * Stop all file watchers and clear the index
   */
  public dispose(): void {
    for (const watcher of this.fileWatchers) {
      watcher.dispose();
    }
    this.fileWatchers = [];
    this.index.clear();
  }

  /**
   * Search the index for files matching a query
   * @param query The search query (simple substring match for now)
   * @param maxResults Maximum number of results to return
   * @returns Array of matching file paths with relevance scores
   */
  public search(query: string, maxResults: number = 10): { path: string; score: number }[] {
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
    if (terms.length === 0) {
      return [];
    }

    const results: { path: string; score: number }[] = [];

    for (const [filePath, file] of this.index.entries()) {
      let score = 0;

      // Simple scoring: count term matches in content and filename
      for (const term of terms) {
        if (file.content.toLowerCase().includes(term)) {
          score += 1;
        }
        if (path.basename(filePath).toLowerCase().includes(term)) {
          score += 0.5;
        }
      }

      if (score > 0) {
        results.push({ path: filePath, score });
      }
    }

    // Sort by score descending, then by path for consistency
    results.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.path.localeCompare(b.path);
    });

    return results.slice(0, maxResults);
  }

  /**
   * Get indexed file content
   * @param filePath Path to the file
   * @returns File content or null if not indexed
   */
  public getFileContent(filePath: string): string | null {
    const file = this.index.get(filePath);
    return file?.content ?? null;
  }

  /**
   * Get list of all indexed files
   */
  public getIndexedFiles(): string[] {
    return Array.from(this.index.keys());
  }

  /**
   * Check if a file is indexed
   * @param filePath Path to the file
   */
  public isFileIndexed(filePath: string): boolean {
    return this.index.has(filePath);
  }

  /**
   * Re-index a specific file
   * @param filePath Path to the file
   */
  public async reindexFile(filePath: string): Promise<void> {
    const content = await this.readFile(filePath);
    if (content !== null) {
      this.index.set(filePath, {
        path: filePath,
        content,
        indexedAt: Date.now(),
      });
    } else {
      this.index.delete(filePath);
    }
  }

  /**
   * Remove a file from the index
   * @param filePath Path to the file
   */
  public removeFile(filePath: string): void {
    this.index.delete(filePath);
  }

  /**
   * Get indexing statistics
   */
  public getStats(): { fileCount: number; lastIndexedAt: number | null } {
    return {
      fileCount: this.index.size,
      lastIndexedAt: this.lastIndexedAt,
    };
  }

  /**
   * Initialize file watchers for automatic index updates
   */
  private setupFileWatchers(): void {
    // Clear existing watchers
    for (const watcher of this.fileWatchers) {
      watcher.dispose();
    }
    this.fileWatchers = [];

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      return;
    }

    // Watch all TypeScript, JavaScript, Markdown, and JSON files
    const patterns = ['**/*.ts', '**/*.js', '**/*.tsx', '**/*.jsx', '**/*.md', '**/*.json'];

    for (const pattern of patterns) {
      try {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(workspaceFolders[0], pattern),
          false, // don't watch create
          true,  // watch change
          false  // don't watch delete
        );

        watcher.onDidChange(async (uri) => {
          await this.reindexFile(uri.fsPath);
        });

        watcher.onDidDelete((uri) => {
          this.removeFile(uri.fsPath);
        });

        this.fileWatchers.push(watcher);
      } catch {
        // Ignore errors (e.g., too many file watchers)
      }
    }
  }

  /**
   * Index all files in the workspace
   */
  private async indexWorkspace(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      return;
    }

    // Find all relevant files
    const patterns = ['**/*.ts', '**/*.js', '**/*.tsx', '**/*.jsx', '**/*.md', '**/*.json'];
    const excludePatterns = '**/{node_modules,.git,dist,out,build}/**';

    for (const pattern of patterns) {
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(workspaceFolders[0], pattern),
        excludePatterns,
        5000 // limit for performance
      );

      for (const uri of uris) {
        const content = await this.readFile(uri.fsPath);
        if (content !== null) {
          this.index.set(uri.fsPath, {
            path: uri.fsPath,
            content,
            indexedAt: Date.now(),
          });
        }
      }
    }

    this.lastIndexedAt = Date.now();
    this.setupFileWatchers();
  }

  /**
   * Read a file and return its content
   * @param filePath Path to the file
   * @returns File content or null if read fails
   */
  private async readFile(filePath: string): Promise<string | null> {
    try {
      const uri = vscode.Uri.file(filePath);
      const bytes = await vscode.workspace.fs.readFile(uri);
      return new TextDecoder().decode(bytes);
    } catch {
      return null;
    }
  }
}

/**
 * Indexed file metadata
 */
interface IndexedFile {
  path: string;
  content: string;
  indexedAt: number;
}

// Singleton instance
let instance: WorkspaceIndexer | undefined;

export function getWorkspaceIndexer(): WorkspaceIndexer {
  if (!instance) {
    instance = new WorkspaceIndexer();
  }
  return instance;
}

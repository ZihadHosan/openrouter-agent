import * as vscode from 'vscode';

export interface CachedContext {
  workspaceName: string;
  activeFilePath: string;
  selectedText: string;
  fileContent: string;
  timestamp: number;
  fileVersion?: number; // Track file change version
}

export class ContextCache {
  private cache = new Map<string, CachedContext>();
  private fileWatchers: vscode.FileSystemWatcher[] = [];
  private lastFileChange = new Map<string, number>();

  constructor() {
    this.setupFileWatchers();
  }

  /**
   * Get cached context if valid, undefined if cache miss or stale
   */
  get(key: string): CachedContext | undefined {
    const cached = this.cache.get(key);
    if (!cached) {
      return undefined;
    }

    // Check if cache entry is stale (older than 5 minutes)
    const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
    if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
      this.cache.delete(key);
      return undefined;
    }

    // Check if file has changed since caching
    if (cached.activeFilePath) {
      const lastChange = this.lastFileChange.get(cached.activeFilePath);
      if (lastChange && lastChange > cached.timestamp) {
        this.cache.delete(key);
        return undefined;
      }
    }

    return cached;
  }

  /**
   * Store context in cache
   */
  set(key: string, context: CachedContext): void {
    this.cache.set(key, context);
  }

  /**
   * Clear cache entry for a specific key
   */
  clear(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Clear all cache entries
   */
  clearAll(): void {
    this.cache.clear();
  }

  /**
   * Setup file system watchers to invalidate cache on file changes
   */
  private setupFileWatchers(): void {
    // Clear existing watchers
    for (const watcher of this.fileWatchers) {
      watcher.dispose();
    }
    this.fileWatchers = [];

    // Watch all workspace folders
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      return;
    }

    // Create a watcher for all files in workspace
    try {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(workspaceFolders[0], '**/*'),
        false, // don't watch create
        true,  // watch change
        false  // don't watch delete
      );

      watcher.onDidChange((uri) => {
        this.lastFileChange.set(uri.fsPath, Date.now());
      });

      this.fileWatchers.push(watcher);
    } catch {
      // Ignore errors (e.g., too many file watchers)
    }
  }

  /**
   * Get cache statistics for debugging
   */
  getStats(): { size: number; keys: string[] } {
    const keys = Array.from(this.cache.keys());
    return { size: this.cache.size, keys };
  }
}

// Singleton instance
let instance: ContextCache | undefined;
export function getContextCache(): ContextCache {
  if (!instance) {
    instance = new ContextCache();
  }
  return instance;
}

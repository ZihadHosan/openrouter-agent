import * as crypto from 'crypto';

export interface ToolResultEntry {
  hash: string;
  tool: string;
  args: Record<string, string>;
  result: string;
  timestamp: number;
  ttlMs: number;
}

export class ToolResultCache {
  private cache = new Map<string, ToolResultEntry>();
  private defaultTTL = 5 * 60 * 1000; // 5 minutes

  /**
   * Generate a hash for a tool call
   */
  private generateHash(tool: string, args: Record<string, string>): string {
    // Sort the keys for consistent hashing
    const sortedArgs = Object.keys(args)
      .sort()
      .reduce((acc, key) => {
        acc[key] = args[key];
        return acc;
      }, {} as Record<string, string>);
    const argsStr = JSON.stringify(sortedArgs);
    const data = `${tool}:${argsStr}`;
    return crypto.createHash('md5').update(data).digest('hex').slice(0, 12);
  }

  /**
   * Get cached result for a tool call
   */
  get(tool: string, args: Record<string, string>): string | undefined {
    const hash = this.generateHash(tool, args);
    const entry = this.cache.get(hash);

    if (!entry) {
      return undefined;
    }

    // Check if cache entry is stale
    const now = Date.now();
    if (now - entry.timestamp > entry.ttlMs) {
      this.cache.delete(hash);
      return undefined;
    }

    return entry.result;
  }

  /**
   * Store result for a tool call
   */
  set(
    tool: string,
    args: Record<string, string>,
    result: string,
    ttlMs?: number
  ): void {
    const hash = this.generateHash(tool, args);
    const entry: ToolResultEntry = {
      hash,
      tool,
      args,
      result,
      timestamp: Date.now(),
      ttlMs: ttlMs ?? this.defaultTTL,
    };
    this.cache.set(hash, entry);
  }

  /**
   * Clear cache for a specific tool
   */
  clearForTool(tool: string): void {
    for (const [hash, entry] of this.cache.entries()) {
      if (entry.tool === tool) {
        this.cache.delete(hash);
      }
    }
  }

  /**
   * Clear cache for a specific path (for read_file)
   */
  clearForPath(path: string): void {
    for (const [hash, entry] of this.cache.entries()) {
      if (
        (entry.tool === 'read_file' ||
          entry.tool === 'read_glob') &&
        entry.args.path === path
      ) {
        this.cache.delete(hash);
      }
    }
  }

  /**
   * Clear all cache entries
   */
  clearAll(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics for debugging
   */
  getStats(): { size: number; hitRate?: number } {
    return { size: this.cache.size };
  }
}

// Singleton instance
let instance: ToolResultCache | undefined;
export function getToolResultCache(): ToolResultCache {
  if (!instance) {
    instance = new ToolResultCache();
  }
  return instance;
}

/**
 * Check if a tool call should use caching
 */
export function shouldCacheTool(tool: string): boolean {
  // Cache read-only tools
  return tool === 'read_file' || tool === 'list_files' || tool === 'read_glob';
}

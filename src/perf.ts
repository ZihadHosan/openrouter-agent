import * as vscode from 'vscode';

export function isPerfDebugEnabled(): boolean {
  return (
    process.env.DEBUG_PERF === '1' ||
    vscode.workspace.getConfiguration('openrouterAgent').get<boolean>('debugPerformance', false)
  );
}

/** Log elapsed ms when debug performance is enabled. */
export class PerfSpan {
  private readonly start = performance.now();

  constructor(private readonly label: string) {}

  end(note?: string): number {
    const ms = Math.round(performance.now() - this.start);
    if (isPerfDebugEnabled()) {
      const suffix = note ? ` ${note}` : '';
      console.log(`[perf] ${this.label}: ${ms}ms${suffix}`);
    }
    return ms;
  }
}

export async function withPerf<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const span = new PerfSpan(label);
  try {
    return await fn();
  } finally {
    span.end();
  }
}

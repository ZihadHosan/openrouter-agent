import * as vscode from 'vscode';
import type { ApiKeyStore } from './apiKeyStore';

const CREDITS_URL = 'https://openrouter.ai/api/v1/credits';
const KEY_URL = 'https://openrouter.ai/api/v1/key';
const BALANCE_CACHE_TTL_MS = 60_000;

export type BalanceSource = 'account' | 'key_limit';

export interface OpenRouterBalance {
  balanceUsd: number;
  source: BalanceSource;
}

export interface AccountBalanceDisplay {
  visible: boolean;
  label?: string;
  shortLabel?: string;
  isZero?: boolean;
  title?: string;
}

function openRouterHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'HTTP-Referer': 'https://github.com/openrouter-agent',
    'X-Title': 'OpenRouter Agent VS Code Extension',
  };
}

async function fetchCreditsBalance(apiKey: string): Promise<number | null> {
  try {
    const res = await fetch(CREDITS_URL, { headers: openRouterHeaders(apiKey) });
    if (!res.ok) {
      return null;
    }
    const json = (await res.json()) as {
      data?: { total_credits?: number; total_usage?: number };
    };
    const purchased = json.data?.total_credits;
    const used = json.data?.total_usage;
    if (typeof purchased !== 'number' || typeof used !== 'number') {
      return null;
    }
    return purchased - used;
  } catch {
    return null;
  }
}

async function fetchKeyLimitRemaining(apiKey: string): Promise<number | null> {
  try {
    const res = await fetch(KEY_URL, { headers: openRouterHeaders(apiKey) });
    if (!res.ok) {
      return null;
    }
    const json = (await res.json()) as {
      data?: { limit_remaining?: number | null };
    };
    const remaining = json.data?.limit_remaining;
    if (typeof remaining !== 'number' || !Number.isFinite(remaining)) {
      return null;
    }
    return remaining;
  } catch {
    return null;
  }
}

/** Try account credits, then per-key limit remaining. */
export async function fetchOpenRouterBalance(
  apiKey: string
): Promise<OpenRouterBalance | null> {
  const account = await fetchCreditsBalance(apiKey);
  if (account !== null) {
    return { balanceUsd: account, source: 'account' };
  }
  const keyLimit = await fetchKeyLimitRemaining(apiKey);
  if (keyLimit !== null) {
    return { balanceUsd: keyLimit, source: 'key_limit' };
  }
  return null;
}

export function formatBalanceDisplay(balanceUsd: number): {
  label: string;
  shortLabel: string;
  isZero: boolean;
} {
  const isZero = balanceUsd <= 0;
  const display = Math.max(0, balanceUsd);
  const formatted = display.toFixed(2);
  return {
    label: `Balance $${formatted}`,
    shortLabel: `$${formatted}`,
    isZero,
  };
}

export function balanceTooltip(source: BalanceSource): string {
  if (source === 'account') {
    return 'OpenRouter account balance (may be up to ~60s stale).';
  }
  return 'Credits remaining on this API key limit (may be up to ~60s stale).';
}

export function isAccountBalanceEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('openrouterAgent')
    .get<boolean>('showAccountBalance', true);
}

class OpenRouterBalanceCache {
  private cacheKey = '';
  private fetchedAt = 0;
  private cached: OpenRouterBalance | null | undefined;

  async get(apiKeyStore: ApiKeyStore, force = false): Promise<OpenRouterBalance | null> {
    const apiKey = await apiKeyStore.get();
    if (!apiKey) {
      this.invalidate();
      return null;
    }
    const now = Date.now();
    if (
      !force &&
      apiKey === this.cacheKey &&
      this.cached !== undefined &&
      now - this.fetchedAt < BALANCE_CACHE_TTL_MS
    ) {
      return this.cached;
    }
    this.cached = await fetchOpenRouterBalance(apiKey);
    this.cacheKey = apiKey;
    this.fetchedAt = now;
    return this.cached;
  }

  invalidate(): void {
    this.cacheKey = '';
    this.fetchedAt = 0;
    this.cached = undefined;
  }
}

let balanceCache: OpenRouterBalanceCache | undefined;

export function getOpenRouterBalanceCache(): OpenRouterBalanceCache {
  if (!balanceCache) {
    balanceCache = new OpenRouterBalanceCache();
  }
  return balanceCache;
}

export async function getAccountBalanceForWebview(
  apiKeyStore: ApiKeyStore,
  force = false
): Promise<AccountBalanceDisplay> {
  if (!isAccountBalanceEnabled()) {
    return { visible: false };
  }
  const apiKey = await apiKeyStore.get();
  if (!apiKey) {
    return { visible: false };
  }
  const balance = await getOpenRouterBalanceCache().get(apiKeyStore, force);
  if (!balance) {
    return { visible: false };
  }
  const { label, shortLabel, isZero } = formatBalanceDisplay(balance.balanceUsd);
  return {
    visible: true,
    label,
    shortLabel,
    isZero,
    title: balanceTooltip(balance.source),
  };
}

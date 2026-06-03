/** Harmony / OpenRouter control-token sanitization (no vscode dependency — testable in Node). */

export const HARMONY_CONTROL_NAME_HINTS = [
  'tool',
  'function',
  'call',
  'argument',
  'section',
  'channel',
  'message',
  'assistant',
  'final',
  'redacted',
  'sep',
  'calls',
] as const;

export const HARMONY_PIPE_TOKEN_RE = /<\|([^|]+)\|>/g;
export const FUNCTIONS_WIRE_PREFIX_RE = /\bfunctions\.[A-Za-z0-9_.]+(?::\d+)?\b/g;
export const FUNCTIONS_WIRE_DETECT_RE = /\bfunctions\.[A-Za-z0-9_.]+(?::\d+)?\b/;

/** Collapse spaced pipe tokens: `< | function_call_begin | >` → `<|function_call_begin|>`. */
export function normalizeModelToolSyntax(text: string): string {
  return text.replace(/<\s*\|\s*([^|>]+?)\s*\|\s*>/g, '<|$1|>');
}

/** Classify Harmony/OpenRouter control tokens (model-agnostic heuristic). */
export function isHarmonyControlToken(tokenName: string): boolean {
  const name = tokenName.trim().toLowerCase();
  if (name === 'end' || name === 'start') {
    return true;
  }
  return HARMONY_CONTROL_NAME_HINTS.some((hint) => name.includes(hint));
}

/** True when text contains native tool-wire tokens (any variant). */
export function hasNativeControlTokens(text: string): boolean {
  const normalized = normalizeModelToolSyntax(text);
  if (FUNCTIONS_WIRE_DETECT_RE.test(normalized)) {
    return true;
  }
  let match: RegExpExecArray | null;
  const re = new RegExp(HARMONY_PIPE_TOKEN_RE.source, 'g');
  while ((match = re.exec(normalized)) !== null) {
    if (isHarmonyControlToken(match[1])) {
      return true;
    }
  }
  return false;
}

/**
 * Remove Harmony/control pipe tokens from assistant-visible text (fail-closed).
 * Intentionally strips unknown <|...|> leftovers so new model formats do not leak.
 */
export function stripHarmonyControlTokens(text: string): string {
  let out = normalizeModelToolSyntax(text);

  out = out.replace(
    /<\|(?:redacted_)?(?:tool_calls|function_calls)_section_begin\|>[\s\S]*?<\|(?:redacted_)?(?:tool_calls|function_calls)_section_end\|>/gi,
    ''
  );
  out = out.replace(
    /<\|(?:redacted_)?(?:tool_calls|function_calls)_section_begin\|>[\s\S]*?(?=<\|(?:redacted_)?(?:tool_calls|function_calls)_section_begin\||$)/gi,
    ''
  );

  out = out.replace(
    /<\|(?:redacted_)?tool_call_begin[\w-]*\|>[\s\S]*?<\|(?:redacted_)?tool_call_end[\w-]*\|>/gi,
    ''
  );
  out = out.replace(
    /<\|(?:redacted_)?tool_call_begin[\w-]*\|>[\s\S]*?(?=<\|(?:redacted_)?tool_call_begin[\w-]*\|>|$)/gi,
    ''
  );
  out = out.replace(
    /<\|(?:redacted_)?function_call_begin\|>[\s\S]*?<\|(?:redacted_)?function_call_end\|>/gi,
    ''
  );

  out = out.replace(HARMONY_PIPE_TOKEN_RE, (full, tokenName: string) =>
    isHarmonyControlToken(tokenName) ? '' : full
  );

  out = out.replace(FUNCTIONS_WIRE_PREFIX_RE, '');

  out = out.replace(/^\s*\{[\s\S]*?"(?:tool|name|path|pattern|command)"\s*:\s*[\s\S]*$/gm, '');
  out = out.replace(/^\s*\{\s*"(?:tool|pattern|path|name)"[\s\S]*$/gm, '');

  if (/<\|[^|]+\|>/.test(out)) {
    out = out.replace(/<\|[^|]+\|>/g, '');
  }

  return out.replace(/\n{3,}/g, '\n\n').trim();
}

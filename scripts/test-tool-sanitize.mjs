/**
 * Regression tests for Harmony / native tool-token sanitization.
 * Run: npm run test:sanitize  (compile + node)
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const harmony = require(join(__dirname, '..', 'dist', 'harmonyTokens.js'));

const {
  stripHarmonyControlTokens,
  hasNativeControlTokens,
} = harmony;

const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};
const tools = require(join(__dirname, '..', 'dist', 'tools.js'));
const openrouter = require(join(__dirname, '..', 'dist', 'openrouter.js'));
Module._load = originalLoad;

const {
  cleanAssistantVisibleText,
  parseToolCall,
  normalizeHarmonyToolName,
  detectUserFileIntent,
  buildVerificationFallbackTools,
  parseNativeToolCall,
  getToolDefsForMode,
} = tools;

const { assembleToolCallDeltas, finalizeToolCalls } = openrouter;

assert(
  normalizeHarmonyToolName('functions.list_files:0') === 'list_files',
  'normalizeHarmonyToolName: functions.list_files:0 → list_files'
);
assert(
  normalizeHarmonyToolName('read_file') === 'read_file',
  'normalizeHarmonyToolName: read_file unchanged'
);

const fixturesPath = join(__dirname, 'fixtures', 'tool-leak-samples.json');
const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8'));

let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  }
}

function variantsFor(input) {
  const out = [{ label: 'base', text: input }];
  out.push({
    label: 'spaced-pipes',
    text: input.replace(/<\|([^|]+)\|>/g, '< | $1 | >'),
  });
  if (input.includes('tool_call_begin')) {
    out.push({
      label: 'redacted-prefix',
      text: input.replace(/<\|tool_call/g, '<|redacted_tool_call'),
    });
  }
  return out;
}

for (const fx of fixtures) {
  const cases = variantsFor(fx.input);
  for (const c of cases) {
    const prefix = `${fx.id} [${c.label}]`;
    const sanitized = stripHarmonyControlTokens(c.text);
    for (const bad of fx.mustNotContain ?? []) {
      assert(!sanitized.includes(bad), `${prefix}: stripHarmony left "${bad}"`);
    }
    if (fx.expectHasControl === true) {
      assert(
        hasNativeControlTokens(c.text),
        `${prefix}: expected hasNativeControlTokens true`
      );
    }
    if (fx.expectHasControl === false) {
      assert(
        !hasNativeControlTokens(c.text),
        `${prefix}: expected hasNativeControlTokens false`
      );
    }
    if (fx.expectTool) {
      const call = parseToolCall(c.text);
      assert(
        call && call.tool === fx.expectTool,
        `${prefix}: expected tool ${fx.expectTool}, got ${call?.tool}`
      );
    }
    if (fx.expectVisibleContains) {
      const visible = cleanAssistantVisibleText(c.text);
      assert(
        visible.includes(fx.expectVisibleContains),
        `${prefix}: visible text should contain "${fx.expectVisibleContains}"`
      );
    }
  }
}

const syntheticLeaks = [
  '<|tool_call_begin_v2|>functions.read_file:1<|tool_call_argument_begin|>{"path":"a.ts"}',
  '<|mega_redacted_function_calls_section_begin|>\n<|call_begin|>',
];
for (const leak of syntheticLeaks) {
  const sanitized = stripHarmonyControlTokens(leak);
  assert(!sanitized.includes('<|'), `synthetic: still has pipe tokens: ${leak.slice(0, 40)}…`);
  assert(hasNativeControlTokens(leak), `synthetic: should detect control tokens`);
}

assert(
  detectUserFileIntent('how this project connected with database or cms').kind ===
    'explore_project_stack',
  'database/cms question should map to explore_project_stack'
);
const fallback = buildVerificationFallbackTools(
  'how this project connected with database or cms'
);
assert(
  fallback.length >= 3 && fallback.some((c) => c.tool === 'list_files'),
  'verification fallback should include list_files and reads'
);

const channelSample =
  '<|channel|>final<|message|>Hello from final channel.';
const channelVisible = cleanAssistantVisibleText(channelSample);
assert(
  channelVisible.includes('Hello from final channel'),
  'channel final prose should survive cleanAssistantVisibleText'
);

// --- Native (OpenRouter/OpenAI) tool-calling ---

const nativeRead = parseNativeToolCall({
  id: 'call_1',
  type: 'function',
  function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
});
assert(
  nativeRead && nativeRead.tool === 'read_file' && nativeRead.path === 'a.ts',
  'parseNativeToolCall: read_file path mapped'
);

const nativeWireName = parseNativeToolCall({
  function: { name: 'functions.list_files:0', arguments: '{"pattern":"**/*.md"}' },
});
assert(
  nativeWireName && nativeWireName.tool === 'list_files' && nativeWireName.pattern === '**/*.md',
  'parseNativeToolCall: functions.list_files:0 → list_files'
);

assert(
  parseNativeToolCall({ function: { name: 'delete_everything', arguments: '{}' } }) === null,
  'parseNativeToolCall: unknown tool → null'
);

const nativeBadArgs = parseNativeToolCall({
  function: { name: 'read_file', arguments: '{ not json' },
});
assert(
  nativeBadArgs && nativeBadArgs.tool === 'read_file',
  'parseNativeToolCall: malformed arguments still resolves the tool'
);

assert(getToolDefsForMode('plan', false).length === 0, 'getToolDefsForMode: plan → 0 tools');
assert(getToolDefsForMode('ask', false).length === 3, 'getToolDefsForMode: ask → 3 read tools');
assert(getToolDefsForMode('agent', true).length === 5, 'getToolDefsForMode: agent → 5 tools');

// Streamed tool-call fragments must assemble by index into one complete call.
const acc = new Map();
assembleToolCallDeltas(acc, [
  { index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } },
]);
assembleToolCallDeltas(acc, [{ index: 0, function: { arguments: 'th":"x.ts"}' } }]);
const assembled = finalizeToolCalls(acc);
assert(
  assembled.length === 1 &&
    assembled[0].function.name === 'read_file' &&
    assembled[0].function.arguments === '{"path":"x.ts"}',
  'assembleToolCallDeltas: fragments concatenated by index'
);
const assembledParsed = parseNativeToolCall(assembled[0]);
assert(
  assembledParsed && assembledParsed.path === 'x.ts',
  'assembled streamed call parses to read_file path'
);

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log(`OK: ${fixtures.length} fixtures (+ variants) passed.`);

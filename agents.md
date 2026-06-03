# OpenRouter Agent — AI Maintainer Guide

This document describes **OpenRouter Agent** (`openrouter-agent`) in enough detail that an AI agent (or human contributor) can read it, understand the architecture, and safely modify the codebase.

**Extension id:** `ZihadHosan.openrouter-agent`  
**Publisher:** `ZihadHosan`  
**Entry point:** `src/extension.ts` → compiled to `dist/extension.js`  
**Current version:** see `package.json` (`version` field)

---

## 1. What this project is

OpenRouter Agent is a **VS Code / Cursor extension** that provides an AI chat panel powered by the [OpenRouter](https://openrouter.ai/) API. Users bring their own API key.

It supports three interaction modes:

| Mode | Purpose | Tools | Writes files | Runs terminal |
|------|---------|-------|--------------|---------------|
| **Ask** | Q&A, explain code, read workspace | Read-only (`list_files`, `read_file`, `read_glob`) | No | No |
| **Plan** | Design before coding | None | No | No |
| **Agent** | Multi-step coding with approval | All tools | Yes (with approval) | Yes (with approval) |

The chat UI opens in a **WebviewPanel on the right** of the editor (not a sidebar view). Users can attach images, PDFs, and text/code files; pick models or use **Auto** model selection; and manage chat history across sessions.

---

## 2. Tech stack

| Layer | Technology |
|-------|------------|
| Language | TypeScript 5.x (strict mode) |
| Runtime | Node.js 18+ (extension host) |
| Editor API | VS Code Extension API (`@types/vscode` ^1.85) |
| Build | `tsc` → `dist/` |
| Markdown rendering | `marked` (bundled in `media/marked.min.js` for webview) |
| Syntax highlighting | `highlight.js` (bundled to `media/highlight.min.js` via esbuild) |
| LLM provider | OpenRouter REST API (`https://openrouter.ai/api/v1/chat/completions`) |
| Packaging | `@vscode/vsce` → `.vsix` |
| Version bump | `scripts/bump-version-on-change.mjs` (runs on `npm run compile`) |

**No React, no webpack** — the chat UI is a single HTML string with inline CSS/JS generated in `chatView.ts`.

---

## 3. Project layout

```
openrouter-agent/
├── src/                      # All extension logic (TypeScript)
│   ├── extension.ts          # Activation, commands, status bar
│   ├── chatView.ts           # Webview UI + message/agent loop (largest file ~5000 lines)
│   ├── agent.ts              # System prompts, context gathering, message building
│   ├── openrouter.ts         # OpenRouter API client (streaming, native tool-calling)
│   ├── openrouterBalance.ts  # Account/key credit balance for composer badge
│   ├── openrouterModels.ts   # Model catalog cache, pricing display, vision/tool capability
│   ├── tools.ts              # Tool parsing, execution, file ops, native tool schemas
│   ├── harmonyTokens.ts      # Harmony/OpenRouter control-token sanitization (vscode-free)
│   ├── terminalRunner.ts     # Cross-platform shell execution with fallbacks
│   ├── permissions.ts        # Agent permission modes + auto-approve logic
│   ├── approvalBridge.ts     # Webview ↔ extension approval card bridge
│   ├── attachments.ts        # File/image/PDF attachment handling
│   ├── autoModel.ts          # Auto model scoring/selection
│   ├── models.ts             # Model store (pool, selection, migration)
│   ├── chatHistory.ts        # Session persistence
│   ├── apiKeyStore.ts        # Secure API key in VS Code Secret Storage
│   ├── contextCache.ts       # Context gather result cache (5-min TTL, file-watcher invalidation)
│   ├── toolResultCache.ts    # Tool execution result cache (5-min TTL, MD5-keyed)
│   ├── workspaceIndexer.ts   # Background workspace file index for fast search
│   ├── modelPickerWebviewScript.ts  # Model picker UI script (catalog, pool toggles)
│   └── perf.ts               # PerfSpan timing helper (DEBUG_PERF=1 or setting)
├── media/                    # Icons, marked.min.js, highlight.min.js, CSS
├── scripts/                  # Version bump, hljs bundle entry, test runner
│   ├── bump-version-on-change.mjs
│   ├── hljs-entry.mjs
│   ├── test-tool-sanitize.mjs   # Node regression tests (no vscode needed)
│   └── fixtures/
│       └── tool-leak-samples.json
├── docs/                     # DEVELOPMENT.md, RELEASE.md
├── dist/                     # Compiled JS (generated, not committed)
├── package.json              # Extension manifest + settings schema
├── tsconfig.json             # rootDir: src, outDir: dist, strict: true
├── agents.md                 # This file
├── README.md                 # User-facing docs
├── CHANGELOG.md
└── PRIVACY.md
```

---

## 4. Architecture overview

```
VS Code Extension Host
  extension.ts
    └── ChatViewProvider (chatView.ts)   ← central orchestrator
          ├── agent.ts                   ← system prompts, context
          ├── openrouter.ts              ← API client, native tool-calling, streaming
          ├── tools.ts                   ← tool schemas, parse, execute
          │     ├── harmonyTokens.ts     ← control-token sanitization
          │     └── terminalRunner.ts    ← shell execution
          ├── permissions.ts / approvalBridge.ts
          ├── attachments.ts
          ├── models.ts / autoModel.ts
          ├── openrouterModels.ts        ← catalog cache, supportsTools()
          ├── chatHistory.ts
          ├── contextCache.ts / toolResultCache.ts
          └── Webview (postMessage)
                └── Inline HTML/CSS/JS in getHtml()

External
  OpenRouter API  (https://openrouter.ai/api/v1/...)
  OS Shells       (cmd, pwsh, bash, etc.)
  Workspace FS    (vscode.workspace.fs)
```

---

## 5. Activation and commands

**File:** `src/extension.ts`

On `activate()`:

1. Creates singleton stores: `ModelStore`, `ApiKeyStore`, `AttachmentStore`, `ChatHistoryStore`
2. Creates `ChatViewProvider` (chat panel controller)
3. Migrates legacy API key from settings → Secret Storage
4. Starts workspace indexing in background
5. Prefetches editor context (2s delay) for faster first response
6. Shows status bar item **OpenRouter** (click → open chat)
7. Registers commands (see `package.json` → `contributes.commands`)

| Command id | What it does |
|------------|--------------|
| `openrouterAgent.openChat` | Focus/open chat panel (`Ctrl+Alt+L`) |
| `openrouterAgent.setApiKey` | Prompt for API key |
| `openrouterAgent.clearApiKey` | Remove stored key |
| `openrouterAgent.setPermissions` | Quick pick permission mode |
| `openrouterAgent.askCurrentFile` | Open chat, send Ask prompt with active file |
| `openrouterAgent.explainSelection` | Explain selected code in Ask mode |
| `openrouterAgent.fixSelection` | One-shot fix via API, apply to selection |

---

## 6. Chat UI (`chatView.ts`)

This is the **central orchestrator** (~5000 lines). Responsibilities:

- Create/manage `WebviewPanel` on the right (`ChatViewProvider.panelType`)
- Generate HTML/CSS/JS for the chat interface (`getHtml()`)
- Handle `webview.onDidReceiveMessage` → `handleWebviewMessage()`
- Send state to webview via `post({ type: ... })`
- Run the **agent tool loop** (`runToolLoop()`) — both native and text-fallback paths
- Stream assistant tokens (`callOpenRouterStreaming()`) using `askOpenRouterToolAware()`
- Persist sessions via `ChatHistoryStore`

### 6.1 Webview → Extension messages (inbound)

| type | Action |
|------|--------|
| `ready` | Initial sync (history, models, attachments) |
| `send` | User sends message (`text`, `mode`, `modelId`) |
| `stop` | Abort in-flight request and all running terminal processes |
| `clear` | Clear current session messages |
| `newSession` | Create new chat session |
| `deleteSession` | Delete session by id |
| `switchSession` | Switch active session |
| `setMode` | Ask / Plan / Agent |
| `setModel` | Select model or Auto |
| `setAutoPoolModel` | Toggle model on/off for Auto pool |
| `pickAttachments` / `addAttachments` / `removeAttachment` | Attachment UI |
| `toolApprovalResponse` | User approves/skips write or command |
| `openLink` | Open http(s) URL in external browser (shows VS Code confirm dialog) |
| `openFile` | Open a workspace file in a real editor tab (`path` field) |
| `resolveFiles` | Check which candidate file paths exist in workspace (`paths[]`) |

### 6.2 Extension → Webview messages (outbound)

| type | Purpose |
|------|---------|
| `init` | Full state on load |
| `userMessage` / `assistantMessage` | Chat bubbles |
| `assistantStreamStart` / `assistantPartial` / `assistantStreamCancel` | Streaming |
| `loading` | Progress steps (process: `{completed[], current, thought}`) |
| `toolApproval` | Approval card for write/command |
| `toolProgress` | Live progress while native tool-call arguments stream (`name`, `bytes`) |
| `terminalRunStart` / `terminalRunUpdate` / `terminalRunEnd` | Live terminal output |
| `sessions` | Session list for dropdown |
| `models` / `modelCatalog` | Model dropdown + catalog state |
| `modelPricing` | Per-million token pricing for composer |
| `modelCapability` | Vision/tool capability hint for selected model |
| `accountBalance` | OpenRouter credit balance for composer badge |
| `attachmentsUpdated` | Pending attachment previews |
| `filesResolved` | Which candidate file paths exist (`files: [{input, path}]`) |
| `error` | Error toast in UI |

### 6.3 Key constants

```typescript
MAX_AGENT_ITERATIONS = 16     // Max tool loop rounds per user message
MAX_PARSE_RETRIES = 2         // Retries when model tool JSON is unparseable
MAX_UNVERIFIED_RETRIES = 2    // Retries when model guesses about files without tools
STOPPED_MESSAGE = '_Stopped._'
STREAM_IDLE_FINISHING_MS = 1200  // ms quiet before "Finishing up…" label
FINISHING_CYCLE_MS = 3500        // ms between rotating reassurance phrases
```

---

## 7. Message flow (one user send)

```
User → Webview → handleSend(text, mode, modelId)
                   │
                   ├── gatherContext() [contextCache]
                   ├── buildMessagesWithHistory() [agent.ts]
                   │
                   ├── [Plan mode]  callOpenRouterStreaming() → single call → done
                   │
                   └── [Ask/Agent] runToolLoop(allowWrites)
                         │
                         ├── Auto pre-tool (detectUserFileIntent → read before first LLM call)
                         │
                         └── loop (up to MAX_AGENT_ITERATIONS)
                               │
                               ├── callOpenRouterStreaming()
                               │     └── askOpenRouterToolAware() → ToolAwareResult
                               │           { content, toolCalls? }
                               │
                               ├── [native toolCalls present]
                               │     └── runNativeToolCalls()
                               │           ├── push role:'assistant' + tool_calls
                               │           ├── handleToolCall() per call
                               │           └── push role:'tool' result per call
                               │
                               ├── [text agent-tool block] parseAllToolCalls()
                               │     └── handleToolCall() → result appended
                               │
                               └── [no tools] → return final answer
                                     (with verification fallback / retry logic)
```

### 7.1 `handleSend()` steps (simplified)

1. Validate workspace (Ask/Agent need open folder)
2. Vision model checks for image/PDF attachments
3. Set `currentToolDefs = getToolDefsForMode(mode, allowWrites)` for native tool-calling
4. Commit pending attachments to session storage
5. Push user message to history, persist
6. Call `startWork()` — starts the request-level work clock (single continuous timer)
7. Build API conversation: system prompt + history + current user (with attachments)
8. **Plan:** single streaming call, strip accidental tool markup
9. **Ask/Agent:** `runToolLoop()` with `allowWrites = (mode === 'agent')`
10. Push assistant message with activity summary, persist, update webview

---

## 8. Agent prompts and context (`agent.ts`)

### 8.1 System prompts

Three system prompts define behavior:

- `ASK_SYSTEM` — read-only tools; "prefer native tool-calling when API supports it, otherwise use agent-tool blocks"
- `PLAN_SYSTEM` — no tools, step-by-step plans only
- `AGENT_SYSTEM` — full tool set; same native-vs-text preference hint

All include `MARKDOWN_FORMAT` rules (no wrapping entire reply in code fences).

When attachments exist, `ATTACHMENT_SYSTEM` is appended: model must analyze inline attachment content directly.

### 8.2 Workspace context

`gatherContext()` collects (with 5-minute cache and file-watcher invalidation via `contextCache.ts`):

- Workspace name and root path
- Active file path
- Selected text OR truncated active file content (max 12,000 chars)

`buildPrompt()` / `buildMessagesWithHistory()` assemble OpenRouter `ChatMessage[]`.

### 8.3 Multimodal user messages

`buildUserMessageContent()` (in `attachments.ts`) builds `ContentPart[]`:

- Text parts for user message + context + inline attachment text
- `image_url` parts for images (base64 data URLs)
- `file` parts for PDFs (OpenRouter file API format)

---

## 9. OpenRouter API client (`openrouter.ts`)

### 9.1 Key types

```typescript
// Native (OpenRouter/OpenAI) function call
interface NativeToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  index?: number;  // streaming assembly index
}

// Native tool schema advertised in request
interface OpenRouterToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

// Extended message supporting native tool turns
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: MessageContent | null;
  tool_calls?: NativeToolCall[];   // on role:'assistant' turns
  tool_call_id?: string;           // on role:'tool' result turns
}

// Return type of all tool-aware calls
interface ToolAwareResult {
  content: string;
  toolCalls?: NativeToolCall[];
}
```

### 9.2 Main entry points

```typescript
// Tool-aware — used by runToolLoop; returns content + any native tool calls
askOpenRouterToolAware(messages, options): Promise<ToolAwareResult>

// String wrapper (for fixSelection etc.)
askOpenRouter(messages, options): Promise<string>
```

`AskOpenRouterOptions`:

| Field | Purpose |
|-------|---------|
| `modelStore?` | For model selection and Auto pool |
| `apiKeyStore` | Required — reads from Secret Storage |
| `mode?` | ask / plan / agent — used for Auto pick |
| `hasVisionAttachments?` | Filters vision models for Auto |
| `signal?` | AbortSignal for Stop button |
| `stream?` | Token-by-token streaming |
| `onChunk?` | Streaming callback `(delta, accumulated)` |
| `tools?` | Native tool schemas to send (gated by supportsTools) |
| `supportsTools?` | `(modelId) => boolean` predicate from model catalog |
| `onToolProgress?` | `(info: {name?, bytes}) => void` — fires as tool-call args stream in |

### 9.3 Native tool-calling

`buildRequestBody()` attaches `tools` + `tool_choice:'auto'` **only** when:
- `options.tools` is non-empty, AND
- `options.supportsTools(finalModel)` returns true

Defaults to `true` for unknown model ids (frontier paid models all support tools); catalog marks free/text-only models false after loading.

`readSseStream()` assembles streamed tool-call argument fragments by index using `assembleToolCallDeltas()` (pure, exported, unit-tested). `finalizeToolCalls()` flattens the accumulator after the stream closes.

### 9.4 Early stream completion (lossless)

The SSE reader stops as soon as **either**:
- `choice.finish_reason` is set (standard "generation done" signal), OR
- The Harmony end-of-turn token `<|return|>` appears in the accumulated content

Many providers (owl-alpha, etc.) emit `finish_reason` but hold the HTTP connection open for many seconds before sending `[DONE]`. This fix eliminates that tail with **zero content loss** — no displayed content ever follows these signals.

### 9.5 Tool-call argument progress

`onToolProgress(info)` fires whenever tool-call argument bytes accumulate during streaming. Used by `chatView.ts` to post `toolProgress` to the webview so the "Writing file · 15.6 KB" status updates even when no visible text is streaming.

### 9.6 Streaming (text path)

- POST with `stream: true`
- Parses SSE `data:` lines; calls `onChunk(delta, accumulated)` per token
- Throws `AskOpenRouterAbortedError` on abort
- `sanitizeModelOutput()` / `stripHarmonyControlTokens()` clean Harmony channel markup before display

### 9.7 Auto model fallback

`askOpenRouterWithFallback()` (wraps `askOpenRouterToolAware`) retries with a different pool model on provider errors in Auto mode, with exponential backoff (up to `MAX_RETRY_ATTEMPTS = 3`).

### 9.8 Account balance (`openrouterBalance.ts`)

- `GET /api/v1/credits` → `total_credits - total_usage` (account balance)
- Fallback `GET /api/v1/key` → `limit_remaining` (per-key limit)
- Cached 60s; shown in composer top-right. Hidden when balance cannot be fetched.

### 9.9 Headers

```
Authorization: Bearer <apiKey>
HTTP-Referer: https://github.com/openrouter-agent
X-Title: OpenRouter Agent VS Code Extension
```

---

## 10. Harmony token sanitization (`harmonyTokens.ts`)

**vscode-free module** (no VS Code imports) — safe to unit-test in Node.

Handles OpenRouter Harmony-format models (e.g. `openrouter/owl-alpha`) that emit control tokens in their output:

```
<|channel|>final<|message|>  ← channel routing
<|tool_call_begin|>…          ← native tool call wire format
<|return|>                    ← end-of-turn signal
```

Key exports:

| Function | Purpose |
|----------|---------|
| `normalizeModelToolSyntax(text)` | Collapse spaced pipe tokens: `< \| x \| >` → `<\|x\|>` |
| `hasNativeControlTokens(text)` | Detect any Harmony/tool wire tokens |
| `isHarmonyControlToken(name)` | Classify a token name by hint words |
| `stripHarmonyControlTokens(text)` | Remove all Harmony/control tokens from visible text (fail-closed) |

`sanitizeModelOutput()` in `tools.ts` uses these to extract only the `final` channel content before rendering.

---

## 11. Auto model selection (`autoModel.ts`)

`pickAutoModelForRequest(availableModels, ctx, supportsVisionFn?)` scores each model:

| Signal | Effect |
|--------|--------|
| Vision attachments | Only consider vision-capable models; strongly prefer `VISION` regex matches |
| Ask mode | Prefer fast/free models (`FAST` regex) |
| Plan mode | Prefer reasoning models (`REASON` regex) |
| Agent mode | Prefer capable agent models (`AGENT` regex) |
| Code-related user message | Boost reasoning/agent models |
| Long conversation | Slight boost to reasoning models |

If vision attachments present but no vision model in list → returns `null` → UI blocks send.

**Default model:** `openrouter/owl-alpha` (`DEFAULT_FIRST_MODEL_ID` in `models.ts`) — used for every new chat and first install.

**Auto pool seed** (3 distinct ids, first install):
```typescript
DEFAULT_POOL_SEED_IDS = [
  'openrouter/owl-alpha',
  'z-ai/glm-4.5-air:free',
  'openai/gpt-oss-20b:free',
]
```

---

## 12. Tool system (`tools.ts`)

The extension supports **two parallel tool-call paths**:

1. **Native tool-calling** — model uses OpenAI-style `tool_calls` in the response (Claude, GPT-4, Gemini, etc.). This is the preferred path for capable models.
2. **Text agent-tool blocks** — model emits ```` ```agent-tool ``` ```` JSON blocks in assistant text. Fallback for free/text-only models that don't support native tool-calling.

`chatView.ts` tries native first; falls through to text parsing if no native `toolCalls` are returned.

### 12.1 Native tool schemas

`getToolDefsForMode(mode, allowWrites): OpenRouterToolDef[]` returns OpenRouter/OpenAI-format schemas:

| Mode | Tools advertised |
|------|-----------------|
| `ask` | `read_file`, `list_files`, `read_glob` |
| `agent` | above + `propose_write_file`, `run_command` |
| `plan` | none (empty array) |

`parseNativeToolCall(tc: NativeToolCall): ToolCall | null` adapts a native call to the internal `ToolCall` type, reusing `mapArgsToToolCall` + `resolveKnownToolCall`.

### 12.2 Text agent-tool format (fallback)

```agent-tool
{"tool":"read_file","path":"src/extension.ts"}
```

`parseAllToolCalls(text)` tries multiple formats in order:
1. Harmony channel tool calls (`<|channel|>…`)
2. Harmony wire format (`<|tool_call_begin|>…`)
3. Function-calls format (`<|function_call_begin|>…`)
4. `` ```agent-tool `` JSON blocks
5. OpenAI-style nested function JSON
6. XML `<tool_call>` blocks (strict + loose)

### 12.3 Supported tools

| tool | Args | Mode | Description |
|------|------|------|-------------|
| `list_files` | `pattern`, `maxResults` | Ask, Agent | Glob file paths in workspace (cached 5 min) |
| `read_file` | `path` | Ask, Agent | Read one file — max 50k chars (cached 5 min) |
| `read_glob` | `pattern`, `maxFiles` | Ask, Agent | List + read many files (cached 5 min) |
| `propose_write_file` | `path`, `content` | Agent only | Write/create file (with approval; invalidates cache) |
| `run_command` | `command`, `cwd?`, `background?` | Agent only | Run shell command (with approval) |

Tool aliases are normalized (e.g. `cat` → `read_file`, `bash` → `run_command`). Glob patterns auto-upgrade: `*.md` → `**/*.md`.

### 12.4 Parallel read execution

`executeReadToolsInParallel()` runs multiple read-only tools concurrently via `Promise.allSettled`.

`canParallelizeReadTools(calls)` returns true when ≥ 2 calls are all read-only → `runReadToolsInParallel()` in chatView fires them concurrently.

### 12.5 Tool result cache (`toolResultCache.ts`)

MD5-keyed in-memory cache (5-minute TTL). Keyed on tool name + args. `read_file` results are invalidated after `propose_write_file` via `invalidateReadFileCache()`.

### 12.6 Tool loop safeguards

- **Auto pre-tool on turn 1:** `detectUserFileIntent()` + `buildAutoToolCalls()` runs before first LLM call (skipped when attachments present)
- **Unverified file claims:** `mentionsFileAccessRefusal()` / `mentionsFileExistence()` → retry or auto-run fallback tools
- **Parse retries:** tool markup present but unparseable → `TOOL_INTERRUPTION_RETRY_PROMPT`
- **Ask mode guard:** write/command tools blocked with hint to switch to Agent
- **Verification fallback:** `buildVerificationFallbackTools()` hard-reads `list_files` + `package.json` + `README.md` when verification required but model ran no tools

### 12.7 File path security

`resolveWorkspacePath()` ensures all paths stay inside workspace root (blocks `../` traversal). `resolveExistingWorkspaceFile()` additionally verifies the file exists (used for clickable file mentions in chat).

### 12.8 Destructive command guard

`isDestructiveCommand()` matches `rm -rf`, `git reset --hard`, `format C:`, etc. Destructive commands **always** require approval regardless of permission mode.

---

## 13. Terminal execution (`terminalRunner.ts`)

Runs Agent mode shell commands inside the **extension host** (not VS Code integrated terminal), with robust cross-platform shell fallback.

### 13.1 Shell resolution order

`resolveShellCandidates(command, env)`:

1. `openrouterAgent.shell` (user override)
2. `vscode.env.shell`
3. VS Code integrated terminal default profile path
4. **Windows:** cmd → pwsh → PowerShell 5 → Git Bash → bash → sh → WSL
5. **macOS/Linux:** `$SHELL` → `/bin/bash` → `/bin/zsh` → `/bin/sh` → fish
6. `openrouterAgent.shellFallbacks` (user extras)
7. Final: `spawn(command, { shell: true })`

### 13.2 Background commands

`isBackgroundCommand()` auto-detects dev servers (`npm run dev`, `vite`, `ng serve`, `docker compose up`, etc.):

- Captures initial output for 8s, then resolves `{ running: true }`
- Process continues detached
- Foreground timeout: 120s

### 13.3 Cancellation

`stopAllRunningProcesses()` kills all tracked non-background processes. Called from `handleStop()` when the user clicks Stop.

---

## 14. Permissions and approvals

### 14.1 Permission modes (`permissions.ts`)

Setting: `openrouterAgent.agentPermissions`

| Mode | Auto-approve reads | Auto-approve writes | Auto-approve commands |
|------|-------------------|--------------------|-----------------------|
| `ask` | Yes | No | No |
| `readOnly` | Yes | No | No |
| `workspace` | Yes | Yes | No |
| `full` | Yes | Yes | Yes (non-destructive only) |

Session "always allow" memory cleared on VS Code reload.

### 14.2 Approval bridge (`approvalBridge.ts`)

1. `confirmWriteFile()` / `confirmRunCommand()` check auto-approve
2. If not: `ApprovalBridge.request()` → posts `toolApproval` to webview
3. User picks Run / Always / Skip → `toolApprovalResponse` → `respond()`
4. `rememberApproval()` updates session memory

---

## 15. Model catalog (`openrouterModels.ts`)

`ModelPricingCache` — singleton, fetches `GET /api/v1/models` (24h TTL, persisted in global state).

Key capabilities detected per model:

| Capability | How detected |
|------------|-------------|
| `supportsVision` | `architecture.input_modalities` includes `'image'`/`'file'`; OR regex on model id |
| `supportsTools` | `supported_parameters` includes `'tools'`; **defaults to `true` for unknown ids** (frontier paid models always support tools; free/text-only marked false after catalog loads) |

Key methods:
- `supportsVision(modelId)` — used for vision attachment routing
- `supportsTools(modelId)` — gates whether native `tools` array is sent in requests
- `poolHasVisionModel(pool)` — checks if Auto pool can handle images
- `getDisplayForModel(modelId)` → `ModelPricingDisplay` (pricing line + compact badge)
- `getCatalogForPicker()` → `CatalogPickerItem[]` for the model picker webview

---

## 16. Attachments (`attachments.ts`)

### 16.1 Supported types

| Kind | Extensions / MIME | Sent to API as |
|------|-------------------|----------------|
| `image` | png, jpeg, webp, gif | `image_url` (base64 data URL) |
| `pdf` | application/pdf | `file` part (base64) |
| `text` | .ts, .md, .json, source files, etc. | Inline text in user message |

### 16.2 Storage

- Pending: in-memory + `globalStorageUri/attachments/_pending/`
- Committed: `globalStorageUri/attachments/<sessionId>/`
- Chat history stores only metadata (id, name, kind, size) — not raw bytes

### 16.3 Limits

- `maxAttachments` (default 5), `maxImageSizeMb` (default 4), `maxPdfSizeMb` (default 10), text max 120 KB

### 16.4 Paste screenshots

Webview listens for `paste` events on the composer; image/PDF clipboard items sent to extension via `addAttachments`.

---

## 17. Chat history (`chatHistory.ts`)

Persisted in extension global state (`openrouterAgent.sessions`, max 50):

Each `SavedChatSession`: `id`, `title`, `mode`, `modelId`, `messages[]`, timestamps.

Each `ChatSessionMessage`: `role`, `content`, `attachments?` (metadata), `details?` (tool step log for "Show details" collapse).

Sliding window: in-memory messages capped at 50 (keeps first 2 + most recent 48) to avoid unbounded growth. Full history persisted to storage.

---

## 18. Webview UI — live activity log & status

### 18.1 Request-level work clock

A **single continuous timer** runs from the moment the user sends until the final message arrives. Variables:

- `workStartedAt` — epoch ms when work started (set once per request)
- `working` — boolean
- `workPhase` — current action text (e.g. "Generating answer", "Reading workspace")
- `workDetail` — secondary detail (e.g. "15.6 KB")

Functions: `startWork()`, `stopWork()`, `setWorkPhase(phase, detail)`, `renderWorkStatus()`, `workHeartbeat()` (1s interval).

### 18.2 Composer footer status

`#workStatus` (`div.work-status`) sits in the center of the composer footer. While working it shows:

```
⟳  Writing file · 15.6 KB               5:57
```

- **Teal** (`--vscode-charts-teal`) spinner + phase + detail + right-aligned timer
- Hides pricing while working; restored after
- Respects `prefers-reduced-motion`

### 18.3 Inline stream working chip

While the model's stream is open but no visible text is arriving (reading files, draining hidden reasoning), the message-level blinking caret (`▍`) is replaced by a live **inline chip**:

```
● ● ●  Reading workspace
```

Transitions:
- Text flowing → normal blinking caret
- Tool-call args streaming → chip with real action (`Reading workspace`, `Writing file · N KB`) — fires immediately on `toolProgress`
- Quiet tail after answer (`workPhase === 'Generating answer'`) → chip after `STREAM_IDLE_FINISHING_MS` (1.2s)

### 18.4 Cycling reassurance phrases

During the "finishing up" tail, the inline chip cycles through gentle phrases every 3.5s:

1. "Working through the details…"
2. "Still working…"
3. "Almost there…"
4. "Polishing the response…"
5. "Wrapping things up…"

Footer keeps the steady **"Finishing up… · 0:NN"** label; inline cycles for engagement.

### 18.5 Activity log (thinking box)

During active tool steps, a **compact collapsible activity log** floats in the message list:

- **Header row:** step-type icon + current action (monospaced file paths) + animated dots + elapsed timer
- **History:** collapsed `▸ N steps` toggle — de-duplicated (`Explored files ×5`), capped height with scroll + fade
- **Step icons:** SVG per type — think (⋆), search (🔍), read (📄), glob (📂), write (✏), run (⬛), check (✓)
- **Card style:** `--vscode-editorWidget-background` with `1px solid --vscode-panel-border`

### 18.6 "Worked for X" summary

When the assistant message finalizes, a slim `✓ Worked for 1:45 · 25 steps` collapsible is prepended above the answer (using the same clock that started on send). Expand to review the iconified activity log. The separate raw "Show details" tool-result panel remains below.

### 18.7 Clickable file mentions

Inline `<code>` spans that look like file references (`agents.md`, `src/tools.ts`) are:

1. Collected after each assistant message renders
2. Verified by the extension (`resolveFiles` → `resolveExistingWorkspaceFile`)
3. Upgraded to **teal clickable links** (`code.file-link`) only if the file actually exists in the workspace

Clicking posts `openFile` → `showTextDocument` in `ViewColumn.One` (persistent tab). Files created during the run become clickable once the model mentions them afterward.

### 18.8 External link handling

All `<a href="https://…">` anchors are neutralized (`href` → `data-href`) before rendering. Clicking shows VS Code's **"Do you want Code to open the external website?"** confirm dialog and only opens the browser if confirmed. `bindMessageLinks` is idempotent (guarded by `data-linksBound='1'`) to prevent stacked listeners during streaming re-renders.

---

## 19. Models (`models.ts`)

| Storage | Key | Content |
|---------|-----|---------|
| Global state | `openrouterAgent.autoPoolEnabled` | Models toggled on for Auto |
| Global state | `openrouterAgent.selectedModelId` | Current selection or `__auto__` |
| Global state | `openrouterAgent.selectedModelInitialized` | Whether user has set a model |

**Default model for new chats:** `openrouter/owl-alpha`  
**Auto pool minimum:** 3 models (`MIN_AUTO_POOL_SIZE`)  
**Special id:** `__auto__` = Auto selection mode

---

## 20. Settings reference

All under `openrouterAgent.*` in VS Code Settings:

| Setting | Type | Default | Purpose |
|---------|------|---------|---------|
| `agentPermissions` | enum | `ask` | Tool approval level |
| `shell` | string | `""` | Primary shell override |
| `shellFallbacks` | string[] | `[]` | Extra shell paths |
| `chatFontSize` | number | `0` | Chat font px (0 = 14) |
| `streamResponses` | boolean | `true` | Token streaming |
| `contextGatherTimeoutMs` | number | `1500` | Max ms for context gather |
| `debugPerformance` | boolean | `false` | Log `[perf]` timing to console |
| `showModelPricing` | boolean | `true` | Per-million pricing in composer |
| `showAccountBalance` | boolean | `true` | OpenRouter balance badge |
| `maxAttachments` | number | `5` | Per-message attachment limit |
| `maxImageSizeMb` | number | `4` | Image size cap |
| `maxPdfSizeMb` | number | `10` | PDF size cap |

---

## 21. Build, debug, release

### 21.1 Development

```bash
npm install
npm run compile      # or npm run watch
# F5 → "Run OpenRouter Agent" in Extension Development Host
```

### 21.2 Tests

```bash
npm run test:sanitize   # Node regression tests (no VS Code needed)
```

Covers: Harmony token stripping, tool-call parsing across all formats, `parseNativeToolCall`, `assembleToolCallDeltas`, `getToolDefsForMode`, user file intent detection.

### 21.3 Version bumping

`scripts/bump-version-on-change.mjs` runs before compile:
- 1–3 changed `src/` files → **patch**
- 4+ files or `extension.ts` / `package.json` → **minor**

### 21.4 Package / publish

```bash
npm run package:vsix           # local .vsix
npm run publish:marketplace    # compile + package + vsce publish
```

---

## 22. Common modification guide for AI agents

### Add a new tool

1. Add native schema to `NATIVE_TOOL_DEFS` in `tools.ts`; include it in `getToolDefsForMode()`
2. Add tool name to `KNOWN_TOOLS` array; add case in `handleToolCall()`
3. Add case in `describeToolCall()` and `describeProcessStep()` / `describeProcessDone()`
4. Update system prompts in `agent.ts` (`ASK_SYSTEM` / `AGENT_SYSTEM`)
5. If write/command: wire approval in `confirmWriteFile` / `confirmRunCommand` pattern
6. Test via F5

### Add a new webview ↔ extension message type

1. Add handler branch in `handleWebviewMessage()` (and declare in the type union)
2. Add server method if needed; post with `this.post({ type: ... })`
3. Add JS handler in `getHtml()` → `window.addEventListener('message', …)` switch
4. **Avoid backticks and `${…}` in webview JS/CSS** — the HTML is a TypeScript template literal; they will be interpreted by the TS compiler.

### Change model Auto selection

Edit scoring in `autoModel.ts` → `scoreModel()`. Regex constants: `FAST`, `REASON`, `AGENT`, `VISION`, `CODE`.

### Change the activity log / UI

Edit `getHtml()` in `chatView.ts` (inline CSS + JS in the template string). Key functions:

| Function | Purpose |
|----------|---------|
| `renderProcessHtml(completed, current, thought)` | Builds the thinking-box HTML |
| `showThinking / updateThinking / removeThinking` | Thinking-box lifecycle |
| `makeStreamCursor()` | Returns caret or working chip depending on `streamCursorWorking` |
| `setWorkPhase(phase, detail)` | Updates footer status + inline chip label |
| `startWork / stopWork` | Request clock lifecycle |
| `buildActivitySummary(el)` | Prepends "Worked for X" collapsible |
| `linkifyFileMentions(root)` | Detects + verifies file-like code spans |

### Add a new setting

1. Add property under `contributes.configuration.properties` in `package.json`
2. Read via `vscode.workspace.getConfiguration('openrouterAgent').get(...)`
3. Listen with `onDidChangeConfiguration` if UI must refresh (see `chatFontSize` pattern)

### Change shell behavior

Edit `terminalRunner.ts`:
- `windowsShellCandidates()` / `unixShellCandidates()` — add/remove shells
- `buildEnv()` — PATH repair for extension host
- `buildSpawnArgs()` — shell-specific argument format
- `BACKGROUND_PATTERNS` — auto-background command detection

---

## 23. Error handling patterns

| Layer | Pattern |
|-------|---------|
| OpenRouter | Returns `**Error:**` / `**API Error:**` / `**Network Error:**` strings; caller checks prefix |
| Abort | `AskOpenRouterAbortedError` / `AbortController.signal` |
| Tools | JSON `{ error: "..." }` returned to LLM as user message; native blocked calls get `role:'tool'` error result |
| Terminal | `success: false` in result JSON; `fallbacksAttempted` listed |
| Webview | `{ type: 'error', message }` posted to UI |
| File ops | `resolveWorkspacePath()` validates before any FS access |

---

## 24. Security model

- API keys: Secret Storage only, never in `settings.json`
- File access: workspace-scoped (`resolveWorkspacePath` blocks `../` traversal)
- Writes/commands: user approval (configurable by mode)
- Destructive commands: always prompt, never auto-approve
- External links: VS Code confirm dialog before opening browser
- No telemetry or external analytics
- Chat + attachments stored locally in extension global storage

See `PRIVACY.md` for user-facing disclosure.

---

## 25. Git conventions

- Commit author: **Zihad Hosan** only
- Do **not** add `Co-authored-by: Cursor` or `Made-with: Cursor` trailers
- Optional hook: `.githooks/commit-msg` strips Cursor attribution
- Enable: `git config core.hooksPath .githooks`

---

## 26. Related user docs

| File | Audience |
|------|----------|
| `README.md` | End users / Marketplace |
| `docs/DEVELOPMENT.md` | Contributors (F5, clone) |
| `docs/RELEASE.md` | Release checklist |
| `CHANGELOG.md` | Version history |
| `PRIVACY.md` | Privacy policy |
| `agents.md` | AI agents / deep architecture (this file) |

---

## 27. Mental model summary

1. **User types in webview** → message goes to `ChatViewProvider`
2. **Context + history + attachments** assembled by `agent.ts` / `attachments.ts`
3. **Request-level work clock starts** (`startWork()`) — drives footer status + inline chip
4. **Native tool schemas** (`getToolDefsForMode`) sent with the request if model supports tools
5. **OpenRouter** called via `askOpenRouterToolAware()` (streaming + native tool-call assembly)
6. **Stream ends early** at `finish_reason` or `<|return|>` — no wasted tail wait
7. **Native `toolCalls`** → `runNativeToolCalls()` (role:'assistant' + role:'tool' turns); OR
   **Text agent-tool blocks** → `parseAllToolCalls()` → `handleToolCall()` (text fallback path)
8. **Tool results** appended to conversation → loop until final answer or max iterations
9. **Activity log collapses** to "✓ Worked for X · N steps" summary on the finished message
10. **File mentions** in the response are verified and become clickable links to open in editor
11. **Everything persisted** in `ChatHistoryStore`; API key in `ApiKeyStore`

The extension is intentionally **self-contained**: no backend server, no database — only VS Code APIs, local FS, and OpenRouter HTTP.

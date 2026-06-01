# Changelog

All notable changes to **OpenRouter Agent** are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).  
Version numbers match `package.json` (auto-bumped on `src/` changes during `npm run compile`).

---

## [Unreleased]

### Added
- **Composer busy border** — a teal gradient “snake” (~50% of the edge, blunt lead and soft tail) travels slowly on a 1px ring while a prompt runs; static border removed while busy; reduced-motion uses static border only.
- **Composer balance badge** — shows OpenRouter credit balance (teal when positive, orange at $0) in the top-right of the message box when the API returns account or per-key limit data.
- **Full OpenRouter model picker** — searchable catalog with **Free** / **Paid** tabs; scrollable menu (~280px). **Auto** mode uses on/off toggles (min 2 models); paid-model tip in the Auto banner.
- **Composer capability hint** — fixed message above the input when the selected model (or Auto pool) cannot read images/PDFs; hidden for vision-capable models.
- **Catalog vision detection** — `architecture.input_modalities` from OpenRouter API (regex fallback).
- **Model pricing in composer** — shows `$X/M input tokens | $Y/M output tokens` (teal numerals) when the panel is wide; collapses to teal **free** / **paid** when narrow (full line in tooltip).

### Changed
- **Enable Auto** — disabled button shows a tooltip when fewer than 3 pool models are toggled on.
- **Settings** — removed `openrouterAgent.models` list (models are managed in the chat model menu only).
- **Model picker** — Auto pool models (teal switches) always appear at the top of the catalog; clearer why/how Auto copy; removed misleading “Using N models from your pool” status (Auto still scores every pool model and picks one per message).
- First install defaults to `z-ai/glm-4.5-air:free` with a 2-model Auto pool seeded from settings.
- Removed **Add model…** / **Remove model…** from chat (use catalog + Auto toggles).
- Model picker: taller **380px** menu, inline **Free** / **Paid** toggle tags (teal when on, both off = show all), model trigger **88–160px** width.
- **Auto Enable/Disable** — catalog hidden when Auto is on; tap model name to pick, toggles only for pool; min **3** models to enable Auto; fixes trigger stuck on Auto.
- System prompts clarify text `agent-tool` format, parallel read tools, and that workspace files are readable via tools.

### Fixed
- **Assistant message UI** — empty `json` / `tool` code fences no longer render copy-only shells; streaming cursor no longer blinks after the reply finishes (stale render race).
- **New chat model selection** — new sessions default to the first model (not Auto); Disable Auto works on new chats (no race overwriting the chosen model).
- **Composer top row** — capability hint shrink-wraps to content; balance vertically centered on the same line; balance refetches after each completed prompt.
- **Composer layout** — balance badge and vision/text-only hint share a flex top row (no overlap on narrow panels); hint text smaller and orange; compact `$X.XX` balance on narrow composers.
- **Insufficient credits (HTTP 402)** — clearer chat message for paid models with no OpenRouter balance (402 status + credit keywords); link to [OpenRouter Credits](https://openrouter.ai/settings/credits) and suggest free models.
- **Provider API errors** — surface upstream details from OpenRouter `error.metadata` when available; append **What you can try** hints; Auto mode retries another pool model on generic provider failures.
- **Model picker search** — typing no longer stops after one letter (list updates without rebuilding the search field).
- **Stray line over footer dropdowns** — closed model menu fully hidden when chat opens.
- **Tool interruption text in chat** — strip Roo-style `[Response interrupted by a tool use result…]` from streams and replies; retry with correct `agent-tool` format when models emit it without runnable tools.
- **False "can't access files" in Agent/Ask** — tech-stack and project questions trigger auto-read of `package.json` and `README.md`, broader file-verification rules, and retries when models refuse to call tools without reading the workspace.

---

## [1.13.1] — 2026-06-01

### Added
- **Editor-style code blocks** — fenced code renders as mini editor panels with line numbers, language label, syntax highlighting (highlight.js), and one-click copy.
- **Copy icon feedback** — icon-only copy button swaps to a green checkmark for ~1.5s after a successful copy.
- **Tool result cache** — `read_file`, `list_files`, and `read_glob` results are cached with TTL to avoid redundant workspace reads within a session.
- **Context cache** — workspace and active-file context is cached briefly to speed repeated prompts in the same session.
- **Parallel read tools** — multiple read tools emitted in one assistant turn run concurrently (capped batch size).
- **Model fallback on API errors** — Auto mode retries with alternate models and exponential backoff when the API returns retryable errors.
- **Workspace indexer** — background file scan on activation builds an in-memory index (foundation for fast search).
- **Performance debug** — setting `openrouterAgent.debugPerformance` (or env `DEBUG_PERF=1`) logs `[perf]` timing spans to the Developer Console.
- **Sliding-window chat history** — keeps the last 50 messages in memory per session to reduce payload size on long chats.
- **`npm run build:hljs`** — bundles highlight.js languages into `media/highlight.min.js`.

### Fixed
- **Tool JSON in chat stream** — raw `agent-tool` / tool-call markup is stripped during streaming in Ask and Agent modes, so models like `openrouter/owl-alpha` no longer dump tool JSON into visible replies.
- **Batch file reads** — system prompts allow multiple `read_file` calls in one response when the model needs several files at once.

### Changed
- **Code block styling** — single elevated surface for header, gutter, and code; softer outer border; no header divider or mismatched grey backgrounds.
- Agent system prompt documents optional `THOUGHT:` reasoning prefix before tool calls.

---

## [1.4.1] — 2026-05-30

### Added
- **Chat attachments** — paperclip button and drag-and-drop for images (PNG/JPEG/WebP/GIF), PDFs, and text/code files.
- Attachments sent to OpenRouter as multimodal message content; **Auto** prefers vision-capable models when images/PDFs are attached.
- Attachment previews in chat history; files stored locally under extension global storage (not in settings JSON).
- Settings: `openrouterAgent.maxAttachments`, `maxImageSizeMb`, `maxPdfSizeMb`.

---

## [1.6.1] — 2026-05-30

### Added
- **Remove model…** in the chat model dropdown — removes models added via **Add model…** (default Settings models are still edited in `openrouterAgent.models`).

---

## [1.6.0] — 2026-05-30

### Added
- **Paste screenshots** — Ctrl+V / Cmd+V in the message box attaches clipboard images (Win+Shift+S, Print Screen, etc.).

### Fixed
- **Image attachment previews** — thumbnails in the attachment bar and chat history render correctly (webview CSP allows `data:` URLs).
- **Vision warning dialog** — single Cancel button; **Use Auto** and **Send anyway** options when a non-vision model is selected with images/PDFs.
- **Paperclip icon** alignment in the attach button.

### Changed
- **Auto + images/PDFs** — picks only from vision-capable models in your list; blocks send with a clear message if none are configured.
- OpenRouter image-input errors include a hint to switch to **Auto** or add a vision model.

---

## [1.5.0] — 2026-05-30

### Changed
- **Attachment analysis (hybrid mode)** — text/PDF attachments are flattened into a single user message with file content before your question, so weaker models read inline content first.
- When attachments are present, turn 1 skips automatic workspace file listing/verification; the UI shows **Analyzing &lt;filename&gt;…** instead of generic file checks.
- System prompt tells the model to analyze attached content directly and not call `read_file` for attached filenames unless you ask to compare with workspace copies.
- Raw tool JSON (`{"tool":"read_file",...}` and `agent-tool` blocks) is stripped from streamed and final chat output when attachments are on the message.
- Soft hint when using free models with text attachments: **Auto** or a stronger model may give cleaner results.

---

## [1.3.0] — 2026-05-30

### Changed
- **Auto model selection** — picks one model from your available list per request (by Ask / Plan / Agent mode and message), instead of a fixed fallback chain or “free models” label.
- Removed misleading **Auto = free models** UI copy; settings and README describe Auto behavior accurately.

---

## [1.2.0] — 2026-05-30

### Changed
- **Model dropdown** — wider menu with full model ids; trigger stays compact (Auto / shortened names).
- **Default Auto models** — free-tier only (`z-ai/glm-4.5-air:free`, `openrouter/owl-alpha`); removed paid DeepSeek default.
- Settings and chat hint clarify that **Auto** uses free fallbacks; paid models via **Add model…**.
- **README** — first-time setup quick path for new installs.

---

## [1.0.0] — 2026-05-30

### Added
- **Marketplace-ready metadata** — publisher, repository, license, keywords, gallery banner, 128×128 icon.
- **[LICENSE](./LICENSE)** (MIT) and **[PRIVACY.md](./PRIVACY.md)** (OpenRouter data handling).
- README section for publishing to VS Code Marketplace.

### Changed
- `publisher` set to **`ZihadHosan`** (register this id at [Visual Studio Marketplace](https://marketplace.visualstudio.com/manage) before `vsce publish`).
- Category includes **Machine Learning**.
- `.vscodeignore` tightened so dev files are not bundled in the VSIX.

---

## [0.9.3] — 2026-05-30

### Added
- **Smart auto-scroll** during streaming — follows new tokens only while you are at the bottom of the chat.
- **↓ Latest** button when you scroll up mid-reply; click to jump back and resume follow mode.

### Changed
- Scrolling up while the model is still writing no longer fights your position; auto-scroll resumes when you return to the bottom (~48px threshold) or send a new message.

---

## [0.9.2] — 2026-05-30

### Fixed
- Strip harmony/channel delimiter tokens from model output (e.g. `<|channel|>final<|message|>` from `openrouter/owl-alpha` and similar models).
- Sanitize during streaming, display, and saved chat history.

### Changed
- System prompt instructs models not to emit special delimiter tokens.

---

## [0.9.1] — 2026-05-30

### Changed
- **User messages** — stronger background contrast (`color-mix` tint + border) so your prompts are easy to spot in dark themes.

---

## [0.9.0] — 2026-05-30

### Fixed
- **VS Code editor webview** — theme-safe CSS using `--vscode-panel-background` fallbacks so user vs assistant styling matches Cursor.
- **Stale webview** — refresh HTML on extension activate when the chat panel is already open (`retainContextWhenHidden` cache).

### Changed
- User bar uses input-style tokens with `color-mix` fallbacks; assistant replies stay plain (no box, no label).

---

## [0.8.0] — 2026-05-30

### Added
- **Streaming responses** — token-by-token delivery via OpenRouter SSE (`openrouterAgent.streamResponses`, default on).
- Live markdown rendering with throttled updates (~80ms), streaming cursor, and thinking → answer morph.
- Message entrance animation (`msg-enter`); respects `prefers-reduced-motion`.
- **`openrouterAgent.streamResponses`** setting to disable streaming.

### Changed
- Agent tool-loop iterations cancel stream UI when a tool call is detected; only the final user-visible answer streams.
- Custom dropdowns for History, Mode, and Model (themed menus, fixed positioning, body-appended menus to avoid clipping).

---

## [0.7.x] — 2026-05-30

### Added
- Full **markdown** rendering in chat (`marked` — headings, lists, tables, links).
- **`openrouterAgent.chatFontSize`** setting.
- Pipe-table normalization for models that omit header/separator rows.
- Auto version bump script on compile (`scripts/bump-version-on-change.mjs`).

### Changed
- Chat typography — UI sans-serif, 14px default, improved line-height and contrast.
- Assistant messages — flat layout, no nested grey boxes; inline code border-only.
- Scroll UX — assistant messages scroll to **start**, user to **end**; table horizontal wrap.
- Larger **+** (new chat) button; modern SVG chevron on dropdowns.

### Fixed
- **VSIX size** — exclude stale `openrouter-agent/` duplicate folder (~64 KB vs ~3.8 MB).
- Dropdown menus opening upward and clipping inside composer (`position: fixed`, body append).
- Native `<select>` white popup on Windows replaced with custom dropdowns.

---

## [0.6.x and earlier]

### Added
- **Ask**, **Plan**, and **Agent** modes with OpenRouter API.
- Read-only file tools in Ask mode; `read_glob` and verified file reads.
- Tool approval cards, terminal run UI, chat history / sessions.
- Enter to send, **Stop** button, API key secure storage.
- Status bar entry and `Ctrl+Alt+L` shortcut.

### Changed
- Extension moved to repo root; README for VS Code and Cursor.

### Fixed
- Git commit attribution — Cursor co-author trailers removed from history.


# Changelog

All notable changes to **OpenRouter Agent** are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).  
Version numbers match `package.json` (auto-bumped on `src/` changes during `npm run compile`).

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

---

## [Unreleased]

_Work in progress will be listed here before the next version bump._

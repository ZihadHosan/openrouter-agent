# OpenRouter Agent

AI chat for **VS Code** and **Cursor** — **Ask**, **Plan**, and **Agent** modes powered by [OpenRouter](https://openrouter.ai/). Use any OpenRouter model (free or paid). Chat opens in a **panel on the right**, beside your code.

[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/ZihadHosan.openrouter-agent?label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=ZihadHosan.openrouter-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## Install

**From the Marketplace (recommended)**

1. Open **Extensions** (`Ctrl+Shift+X` / `Cmd+Shift+X`)
2. Search **OpenRouter Agent**
3. Click **Install**, then **Reload** if prompted

Or from the terminal:

```bash
code --install-extension ZihadHosan.openrouter-agent
```

**Manual install** (`.vsix` or building from source) → see [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md).

---

## Get started

### First-time setup (quick path)

1. **Install** from Extensions → search **OpenRouter Agent** → **Install** → **Reload** if prompted.
2. **Set API key** — **Ctrl+Shift+P** → **`OpenRouter: Set API Key`** → paste a key from [openrouter.ai/keys](https://openrouter.ai/keys).
3. **Open chat** — click **OpenRouter** in the status bar, or press **Ctrl+Alt+L** (Mac: **Cmd+Alt+L**), or run **`OpenRouter: Open Chat`** from the Command Palette.
4. **Send a message** — pick **Ask**, **Plan**, or **Agent**; attach **images, PDFs, or files** with the paperclip; use **Auto** or pick a model.

### 1. Open a workspace

Open a project folder (**File → Open Folder**). **Ask** and **Agent** modes need a workspace on disk to read files.

### 2. Set your API key

Your key is stored in the editor’s **secret storage** (not in plain settings).

1. **Ctrl+Shift+P** (Mac: **Cmd+Shift+P**)
2. Run **`OpenRouter: Set API Key`**
3. Paste a key from [openrouter.ai/keys](https://openrouter.ai/keys)

Remove it anytime: **`OpenRouter: Clear API Key`**.

### 3. Open chat

| Method | Action |
|--------|--------|
| **Status bar** | Click **OpenRouter** (bottom-right) |
| **Shortcut** | **Ctrl+Alt+L** (Mac: **Cmd+Alt+L**) |
| **Command Palette** | **`OpenRouter: Open Chat`** |
| **Editor toolbar** | Chat icon on an open file |

### 4. Send a message

- **Enter** to send · **Shift+Enter** for a new line
- **Paperclip**, **Ctrl+V / Cmd+V** (paste screenshots), or drag-and-drop to attach images, PDFs, or text/code files
- Pick **Ask**, **Plan**, or **Agent** and a **model** below the input
- While the model works, **↑** becomes **Stop (■)**

---

## Features

- **Ask** — Q&A and read-only file exploration in your workspace
- **Plan** — Step-by-step plans without running tools
- **Agent** — Read, write (with approval), and terminal commands (with approval)
- **Streaming replies** — Token-by-token responses (disable in settings)
- **Chat history** — Sessions saved automatically; switch or start new chats
- **Any OpenRouter model** — Settings list + **Add model…** / **Remove model…** in chat (chat-added models are stored separately from Settings)
- **Attachments** — Images, PDFs, and text/code files in chat. **Images and PDFs require a vision-capable model** (or **Auto** with at least one vision model in your list). Paste screenshots with Ctrl+V / Cmd+V. Text/PDF content is inlined for direct analysis; **Agent** can still use workspace tools for other paths in follow-ups.
- **Smart scroll** — Follows new text unless you scroll up to read earlier content

---

## Modes

### Ask

Best for explaining code, reading files, and quick answers.

- Reads and lists workspace files automatically
- Does not write files or run terminal commands

### Plan

Best for designing before you code.

- Ordered steps, files to touch, risks, and commands **you** run manually
- Does not edit files or call tools

### Agent

Best for multi-step work with your approval.

| Action | Behavior |
|--------|----------|
| Read / list files | Runs automatically |
| Write files | Approval card in chat |
| Terminal commands | Approval card; output in chat |

Default permission level: **`OpenRouter: Agent Permissions`** (Command Palette).

### Attachments

- **Text/code files** (`.md`, `.txt`, source files, etc.) and **PDFs** are sent inline in your message — the model should analyze them without listing the workspace first.
- **Images** and **PDFs** require a **vision-capable** model (e.g. Gemini Flash, GPT-4o, Claude). **Auto** picks only from vision-capable models in your list when images/PDFs are attached.
- **Paste screenshots** into the message box with **Ctrl+V** (Mac: **Cmd+V**) after Win+Shift+S, Print Screen, or any screenshot tool.
- **Paperclip** and drag-and-drop also work for images, PDFs, and text files.
- In **Agent** or **Ask**, you can still ask about *other* workspace files in the same or a follow-up message; tools run normally for those paths.
- Text-only models (including many DeepSeek ids) cannot accept image input on OpenRouter — use **Auto** or add a vision model via **Add model…**.

---

## Settings

Open **Settings** (`Ctrl+,`) and search **`openrouterAgent`**.

| Setting | Purpose |
|---------|---------|
| **`openrouterAgent.agentPermissions`** | `ask` · `readOnly` · `workspace` · `full` |
| **`openrouterAgent.shell`** | Custom shell for in-chat commands |
| **`openrouterAgent.shellFallbacks`** | Extra shell paths if defaults fail |
| **`openrouterAgent.chatFontSize`** | Chat text size in px (`0` = 14px) |
| **`openrouterAgent.streamResponses`** | Stream replies token-by-token (default: on) |
| **`openrouterAgent.showAccountBalance`** | Show OpenRouter balance in the chat composer (default: on) |
| **`openrouterAgent.maxAttachments`** | Max files/images per message (default: 5) |
| **`openrouterAgent.maxImageSizeMb`** | Max image size in MB (default: 4) |
| **`openrouterAgent.maxPdfSizeMb`** | Max PDF size in MB (default: 10) |

**Auto** picks one model per message from models you enable in the chat model menu (teal pool toggles), based on mode and what you wrote.

### Managing models

| Action | Where |
|--------|--------|
| **Pick a model for chat** | Model dropdown → tap a model name |
| **Build Auto pool** | Model dropdown → turn on **teal switches** (at least 3), then **Enable Auto** |
| **Disable Auto** | Model dropdown → **Disable Auto**, then pick a model by name |
| **Browse catalog** | Model dropdown → search, **Free** / **Paid** filters |

---

## Commands

| Command | Description |
|---------|-------------|
| **OpenRouter: Open Chat** | Open or focus chat |
| **OpenRouter: Set API Key** | Save API key |
| **OpenRouter: Clear API Key** | Remove API key |
| **OpenRouter: Agent Permissions** | Default tool approval behavior |
| **OpenRouter: Ask About Current File** | Ask mode with open file context |
| **OpenRouter: Explain Selection** | Explain selected code |
| **OpenRouter: Fix Selection** | Suggest a fix for selection |

---

## Chat history

- Conversations **save automatically**
- **History** dropdown — switch sessions
- **+** new chat · **Del** delete session · **Clear** clear current chat only

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Chat doesn’t open | Reload window; confirm extension is **Enabled** |
| **Ctrl+Alt+L** does nothing | Command Palette → **OpenRouter: Open Chat** |
| “No API key” | **OpenRouter: Set API Key** |
| **Insufficient credits** on a paid model | Add credits at [openrouter.ai/settings/credits](https://openrouter.ai/settings/credits), or pick a **free** model (`:free` suffix or **Free** filter in the model menu) |
| Balance badge missing | OpenRouter may not expose balance for your key type; add credits at [openrouter.ai/settings/credits](https://openrouter.ai/settings/credits) or set a per-key credit limit on [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) |
| Agent can’t run commands | Open a workspace folder; set **`openrouterAgent.shell`** if needed |
| Wrong files in Ask mode | Open the correct folder; start a **new chat** |
| Extension feels outdated | Extensions → check for updates, or reload window |

---

## Privacy & safety

- API keys stay in **VS Code secret storage**
- File access is limited to the **open workspace**
- Writes and commands require approval (unless you change permissions)
- Destructive commands show an extra warning

Full disclosure: **[PRIVACY.md](./PRIVACY.md)** — what is sent to OpenRouter and what stays local.

---

## Development

Building from source, F5 debug, and full contributor guide:

**[docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)**

**Release checklist** (local VSIX + Marketplace publish — use this when shipping a new version):

**[docs/RELEASE.md](./docs/RELEASE.md)**

---

## Changelog

**[CHANGELOG.md](./CHANGELOG.md)**

---

## License

MIT — see [LICENSE](./LICENSE).

# OpenRouter Agent — Free AI Coding Assistant for VS Code

<p align="center">
  <img src="media/openrouter-agent-banner.png" alt="OpenRouter Agent — Free AI Coding Assistant for VS Code" width="100%" />
</p>

**Use Claude, GPT-4o, Gemini, DeepSeek, and 300+ AI models directly in VS Code — free.**  
No subscription. No lock-in. Bring your own [OpenRouter API key](https://openrouter.ai/keys) (free tier available).

The free AI coding assistant for VS Code and Cursor. Ask questions about your codebase, generate step-by-step plans, or let the **Agent** autonomously read files, write code, and run terminal commands — with your approval. Works with Claude, GPT-4o, Gemini, DeepSeek, and 300+ models via a single OpenRouter API key.

[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/ZihadHosan.openrouter-agent?label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=ZihadHosan.openrouter-agent)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/ZihadHosan.openrouter-agent)](https://marketplace.visualstudio.com/items?itemName=ZihadHosan.openrouter-agent)
[![Open VSX](https://img.shields.io/open-vsx/v/ZihadHosan/openrouter-agent?label=Open%20VSX)](https://open-vsx.org/extension/ZihadHosan/openrouter-agent)
[![Rating](https://img.shields.io/visual-studio-marketplace/stars/ZihadHosan.openrouter-agent)](https://marketplace.visualstudio.com/items?itemName=ZihadHosan.openrouter-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## Why OpenRouter Agent?

Most AI coding assistants lock you into one provider, one model, and a monthly subscription. OpenRouter Agent is different:

| | **OpenRouter Agent** | Subscription-based assistants | Single-provider tools |
|---|---|---|---|
| **50+ free models** | ✅ No billing required | ❌ Subscription required | ⚠️ Limited |
| **300+ model catalog** | ✅ Claude, GPT-4, Gemini & more | ❌ Fixed model set | ❌ One provider |
| **Auto model routing** | ✅ Smart per-message pick | ❌ | ❌ |
| **No monthly fee** | ✅ Pay only for what you use | ❌ $10–40/mo | ⚠️ Varies |
| **Approval-based Agent** | ✅ You approve every write & command | ⚠️ Varies | ⚠️ Varies |
| **Works in Cursor IDE** | ✅ | ❌ | ⚠️ Varies |
| **Image & PDF attachments** | ✅ | ⚠️ Varies | ❌ |
| **Bring your own API key** | ✅ Full control | ❌ | ⚠️ Varies |

---

## Features

🤖 **300+ AI models** — Claude 3.5 Sonnet, GPT-4o, Gemini 2.0 Flash, DeepSeek, Llama, Mistral, and more. Swap models per conversation without leaving VS Code.

💸 **Free models included** — dozens of high-quality `:free` models (including `openrouter/owl-alpha`, `google/gemini-flash`, `meta-llama` and others) — no billing required.

🧠 **Auto model routing** — enable **Auto** mode and the extension automatically picks the best model from your pool for each message, based on mode, message type, and vision needs.

🔧 **Agent mode** — the AI reads your workspace files, proposes changes, and runs terminal commands. Every write and command requires your explicit approval. Destructive commands always prompt.

📋 **Ask & Plan modes** — read-only workspace Q&A and step-by-step planning without touching files or running commands.

📎 **Image, PDF & file attachments** — paste screenshots (Win+Shift+S → Ctrl+V), attach PDFs, images, or source files. Vision-capable models analyze them directly.

🗂️ **@ file mentions** — type `@` in the composer to search and select workspace files as you type; the selected file's content is read and included automatically, and shows as a clickable teal chip in your message.

🔗 **Clickable file mentions** — when the AI mentions a file that exists in your workspace (e.g. `agents.md`), it becomes a clickable link that opens the file in a real editor tab.

📊 **Live activity log** — a compact, collapsible step-by-step progress panel shows exactly what the agent is doing, how long it's taken, and what files it's reading or writing — with per-type icons and a ticking elapsed timer.

✅ **"Worked for X" summary** — when the agent finishes, a collapsible `✓ Worked for 1:45 · 25 steps` summary sits above the answer so you can audit the work.

🔒 **Privacy-first** — API key stored in VS Code secure storage, never in settings. File access is workspace-scoped. No telemetry.

---

## Install

**VS Code**
1. Open **Extensions** (`Ctrl+Shift+X`)
2. Search **OpenRouter Agent** → **Install**

**Cursor**
1. Open **Extensions** (`Ctrl+Shift+X`)
2. Search **OpenRouter Agent** → **Install**
   — or install directly from [Open VSX](https://open-vsx.org/extension/ZihadHosan/openrouter-agent)

**Terminal**
```bash
# VS Code
code --install-extension ZihadHosan.openrouter-agent

# Cursor
cursor --install-extension ZihadHosan.openrouter-agent
```

**Manual install** (`.vsix` or building from source) → see [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md).

---

## Quick Start

1. **Install** the extension and reload VS Code.
2. **Set your API key** — `Ctrl+Shift+P` → **`OpenRouter: Set API Key`** → paste a key from [openrouter.ai/keys](https://openrouter.ai/keys). The free tier gives you access to 50+ free models immediately.
3. **Open chat** — press **`Ctrl+Alt+L`** (Mac: `Cmd+Alt+L`), click **OpenRouter** in the status bar, or use the Command Palette.
4. **Pick a mode and model** — choose **Ask**, **Plan**, or **Agent** and select any model from the in-chat catalog (or use **Auto** to let the extension pick).

> 💡 **New to OpenRouter?** Create a free account at [openrouter.ai](https://openrouter.ai/), grab an API key, and use any `:free` model at zero cost.

---

## Modes

### 🔍 Ask Mode
Best for **explaining code, reading files, and quick answers**.

- Reads and lists workspace files automatically via `list_files`, `read_file`, `read_glob`
- Does not write files or run terminal commands
- Great for: "explain this function", "find all API calls", "summarize this codebase"

### 📋 Plan Mode
Best for **designing before you code**.

- Produces ordered step-by-step plans with files to change and risks
- No tools run — commands are listed for you to run manually
- Great for: "plan a migration from REST to GraphQL", "how should I refactor this module"

### 🤖 Agent Mode
Best for **multi-step autonomous work with your approval**.

| Action | Behavior |
|--------|----------|
| Read / list files | Runs automatically |
| Write files | **Approval card in chat** — you confirm before anything is written |
| Terminal commands | **Approval card** — output streams live in chat |
| Destructive commands (`rm -rf`, etc.) | **Always prompts**, regardless of permission mode |

Default permission level: **`OpenRouter: Agent Permissions`** in the Command Palette.

---

## Model Catalog & Auto Mode

OpenRouter Agent gives you access to **300+ models** from a searchable in-chat catalog:

- **Browse** — search by name, filter by **Free** or **Paid**
- **Pick any model** for a single conversation
- **Auto mode** — enable at least 3 models with the teal toggles, then **Enable Auto**. The extension scores and picks the best model for each message (vision-aware, mode-aware)
- **Per-message pricing** shown in the composer footer so you always know the cost
- **Balance badge** shows your OpenRouter credit balance in real time

Popular free models available:
- `openrouter/owl-alpha` (default)
- `google/gemini-2.0-flash-lite:free`
- `meta-llama/llama-3.3-70b-instruct:free`
- `deepseek/deepseek-r1:free`
- `mistralai/mistral-7b-instruct:free`

---

## Attachments

Attach **images, PDFs, and text/code files** to any message:

| How | What |
|-----|------|
| Paperclip button | Browse files (images, PDFs, source files) |
| Drag and drop | Drop files into the composer |
| Ctrl+V / Cmd+V | Paste screenshots directly from clipboard |

- **Text/code files** and **PDFs** are sent inline — the model analyzes them directly
- **Images and PDFs** require a vision-capable model (Claude, GPT-4o, Gemini) — or use **Auto** with a vision model in your pool
- In Agent mode, you can ask about other workspace files in the same conversation alongside attachments

---

## Keyboard Shortcut

| Action | Windows / Linux | macOS |
|--------|----------------|-------|
| Open chat | `Ctrl+Alt+L` | `Cmd+Alt+L` |

---

## Commands

| Command | Description |
|---------|-------------|
| **OpenRouter: Open Chat** | Open or focus chat panel |
| **OpenRouter: Set API Key** | Save API key securely |
| **OpenRouter: Clear API Key** | Remove stored API key |
| **OpenRouter: Agent Permissions** | Set tool approval level |
| **OpenRouter: Ask About Current File** | Open chat with the active file as context |
| **OpenRouter: Explain Selection** | Explain selected code in Ask mode |
| **OpenRouter: Fix Selection** | AI-suggest a fix, apply with one click |

---

## Settings

Open **Settings** (`Ctrl+,`) and search **`openrouterAgent`**.

| Setting | Purpose |
|---------|---------|
| `agentPermissions` | `ask` · `readOnly` · `workspace` · `full` |
| `shell` | Custom shell for in-chat terminal commands |
| `shellFallbacks` | Extra shell paths tried if defaults fail |
| `chatFontSize` | Chat text size in px (`0` = 14px) |
| `streamResponses` | Stream replies token-by-token (default: on) |
| `contextGatherTimeoutMs` | Max ms to wait for editor/workspace context |
| `debugPerformance` | Log `[perf]` timing to the Developer Console |
| `showModelPricing` | Per-million token pricing in the composer |
| `showAccountBalance` | OpenRouter balance badge in chat |
| `maxAttachments` | Max attachments per message (default: 5) |
| `maxImageSizeMb` | Max image size in MB (default: 4) |
| `maxPdfSizeMb` | Max PDF size in MB (default: 10) |

---

## Chat History

- Conversations **save automatically** across VS Code sessions
- **History dropdown** — switch between sessions; each session remembers its model
- **+** new chat — starts fresh on the default model
- **Delete** session or **Clear** current chat at any time

---

## Frequently Asked Questions

**Is OpenRouter Agent free?**  
Yes. The extension itself is free and open-source (MIT). You can use it at zero cost with any of the 50+ free models on OpenRouter (models with the `:free` suffix). Paid models (Claude, GPT-4o, Gemini Pro, etc.) cost only what you actually use — there is no subscription or monthly fee.

**Does it work in Cursor IDE?**  
Yes. OpenRouter Agent works in both VS Code and Cursor. Install it from the VS Code Marketplace or the Cursor extension panel — setup is identical.

**What AI models can I use?**  
Any model available on [OpenRouter](https://openrouter.ai/models) — 300+ models including Claude 3.5 Sonnet, GPT-4o, Gemini 2.0 Flash, DeepSeek R1, Llama 3.3, Mistral, and many more. Free models are available immediately with a free OpenRouter account.

**How is Auto mode different from picking a model manually?**  
Auto mode scores every model in your pool for each individual message — taking into account the mode (Ask/Plan/Agent), message length, and whether you have image attachments — and routes to the best fit automatically. You build the pool; the extension decides per-message.

**Is my code sent to the cloud?**  
Only the content you explicitly include in your message is sent to OpenRouter (and forwarded to the chosen model provider). Your API key is stored in VS Code's secure secret storage and never appears in settings or logs. File access is limited to your open workspace folder. There is no telemetry.

**Can it write and run code autonomously?**  
In **Agent mode**, yes — but with mandatory approval gates. Every file write and every terminal command shows an approval card in chat that you must confirm before anything happens. Destructive commands (like `rm -rf`) always prompt regardless of your permission settings. You are always in control.

**What is the difference between Ask, Plan, and Agent mode?**  
**Ask** reads your workspace and answers questions (read-only). **Plan** produces step-by-step written plans without touching any files. **Agent** can read, write, and run commands with your approval.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Chat doesn't open | Reload window; confirm extension is **Enabled** |
| `Ctrl+Alt+L` does nothing | Command Palette → **OpenRouter: Open Chat** |
| "No API key" error | **OpenRouter: Set API Key** from Command Palette |
| API key not working / "Invalid API key" | Double-check the key at [openrouter.ai/keys](https://openrouter.ai/keys). Run **Clear API Key** then **Set API Key** to re-enter it. Keys start with `sk-or-`. |
| **Insufficient credits** on a paid model | Add credits at [openrouter.ai/settings/credits](https://openrouter.ai/settings/credits), or pick a **free** model (`:free` suffix) |
| Balance badge missing | OpenRouter may not expose balance for your key type; set a per-key limit at [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) |
| Models not loading in the picker | The catalog refreshes from OpenRouter on open. Check your internet connection; re-open the model menu after reconnecting. |
| **Provider returned error** | Switch model or use **Auto**; check [OpenRouter status](https://openrouter.ai/) |
| **Auto** won't enable | Enable at least **3** models with the teal toggles in the model menu |
| Agent can't run commands | Open a workspace folder; set `openrouterAgent.shell` if needed |
| Agent seems stuck / no progress | Click **Stop ■**; if the extension host crashed, reload the window (`Ctrl+Shift+P` → **Reload Window**). |
| Long wait after answer appears | This is the model finishing hidden reasoning — the UI shows "Finishing up…" and resolves automatically |
| Extension not activating on startup | Requires VS Code ≥1.85. Run **Check for Updates** or reinstall the extension. |

---

## Privacy & Security

- **API key**: stored in VS Code **secret storage** — never in `settings.json` or logs
- **File access**: strictly scoped to your open workspace folder
- **Writes and commands**: require explicit user approval in Agent mode
- **Destructive commands**: always prompt, regardless of permission settings
- **External links**: VS Code confirm dialog before any browser opens
- **No telemetry**: zero analytics or tracking

Full disclosure: **[PRIVACY.md](./PRIVACY.md)**

---

## Development

Building from source, F5 debug, contributor guide:

**[docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)**

Release checklist (VSIX + Marketplace publish):

**[docs/RELEASE.md](./docs/RELEASE.md)**

---

## Changelog

**[CHANGELOG.md](./CHANGELOG.md)**

---

## License

MIT — see [LICENSE](./LICENSE).

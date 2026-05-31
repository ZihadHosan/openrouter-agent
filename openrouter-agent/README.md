# OpenRouter Agent

A lightweight VS Code extension that provides a Cursor-like AI assistant using the [OpenRouter](https://openrouter.ai/) API. It includes a custom chat panel in the **right sidebar** (Secondary Side Bar) with **Ask**, **Plan**, and **Agent** modes.

## Requirements

- VS Code 1.85+
- An [OpenRouter API key](https://openrouter.ai/keys)
- Node.js 18+ (for development)

## Install dependencies

```bash
cd openrouter-agent
npm install
```

## Compile

```bash
npm run compile
```

Or watch mode:

```bash
npm run watch
```

## Run with F5

Open **either** the repo root (`vs-code-ai-extension`) **or** the `openrouter-agent` folder in VS Code/Cursor.

1. Run **Terminal → Run Build Task** (or `cd openrouter-agent && npm run compile`).
2. Open **Run and Debug** (`Ctrl+Shift+D`) and choose **Run OpenRouter Agent** (repo root) or **Run Extension** (`openrouter-agent` folder only).
3. Press **F5** — do **not** use “Debug JSON” if `package.json` is focused; pick the extension launch config above.
4. In the new Extension Development Host window, open chat with **OpenRouter: Open Chat** (Command Palette), **Ctrl+Alt+L**, the **toolbar chat icon**, or the **OpenRouter** status bar button — the chat opens in a **panel on the right** beside your code (works in VS Code and Cursor).

If you see *“You don't have an extension for debugging JSON”*, the wrong debug target is selected. Use the extension configuration from step 2, not JSON debugging.

## How to open chat

There are several ways to open the chat panel on the **right side**:

### 1. Status bar button (easiest to find)

Look at the **bottom-right corner** of the window (the blue status bar). Click:

**💬 OpenRouter**

It is always visible while the extension is running.

### 2. Keyboard shortcut

Press **Ctrl+Alt+L** (Mac: **Cmd+Alt+L**).

> **Note:** Do not use Ctrl+Shift+L — that shortcut is already used by VS Code (“Select All Occurrences of Find Match”).

### 3. Command Palette

1. Press **Ctrl+Shift+P** (Mac: **Cmd+Shift+P**)
2. Type **OpenRouter: Open Chat**
3. Press **Enter**

### 4. Editor toolbar icon (VS Code)

With a code file open, look at the **top-right of the editor** (same row as file tabs). Click the **chat bubble** icon, or find **OpenRouter: Open Chat** under the **⋯** menu.

### Where the chat appears

Chat opens as an **OpenRouter Chat** tab/panel **to the right of your editor** (split view). This works reliably in both VS Code and Cursor — no need to enable Secondary Side Bar.

### 5. Right sidebar (optional)

If you enable **View → Appearance → Secondary Side Bar**, the OpenRouter view may also appear there.

```
┌─────────────────────────────────────────────────────────────┐
│  File tabs …                           [icons] [⋯]  ← #4    │
├───────────────────────────────────────┬─────────────────────┤
│                                       │                     │
│         Your code editor              │   OpenRouter Chat   │
│                                       │   (right panel)     │
│                                       │                     │
├───────────────────────────────────────┴─────────────────────┤
│  …                                    💬 OpenRouter  ← #1   │
└─────────────────────────────────────────────────────────────┘
         bottom status bar (click OpenRouter here)
```

## Set your OpenRouter API key

The API key is stored in VS Code **Secret Storage** (like a password). It does **not** appear in Settings as plain text.

1. Open the Command Palette (`Ctrl+Shift+P`).
2. Run **OpenRouter: Set API Key**.
3. Paste your key from https://openrouter.ai/keys (input is masked).

To remove the key: **OpenRouter: Clear API Key**.

If you still see **Openrouter Agent: Api Key** in Settings (`Ctrl+,`), you are on an old build — reinstall **0.4.4+**. The extension only exposes **Models** in Settings; the API key field is removed and any old value is migrated then cleared automatically.

Optional: configure fallback models (max 3) in Settings:

- `openrouterAgent.models` — default:
  1. `z-ai/glm-4.5-air:free`
  2. `openrouter/owl-alpha`
  3. `deepseek/deepseek-v4-flash`

The API key is stored only in VS Code settings and is never shown in the chat panel or logs.

## Modes

### Ask Mode

General coding assistant. Uses your current selection if any; otherwise includes a safely truncated view of the active file (~12k characters).

### Plan Mode

Planning only. The assistant will **not** edit files, run commands, or claim changes were made. It produces step-by-step plans, likely files to touch, risks, and commands you should run manually.

### Agent Mode

A cautious local agent with controlled tools:

| Tool | Behavior |
|------|----------|
| `list_files` | Lists workspace files (auto) |
| `read_file` | Reads a workspace file (auto) |
| `propose_write_file` | Shows VS Code confirmation before writing |
| `run_command` | Shows VS Code confirmation before sending to terminal |

The model requests tools using a JSON block tagged `agent-tool`. Writes and commands always require explicit confirmation.

## Commands

| Command | Description |
|---------|-------------|
| **OpenRouter: Open Chat** | Focus the chat panel (toolbar icon, status bar, **Ctrl+Alt+L**) |
| **OpenRouter: Ask About Current File** | Send current file to chat (Ask mode) |
| **OpenRouter: Explain Selection** | Explain selected text |
| **OpenRouter: Fix Selection** | Propose a fix; apply only after confirmation |

## Chat history

- Chats are **saved automatically** (persists across reloads and VS Code restarts).
- Use the **History** dropdown at the **top** to switch between past conversations.
- **+** — new chat  
- **Del** — delete the selected chat  
- **Clear** — clear messages in the current chat only  

Each chat keeps its own messages, mode, and model selection. Titles are taken from your first message (up to 50 characters).

## Tool details (optional)

When the agent uses file tools, the reply stays clean. Expand **Show details (N tools)** under any assistant message to see raw tool names and JSON results (for debugging).

## Model selection (composer)

- **Agent / Ask / Plan** — pill dropdown at the bottom-left of the input box.
- **Auto** or a specific model — second pill dropdown.
- **Add model…** — add one model id at a time (saved globally).
- **Settings** — `openrouterAgent.models` (max 3) for **Auto** fallback routing.

## Keyboard shortcuts

- **Ctrl+Enter** / **Cmd+Enter** in the chat input sends a message.

## Safety notes

- API keys are read from settings only — never hardcoded or displayed in the webview.
- File access is restricted to workspace folders; path traversal outside the workspace is blocked.
- File writes and terminal commands require modal confirmation.
- Destructive commands (`rm -rf`, `git reset --hard`, etc.) show an extra **Run Anyway (Dangerous)** warning.
- Agent mode requires an open workspace folder.

## Current limitations

- Session history is in-memory only (cleared when VS Code reloads).
- Agent tool calling depends on the model following the `agent-tool` JSON format.
- No streaming responses in v1.
- `run_command` sends text to a terminal but does not capture output back to the agent.
- No built-in diff view for file proposals (preview shown in confirmation dialog).
- Single workspace root used for path resolution (first folder in multi-root workspaces).

## Project structure

```
openrouter-agent/
  package.json
  tsconfig.json
  src/
    extension.ts    — activation & commands
    openrouter.ts   — OpenRouter API client
    agent.ts        — prompts & context
    chatView.ts     — webview chat UI
    tools.ts        — agent tools & safety
```

## License

MIT (adjust as needed for your use).

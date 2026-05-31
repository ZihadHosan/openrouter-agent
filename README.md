# OpenRouter Agent

A lightweight **VS Code / Cursor** extension that adds an AI chat panel with **Ask**, **Plan**, and **Agent** modes, powered by the [OpenRouter](https://openrouter.ai/) API.

Use any OpenRouter model (free or paid). Chat opens in a **panel on the right** of your editor — similar to Cursor’s AI sidebar.

---

## What you need

| Requirement | Details |
|-------------|---------|
| **Editor** | [VS Code](https://code.visualstudio.com/) 1.85+ or [Cursor](https://cursor.com/) |
| **Node.js** | 18+ (only for building from source) |
| **OpenRouter account** | Free API key at [openrouter.ai/keys](https://openrouter.ai/keys) |
| **Workspace** | A project folder open on disk (required for **Ask** and **Agent** file tools) |

---

## Quick start (5 minutes)

### 1. Get the extension running

**Option A — Develop from source (recommended for this repo)**

```bash
git clone https://github.com/ZihadHosan/openrouter-agent.git
cd openrouter-agent
npm install
npm run compile
```

1. Open this folder in **VS Code** or **Cursor** (`File → Open Folder`).
2. Press **F5** (or **Run → Start Debugging**).
3. A second window opens — the **Extension Development Host**. Use the chat there.

**Option B — Install a `.vsix` package**

If someone gave you a `.vsix` file:

1. In VS Code/Cursor: **Extensions** → **⋯** → **Install from VSIX…**
2. Reload the window.

### 2. Add your API key

The key is stored securely in the editor (not in plain-text settings).

1. **Ctrl+Shift+P** (Mac: **Cmd+Shift+P**)
2. Run **`OpenRouter: Set API Key`**
3. Paste your key from [openrouter.ai/keys](https://openrouter.ai/keys)

To remove it: **`OpenRouter: Clear API Key`**.

### 3. Open chat

| Method | Action |
|--------|--------|
| **Easiest** | Click **OpenRouter** in the **bottom status bar** (right side) |
| **Shortcut** | **Ctrl+Alt+L** (Mac: **Cmd+Alt+L**) |
| **Command Palette** | **`OpenRouter: Open Chat`** |
| **Editor toolbar** | Chat bubble icon on the top-right of an open file |

The chat panel opens **beside your code** on the right.

### 4. Send a message

- Type in the box at the bottom.
- Press **Enter** to send.
- **Shift+Enter** for a new line.
- While the model is thinking, the send button (**↑**) becomes **Stop (■)** — click to cancel.

Pick a **mode** and **model** from the pills below the input.

---

## Modes explained

### Ask — questions & read-only help

Best for: explaining code, reading files, quick answers.

- Can **read** and **list** files in your workspace automatically.
- Cannot write files or run terminal commands.
- Example: *“What does `CHANGELOG.md` say?”* or *“Read all markdown files in this project.”*

### Plan — step-by-step plans only

Best for: design before you code.

- Produces ordered steps, files to touch, risks, and commands **you** should run.
- Does **not** edit files or run tools.

### Agent — read, write, and run commands

Best for: multi-step tasks with your approval.

| Action | Behavior |
|--------|----------|
| Read / list files | Runs automatically |
| Write files | Shows an **approval card** in chat |
| Run terminal commands | Shows an **approval card**; output appears in chat |

Set global permission defaults: **`OpenRouter: Agent Permissions`** (Command Palette).

---

## Settings (optional)

Open **Settings** (`Ctrl+,`) and search **`openrouterAgent`**.

| Setting | Purpose |
|---------|---------|
| **`openrouterAgent.models`** | Up to 3 fallback models when **Auto** is selected |
| **`openrouterAgent.agentPermissions`** | `ask` · `readOnly` · `workspace` · `full` |
| **`openrouterAgent.shell`** | Custom shell for in-chat commands (Windows example: `C:\Windows\System32\cmd.exe`) |
| **`openrouterAgent.shellFallbacks`** | Extra shell paths if the default chain fails |

Default **Auto** fallbacks:

1. `z-ai/glm-4.5-air:free`
2. `openrouter/owl-alpha`
3. `deepseek/deepseek-v4-flash`

Add more models from the **model dropdown** in chat → **Add model…**

---

## All commands

| Command | What it does |
|---------|----------------|
| **OpenRouter: Open Chat** | Open/focus chat |
| **OpenRouter: Set API Key** | Save API key (secure) |
| **OpenRouter: Clear API Key** | Remove API key |
| **OpenRouter: Agent Permissions** | Default approve/ask behavior |
| **OpenRouter: Ask About Current File** | Ask mode + current file context |
| **OpenRouter: Explain Selection** | Explain highlighted code |
| **OpenRouter: Fix Selection** | Suggest a fix for selection |

---

## Chat history

- Conversations **save automatically**.
- **History** dropdown at the top — switch chats.
- **+** new chat · **Del** delete · **Clear** clear current chat only.

---

## Development

### Project layout

```
├── src/              Extension source (TypeScript)
├── media/            Icons
├── scripts/          Build helpers (auto version bump)
├── dist/             Compiled output (generated)
├── package.json
└── tsconfig.json
```

### Commands

```bash
npm install          # once
npm run compile      # build (auto-bumps patch/minor when src/ changes)
npm run watch        # rebuild on save
```

### Debug

1. **Terminal → Run Build Task** (or `npm run compile`).
2. **Run and Debug** → **Run OpenRouter Agent** → **F5**.
3. Test in the Extension Development Host window.

If you see *“You don't have an extension for debugging JSON”*, select **Run OpenRouter Agent**, not JSON debug.

### Package for install

```bash
npm install -g @vscode/vsce
npm run compile
vsce package
```

Install the generated `.vsix` via Extensions → Install from VSIX.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Chat doesn’t open | Reload window; confirm extension is enabled in the Development Host |
| **Ctrl+Alt+L** does nothing | Use Command Palette → **OpenRouter: Open Chat** |
| “No API key” | **OpenRouter: Set API Key** |
| Agent can’t run commands | Set **`openrouterAgent.shell`** or open the correct workspace folder |
| Wrong file answers in Ask | Open the folder that contains the files; start a **new chat** |
| Old version in UI | Run `npm run compile`, reload (**F5** again) |

---

## Safety

- API keys use the editor’s **secret storage**.
- File access is limited to the **open workspace**.
- Writes and commands require approval (unless you change permissions).
- Destructive commands show an extra **danger** warning.

---

## License

MIT

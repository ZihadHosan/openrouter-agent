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

## Quick start

Use this repo to **build and install** the extension in your normal VS Code or Cursor window (not the F5 debug host).

> **`npm run compile` is not enough** to use the extension in your everyday editor. You must **`npx @vscode/vsce package`** to create a `.vsix`, then **Install from VSIX…** and reload.

### 1. Clone and install dependencies

```bash
git clone https://github.com/ZihadHosan/openrouter-agent.git
cd openrouter-agent
npm install
```

Open the **`openrouter-agent`** folder in VS Code or Cursor (`File → Open Folder`).

### 2. Build the `.vsix` installer (required)

From the project root in a terminal:

```bash
npx @vscode/vsce package
```

This command:

1. Compiles TypeScript automatically (`precompile` → `npm run compile`)
2. Bundles the extension into a file like **`openrouter-agent-0.9.3.vsix`** in the project root (version matches `package.json`)

You do **not** need to install `@vscode/vsce` globally — `npx` runs it for this command.

If you already ran `npm run compile` separately, that is fine; **`npx @vscode/vsce package` is still required** to produce the installable `.vsix`.

### 3. Install the extension

Use the **same VS Code or Cursor window** where you want OpenRouter Chat every day (you can have any project folder open, or open one after install).

#### Option A — Command Palette (recommended)

1. Press **`Ctrl+Shift+P`** (Mac: **`Cmd+Shift+P`**) to open the **Command Palette**.
2. Type **`install from vsix`** (or **`Extensions: Install from VSIX`**).
3. Select **`Extensions: Install from VSIX...`**
4. In the file picker, go to your `openrouter-agent` folder and select the file from step 2, e.g. **`openrouter-agent-0.9.3.vsix`**.
5. Wait for the “Extension installed” message.

#### Option B — Extensions sidebar

1. Press **`Ctrl+Shift+X`** (Mac: **`Cmd+Shift+X`**) to open **Extensions**.
2. Click the **`⋯`** (three dots) menu at the top of the Extensions panel.
3. Click **Install from VSIX…**
4. Select the `.vsix` file from step 2.

#### Reload the window (required)

The extension loads fully only after a reload. Use **either** method:

**Reload method 1 — prompt after install**

- If the editor shows **“Reload Required”** or **“Reload”**, click **Reload**.

**Reload method 2 — Command Palette**

1. Press **`Ctrl+Shift+P`** (Mac: **`Cmd+Shift+P`**).
2. Type **`reload window`** (or **`Developer: Reload Window`**).
3. Select **`Developer: Reload Window`**.

After reload, open **Extensions** (`Ctrl+Shift+X`) and confirm **OpenRouter Agent** appears under **Installed**.

### 4. Open a workspace

Open a project folder (`File → Open Folder`). **Ask** and **Agent** modes need a workspace on disk to read files.

### 5. Add your API key

The key is stored securely in the editor (not in plain-text settings).

1. **Ctrl+Shift+P** (Mac: **Cmd+Shift+P**)
2. Run **`OpenRouter: Set API Key`**
3. Paste your key from [openrouter.ai/keys](https://openrouter.ai/keys)

To remove it: **`OpenRouter: Clear API Key`**.

### 6. Open chat

| Method | Action |
|--------|--------|
| **Easiest** | Click **OpenRouter** in the **bottom status bar** (right side) |
| **Shortcut** | **Ctrl+Alt+L** (Mac: **Cmd+Alt+L**) |
| **Command Palette** | **`OpenRouter: Open Chat`** |
| **Editor toolbar** | Chat bubble icon on the top-right of an open file |

The chat panel opens **beside your code** on the right.

### 7. Send a message

- Type in the box at the bottom.
- Press **Enter** to send.
- **Shift+Enter** for a new line.
- While the model is thinking, the send button (**↑**) becomes **Stop (■)** — click to cancel.

Pick a **mode** and **model** from the pills below the input.

### Updating after you change the code

When you pull changes or edit the extension, rebuild the installer and reinstall:

```bash
npx @vscode/vsce package
```

Then install again:

1. **`Ctrl+Shift+P`** → type **`install from vsix`** → **`Extensions: Install from VSIX...`** → pick the new `.vsix`.
2. Reload: click **Reload** if prompted, **or** **`Ctrl+Shift+P`** → **`Developer: Reload Window`**.

You do not need to uninstall the old version first.

See **[CHANGELOG.md](./CHANGELOG.md)** for version history.

---

### For extension developers only (F5 debug)

Use this when you are **actively changing** `src/` and want hot reload in an isolated window:

1. Open this repo in VS Code/Cursor.
2. Run **`npm run compile`** (or **`npm run watch`**).
3. Press **F5** (or **Run → Start Debugging** → **Run OpenRouter Agent**).
4. A second **Extension Development Host** window opens — test the chat there.

End users should prefer the **VSIX install** steps above so the extension runs in their everyday editor.

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
| **`openrouterAgent.chatFontSize`** | Chat text size in px (`0` = 14px default) |
| **`openrouterAgent.streamResponses`** | Stream replies token-by-token (`true` by default) |

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
├── CHANGELOG.md      Version history
├── package.json
└── tsconfig.json
```

### Commands

```bash
npm install                    # once
npm run compile                # build TypeScript only (dev / F5)
npm run watch                  # rebuild on save
npx @vscode/vsce package       # create installable .vsix (required for normal use)
```

### Debug

1. **Terminal → Run Build Task** (or `npm run compile`).
2. **Run and Debug** → **Run OpenRouter Agent** → **F5**.
3. Test in the Extension Development Host window.

If you see *“You don't have an extension for debugging JSON”*, select **Run OpenRouter Agent**, not JSON debug.

### Package and install

Same as [Quick start §2](#2-build-the-vsix-installer-required):

```bash
npx @vscode/vsce package
```

Install the generated `.vsix`:

1. **`Ctrl+Shift+P`** → **`Extensions: Install from VSIX...`** → select the file.
2. **`Ctrl+Shift+P`** → **`Developer: Reload Window`** (or click **Reload** when prompted).

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Chat doesn’t open | Reload window; confirm **OpenRouter Agent** is enabled under Extensions |
| **Ctrl+Alt+L** does nothing | Use Command Palette → **OpenRouter: Open Chat** |
| “No API key” | **OpenRouter: Set API Key** |
| Agent can’t run commands | Set **`openrouterAgent.shell`** or open the correct workspace folder |
| Wrong file answers in Ask | Open the folder that contains the files; start a **new chat** |
| Old version in UI | Rebuild (`npm run compile`), repackage (`npx @vscode/vsce package`), reinstall VSIX, reload |
| Changes not visible after edit | Close and reopen the chat panel, or reload window; for dev use **F5** host |

---

## Safety

- API keys use the editor’s **secret storage**.
- File access is limited to the **open workspace**.
- Writes and commands require approval (unless you change permissions).
- Destructive commands show an extra **danger** warning.

---

## License

MIT

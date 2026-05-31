# Development — OpenRouter Agent

Guide for **contributors** and **manual installs**. End users should install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ZihadHosan.openrouter-agent).

---

## Project layout

```
├── src/              Extension source (TypeScript)
├── media/            Icons and bundled assets
├── scripts/          Auto version bump on compile
├── dist/             Compiled output (generated)
├── docs/             Developer documentation
├── CHANGELOG.md
├── LICENSE
├── PRIVACY.md
└── package.json
```

---

## Prerequisites

- **Node.js** 18+
- **VS Code** or **Cursor** 1.85+

---

## Clone and build

```bash
git clone https://github.com/ZihadHosan/openrouter-agent.git
cd openrouter-agent
npm install
npm run compile
```

Open the repo folder in VS Code/Cursor (`File → Open Folder`).

### npm scripts

```bash
npm install          # once
npm run compile      # build TypeScript (runs version bump when src/ changes)
npm run watch        # rebuild on save
npm run package:vsix # compile + create .vsix in project root
npm run publish:marketplace  # compile + package + upload to Marketplace (requires vsce login)
```

### Version bumps

`npm run compile` runs `scripts/bump-version-on-change.mjs` first:

- **1–3** changed files in `src/` → **patch** (e.g. `1.0.0` → `1.0.1`)
- **4+** files or **`package.json` / `extension.ts`** → **minor** (e.g. `1.0.0` → `1.1.0`)
- No `src/` changes → version unchanged

State is stored in `.version-state.json` (local, gitignored).

---

## F5 debug (Extension Development Host)

For active work on `src/`:

1. `npm run compile` (or `npm run watch`)
2. **Run and Debug** → **Run OpenRouter Agent** → **F5**
3. Test in the second **Extension Development Host** window

If prompted for JSON debug, pick **Run OpenRouter Agent**, not a JSON config.

---

## Package a `.vsix` (manual install)

```bash
npx @vscode/vsce package
```

This compiles via `precompile`, then creates `openrouter-agent-x.y.z.vsix` in the project root.

### Install the VSIX

1. **Ctrl+Shift+P** → **`Extensions: Install from VSIX...`** → select the file  
   Or: Extensions sidebar → **⋯** → **Install from VSIX…**
2. Reload: click **Reload** when prompted, or **Ctrl+Shift+P** → **`Developer: Reload Window`**

Reinstalling a new VSIX over an old one is fine — no uninstall needed.

---

## Publish to VS Code Marketplace

**→ Step-by-step release checklist: [RELEASE.md](./RELEASE.md)** (PAT setup, version bump, publish commands)

### One-time setup

1. Create a publisher at [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage)  
   Id must match `publisher` in `package.json` (**`ZihadHosan`**).
2. Create an Azure DevOps **Personal Access Token** with **Marketplace → Publish**.
3. Log in: `npx @vscode/vsce login ZihadHosan`

### Publish a release

```bash
npm run compile
npx @vscode/vsce publish
```

Package only (no upload):

```bash
npx @vscode/vsce package
```

### Required listing files

- `README.md` — user-facing (Marketplace + GitHub)
- `LICENSE`, `PRIVACY.md`, `CHANGELOG.md`
- `media/icon.png` (128×128)

After changing `README.md`, publish a new version for Marketplace to show the update.

---

## Troubleshooting (development)

| Problem | Fix |
|---------|-----|
| Old UI after edit | Repackage VSIX and reinstall, or use **F5** host |
| Version stuck | Edit `src/` to trigger bump, or check `.version-state.json` |
| VSIX too large | Check `.vscodeignore` excludes dev folders |

---

## Resources

- [Repository](https://github.com/ZihadHosan/openrouter-agent)
- [Issues](https://github.com/ZihadHosan/openrouter-agent/issues)
- [OpenRouter API keys](https://openrouter.ai/keys)

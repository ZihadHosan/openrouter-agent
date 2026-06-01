# Release checklist — OpenRouter Agent

Short guide for **packaging locally** and **publishing to the VS Code Marketplace**.  
Use this when you come back after a few months and forget the steps.

Full dev setup (F5 debug, project layout): **[DEVELOPMENT.md](./DEVELOPMENT.md)**

---

## Quick reference

| Item | Value |
|------|--------|
| Extension id | `ZihadHosan.openrouter-agent` |
| Publisher | `ZihadHosan` |
| Marketplace | [OpenRouter Agent listing](https://marketplace.visualstudio.com/items?itemName=ZihadHosan.openrouter-agent) |
| Manage publisher | [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage) |
| Repo | [github.com/ZihadHosan/openrouter-agent](https://github.com/ZihadHosan/openrouter-agent) |

---

## One-time setup

Do this once (or again when your PAT expires).

### 1. Publisher

1. Open [Visual Studio Marketplace → Manage](https://marketplace.visualstudio.com/manage)
2. Sign in with your Microsoft account
3. Confirm publisher id **`ZihadHosan`** matches `"publisher"` in `package.json`

### 2. Personal Access Token (PAT)

1. Open [dev.azure.com](https://dev.azure.com) (same Microsoft account)
2. Profile icon → **Personal access tokens** → **+ New Token**
3. **Organization:** All accessible organizations  
4. **Scopes:** Custom defined → **Marketplace** → **Publish**
5. Copy the token — you will not see it again. Store in a password manager (**not** in this repo)

Shortcut: on the Marketplace manage page, use **Get Personal Access Token** if shown.

### 3. Log in to vsce

```bash
npx @vscode/vsce login ZihadHosan
```

Paste the PAT when prompted (nothing appears as you type — normal).

> **No paid Azure subscription** is required for publishing.

---

## Every release — checklist

Copy and tick off:

```text
[ ] Update CHANGELOG.md — move [Unreleased] notes into [x.y.z] with date
[ ] npm run compile          — builds dist/; may auto-bump version (see below)
[ ] Check package.json version is HIGHER than live Marketplace version
[ ] npm run package:vsix     — or: npx @vscode/vsce package
[ ] Verify VSIX ~80 KB; no .cursor/, scripts/, or src/ in the bundle
[ ] Test locally — install VSIX or F5 Extension Development Host
[ ] git commit + push
[ ] npm run publish:marketplace — or publish command below with correct .vsix path
[ ] Confirm Marketplace page shows new version + updated README
[ ] (Optional) GitHub Release — tag vX.Y.Z and attach the .vsix
```

---

## Commands

### Local package only (`.vsix`)

```bash
npm run package:vsix
```

Creates `openrouter-agent-x.y.z.vsix` in the project root (version from `package.json`).

Install locally:

1. **Ctrl+Shift+P** → **Extensions: Install from VSIX...**
2. **Developer: Reload Window**

### Publish to Marketplace

```bash
npm run compile
npx @vscode/vsce publish --packagePath openrouter-agent-1.14.0.vsix
```

Replace `1.3.0` with the version in `package.json`.

Or compile + package + publish in one go (after you know the version):

```bash
npm run publish:marketplace
```

(`publish:marketplace` runs compile, packages, then runs `vsce publish` with the current version.)

### Re-login if publish fails

```bash
npx @vscode/vsce login ZihadHosan
```

Common error: *Personal Access Token verification has failed* → create a new PAT with **Marketplace → Publish**.

---

## Version bumps

`npm run compile` runs `scripts/bump-version-on-change.mjs` first:

| Change | Bump |
|--------|------|
| 1–3 files in `src/` | patch (e.g. `1.3.0` → `1.3.1`) |
| 4+ files in `src/`, or `package.json` / `extension.ts` | minor (e.g. `1.3.0` → `1.4.0`) |
| No `src/` changes | unchanged |

State: `.version-state.json` (local, gitignored).

**Before publish:** open `package.json` and confirm `"version"` is greater than [the live Marketplace version](https://marketplace.visualstudio.com/items?itemName=ZihadHosan.openrouter-agent).

You can also bump manually in `package.json` if needed.

---

## Pre-publish files (Marketplace listing)

These are included in the VSIX and shown on the listing:

- `README.md` — user-facing docs (GitHub + Marketplace)
- `CHANGELOG.md`
- `LICENSE`, `PRIVACY.md`
- `media/icon.png` (128×128)

**README on Marketplace only updates when you publish a new version** — editing README on GitHub alone is not enough.

---

## Gotchas

| Issue | Fix |
|-------|-----|
| Marketplace README stale | Publish a **new** version (must be higher than current) |
| `vsce publish` rejected — version exists | Bump `package.json` version |
| VSIX huge (~MB) | Check `.vscodeignore` excludes dev folders |
| Old UI after install | Reload window; reinstall VSIX |
| Cursor in git contributors | See `.githooks/commit-msg`; run `git config core.hooksPath .githooks` |
| PAT expired | Create new token at dev.azure.com and `vsce login` again |

---

## Optional: GitHub Release

After a successful Marketplace publish:

```bash
git tag v1.3.0
git push origin v1.3.0
```

On GitHub → **Releases** → **Draft new release** → attach `openrouter-agent-1.3.0.vsix` for download history.

---

## Related docs

- **[DEVELOPMENT.md](./DEVELOPMENT.md)** — clone, F5 debug, troubleshooting
- **[CHANGELOG.md](../CHANGELOG.md)** — release notes
- **[README.md](../README.md)** — user-facing install guide

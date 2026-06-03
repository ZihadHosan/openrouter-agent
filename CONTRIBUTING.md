# Contributing to OpenRouter Agent

Thank you for your interest in contributing! OpenRouter Agent is an open-source VS Code extension that brings 300+ AI models into your editor. Every contribution — bug reports, feature ideas, code, or docs — is welcome.

---

## Getting started

1. **Fork** the repository and clone your fork
2. Install dependencies: `npm install`
3. Build: `npm run compile` (or `npm run watch` for continuous rebuild)
4. Press **F5** in VS Code to launch the **Extension Development Host** with your changes live
5. Full setup guide: **[docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)**

---

## Reporting bugs

Open an issue at **[GitHub Issues](https://github.com/ZihadHosan/openrouter-agent/issues)** and include:

- VS Code version (`Help → About`)
- Extension version (Extensions panel → OpenRouter Agent)
- Operating system
- Steps to reproduce
- Expected vs actual behaviour
- Any error messages from the **Developer Tools console** (`Help → Toggle Developer Tools`)

---

## Suggesting features

Open an issue with the **`enhancement`** label. Describe:

- The problem you're trying to solve
- Your proposed solution
- Any alternatives you considered

---

## Pull requests

1. **Branch** from `main`: `git checkout -b feat/my-feature` or `fix/my-bug`
2. Make your changes — keep commits focused and atomic
3. **Run the tests** before submitting:
   ```bash
   npm run compile
   npm run test:sanitize
   ```
4. Open a PR against `main` with a clear title and description
5. Link any related issue in the PR description (`Closes #123`)

---

## Code style

- **TypeScript strict mode** — no `any`, no `@ts-ignore` without a comment explaining why
- **No new vscode dependency in `harmonyTokens.ts`** — this file is intentionally vscode-free for unit testing
- **Webview JS/CSS lives inside the template string** in `chatView.ts` — avoid backticks (`` ` ``) and `${…}` interpolation inside webview code blocks; they break the outer TypeScript template literal
- Run `npm run compile` — zero TypeScript errors required
- Run `npm run test:sanitize` — all assertions must pass

---

## Good first issues

Look for issues labelled **`good first issue`** — these are self-contained tasks with clear acceptance criteria, suitable for a first contribution.

---

## Questions?

Open a [GitHub Discussion](https://github.com/ZihadHosan/openrouter-agent/discussions) or drop a comment on any open issue.

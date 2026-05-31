# Privacy Policy — OpenRouter Agent

**Last updated:** 2026-05-30

OpenRouter Agent is a VS Code / Cursor extension that connects your editor to the [OpenRouter](https://openrouter.ai/) API using **your own API key**.

## Summary

- **We (the extension authors) do not operate servers** and do not receive your chat content or API key.
- **OpenRouter** processes prompts and model responses according to [OpenRouter’s policies](https://openrouter.ai/privacy).
- **Your editor** stores your API key locally in VS Code **Secret Storage** on your machine.

## What data leaves your computer

When you send a chat message, the extension may transmit to **OpenRouter**:

| Data | When |
|------|------|
| Your **prompt** and **conversation history** (current session) | Every chat request |
| **Images, PDFs, and attached files** | When you attach files in chat (sent as base64 to vision/file-capable models) |
| **Workspace file contents** | When the model uses read/list tools, or you include file/selection context |
| **Terminal command output** | When Agent mode runs an approved command |
| Your **OpenRouter API key** | In the `Authorization` header on each API request |

The extension also sends standard OpenRouter HTTP headers (`HTTP-Referer`, `X-Title`) identifying this extension.

## What stays on your computer

| Data | Storage |
|------|---------|
| OpenRouter **API key** | VS Code Secret Storage (encrypted by the editor) |
| **Chat history** (sessions) | Extension global state on your machine |
| **Attachment files** (images, PDFs) | Extension global storage on your machine (per session) |
| **Agent permission choices** | Workspace/user settings |

The extension does **not** include analytics, crash reporting, or third-party telemetry.

## Third parties

- **[OpenRouter](https://openrouter.ai/)** — LLM API provider; you choose models and must accept their terms.
- **Model providers** (via OpenRouter) — e.g. Anthropic, OpenAI, Meta, etc., depending on the model you select.

## Your choices

- Do not set an API key — the extension cannot call OpenRouter without it.
- Use **Ask** mode for read-only file access; restrict **Agent** permissions in settings.
- Clear your API key: **OpenRouter: Clear API Key**
- Delete chat history: use **Del** / **Clear** in the chat UI or remove extension storage by uninstalling the extension.

## Contact

Issues and questions: [GitHub Issues](https://github.com/ZihadHosan/openrouter-agent/issues)

# FreeLLMAPI for VS Code

[![Version](https://img.shields.io/visual-studio-marketplace/v/rolando-s-solutions.freellmapi-vscode)](https://marketplace.visualstudio.com/items?itemName=rolando-s-solutions.freellmapi-vscode)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/rolando-s-solutions.freellmapi-vscode)](https://marketplace.visualstudio.com/items?itemName=rolando-s-solutions.freellmapi-vscode)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/rolando-s-solutions.freellmapi-vscode)](https://marketplace.visualstudio.com/items?itemName=rolando-s-solutions.freellmapi-vscode)
[![License](https://img.shields.io/github/license/rolandossolutions/freellmapi)](LICENSE)
[![Build](https://github.com/rolandossolutions/freellmapi/actions/workflows/ci.yml/badge.svg)](https://github.com/rolandossolutions/freellmapi/actions)

Bring **FreeLLMAPI's model router (auto, fusion, 70+ open models)** into **VS Code Chat & Agent mode** — zero config, secure API-key storage, streaming, and full tool calling support.

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🤖 **Auto model routing** | Select `auto` and FreeLLMAPI picks the best model per request |
| 🔧 **Agent mode / tool calling** | Works with VS Code tools (file search, edit, terminal, etc.) |
| 🔐 **Secure API key storage** | Keys stored in VS Code SecretStorage — never in settings or source |
| 🌊 **Streaming responses** | Real-time token streaming via OpenAI-compatible SSE |
| 🔍 **Auto model discovery** | Fetches live model list from `/v1/models?execution_status=ready` |
| ⚡ **One-command setup** | `FreeLLMAPI: Configure Connection` — done |
| 🎯 **Per-model capabilities** | Tool calling, vision, context length shown in model picker |

---

## 📋 Requirements

- **VS Code 1.104+** (Language Model Chat API)
- **FreeLLMAPI** running locally (desktop app or self-hosted server)
- **Unified API key** from the [FreeLLMAPI dashboard](https://freellmapi.com/dashboard)

> **Copilot Business/Enterprise**: Your org must allow models configured with personal API keys.

---

## 🚀 Quick Start

```bash
# 1. Start FreeLLMAPI (desktop app default: http://127.0.0.1:31415)
#    Or self-hosted: http://localhost:3001

# 2. In VS Code → Command Palette (Cmd/Ctrl+Shift+P)
> FreeLLMAPI: Configure Connection

# 3. Paste your unified API key → Enter

# 4. Open Copilot Chat → Model Picker → Select a FreeLLMAPI model
#    💡 Pick "FreeLLMAPI Auto" for automatic routing
#    🛠 Choose Agent mode to enable tools
```

---

## 🎮 Usage

### Chat Mode
Standard conversation — pick any FreeLLMAPI model.

### Agent Mode (Tool Calling)
1. Select a **tool-capable** model (e.g., `auto`, or any model with 🛠 badge)
2. Toggle **Agent** mode in Chat panel
3. Ask: *"Read my package.json and add a test script"* — the model uses VS Code tools

### Model Capabilities at a Glance
| Model | Tools | Vision | Context |
|-------|-------|--------|---------|
| `auto` (router) | ✅ | ✅ | Dynamic |
| `fusion` (router) | ❌ | ❌ | Dynamic |
| Concrete models | Per `supported_parameters` | Per `input_modalities` | Per `max_input_tokens` |

---

## 🔧 Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `freellmapi.baseUrl` | `http://127.0.0.1:31415/v1` | OpenAI-compatible base URL (`/v1` required) |

Change anytime via **FreeLLMAPI: Configure Connection**.

---

## 🛡 Privacy & Security

- **API key**: Stored in VS Code [SecretStorage](https://code.visualstudio.com/api/references/extension-api#SecretStorage) — encrypted at rest, never synced, never in `settings.json`
- **Base URL**: User setting (not secret)
- **No telemetry**: Extension collects zero usage data
- **Local-first**: All requests go to your FreeLLMAPI instance

---

## 🐛 Troubleshooting

| Issue | Fix |
|-------|-----|
| "FreeLLMAPI is not configured" | Run **FreeLLMAPI: Configure Connection** |
| No models appear | Verify FreeLLMAPI is running; check base URL; ensure `/v1/models?execution_status=ready` returns data |
| Tool calls fail | Pick a model with tool support (`auto` or models with `tools` in `supported_parameters`) |
| Streaming errors | Ensure FreeLLMAPI version supports SSE; check firewall/proxy |
| 502 "cannot convert message role" | Update extension — tool results now sent as labeled user messages |

---

## 🧑‍💻 Development

```bash
# Install deps
npm install

# Run tests
npm test

# Compile
npm run compile

# Watch mode
npm run watch

# Package .vsix
npx vsce package
```

Press **F5** in VS Code to launch an Extension Development Host.

---

## 📄 License

MIT — see [LICENSE](LICENSE)

---

## 🙋 Support

- **Issues**: [GitHub Issues](https://github.com/rolando-s-solutions/freellmapi-vscode/issues)
- **FreeLLMAPI**: [Documentation](https://docs.freellmapi.com) • [Dashboard](https://freellmapi.com/dashboard)
- **VS Code LM API**: [Official docs](https://code.visualstudio.com/api/extension-guides/language-model)

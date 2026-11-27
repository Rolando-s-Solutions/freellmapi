# FreeLLMAPI for VS Code

Use FreeLLMAPI models directly in VS Code Chat, including agent mode. The extension registers FreeLLMAPI as a chat model provider; it does not create a separate chat panel.

## Requirements

- VS Code 1.104 or newer.
- A running FreeLLMAPI server or desktop app.
- A unified API key created from the FreeLLMAPI dashboard.
- For Copilot Business or Enterprise, the organization must allow models configured with personal API keys.

## Setup

1. Install and start FreeLLMAPI. The desktop app listens on `http://127.0.0.1:31415` (the extension default); a self-hosted server typically uses `http://localhost:3001`.
2. In VS Code, run **FreeLLMAPI: Configure Connection** from the Command Palette.
3. Enter the FreeLLMAPI OpenAI-compatible base URL (`http://127.0.0.1:31415/v1` for the desktop app, `http://localhost:3001/v1` for a self-hosted server) and your unified API key.
4. Open Copilot Chat, select a FreeLLMAPI model from the model picker, and choose **Agent** mode when you want the model to use VS Code tools.

The extension discovers models from `/v1/models?execution_status=ready`, including FreeLLMAPI's `auto` routing model. It sends streaming OpenAI-compatible chat-completion requests to `/v1/chat/completions` (and also accepts non-streaming JSON replies).

Tool calling is advertised per model: router slots such as `auto` support it, `fusion` does not, and concrete models support it only when their `supported_parameters` include `tools`. Pick a tool-capable model for **Agent** mode; with other models, earlier tool calls in the conversation are sent as plain text.

The API key is stored in VS Code SecretStorage and is not written to extension settings or source files. The base URL is stored as the `freellmapi.baseUrl` user setting. To change it, run the configuration command again.

## Development

```sh
npm install
npm test
make vsix
```

`make vsix` compiles the extension and creates a versioned `.vsix` package in the project root.

Press **F5** in VS Code to launch an Extension Development Host with the extension.

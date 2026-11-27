# Spec: Fix VS Code Chat to FreeLLMAPI Communication & Protocol Compatibility
Revision: 1
Type: bugfix
Base commit: none
Language/stack: TypeScript 5.9 (ES2022 / Node16), VS Code Extension API (^1.104.0), Node.js built-in test runner (`node:test`)
Commands: build=`npm run compile` · lint=`npx tsc --noEmit` · test=`npm test` · run=`make vsix`

## 1. Context
`freellmapi-vscode` registers FreeLLMAPI as a `vscode.LanguageModelChatProvider` so users can select FreeLLMAPI models in VS Code Chat and Copilot Agent mode. Direct `curl` calls to `http://127.0.0.1:31415/v1/chat/completions` succeed, whereas requests sent from VS Code fail across five code paths in `package.json`, `src/extension.ts`, `src/apiUtils.ts`, and `src/provider.ts`:
1. **Default Base URL mismatch:** `DEFAULT_BASE_URL` and `package.json` default to `http://localhost:3001/v1`, whereas the FreeLLMAPI desktop app listens on IPv4 `http://127.0.0.1:31415/v1` (causing `ECONNREFUSED` until manually overridden, and risking IPv6 `::1` resolution mismatches on `localhost`).
2. **Unconditional `toolCalling: true` capability:** `parseModelList` marks every model `toolCalling: true`. In `/v1/models?execution_status=ready`, models without `"tools"` in `supported_parameters` (e.g., `deepseek-v4-flash-0731`) receive `tools` from VS Code Chat and fail with `429 routing_exhausted` (`1 model lacks tool-calling`), and `fusion` synthesizes multi-model text responses rather than tool calls.
3. **Invalid tool-result message role:** `convertMessages` serializes `LanguageModelToolResultPart` as `{ role: 'user', content: 'Tool result for call ...' }` instead of OpenAI `{ role: 'tool', tool_call_id, content }`, breaking multi-turn tool execution on strict OpenAI-compatible upstream providers.
4. **Unhandled VS Code message roles, parts, and participant names:**
   - System-role messages (`role === 3` / non-User/Assistant roles) throw `'FreeLLMAPI cannot convert this message role.'` before any HTTP call is made.
   - `LanguageModelDataPart` with `application/json` (or `+json`) and `LanguageModelPromptTsxPart` in messages/tool results throw `'FreeLLMAPI cannot convert this ... content type.'`.
   - Unsanitized `message.name` values containing spaces or invalid characters (e.g., `"GitHub Copilot"`) violate OpenAI's `^[a-zA-Z0-9_-]{1,64}$` constraint on strict backends.
5. **Response & SSE stream fragility:**
   - Non-SSE `application/json` responses (`object: "chat.completion"`) returned by non-streaming upstreams or `fusion` are fed to `readEventStream`, producing empty output.
   - SSE keep-alive/metadata/usage chunks where `choices` is omitted throw `'FreeLLMAPI returned an invalid streaming response.'`.
   - Reasoning-only completions (where `delta.reasoning` / `message.reasoning` is populated and `content` is empty) emit no visible text.

## 2. Goals
- G-1: Ensure fresh installations and configured instances connect cleanly to the FreeLLMAPI desktop gateway (`http://127.0.0.1:31415/v1`) and normalize loopback URLs safely.
- G-2: Advertise accurate per-model `toolCalling` capabilities and only send `tools`/`tool_choice` to models that support tool calling.
- G-3: Achieve full OpenAI Chat Completions protocol compliance for `system`, `user`, `assistant`, and `tool` messages, participant `name` sanitization, and VS Code rich message/tool parts (`application/json`, `LanguageModelPromptTsxPart`, unknown parts).
- G-4: Reliably parse both `text/event-stream` (SSE) and `application/json` chat completion responses from FreeLLMAPI without dropping responses or crashing on metadata chunks.

## 3. Non-goals / Out of scope
- Adding custom webviews, sidebar panels, custom chat participants (`@freellm`), or new VS Code settings beyond `freellmapi.baseUrl`.
- Automatic port-scanning or background probing of local ports.
- Modifying the upstream FreeLLMAPI server or desktop application.
- Adding runtime npm dependencies (`dependencies` in `package.json` remains empty).

## 4. Functional requirements
- **FR-1 (Default Base URL):** Set the default `freellmapi.baseUrl` in `package.json`, `src/extension.ts`, `src/provider.ts`, and `README.md` documentation examples to `http://127.0.0.1:31415/v1`.
- **FR-2 (Accurate Tool-Calling Capability):** In `parseModelList` (`src/apiUtils.ts`):
  - If `model.id === 'fusion'`, set `capabilities.toolCalling = false`.
  - Else if `Array.isArray(model.supported_parameters)`, set `capabilities.toolCalling = model.supported_parameters.includes('tools')`.
  - Else (router slots such as `auto`, `claude-opus-4-5`, `claude-sonnet-4-5`, `claude-haiku-4-5` that omit `supported_parameters`), set `capabilities.toolCalling = true`.
- **FR-3 (Guard Outgoing Tools Payload):** In `provideLanguageModelChatResponse` (`src/provider.ts`), only include `body.tools` (and `body.tool_choice = 'required'` when `toolMode === Required` and `supported_parameters` does not exclude `tool_choice`) when `model.capabilities.toolCalling` is truthy and `options.tools` is non-empty.
- **FR-4 (OpenAI `tool` Role Conversion):** In `convertMessages` (`src/provider.ts`), convert each `LanguageModelToolResultPart` into `{ role: 'tool', tool_call_id: part.callId, content: convertToolResult(part.content) }`. When a VS Code `User` message contains both `LanguageModelToolResultPart`s and user text/image parts, emit all `role: 'tool'` messages first (preserving adjacency to the preceding `assistant` `tool_calls`), followed by the `role: 'user'` message. If a conversation ends up with orphan `role: 'tool'` messages without a preceding matching `assistant` `tool_calls` ID, or when targeting a model with `capabilities.toolCalling === false`, fall back or ensure valid message ordering so non-tool models do not reject historical tool turns.
- **FR-5 (System Role, Rich Parts & Name Sanitization):**
  - Map VS Code messages with `role` outside `User`/`Assistant` (specifically `System` role = `3`) to `{ role: 'system', content: ... }` instead of throwing.
  - Decode `LanguageModelDataPart` when `mimeType` starts with `text/`, equals `application/json`, or ends with `+json`.
  - Extract readable text from `LanguageModelPromptTsxPart` (recursively reading prompt-tsx text/children nodes or JSON-stringifying fallback values) and gracefully ignore or stringify unknown part objects instead of throwing hard errors on unexpected Copilot internal parts.
  - Sanitize `message.name` to match `^[a-zA-Z0-9_-]{1,64}$` (replacing invalid characters with `_` and trimming/omitting if empty).
- **FR-6 (Resilient SSE & JSON Completion Parsing):**
  - If `/v1/chat/completions` responds with `Content-Type` containing `application/json` (or non-SSE single JSON payload), parse the JSON completion object (`choices[].message.content`, `choices[].message.reasoning`, and `choices[].message.tool_calls`) and report parts via `progress`.
  - In `readEventStream`, ignore SSE comments (`:` lines) and chunks where `choices` is missing/empty (such as ping or final `usage` chunks) rather than throwing `'FreeLLMAPI returned an invalid streaming response.'`, while still surfacing `{ error: { message } }` payloads as errors.
  - If a response finishes with zero `content` text parts and zero `tool_calls`, but accumulated `reasoning` text is non-empty, emit the accumulated reasoning text so reasoning-only responses do not appear blank in VS Code Chat.

## 5. Non-functional requirements
- **NFR-1 (Security):** Never log or expose the secret API key in error messages (`errorMessageFromResponse` must continue redacting `apiKey`).
- **NFR-2 (Zero Runtime Dependencies):** Compile cleanly with `tsc -p .` using only Node/Web standard APIs (`fetch`, `TextDecoder`, `Buffer`, `URL`) and `@types/vscode`.
- **NFR-3 (Test Verification):** All existing and new unit tests pass via `npm test` in under 5 seconds, and `make vsix` builds the updated `.vsix` package cleanly.

## 6. Contracts
### API / interfaces
- **`GET {baseUrl}/models?execution_status=ready`**
  - Request headers: `Authorization: Bearer <apiKey>`
  - Response `200 OK` (`application/json`): `{ object: "list", data: Array<{ id: string, name?: string, owned_by?: string, context_window?: number | null, context_length?: number | null, supported_parameters?: string[] }> }`
- **`POST {baseUrl}/chat/completions`**
  - Request headers: `Authorization: Bearer <apiKey>`, `Content-Type: application/json`, `Accept: text/event-stream`
  - Request JSON:
    ```json
    {
      "model": "auto",
      "messages": [
        { "role": "system", "content": "..." },
        { "role": "user", "name": "GitHub_Copilot", "content": "Hello" },
        { "role": "assistant", "content": null, "tool_calls": [{ "id": "call_1", "type": "function", "function": { "name": "toolName", "arguments": "{}" } }] },
        { "role": "tool", "tool_call_id": "call_1", "content": "result string" }
      ],
      "stream": true,
      "tools": [{ "type": "function", "function": { "name": "...", "description": "...", "parameters": { "type": "object", "properties": {} } } }],
      "tool_choice": "required"
    }
    ```
  - Response `200 OK`:
    - Streaming (`text/event-stream`): `data: {"choices":[{"delta":{"content":"...","reasoning":"...","tool_calls":[...]}}]}` ... `data: {"choices":[],"usage":{...}}` ... `data: [DONE]`
    - Non-streaming fallback (`application/json`): `{"choices":[{"message":{"role":"assistant","content":"...","tool_calls":[...]}}]}`

### Data model
- `OpenAIMessage` (`src/provider.ts`):
  - `{ role: 'system'; content: string; name?: string }`
  - `{ role: 'user'; content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>; name?: string }`
  - `{ role: 'assistant'; content: string | null; name?: string; tool_calls?: OpenAIToolCall[] }`
  - `{ role: 'tool'; tool_call_id: string; content: string }`

### Errors
- Non-2xx HTTP status: throws `Error("FreeLLMAPI request failed (<status>): <redacted detail>")`.
- Mid-stream SSE error object (`{"error":{"message":"..."}}`): throws `Error("FreeLLMAPI streaming error: <message>")`.
- Cancellation (`token.isCancellationRequested`): throws `vscode.CancellationError`.

## 7. Implementation & Testing Decisions
### Implementation decisions
- **Challenge 1 — Default URL (`127.0.0.1:31415` vs auto-probing `:31415` and `:3001`):**
  - *Alternative considered:* Probe both `127.0.0.1:31415` and `localhost:3001` automatically on failure.
  - *Decision:* Set default directly to `http://127.0.0.1:31415/v1` (per user confirmation) without silent port-probing, avoiding unexpected cross-process traffic and latency while keeping `freellmapi.configure` explicit for server users on `:3001`.
- **Challenge 2 — Tool-result representation (`role: 'tool'` vs `role: 'user'`):**
  - *Alternative considered:* Always send `role: 'user'` text for broad role-limited compatibility.
  - *Decision:* Emit standard OpenAI `role: 'tool'` with `tool_call_id` when paired with a preceding `assistant` `tool_calls` (and `model.capabilities.toolCalling` is true), while degrading historical tool calls/results to plain text only if the user switches mid-conversation to a model with `toolCalling: false` (preventing 400 errors on non-tool models!).
- **Challenge 3 — Response parser (`SSE-only` vs dual `SSE + JSON`):**
  - *Alternative considered:* Force `stream: false` for all models.
  - *Decision:* Keep `stream: true` for responsive token streaming in VS Code Chat, and inspect `Content-Type` (plus leading `{` fallback if needed) to support both `text/event-stream` and `application/json` responses seamlessly.

### Testing decisions
- Unit tests in `test/apiUtils.test.cjs`:
  - Verify `parseModelList` sets `toolCalling: true` for `auto` and models with `"tools"` in `supported_parameters`, and `toolCalling: false` for `fusion` and models whose `supported_parameters` omits `"tools"`.
- Unit tests in `test/provider.test.cjs`:
  - Verify `convertMessages` maps `System` role (`3`), sanitizes `message.name`, decodes `application/json` `LanguageModelDataPart` and `LanguageModelPromptTsxPart`, emits `role: 'tool'` with `tool_call_id` before trailing user text, and degrades tool history cleanly when `toolCalling` is disabled.
  - Verify `provideLanguageModelChatResponse` / stream & JSON parsers handle SSE chunks without `choices`, SSE `[DONE]`, reasoning-only fallback, non-SSE `application/json` completions, and omit `tools` when `model.capabilities.toolCalling` is `false`.

### Modules / Services affected
- Internal: `package.json`, `README.md`, `src/extension.ts`, `src/apiUtils.ts`, `src/provider.ts`, `test/apiUtils.test.cjs`, `test/provider.test.cjs`
- External dependencies: Local FreeLLMAPI HTTP OpenAI-compatible gateway (`/v1/models`, `/v1/chat/completions`)

## 8. Acceptance criteria
- **AC-1 (FR-1):** Given a fresh configuration without custom `freellmapi.baseUrl`, When the extension resolves the base URL or shows configuration defaults, Then `http://127.0.0.1:31415/v1` is used.
- **AC-2 (FR-2, FR-3):** Given `/v1/models?execution_status=ready` returns `auto` (no `supported_parameters`), `fusion`, `glm-5.3-flash` (`supported_parameters` includes `"tools"`), and `deepseek-v4-flash-0731` (`supported_parameters` omits `"tools"`), When `parseModelList` runs and `provideLanguageModelChatResponse` builds a request with `options.tools`, Then `auto` and `glm-5.3-flash` have `toolCalling: true` and include `tools`, whereas `fusion` and `deepseek-v4-flash-0731` have `toolCalling: false` and omit `tools`.
- **AC-3 (FR-4):** Given an `Assistant` message with a `LanguageModelToolCallPart` (`call-1`) followed by a `User` message with a `LanguageModelToolResultPart` (`call-1`) and a `LanguageModelTextPart`, When `convertMessages` runs for a tool-capable model, Then it emits the `assistant` message with `tool_calls`, followed immediately by `{ role: 'tool', tool_call_id: 'call-1', content: '...' }`, followed by `{ role: 'user', content: '...' }`.
- **AC-4 (FR-4):** Given chat history containing prior tool calls/results and a selected model with `capabilities.toolCalling === false`, When `convertMessages` runs, Then tool calls and tool results are serialized as plain `assistant`/`user` text without `tool_calls` or `role: 'tool'` fields.
- **AC-5 (FR-5):** Given messages containing `System` role (`3`), `message.name = "GitHub Copilot"`, `LanguageModelDataPart.json({ a: 1 })`, and `LanguageModelPromptTsxPart`, When `convertMessages` runs, Then no error is thrown, `role: 'system'` is produced, `name` is sanitized to `"GitHub_Copilot"`, and JSON/prompt-tsx content is preserved as text.
- **AC-6 (FR-6):** Given `/v1/chat/completions` returns either (a) an SSE stream containing reasoning chunks, metadata chunks without `choices`, and `data: [DONE]` or (b) an `application/json` completion object, When `provideLanguageModelChatResponse` processes the response, Then all text/tool-call parts are reported to `progress` without error.

## 9. Assumptions
- A-1: Users who previously saved `http://localhost:3001/v1` explicitly in their VS Code global settings can update it via **FreeLLMAPI: Configure Connection** (`freellmapi.configure`).
- A-2: Router slot models in FreeLLMAPI (`auto`, `claude-opus-4-5`, `claude-sonnet-4-5`, `claude-haiku-4-5`) omit `supported_parameters` and automatically filter to tool-capable upstream models when `tools` is present in the request body.

## 10. Open questions
- None (`blocking: no`).

## 11. Risks and trade-offs
- Sanitizing `message.name` replaces spaces/punctuation with `_`; if two participants differed only by punctuation, their sanitized names could match, which has negligible impact on LLM context.
- Degrading historical `tool_calls` to text when switching mid-thread to a non-tool model alters prompt formatting slightly for that turn in exchange for preventing hard HTTP 400 errors.

## 12. Links
- Design doc: none (Standard inline decisions)
- Decision logs: none
- Source map: none

Approved-by: rolando
Approved-at: 2026-11-27
Status: READY

# Tasks: Fix VS Code Chat to FreeLLMAPI Communication & Protocol Compatibility
Spec: docs/spec.md (Revision 1)
Base commit: none

## Task list
- [ ] T-01 Default base URL → `http://127.0.0.1:31415/v1`
  - Target: extension config
  - Depends on: —
  - Covers: FR-1, AC-1
  - Files: package.json, src/extension.ts, src/provider.ts, README.md, test/apiUtils.test.cjs
  - Done when: all defaults, input-box placeholders and README examples use `http://127.0.0.1:31415/v1`; a test asserts the exported default constant.

- [ ] T-02 Derive `toolCalling` from `supported_parameters`
  - Target: src/apiUtils.ts
  - Depends on: —
  - Covers: FR-2, AC-2
  - Files: src/apiUtils.ts, test/apiUtils.test.cjs
  - Consumes: `GET {baseUrl}/models?execution_status=ready` → `{ data: Array<{ id, supported_parameters?: string[] }> }`
  - Done when: tests prove `auto` and `glm-5.3-flash` → `toolCalling: true`; `fusion` and `deepseek-v4-flash-0731` → `toolCalling: false`.

- [ ] T-03 Guard `tools` / `tool_choice` in the request body
  - Target: src/provider.ts
  - Depends on: T-02
  - Covers: FR-3, AC-2, NFR-1
  - Files: src/provider.ts, test/provider.test.cjs
  - API Contract: `export function buildRequestBody(model: FreeLLMModel, messages: readonly LanguageModelChatRequestMessage[], options: ProvideLanguageModelChatResponseOptions): Record<string, unknown>`
  - Consumes: `POST {baseUrl}/chat/completions` (spec §6)
  - Done when: tests prove `tools` is omitted when `toolCalling=false`, included otherwise, and `tool_choice: 'required'` is set only in Required mode for tool-capable models.

- [ ] T-04 Rich content parts and `name` sanitization
  - Target: src/provider.ts
  - Depends on: —
  - Covers: FR-5, AC-5
  - Files: src/provider.ts, test/provider.test.cjs
  - Done when: tests prove `application/json` and `+json` data parts are decoded, `LanguageModelPromptTsxPart` yields text, unknown parts don't throw, and `"GitHub Copilot"` → `"GitHub_Copilot"`.

- [ ] T-05 System role mapping
  - Target: src/provider.ts
  - Depends on: T-04
  - Covers: FR-5, AC-5
  - Files: src/provider.ts, test/provider.test.cjs
  - Done when: a test proves a role-3 message is converted to `{ role: 'system', content }` without throwing.

- [ ] T-06 `role: 'tool'` conversion and ordering
  - Target: src/provider.ts
  - Depends on: T-04
  - Covers: FR-4, AC-3
  - Files: src/provider.ts, test/provider.test.cjs
  - Done when: a test proves output order assistant(`tool_calls`) → `{ role: 'tool', tool_call_id, content }` → `{ role: 'user', ... }`.

- [ ] T-07 Degrade tool history for non-tool models
  - Target: src/provider.ts
  - Depends on: T-02, T-06
  - Covers: FR-4, AC-4
  - Files: src/provider.ts, test/provider.test.cjs
  - Done when: a test proves no `tool_calls` / `role: 'tool'` remain when converting for a model with `toolCalling=false`, with the content preserved as plain text.

- [ ] T-08 Resilient SSE stream parsing
  - Target: src/provider.ts
  - Depends on: —
  - Covers: FR-6, AC-6
  - Files: src/provider.ts, test/provider.test.cjs
  - Consumes: SSE `chat.completion.chunk` stream (spec §6)
  - Done when: tests prove a stream containing comments, chunks without `choices`, usage-only chunks, `[DONE]` and reasoning-only deltas produces text without error, and `{ error }` payloads still throw.

- [ ] T-09 JSON (non-SSE) completion fallback
  - Target: src/provider.ts
  - Depends on: T-08
  - Covers: FR-6, AC-6, NFR-1
  - Files: src/provider.ts, test/provider.test.cjs
  - Consumes: `application/json` `chat.completion` object (spec §6)
  - Done when: tests prove `message.content`, `message.reasoning` (fallback) and `message.tool_calls` are reported from a JSON response.

- [ ] T-10 Version bump, docs and package build
  - Target: packaging
  - Depends on: T-01, T-02, T-03, T-04, T-05, T-06, T-07, T-08, T-09
  - Covers: NFR-2, NFR-3
  - Files: package.json, README.md
  - Done when: `npm test` is green in < 5s, `npx tsc --noEmit` is clean, version is 0.1.2, and `make vsix` produces `freellmapi-vscode-0.1.2.vsix`.

## Traceability
| Spec ID | Tasks |
|---|---|
| FR-1 | T-01 |
| FR-2 | T-02 |
| FR-3 | T-03 |
| FR-4 | T-06, T-07 |
| FR-5 | T-04, T-05 |
| FR-6 | T-08, T-09 |
| NFR-1 | T-03, T-09 |
| NFR-2 | T-10 |
| NFR-3 | T-10 |
| AC-1 | T-01 |
| AC-2 | T-02, T-03 |
| AC-3 | T-06 |
| AC-4 | T-07 |
| AC-5 | T-04, T-05 |
| AC-6 | T-08, T-09 |

## Review adjustments
<!-- sdd-review appends R-xx tasks here -->

Status: TASKS READY

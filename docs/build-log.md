# Build log
## Run 1 — 2026-11-27T20:37
Base commit: c7fc04823c2b4288b8cc2f0cf0d4c3ce7c07a62e (git initialised by sdd-build; branch `fix/freellmapi-communication`)
Toolchain: TypeScript 5.9 · typecheck `npx tsc --noEmit` · build `npm run compile` · test `npm test` · package `make vsix`
Baseline: tsc ✔ · tests 5 passed / 0 failed

### T-01 Default base URL → `http://127.0.0.1:31415/v1` — DONE
- Files: package.json, src/apiUtils.ts (exported `DEFAULT_BASE_URL`), src/extension.ts, src/provider.ts, README.md
- Tests: `defaults to the FreeLLMAPI desktop app URL (AC-1)`
- Review: Spec ✅ · Code quality ✅ (removed duplicated constant)
- Checks: tsc ✔ test ✔ (7 passed)

### T-02 Derive `toolCalling` from `supported_parameters` — DONE
- Files: src/apiUtils.ts (`supportsToolCalling`)
- Tests: `derives tool calling from supported_parameters (AC-2)`
- Review: Spec ✅ · Code quality ✅
- Checks: tsc ✔ test ✔ (7 passed)
- Commit: shared with T-01 (both tasks edit src/apiUtils.ts) — `fix(models): default to desktop URL and derive tool support [T-01][T-02]`

### T-03 … T-09 Provider protocol fixes — DONE
- Files: src/provider.ts, test/provider.test.cjs
- New exports: `buildRequestBody` (T-03), `convertMessages(messages, { toolCalling })` (T-04…T-07), `parseEventStream` (T-08), `parseJsonCompletion` (T-09); shared `ResponseAccumulator` for SSE + JSON.
- Tests (14 in provider.test.cjs): tools guard (AC-2); JSON/+json/prompt-tsx/unknown parts + name sanitization, empty-name drop, system role (AC-5); role:'tool' ordering (AC-3); non-tool degradation + orphan tool results (AC-4); SSE comments/choice-less/usage/[DONE], reasoning fallback, streamed tool-call assembly, error payloads, JSON completion content/tool_calls/reasoning/error (AC-6).
- Review: Spec ✅ (AC-2…AC-6) · Code quality ✅ (one accumulator, type-guarded field access, no new deps)
- Checks: tsc ✔ test ✔ (19 passed, ~130 ms)
- Deviation: all seven tasks rewrite the same module (src/provider.ts), so they were test-driven together (12 red → 19 green) and committed as one commit listing every task ID instead of one commit per task.
- Commit: `fix(provider): OpenAI-compliant messages, tool guard and resilient parsing [T-03][T-04][T-05][T-06][T-07][T-08][T-09]`

### T-10 Version bump, docs and package build — DONE
- Files: package.json, package-lock.json (0.1.2), README.md (URLs + per-model tool support), .vscodeignore (+`docs/**`, `*.vsix`)
- Review: Spec ✅ · Code quality ✅ — the package now contains only manifest, readme and out/*.js (7 files, 11.38 KB)
- Checks: tsc ✔ test ✔ (19 passed) · `make vsix` ✔ → freellmapi-vscode-0.1.2.vsix
- Commit: `chore(release): 0.1.2 with docs and packaging excludes [T-10]`

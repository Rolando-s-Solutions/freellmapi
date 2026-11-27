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

# Changelog

All notable changes to `@shipispec/tsfix` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added (Layer 4 — stub-and-continue escape hatch)
- **`stubAndContinue(opts)`** — new public API. Inserts `// @ts-expect-error - tsfix: <codes> — <message>` immediately above each unresolved error site so `tsc --noEmit` exits 0. Closes the "tsfix never leaves the workspace worse than it found it" property. Uses `@ts-expect-error` (not `@ts-ignore`) so directives self-destruct once the underlying issue is fixed by other means.
- **`runMendLoop` opt-in flag** — new `stubOnFailure?: boolean` option (default `false`). When the LLM loop terminates with leftover errors and the flag is set, Layer 4 runs automatically. New `"stubbed"` stop reason; new `stubs?: AppliedStub[]` result field with what was applied.
- **Idempotency** — re-running `stubAndContinue` on an already-stubbed workspace is a no-op. Detects existing `@ts-expect-error` / `@ts-ignore` directives on the line above and skips.
- **Safe skips** — `node_modules/`, `.d.ts` files, missing files, and lines beyond file length are recorded as `skipped` (with reason) rather than crashing.
- **Multi-error coalescing** — multiple diagnostics on the same line collapse into one stub comment listing all TS codes and joined messages.
- **Indent + CRLF preservation** — comment matches the indentation of the line it's stubbing; CRLF line endings on Windows-authored files survive the rewrite.
- **`dryRun`** support — same semantics as Layer 2: reports `stubsApplied` without writing.

### Added (fixture engine — Day 2/3 mutators)
- **5 new ts-morph mutators** covering codes the original 3-mutator set didn't reach:
  - `ts2322-incompatible-return.mjs` — replaces a return expression with a wrong-typed primitive literal in a function with a primitive return type
  - `ts2304-cannot-find-name.mjs` — renames a value-position identifier (variable, call, parameter usage) to a no-near-match string; Layer 0's auto-import abstains because there's no candidate
  - `ts2345-arg-type-mismatch.mjs` — replaces a function-call argument with a wrong-typed primitive when the parameter's declared type is `string` / `number` / `boolean`
  - `ts2554-arg-count-mismatch.mjs` — drops the trailing argument from a call that currently satisfies its signature
  - `ts2365-operator-mismatch.mjs` — replaces one operand of a numeric binary expression (`<`, `>`, `<=`, `>=`, `-`, `*`, `/`, `%`) with a string literal
- **50 new generated fixtures** (10 per new code × 8 codes total). Total Layer-2 fixture corpus: **85** (was 35) — 3 minimal + 2 realistic + 80 generated across 8 codes. Total fixture count across all layers: **99** (14 Layer-0 + 85 Layer-2).

### Added (tests)
- **19 new Layer-4 unit tests** — 16 in `stubAndContinue.test.ts` + 3 in `runMendLoop.test.ts` covering single error, multi-error-same-line, multi-code, indent preservation, descending-order processing, idempotency, node_modules skip, .d.ts skip, missing-file skip, dry-run, message truncation, CRLF preservation, first-line edge case, no-eligible case, warning/suggestion filtering, and the runMendLoop integration (stopReason flip, default-off behavior, dryRun interaction).

### Changed
- **Public surface** at `src/index.ts` extended with `stubAndContinue`, `StubAndContinueOptions`, `StubAndContinueResult`, `AppliedStub`, `SkippedStub`. Layer 0/1/2 surface unchanged.
- **`RunMendLoopOptions`** gains `stubOnFailure?: boolean`. **`RunMendLoopResult`** gains optional `stubs?: AppliedStub[]`. **`StopReason`** union gains `"stubbed"`. All additive — old callers unaffected.
- **`scripts/generate-fixtures.mjs`** now runs via `tsx` and imports from `src/index.ts` directly instead of `dist/index.js`. Reason: the v0.4.0 dist bundle inlines `@vercel/oidc` (transitive of `ai`), which uses dynamic `require()` patterns that fail under esbuild's ESM output at module-init time. The generator only needs Layer 0/1 entry points, so importing from source bypasses the AI SDK entirely. Side benefit: no `npm run build` prerequisite — `npm run generate-fixtures` works from a fresh clone.
- Removed `pregenerate-fixtures: npm run build` hook from `package.json`.

### Fixed
- **`stubAndContinue` resolves relative paths** against `workspaceRoot`. Diagnostics from `runInProcessTsc` use relative paths; consumers may pass absolute. Both work.

### Deferred (fixture engine)
- **TS2532** (Object is possibly undefined) — seeds don't currently contain optional chains or `Map.get()`-style calls that would produce TS2532 deterministically. Mutator deferred until seeds expand or a real-failure capture provides better candidates.
- **TS2551-negative** (LSP returns multiple equally-close fix candidates → abstains) — engineering a deterministic TS2551 case where Layer 0's `fixesAreEquivalent` check abstains is contrived. Defer until we see a real-world example.

## [0.4.0] - 2026-05-14

**Layer 2 LLM mend is now in-package.** The previously-planned sister package `@shipispec/tsmend` has been folded into `tsfix` so the deterministic Layer 0/1 stack and the LLM-driven Layer 2 stack ship as one. This reverses the v0.3.0 sister-package decision (D3) — see roadmap update.

### Added (Layer 2 — single-file LLM mend)
- **`getTypeContext(opts)`** — TS Language Service helper. Resolves an error site to its declaring type via `getTypeAtLocation()` + `getDeclarations()`, slices ±3 lines around the error site and ±20 lines around the declaration. Bounded walk-up (4 hops) plus a special case for `PropertyAccessExpression` so TS2339 errors resolve to the *receiver's* type, not the non-existent property's. The architectural moat — no other OSS tool does this for TypeScript specifically.
- **`mendSingleFile(opts)`** — single-LLM repair via Vercel AI SDK + `@ai-sdk/anthropic`. Uses top-level `system:` parameter (v6 pattern), markdown-headered file delimiters in the prompt (XML wrappers caused Claude to mirror them in output and break the parser). Returns `rawResponse`, parsed `blocks`, `apply` result, token counts, latency.
- **`applySingleBlock(content, search, replace)`** + **`applyEditBlocks(opts)`** + **`parseEditBlocks(text)`** — Aider-style `editblock` parser and 3-tier fuzzy applier (exact → rstrip → strip). Defensive parser handles `<file path="…">` wrappers Claude emits when the system prompt uses XML markers. Abstains on ambiguous matches (multiple hits) rather than guess.
- **`runMendLoop(opts)`** — bounded retry (default 3 iterations) with no-progress / regression detection via error-signature-set comparison. Streams per-iteration data: `patchesApplied`, `patchesFailed`, `inputTokens`, `outputTokens`, `latencyMs`, `rawResponse`. Stop reasons: `noErrors`, `fixed`, `noProgress`, `regressed`, `maxIterations`.

### Added (fixtures + harness)
- **3 hand-authored minimal Layer-2 fixtures** — `mend-ts2339-property-typo`, `mend-ts7006-implicit-any`, `mend-ts2741-missing-prop`.
- **2 realistic Layer-2 fixtures** — `realistic-multi-error-user-helpers` (3 errors, 1 file, `taskDescription` populated), `realistic-rename-ripple` (2 errors, 2 files).
- **30 auto-generated fixtures** via `scripts/generate-fixtures.mjs` (ts-morph AST mutators × 3 codes × 3 seeds × 10 each). Total Layer-2 fixture corpus: **35**.
- **`benchmark/run-llm-benchmark.ts`** (`npm run benchmark:llm`) — Layer 2 live LLM benchmark against Anthropic. Skips silently with exit 0 when `ANTHROPIC_API_KEY` is unset.
- **`scripts/generate-fixtures.mjs`** (`npm run generate-fixtures`) — ts-morph AST mutators that introduce one targeted error per fixture into a valid seed file. Validation gate: every mutation runs through `runInProcessTsc` to confirm the expected error code, then through `runValidationLoop` to confirm Layer 0 abstains. Memory-bounded shared `Project` + tempDir + cache resets to prevent OOMs.

### Added (tests)
- **33 unit tests** across `typeContext`, `applyEditBlock`, `mendAgent`, `runMendLoop`. Mocked LLM call via injectable `_callLLM` — tests never hit the real API.

### Added (CI)
- Workflow gains a Layer-2 benchmark step gated on `ANTHROPIC_API_KEY` (skips cleanly when unset). Existing Layer-0 benchmark + matrix steps unchanged.
- Bumped `actions/checkout` + `actions/setup-node` v4 → v5.

### Changed
- **Dependencies added (runtime):** `@ai-sdk/anthropic@^3.0.44`, `ai@^6.0.86`. Previous "near-zero deps" north star (Layer 0/1 only) is superseded — package now spans Layer 0/1/2.
- **Dependencies added (dev):** `ts-morph@^28.0.0` (fixture generation).
- **Public-API surface** at `src/index.ts` extended with the Layer-2 exports listed above. Layer 0/1 surface unchanged — `runValidationLoop`, `runInProcessTsc`, `runLSPFixerPass`, `discoverTsFiles`, and the contract types stay byte-identical.
- **Roadmap decision D3 reversed** — previous decision was "mend in sister package"; current decision is "mend in-package." Updated in `tsc-defense-roadmap.md`.

### Engines
- Node `>=20.9.0` (unchanged)
- TypeScript `>=5.0.0` peer (unchanged)

### Performance signals (Layer 2, 35-fixture run, claude-haiku-4-5)

| Metric | Target | Observed |
|---|---|---|
| Pass rate | ≥70% (Haiku floor) | **100%** (35/35) |
| Iter-1 success | ≥40% | **97%** (34/35) |
| Cost / fixture | ≤$0.005 | **$0.001 avg** |
| Latency / fixture | P95 ≤25s | ~1.5s |

Caveat: 30 of 35 fixtures are single-error mutations of 3 seeds. Real-world diversity will dent these numbers.

## [0.3.0] - 2026-05-07

Phase 2 contract release. **Establishes the public types `MendContext`, `LayerEvent`, and `Diagnostic` so a downstream LLM-mend package (e.g. `@shipispec/tsmend`) can consume tsfix's output without redefining the shape.** No behavior changes; purely additive types. Also collapses several dev-only improvements that landed since v0.2.0 into a single release.

### Added
- **`MendContext` interface** — public type defining the input contract for a Layer 2–4 LLM-mend agent. Required fields: `workspaceRoot`, `diagnostics`, `erroredFiles`. Optional fields: `taskDescription`, `featureSpecText`, `acceptanceCriteria`, `siblingTasks`, `priorTaskExports`, `installedTypes`.
- **`LayerEvent` interface** — per-layer event shape for streaming telemetry. Designed for an `onLayerEvent` callback in a future minor release; the type is published now so downstream callers can construct events themselves.
- **`Diagnostic` type alias** — public re-export of `InProcessTscResult["diagnostics"][number]`. Convenience for consumers building `MendContext`.
- **Project-shape matrix** (`scripts/run-matrix.mjs`, `npm run matrix`) — pre-publish gate that builds the local tarball and exercises it cold against 6 distinct project shapes: `monorepo-refs` (project references — pinned as a documented limitation), `next-app` (App Router, `paths` alias, `jsx: preserve`), `plain-ts-bundler` (esnext + bundler), `plain-ts-commonjs` (legacy CJS + ES2015 + node10), `plain-ts-nodenext` (nodenext resolution), `react-vite` (TSX + `jsx: react-jsx`). 6/6 pass. Dev-only — not shipped in the tarball.
- **Capture script** (`scripts/capture-fixture.mjs`, `npm run capture`) — Phase 3b tooling for snapshotting real broken workspaces into `fixtures/real-<name>/`. Awaits first real failure to produce fixtures.
- **GitHub Actions CI** (`.github/workflows/test.yml`) — runs check-types, vitest, benchmark, and the matrix on every PR + main push.

### Changed
- **Repository moved.** `tsc-defense-stack/` was extracted from the `spectoship-meta` monorepo into its own repository at <https://github.com/owgreen-dev/tsfix>. All `repository.url`, `homepage`, `bugs.url` fields point at the new repo. Internal git history pre-2026-05-06 lives in the original monorepo; the CHANGELOG narrates v0.1.0–v0.2.0 in detail.
- **Public README rewritten** for an OSS audience — tagline, before/after, 30-second cold start, four-layer model, library API, trust model, contributing protocol. Previous internal-orientation README preserved at `docs/internal-orientation.md`.

### Engines
- Node `>=20.9.0` (unchanged)
- TypeScript `>=5.0.0` peer (unchanged)

## [0.2.0] - 2026-05-04

Phase 1a complete. **Plain Node consumers can now `import` the package without a TypeScript loader, and `npx @shipispec/tsfix` works cold.** Folds in everything that was queued for v0.1.1 (which was never published — its commit is now part of v0.2.0).

### Added
- **esbuild bundle** in `dist/`. Three artifacts: `dist/index.js` (library, ESM bundle), `dist/cli.js` (CLI, ESM with shebang, executable), `dist/index.d.ts` (public type declarations from `tsc --emitDeclarationOnly`). Per-file `.d.ts` files in `dist/types/` for callers wanting subpath types.
- `npm run build` → `node scripts/build.mjs`. Also runs as `prepublishOnly` so `npm publish` always ships fresh `dist/`.
- **`--dry-run` flag** on the CLI and `dryRun` option on `runValidationLoop` and `runLSPFixerPass`. Runs the full LSP fix loop in memory; reports what *would* be edited; no disk writes. Resolves the documented footgun where pointing tsfix at a fixture irreversibly mutated it. (Audit M-E4.)
- **Trust model section** in README: `tsfix` loads `typescript` from your workspace's `node_modules`. Only run on workspaces you trust. (Audit M-S1.)
- **Troubleshooting section** in README covering the most likely user errors (`ERR_MODULE_NOT_FOUND` for typescript; missing `tsconfig.json`).
- **Dev-vs-consumer guidance** in README. (Audit M-E3.)
- **3 dryRun unit tests** in `src/dryRun.test.ts`.

### Changed
- **Package shape**: `main`/`types`/`exports` now point at `dist/`, not `src/`. `bin.tsfix` points at `dist/cli.js` directly. `files` array ships `dist/` only (no more `src/`, `cli/`, `bin/` in tarball). Tarball: 10 files, 16.8 KB packed.
- **Removed `bin/tsfix.mjs` wrapper** — replaced by the bundled `dist/cli.js`. The wrapper was a Phase 0c bridge that depended on local `tsx`; the bundle drops that dependency.
- **Dropped `./validation` and `./lsp-fixer` subpath exports** — unused; the only consumer (spectoship2 shims) imports from the main entry. Easy to re-add if needed.
- README CLI section rewritten to reflect Phase 0c standalone install (no longer references the old `cd spectoship2 && tsx ../tsc-defense-stack/...` flow).

### Fixed
- **Plain Node `import { runValidationLoop } from "@shipispec/tsfix"` now works.** Was previously blocked by Node 22+ refusing to type-strip `.ts` files in `node_modules` (audit H-E1). Verified end-to-end via `npm install` from tarball + `node use-as-library.mjs`.
- **`npx @shipispec/tsfix --workspace ./project` now works cold.** Was previously blocked by the bin wrapper requiring `tsx` from the package's own `node_modules` (audit M-E2).
- `bin/tsfix.mjs` error message no longer references the old `tsc-defense` name (n/a in 0.2.0 — wrapper deleted entirely; audit M-E1).
- `cli/run-stack.ts` no longer ships with executable permission bits (the bundled `dist/cli.js` does, which is correct since it's the actual entry; audit L-S2).

### Engines
- Node `>=20.9.0` (unchanged)
- TypeScript `>=5.0.0` peer (unchanged; npm 7+ auto-installs)

### Outstanding from audit (deferred)
- L-S1 (npm `--provenance` for supply-chain attestation) — Phase 1b CI publish.

## [0.1.1] - 2026-05-04

Patch release addressing the medium-severity findings from the post-publish audit (`docs/audit-2026-05-04.md`). No API breaks; consumers can upgrade with `npm install @shipispec/tsfix@latest`.

### Added
- **`--dry-run` flag** on the CLI and a corresponding `dryRun` option on `runValidationLoop` and `runLSPFixerPass`. Runs the full LSP fix loop in memory and reports what *would* be edited, but does not write to disk. Resolves the documented footgun where running `tsfix` against a fixture directory irreversibly mutated the broken code. (Audit M-E4.)
- **Trust model section** in README: explicit disclosure that `tsfix` loads `typescript` from the workspace's `node_modules`, with the standard "only run on workspaces you trust" warning. (Audit M-S1.)
- **Dev-vs-consumer guidance** in README: clarifies that `npm scripts` shipped in the published `package.json` (benchmark/test/setup-fixtures) are for contributors only — consumer-side `node_modules/@shipispec/tsfix/` doesn't have `tsx`/`vitest`/`fixtures/`. (Audit M-E3.)

### Fixed
- `bin/tsfix.mjs` error message no longer references the old `tsc-defense` name; now describes the correct `tsfix` flow when `tsx` cannot be resolved. (Audit M-E1.)
- `cli/run-stack.ts` no longer ships with executable permission bits (was `-rwxr-xr-x`, now `-rw-r--r--`). The file is loaded by `tsx`, never run directly. (Audit L-S2.)

### Changed
- README CLI section rewritten to reflect Phase 0c standalone install (no longer references the old monorepo `cd spectoship2 && tsx ../tsc-defense-stack/...` flow).

## [0.1.0] - 2026-05-04

Initial public release. **Layers 0–1 only** (deterministic detection + auto-fix). LLM-driven mend layers stay in `spectoship2/` until v0.2.

### Added
- **`runValidationLoop(opts)`** — full deterministic loop (validate → auto-fix → re-validate). Recommended entry point.
- **`runInProcessTsc(opts)`** — in-process `tsc --noEmit` returning structured diagnostics. No subprocess spawn, no Node 23 startup-pause issue. Workspace lib-path override (uses the workspace's `node_modules/typescript` so globals resolve under esbuild bundling).
- **`runLSPFixerPass(opts)`** — Layer 0 deterministic auto-fixer using `ts.LanguageService.getCodeFixesAtPosition`. Strictly opt-in by error code and fix name:
  - `SAFE_FIXABLE_CODES`: `TS2304`, `TS2305`, `TS2551`, `TS2552`, `TS2724`
  - `SAFE_FIX_NAMES`: `import`, `fixImport`, `spelling`, `fixSpelling`
  - 5-iteration cap with signature-set progress check (stops when the `(file, start, code)` set repeats)
  - Multi-fix equivalence check abstains when candidate fixes produce different edits
- **`discoverTsFiles(workspaceRoot)`** — file-discovery helper. Includes `.ts`/`.tsx`; excludes `.d.ts` and `node_modules`/`.next`/`dist`/`build`/`out`/`coverage`/`.git`.
- **CLI** (`tsfix --workspace <path>`, after `npm link`). Flags: `--json`, `--no-lsp`, `--verbose`, `--files <comma-list>`, `--help`. Exit 0 = clean, 1 = errors remain, 2 = bad args.
- **MIT license**, no runtime deps except peer `typescript >=5.0.0`.

### Known limitations
- **`npx @shipispec/tsfix ./project`** does not work for cold-start. The bin wrapper requires `tsx` to be resolvable from the package's own `node_modules`. Use `npm install @shipispec/tsfix && npm link` for now. Phase 1a (esbuild bundle) addresses this.
- **`export { X } from "./mod"`** — TS LanguageService returns zero code-fixes for typos in this syntactic position. Documented in `fixtures/synthetic-cross-file-typo-ts2305/`.
- **Footgun:** the CLI mutates files in place with no snapshot/restore. Don't point it at the package's own `fixtures/` directories during dev — use `npm run benchmark` instead, which snapshots and restores.

### Engines
- Node `>=20.9.0` (matches VS Code Extension Host runtime)
- TypeScript `>=5.0.0` (peer dep, must be installed in the consuming workspace)

[Unreleased]: https://github.com/owgreen-dev/tsfix/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/owgreen-dev/tsfix/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/owgreen-dev/tsfix/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/owgreen-dev/tsfix/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/owgreen-dev/tsfix/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/owgreen-dev/tsfix/releases/tag/v0.1.0

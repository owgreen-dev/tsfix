# tsfix — Status

> Snapshot: 2026-05-14. Read alongside `README.md` (orientation), `CLAUDE.md` (working principles), `tsc-defense-roadmap.md` (phased plan), `CHANGELOG.md` (release history).

## TL;DR

`@shipispec/tsfix` is a two-layer TypeScript error-recovery package. **v0.3.0 is live on npm** (Layer 0/1 only, deterministic). **v0.4.0 is merged to `main`** and ready to publish — adds Layer 2 LLM mend in-package (folded in from the previously-planned `@shipispec/tsmend` sister package, per reversed roadmap decision D3).

| Layer | Status | Benchmark |
|---|---|---|
| 0/1 — deterministic LSP fixer | shipped (v0.1.0+) | 14/14 fixtures, 56% auto-fix rate |
| 2 — single-file LLM mend | in-package (v0.4.0, unreleased) | 35/35 fixtures @ $0.001 avg / fixture / `claude-haiku-4-5` |
| 3 — multi-file LLM mend | planned | — |
| 4 — stub-and-continue | planned | — |

**Install:** `npm install @shipispec/tsfix` (peer dep: `typescript >=5.0.0`).
**CLI:** `npx @shipispec/tsfix --workspace <path>` (Layer 0/1; cold-start works since v0.2.0).
**Layer 2:** opt-in via the library API — see README "Layer 2 — LLM mend".

---

## What works

### Public API (`src/index.ts`)

**Layer 0/1 — deterministic:**
- `runValidationLoop(opts)` — full deterministic loop (validate → auto-fix → re-validate). Recommended entry point. Supports `dryRun`.
- `runInProcessTsc(opts)` — in-process `tsc --noEmit` returning structured diagnostics. No spawn overhead, no Node 23 startup-pause issue.
- `runLSPFixerPass(opts)` — Layer 0 only.
- `discoverTsFiles(workspaceRoot)` — file discovery helper.

**Layer 2 — LLM mend (v0.4.0):**
- `runMendLoop(opts)` — bounded retry (default 3 iterations) with no-progress / regression detection via error-signature-set comparison. Streams per-iteration `MendLoopIteration` data: `patchesApplied`, `patchesFailed`, `inputTokens`, `outputTokens`, `latencyMs`, `rawResponse`. Stop reasons: `noErrors`, `fixed`, `noProgress`, `regressed`, `maxIterations`.
- `mendSingleFile(opts)` — single LLM call. Vercel AI SDK + `@ai-sdk/anthropic`, top-level `system:` parameter (v6 pattern), markdown-headered file delimiters in the prompt (XML wrappers caused Claude to mirror them in output and break the parser).
- `getTypeContext(opts)` — TS Language Service helper. Resolves an error site to its declaring type via `getTypeAtLocation()` + `getDeclarations()`, slices ±3 lines around the error site and ±20 lines around the declaration. Bounded walk-up (4 hops) plus a special case for `PropertyAccessExpression` so TS2339 errors resolve to the *receiver's* type, not the non-existent property's. **The architectural moat — no other OSS tool does this for TypeScript specifically.**
- `applySingleBlock` / `applyEditBlocks` / `parseEditBlocks` — Aider-style SEARCH/REPLACE parser + 3-tier fuzzy applier (exact → rstrip → strip). Defensive parser handles `<file path="…">` wrappers. Abstains on ambiguous matches.
- Contract types: `MendContext`, `LayerEvent`, `Diagnostic`, plus per-function options/results.

### Layer 0 — TS LanguageService auto-fixer
Uses `ts.LanguageService.getCodeFixesAtPosition` (the same engine VS Code Quick Fix uses).

**Fixable error codes** (`SAFE_FIXABLE_CODES` — `tsLanguageServiceFixer.ts:37`):
| Code | Meaning | Fix |
|---|---|---|
| TS2304 | Cannot find name | auto-import |
| TS2305 | Module has no exported member | did-you-mean rename |
| TS2551 | Property does not exist, did you mean Y | spelling |
| TS2552 | Cannot find name, did you mean Y | spelling |
| TS2724 | Module member did-you-mean | import rename |

**Safe fix names** (`SAFE_FIX_NAMES` — `tsLanguageServiceFixer.ts:54`): `import`, `fixImport`, `spelling`, `fixSpelling`.

**Iteration loop**: default 5 passes (`tsLanguageServiceFixer.ts:108`). Stops early via signature-set progress check — if the set of `(file, start, code)` tuples is identical across two iterations, we're stuck.

### Layer 2 — single-file LLM mend
Vercel AI SDK + `@ai-sdk/anthropic`. Default model `claude-haiku-4-5`. Pricing baked into the benchmark cost estimator: $0.80 input / $4.00 output per million tokens.

**Stop conditions (`runMendLoop`):**
- `noErrors` — no diagnostics in the context to begin with (vacuous pass).
- `fixed` — `errorsAfter === 0` after an iteration.
- `noProgress` — error signature set unchanged across two iterations.
- `regressed` — `errorsAfter > errorsBefore` (the LLM made it worse).
- `maxIterations` — hit the iteration cap with progress but unfinished.

**Prompt context (`getTypeContext`):**
- For `TS2339` (property doesn't exist), `PropertyAccessExpression` special case walks up to the receiver, calls `getTypeAtLocation` there, finds the type's declaration, and emits source ±20 lines.
- For other codes, bounded walk-up (4 hops) finds the nearest typed parent.
- Abstains and returns `errorSite` only when no resolvable user-land type exists (e.g. TS2304 against a global).

### CLI (`dist/cli.js`)
`npx @shipispec/tsfix --workspace <path>`. Cold-start works since v0.2.0 (esbuild bundle). Flags: `--json`, `--no-lsp`, `--verbose`, `--files <comma-list>`, `--dry-run`, `--help`. Exit 0 = clean, 1 = errors remain, 2 = bad args. **CLI is Layer 0/1 only** — Layer 2 requires invoking the library API explicitly.

### Benchmarks

**Layer 0 (`benchmark/run-benchmark.ts`, `npm run benchmark`):**
- 14/14 fixtures pass, 56% auto-fix rate (14/25 errors).
- Iterates `fixtures/<name>/` directories that have a Layer-0-shaped `expected.json` (no `costUsdMax`, no `expectedErrorCode`).
- Snapshots each fixture's source files in memory; restores after the run.
- `--fixture <name>` to run one in isolation.

**Layer 2 (`benchmark/run-llm-benchmark.ts`, `npm run benchmark:llm`):**
- 35/35 fixtures pass on `claude-haiku-4-5`, $0.036 total ($0.001 avg / fixture), iter-1 success 97%, P95 latency ~1.5s.
- Iterates `fixtures/<name>/` with a Layer-2-shaped `expected.json` (3 minimal `mend-*` + 2 `realistic-*` + 30 `gen-*`).
- Snapshots → builds `MendContext` (merging optional fields from `expected.json#mendContext`) → runs `runMendLoop` → compares to expected → restores snapshot.
- Skips silently with exit 0 when `ANTHROPIC_API_KEY` is unset — keeps CI green until the secret is configured.

**Project-shape matrix (`scripts/run-matrix.mjs`, `npm run matrix`):**
Pre-publish gate. Builds the local tarball, then for each `test-matrix/<sample>/` copies it to `/tmp/tsfix-matrix/<sample>/`, runs `npm install` + `npm install <tarball> typescript`, executes `tsfix --workspace . --json`, and compares against `expected.json`.

| Sample | Project shape | errorsBefore → after | Notes |
|---|---|---|---|
| `monorepo-refs` | TS project references | 0 → 0 | **Pinned limitation.** Root tsconfig parses to zero `fileNames`; in-process tsc never sees leaves. Workaround: point `--workspace` at a leaf. |
| `next-app` | Next.js App Router | 4 → 3 | TS2552 fixed; 3 JSX-namespace errors correctly left alone (need `jsxImportSource: react` or the Next compiler plugin). `mustPass: false`. |
| `plain-ts-bundler` | esnext + bundler | 1 → 0 | Baseline. |
| `plain-ts-commonjs` | CJS, ES2015, node10 | 1 → 0 | Legacy long-lived-codebase setup. |
| `plain-ts-nodenext` | nodenext + `@types/node` | 1 → 0 | Nodenext semantics. |
| `react-vite` | TSX, `jsx: react-jsx` | 2 → 0 | Two typos in one TSX file. |

**6/6 passing.** Not wired into `prepack` (adds ~3 min) — run manually before tagging.

### Fixture catalog

**Layer 0 (14):**
- `clean-baseline`, `synthetic-missing-import-ts2304`, `synthetic-no-exported-member-ts2305`, `synthetic-import-rename-ts2724`, `synthetic-property-typo-ts2551`, `synthetic-typo-ts2552`, `synthetic-multifile-ripple` (positive — Layer 0 resolves to zero)
- `synthetic-implicit-any-ts7006`, `synthetic-missing-prop-ts2741`, `synthetic-cross-file-typo-ts2305` (negative — Layer 0 abstains, escapes to Layer 2)
- `api-drift-zod4-against-v3`, `api-drift-react19-against-v18`, `api-drift-next16-sync-cookies`, `api-drift-drizzle-wrong-subpath` (API-drift — modeled on real LLM mistakes; semantic mismatches that auto-import can't resolve)

**Layer 2 (35):**
- 3 hand-authored minimal: `mend-ts2339-property-typo`, `mend-ts7006-implicit-any`, `mend-ts2741-missing-prop`.
- 2 realistic: `realistic-multi-error-user-helpers` (3 errors, 1 file, `taskDescription` populated), `realistic-rename-ripple` (2 errors, 2 files — exercises the iteration loop across files).
- 30 auto-generated via `npm run generate-fixtures` (ts-morph AST mutators × 3 codes × 3 seeds × ~10 each). Seeds: `userCrud.ts`, `validators.ts`, `apiRouter.ts`.

### Tests (`vitest run`)
**62/62 passing across 8 files.**
- Layer 0/1: `index.test.ts` (9), `tsLanguageServiceFixer.test.ts` (15), `validatorInProcess.test.ts` (2), `dryRun.test.ts` (3) — 29 tests.
- Layer 2: `typeContext.test.ts` (3), `applyEditBlock.test.ts` (16), `mendAgent.test.ts` (8), `runMendLoop.test.ts` (6) — 33 tests. Mocked LLM via injectable `_callLLM` — tests never hit the real API.

### CI (`.github/workflows/test.yml`)
`actions/checkout@v5` + `actions/setup-node@v5`, Node 20. Runs check-types + vitest + Layer-0 benchmark + matrix on every PR + main push. New Layer-2 step gated on `ANTHROPIC_API_KEY` — skips cleanly when unset.

### Distribution
- esbuild bundle in `dist/`: `index.js` (1.3 MB — AI SDK adds weight), `cli.js` (22 kB, executable), `index.d.ts` (8 kB) + per-file `.d.ts` in `dist/types/`.
- `prepack` rebuilds `dist/` before publish — tarball always ships fresh.
- Tarball at v0.4.0: 14 files, 222 kB packed, 1.3 MB unpacked.

---

## What's planned

### v0.5+ — Layer 3 (multi-file LLM mend)
Currently `runMendLoop` iterates per-file: each iteration runs `mendSingleFile` against `erroredFiles[0]`, then re-validates, then takes the next errored file. This collapses multi-file ripples through iteration but pays N LLM calls for N files.

Layer 3 uses `ts.LanguageService.findReferences()` to compute blast-radius before the LLM call: rename `getUserEmail` → `getEmail` and the loop sees a single edit spanning N call sites in one model invocation. Eliminates "fix one caller, break another" entirely.

Blocker: needs a real-failure fixture that exhibits ripple semantics the per-file iteration loop can't already handle. Synthetic ripple fixtures so far converge via iteration; we don't have a forcing function yet.

### v0.5+ — Layer 4 (stub-and-continue)
Escape hatch for errors no LLM resolves: insert a `// @ts-expect-error` or a typed `as never` stub at the error site, emit a `LayerEvent` so the caller can surface it for human review, and continue. Currently `runMendLoop` returns `regressed` or `maxIterations` and leaves the workspace broken.

### Fixture engine — Day 2/3/4
The auto-generator currently covers 3 error codes × 3 seeds. Planned expansions (originally in the tsmend repo):
- Day 2: 4 more mutators (TS2322, TS2345, TS2554, TS2532) → target 70 generated fixtures.
- Day 3: 3 final mutators (TS2304, TS2365, TS2551 negative-test) → target 100 fixtures.
- Day 4: `p-limit(8)` parallelism (~5 min for 100 fixtures vs ~50 min serial), file-based response cache (re-runs free).

After Day 4: full 100-fixture suite against Haiku 4.5 / Sonnet 4 / Opus 4.7 baseline. Publish on README as a public TypeScript-compile-error-repair leaderboard.

### `onLayerEvent` callback
`runValidationLoop` will eventually accept an `onLayerEvent: (e: LayerEvent) => void` parameter so the caller sees a stream of `{layer, errorCode, fixed, latencyMs, costUsd?}` events across Layer 0/1/2. The `LayerEvent` type was published in v0.3.0; the callback wiring is pending.

### Telemetry across logs
Logs are scattered across `[ts-lsp-fixer]`, `[in-process-tsc]`, `[type-context]`, `[mend-agent]`, `[mend-loop]`. Goal: each layer emits structured events (covered by `LayerEvent` above) instead of free-text prefixes.

### Real-failure fixture pipeline
Synthetic fixtures cover known patterns; we need to capture *unknown* patterns from real spec-pipeline failures. `scripts/capture-fixture.mjs` is the tooling — awaits the first production TSC failure to produce a real `fixtures/real-<name>/`.

### Prompt-cache breakpoint optimization
Anthropic's 5-min ephemeral cache offers ~60% token reduction on repeat calls. Deferred until benchmark data justifies the complexity.

---

## Recent changes

### v0.4.0 — Layer 2 integration (2026-05-14)
Folded `@shipispec/tsmend` into this package. Reverses D3 sister-package decision.
- 5 new src files: `typeContext`, `mendAgent`, `applyEditBlock`, `runMendLoop`, + test mirror.
- 33 new Layer-2 fixtures (3 minimal + 2 realistic + 30 generated) + benchmark + generator.
- Runtime deps added: `@ai-sdk/anthropic@^3.0.44`, `ai@^6.0.86`. Dev: `ts-morph@^28.0.0`.
- tsmend's 9 commits preserved in tsfix history via `git merge --allow-unrelated-histories`.
- 62/62 tests pass, 14/14 Layer-0 benchmark, 35/35 Layer-2 benchmark on Haiku 4.5.

### v0.3.0 — Contract types (2026-05-07)
- Added `MendContext`, `LayerEvent`, `Diagnostic` public types. At the time, designed for a downstream sister package; v0.4.0 folded the consumer in.

### v0.2.0 — Standalone bin (2026-05-04)
- esbuild bundle: `dist/index.js`, `dist/cli.js`, `dist/index.d.ts`. `npx @shipispec/tsfix` works cold.
- `--dry-run` flag (resolved the in-place CLI mutation footgun).
- Trust-model + dev-vs-consumer sections in README.

### v0.1.0 — Initial release (2026-05-04)
- Layer 0/1 only. 14 fixtures, 56% auto-fix rate.
- 26 unit tests. Signature-set progress check. `maxIterations` 2 → 5.

---

## Current gaps

### Layer 2 — synthetic fixture diversity
30 of 35 Layer-2 fixtures come from 3 seeds. Mutators produce structurally similar errors (same shapes, same indentation, same property names). Real LLM output is noisier. Engine sprint Days 2-3 partially address by adding more error codes; full diversity needs LLM-driven synthesis (planned) or real-failure capture.

### Layer 2 — `mendSingleFile` ceiling
Processes `erroredFiles[0]` per LLM call. Multi-file errors converge through the loop iterating across files, but each iteration is one LLM call per file. Layer 3 (planned) collapses N file-edits into one call via `findReferences()`-driven blast-radius detection.

### Layer 2 — TS2741 mutator only succeeds on apiRouter seed
The `ts2741-missing-property` mutator skipped 18 attempts on `userCrud.ts` and `validators.ts` to produce 10 successes — all from `apiRouter.ts`. Either contextual-type detection in ts-morph misses some literal contexts, or those seeds genuinely don't have qualifying object literals. Worth investigating once Day 2 lands more error codes.

### Layer 0 — `export { X } from "./mod"`
TS LanguageService returns zero code-fixes for this form, even though it does for `import { X }`. A custom rewriter would be straightforward (look up source module's exports, find closest match by Levenshtein) but the project principle is "don't re-implement what TypeScript already does." Open question whether this pattern is common enough in real LLM output to warrant breaking that rule. **Currently expected to escape to Layer 2**, which can handle it via type-context injection.

### Layer 0 — `useActionState`-style API drift
Where the typo-mistake-vs-real-API distance is too large for the LSP to suggest anything. Layer 0 abstains by design; Layer 2 picks up.

### Coverage gaps in the fixture set
- Multi-file ripple where the error chain crosses 3+ files (current ripple fixture is 2 files, 3 iterations).
- Auto-import where multiple package candidates exist (ambiguity rejection).
- Auto-import where the symbol is in `@types/X` and the bundled types are empty (React's `@types/react` fallback case).
- TSX files at Layer 0 (current set is all `.ts`; JSX-specific fixes like `fixUnknownProperty` aren't probed).
- Workspaces using Yarn PnP, pnpm — currently all fixtures use a flat `node_modules` symlink to `_shared/`.

### Unknown — needs a probe
- Whether the LSP returns auto-import candidates from local files when those files use `export type` vs `export interface` vs `export class` (the `synthetic-missing-import-ts2304` fixture only tests `export function`).
- Whether `getCodeFixesAtPosition` is performance-sensitive at high error counts. Current largest fixture has 5 errors; we don't know what a 100-error file does.
- How `mendSingleFile` performs against Sonnet 4 / Opus 4.7 vs Haiku 4.5 — single-fixture probes suggest the larger models converge in fewer iterations, but no full-suite data yet.

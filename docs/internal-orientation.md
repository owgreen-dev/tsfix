# TSC Defense Stack — `@shipispec/tsfix`

Standalone npm package implementing **Layers 0–1** of the TypeScript error-recovery stack: in-process tsc validation + deterministic LSP auto-fix. Layers 2–4 (LLM mend) currently live in `spectoship2/src/pipeline/` and will move to a sister package `@shipispec/tsmend` per the roadmap.

Read first:
- `STATUS.md` — what's working, what's planned, current gaps
- `ARCHITECTURE.md` — why the package is shaped the way it is
- `tsc-defense-roadmap.md` — phased plan with open decisions
- `CLAUDE.md` — working principles (small allowlist, fixture-pinned trust model)

---

## Source-of-truth map

This package owns its TypeScript-error handling code outright. The shims in `spectoship2/` re-export from here, not the reverse.

| Path | Role |
|---|---|
| `src/index.ts` | Public API (`runValidationLoop`, `runInProcessTsc`, `runLSPFixerPass`, `discoverTsFiles`) |
| `src/validatorInProcess.ts` | In-process tsc with lib-path workaround (Layer 0) |
| `src/tsLanguageServiceFixer.ts` | LSP auto-fixer using `getCodeFixesAtPosition` (Layer 1) |
| `cli/run-stack.ts` | CLI: `tsx cli/run-stack.ts --workspace <path>` |
| `benchmark/run-benchmark.ts` | Fixture harness (auto-discovers `fixtures/*/`) |
| `fixtures/` | 14 hand-authored synthetic fixtures across 3 tiers |
| `spectoship2/src/pipeline/validatorInProcess.ts` | **Re-export shim** → `@shipispec/tsfix` |
| `spectoship2/src/pipeline/tsLanguageServiceFixer.ts` | **Re-export shim** → `@shipispec/tsfix` |

---

## How the layers fit together

Per `ARCHITECTURE.md`, a TSC error has up to four chances to die before reaching a user. Layers -1 (prevention) and 2-4 (mend) live outside this package.

```
                    ┌─────────────────────────────────────────────────┐
                    │ Layer -1: PREVENTION (in spectoship2/, not here)│
                    │   packageGotchas, installedExports, priorExports│
                    │   codeGenPrompts (rules injected into prompt)    │
                    └────────────────────┬────────────────────────────┘
                                         │ files written to disk
                                         ▼
  ┌────── @shipispec/tsfix ───────┴──────────────────────────┐
  │                                                                  │
  │   ┌─────────────────────────────────────────────┐               │
  │   │ Layer 0: src/validatorInProcess.ts           │               │
  │   │   in-process tsc → structured diagnostics    │               │
  │   │   workspace lib-path override                │               │
  │   └─────────────────────┬───────────────────────┘               │
  │                         │ if errors                              │
  │                         ▼                                        │
  │   ┌─────────────────────────────────────────────┐               │
  │   │ Layer 1: src/tsLanguageServiceFixer.ts       │               │
  │   │   getCodeFixesAtPosition (5 SAFE codes)      │               │
  │   │   signature-set progress check, max 5 iters  │               │
  │   └─────────────────────┬───────────────────────┘               │
  │                         │ re-validate; if errors remain          │
  └─────────────────────────┼─────────────────────────────────────────┘
                            ▼
                 ┌─────────────────────────────────┐
                 │ Layers 2-4: LLM MEND            │
                 │   mendAgent / mendArchitect /   │
                 │   multiFileMend / repairAgent   │
                 │   (in spectoship2/, not here;   │
                 │    moves to @shipispec/tsmend│
                 │    in v0.2 per roadmap)         │
                 └─────────────────────────────────┘
```

---

## What to read first

1. **`STATUS.md`** — current state, fixture catalog, recent fixes
2. **`ARCHITECTURE.md`** — why the package is shaped the way it is (12 sections)
3. **`tsc-defense-roadmap.md`** — phased plan with open decisions
4. **`src/index.ts`** — public API entry point (`runValidationLoop`)
5. **`src/tsLanguageServiceFixer.ts`** — Layer 1 fixer; understand `SAFE_FIXABLE_CODES`, the signature-set progress check, and the iteration loop
6. **`src/validatorInProcess.ts`** — in-process tsc with the lib-path workaround that makes the package work inside the VS Code Extension Host

---

## Standalone harness

```
cli/run-stack.ts             # CLI: run stack on any workspace
benchmark/run-benchmark.ts   # benchmark across all fixtures
fixtures/                    # 14 hand-authored synthetic workspaces
  _shared/                   # shared node_modules symlink target
  clean-baseline/            # regression check (must stay green)
  synthetic-*/               # 9 LSP-behavior fixtures (positive + negative)
  api-drift-*/               # 4 version-drift fixtures (Zod 3 vs 4, React 18 vs 19, etc.)
```

### Use as a library (today's recommended path)

`@shipispec/tsfix` ships its source as `.ts`. Plain Node 22+ refuses to type-strip files in `node_modules`, so consumers need a TypeScript-aware loader (`tsx`, `ts-node`, or `jiti`) until v0.2 ships an esbuild bundle. Most LLM-tooling projects already use one of these.

```sh
npm install @shipispec/tsfix typescript
```

```js
// run-fix.mjs
import { runValidationLoop } from "@shipispec/tsfix";

const result = runValidationLoop({ workspaceRoot: "./my-project" });
console.log(result.errorsBefore, "→", result.errorsAfter);
console.log("LSP fixes:", result.lspFixer.fixesApplied);
```

```sh
npx tsx run-fix.mjs    # tsx loads the package's .ts source
```

### Use as a CLI (after `npm link` from a clone)

The bin's `npx` cold-start is blocked on the v0.2 esbuild bundle (see roadmap § 1a). For now, clone-and-link works:

```sh
git clone https://github.com/owgreen-dev/spectoship-meta
cd spectoship-meta/tsc-defense-stack
npm install
npm link

tsfix --workspace ./your-project
```

Flags: `--json`, `--no-lsp`, `--verbose`, `--files <comma-list>`. Exit codes: `0` = clean, `1` = errors remain, `2` = bad args / harness error.

### Run the benchmark (contributor-only)

From inside the package directory after `npm install`:
```sh
npm run benchmark              # all 14 fixtures
npm run benchmark -- --fixture synthetic-typo-ts2552    # one fixture
```

### Current baseline

**14/14 synthetic fixtures pass. LSP fixer auto-resolves 14/25 errors (56%).** The remaining errors are intentional non-fixes — TS7006 implicit-any, TS2741 missing prop, API-drift errors that need the mend layer. See `STATUS.md` § Fixture catalog for the full list.

### Capturing real-failure fixtures

Phase 3b in the roadmap. When a real spec-pipeline run produces a TSC error Layer 0-1 doesn't fix, snapshot the broken `.ts(x)` files into `fixtures/real-<timestamp>-<hash>/` with an `expected.json`. The fixture set then grows from production failures, not just synthetic ones.

---

## Troubleshooting

**`ERR_MODULE_NOT_FOUND: Cannot find package 'typescript'`** — your package manager didn't install the peer dependency. Run `npm install typescript` (or yarn/pnpm equivalent). Modern npm (v7+) auto-installs peers, so you'll usually only see this with older npm or with `auto-install-peers=false`.

**`Cannot find module '<workspace>/tsconfig.json'`** — you pointed `--workspace` at a directory with no `tsconfig.json`. Pass a directory whose root has the project's tsconfig (typically the project root, not a sub-package).

---

## Trust model

`@shipispec/tsfix` loads `typescript` from your workspace's `node_modules` (this is required for the lib-path workaround that makes the package work inside esbuild bundles). That means a malicious workspace's `typescript` install can execute arbitrary code at validate time.

**Only run `tsfix` on workspaces you trust.** This is the same trust boundary as ESLint, Prettier, Vitest, and other tools that load the workspace's TypeScript.

There is no telemetry, no outbound HTTP, and no exec calls outside the local `node` ↔ `tsx` invocation in the bin wrapper. The only filesystem writes are LSP edits to files you pass in via `targetFiles` (or files discovered under `workspaceRoot`).

---

## What's in the package vs what's only for contributors

The published tarball ships `src/`, `cli/`, `bin/`, plus `README.md` / `LICENSE` / `CHANGELOG.md`. Everything else (`benchmark/`, `fixtures/`, `tsconfig.json`, the dev-only npm scripts in `package.json`, the design docs in `docs/`) is contributor-side and either excluded from the tarball via `package.json#files` or just not part of the consumer-facing surface.

**Heads-up for consumers:** the published `package.json` includes `scripts.benchmark`, `scripts.test`, and `scripts.setup-fixtures`. Those reference `tsx`, `vitest`, and `fixtures/_shared/` — none of which ship to consumers. Don't run them from your `node_modules/@shipispec/tsfix/` directory; clone the repo if you want to contribute.

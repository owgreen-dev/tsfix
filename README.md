# tsfix

> Two-layer TypeScript error recovery for LLM-generated code — fix `TS2304`, `TS2305`, `TS2551`, `TS2552`, `TS2724` deterministically with the same engine that powers VS Code's Quick Fix, and escalate the rest to a single-file LLM mend.

`@shipispec/tsfix` is what you reach for when you've just generated a few hundred files of TypeScript with an LLM and `tsc --noEmit` is screaming at you. It runs in two layers:

- **Layer 0/1** — Deterministic. Borrows the same TypeScript Language Service that powers VS Code's "Quick Fix" lightbulb and runs it as a CLI. Fixes typos, missing imports, and did-you-mean errors with no LLM, no network, no config.
- **Layer 2** — Opt-in. A single-file LLM mend agent (Vercel AI SDK + Anthropic) that picks up what Layer 0 abstains on: TS2339 (property doesn't exist), TS7006 (implicit `any`), TS2741 (missing required prop), and other cases where the LSP can't statically derive the fix. Driven by **type-context injection** — when tsc says "Property 'foo' doesn't exist on type 'Bar'", tsfix resolves the `Bar` declaration via the TypeChecker and feeds its source to the model.

Layer 2 only runs if you explicitly call its API or set `ANTHROPIC_API_KEY` and use the `runMendLoop` entry point. The default `tsfix --workspace ...` CLI is still **Layer 0/1 only**.

## Before / after (Layer 0)

```
$ tsc --noEmit
src/api.ts:5:2  - error TS2552: Cannot find name 'consol'. Did you mean 'console'?
src/api.ts:8:5  - error TS2305: Module '"react"' has no exported member 'ueState'.
src/api.ts:12:14 - error TS2551: Property 'lenght' does not exist on type 'string[]'. Did you mean 'length'?

Found 3 errors in 1 file.

$ npx @shipispec/tsfix --workspace .
[ts-lsp-fixer] applied 3 fixes across 1 file

$ tsc --noEmit
$ # 0 errors
```

## 30-second cold start

```bash
cd your-broken-project
npx @shipispec/tsfix --workspace .
```

No config file. Exit code conventions:

| Code | Meaning |
|---|---|
| 0 | Workspace is clean |
| 1 | Errors remain (printed to stderr) |
| 2 | Bad arguments / harness error |

Preview what *would* change without writing to disk:

```bash
npx @shipispec/tsfix --workspace . --dry-run
```

Machine-readable output for piping into other tools:

```bash
npx @shipispec/tsfix --workspace . --json
```

### All flags

| Flag | Meaning |
|---|---|
| `--workspace <path>` | Required. Directory containing your `tsconfig.json`. |
| `--dry-run` | Run the fixer in memory, report counts, write nothing. |
| `--no-lsp` | Validate only — skip auto-fix. |
| `--files <a.ts,b.ts>` | Restrict fixing to a comma-separated list. |
| `--json` | Machine-readable output. |
| `--verbose` | Per-fix logging. |
| `--help` | Print usage. |

The CLI does not run Layer 2 — call the library API for that (below).

## What Layer 0 fixes

| TS code | Meaning | What tsfix does |
|---|---|---|
| `TS2304` | Cannot find name | Auto-imports |
| `TS2305` | Module has no exported member | Did-you-mean rename |
| `TS2551` | Property does not exist on T, did you mean Y | Spelling fix |
| `TS2552` | Cannot find name, did you mean Y | Spelling fix |
| `TS2724` | Module member did-you-mean | Import rename |

Against a 14-fixture benchmark spanning typos, did-you-mean cases, multi-file ripples, and 4 API-drift scenarios: **14/14 fixtures pass and 14/25 errors are auto-fixed (56%).** The remaining errors are intentionally outside Layer 0's scope and escape to Layer 2.

## What Layer 0 does *not* fix (Layer 2 picks these up)

By design, Layer 0 only applies fixes that are **deterministic** and **non-structural**. It refuses to:

- Add or remove function declarations
- Insert type annotations or change types
- Modify control flow (`await` insertions, async propagation)
- Rewrite JSX trees
- Add object-literal stub properties

The internal allowlist is two-layered: error codes (`SAFE_FIXABLE_CODES`) and Quick Fix names (`SAFE_FIX_NAMES = ['import', 'fixImport', 'spelling', 'fixSpelling']`). When the language service offers anything outside that allowlist, Layer 0 abstains and surfaces the error so Layer 2 (or a human) can pick it up.

Layer 2 is built for the cases the LSP can't statically resolve:

- `TS2339` — Property doesn't exist on type. The LLM needs to see *the type's declaration* to decide whether the receiver should grow a field, the call site has a typo with no near-match, or the receiver is the wrong type entirely.
- `TS7006` — Implicit `any`. The LLM picks the right annotation from surrounding context.
- `TS2741` — Missing required property. The LLM sees the contextual type and supplies a real value, not a placeholder.

Against a 35-fixture Layer-2 benchmark (3 hand-authored minimal + 2 realistic + 30 ts-morph-generated mutations across TS2339/TS7006/TS2741), **35/35 pass at $0.001/fixture avg, P95 latency ~1.5s on `claude-haiku-4-5`.** Caveat: the 30 generated fixtures are mutations of 3 seeds — real-world diversity will move these numbers.

## The four-layer model

```
Layer 0 — Prevention      (prompt rules, exported-API injection — your problem)
Layer 1 — Deterministic   (this package: LSP auto-fix, CLI default)
Layer 2 — Single-file LLM (this package: opt-in via library API)
─────────────────────────────────────────────────────────────────
Layer 3 — Multi-file LLM  (planned: blast-radius search/replace via findReferences)
Layer 4 — Stub-and-continue (planned: escape hatch)
```

The bet: roughly half of TypeScript errors in LLM output are deterministically fixable. By catching them in Layer 1 you dodge the LLM tax (latency, cost, nondeterminism) on the easy half. Layer 2 takes the other half — but only when you explicitly invoke it.

## Library API

### Layer 0/1 — deterministic loop

```typescript
import { runValidationLoop } from '@shipispec/tsfix';

const result = runValidationLoop({
  workspaceRoot: '/path/to/your/project',
  // Optional:
  // targetFiles: ['src/api.ts'],
  // dryRun: true,
  // logger: { info: console.log, warn: console.warn, error: console.error },
});

result.errorsBefore;          // number
result.errorsAfter;           // number
result.lspFixer.fixesApplied; // number
result.lspFixer.filesEdited;  // string[]
result.passed;                // boolean — true if errorsAfter === 0
```

Other Layer 0/1 exports:

- `runInProcessTsc(opts)` — validation only, no fixer. Returns structured diagnostics.
- `runLSPFixerPass(opts)` — Layer 0 fixer alone, no validation loop wrapper.
- `discoverTsFiles(workspaceRoot)` — file-walking helper. Skips `node_modules`, `.next`, `dist`, `build`, `out`, `coverage`, `.git`.

### Layer 2 — LLM mend (opt-in)

```typescript
import { runValidationLoop, runMendLoop } from '@shipispec/tsfix';

// Layer 0/1 first.
const layer1 = runValidationLoop({ workspaceRoot });

if (!layer1.passed) {
  // Layer 2 escalation.
  const layer2 = await runMendLoop({
    context: {
      workspaceRoot,
      diagnostics: layer1.remainingDiagnostics,
      erroredFiles: layer1.lspFixer.filesWithErrors,
      // Optional fields that improve mend quality:
      // taskDescription: 'Build a user CRUD module',
      // featureSpecText: '...the markdown spec...',
      // acceptanceCriteria: '...',
      // installedTypes: '...',  // compact API surface from npm deps
    },
    llm: {
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: process.env.ANTHROPIC_API_KEY,
    },
    maxIterations: 3,
  });

  console.log(layer2.stopReason);  // 'fixed' | 'noProgress' | 'regressed' | 'maxIterations'
  console.log(layer2.totalCostUsd);
}
```

Other Layer 2 exports:

- `mendSingleFile(opts)` — one LLM call for one file. The building block under `runMendLoop`.
- `getTypeContext(opts)` — resolve a `Diagnostic` to its declaring type via the TS Language Service and return ±N lines around the declaration. The architectural moat — every other LLM-driven repair tool uses generic grep or repo-maps.
- `parseEditBlocks(text)` / `applyEditBlocks(opts)` — Aider-style SEARCH/REPLACE patch parser + 3-tier fuzzy applier.
- Types: `MendContext`, `LayerEvent`, `Diagnostic`, plus the per-function option/result types.

## Trust model

Layer 0/1 loads `typescript` from your workspace's `node_modules` — it does **not** bundle its own. This ensures the fixer behaves identically to the `tsc` your project actually compiles with.

> **Run tsfix only on workspaces you trust.** Loading `typescript` from an attacker-controlled `node_modules` is equivalent to running `node_modules/.bin/tsc` against it.

**Network surface (Layer 0/1):** none. No telemetry, no calls home, no background processes, no config files written outside `--workspace`.

**Network surface (Layer 2):** every `mendSingleFile` call hits Anthropic's API via the Vercel AI SDK. The source files in `MendContext.erroredFiles` and the resolved type-context slices are sent in the prompt. If your code is sensitive, do not call Layer 2 — the CLI never does, and the library exports are explicit.

## Engines

- Node `>=20.9.0`
- TypeScript `>=5.0.0` (peer dep — must be installed in your workspace)

If your workspace has no `node_modules/typescript`, tsfix will fail with a clear error:

```
error: this workspace has no TypeScript installed.
run: npm install --save-dev typescript
```

## Contributing

### Adding a Layer-0 fix

1. **Probe** — write a tiny test workspace with the exact error you want fixable. Drop it under `fixtures/<descriptive-name>/` with an `expected.json` declaring `errorsBefore`, `errorsAfterMax`, `lspFixesAppliedMin/Max`, and `mustPass`.
2. **Verify** — run `npm run benchmark -- --fixture <name>` and inspect what the language service offers (the `fix.fixName` field).
3. **Allowlist change** — if `fixName` is unsafe (`fixMissingFunctionDeclaration`, `addMissingPropertyAndOptional`, etc.), document why we don't trust it. Otherwise, add the error code to `SAFE_FIXABLE_CODES` and the fix name to `SAFE_FIX_NAMES` in `src/tsLanguageServiceFixer.ts`.
4. **Lock it in** — confirm all existing fixtures still pass (`npm run benchmark`). Open a PR.

Each new code/fix-name pair gets its own fixture. We don't trust the language service blindly — we trust it under specific, pinned conditions.

### Adding a Layer-2 fixture

Layer-2 fixtures live under `fixtures/` alongside Layer-0 ones, identified by `expectedErrorCode` (singular) or `costUsdMax` in their `expected.json`. The Layer-0 benchmark skips them; `npm run benchmark:llm` runs them against Anthropic.

- Hand-author one under `fixtures/mend-<descriptive-name>/` for new error classes.
- Or generate one via `npm run generate-fixtures -- --code=TS2339 --seed=apiRouter.ts --count=10 --rng-seed=42`. The generator validates every mutation through Layer 0 first to confirm Layer 0 abstains (otherwise it's not Layer 2 territory).

### Pre-publish gates

- `npm run benchmark` — Layer 0, 14 fixtures, no network.
- `npm run benchmark:llm` — Layer 2, 35 fixtures, requires `ANTHROPIC_API_KEY`. Total cost ~$0.04 per run.
- `npm run matrix` — runs the local tarball against 6 distinct project shapes (Next.js, Vite + React, plain `nodenext`, plain `bundler`, plain CommonJS, monorepo with project references). Adds ~3 min; run manually before tagging.

## License

MIT.

## See also

- `CHANGELOG.md` — release notes per version.
- `ARCHITECTURE.md` — internal design rationale (the four-layer model, the workspace lib-path workaround).
- `STATUS.md` — current snapshot, gaps, and roadmap state.
- `tsc-defense-roadmap.md` — phased plan.
- `docs/internal-orientation.md` — the original SpecToShip-context README, kept for contributors who want the design history.

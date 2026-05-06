# tsfix

> Headless TypeScript error recovery — auto-resolve `TS2304`, `TS2305`, `TS2551`, `TS2552`, `TS2724` before they reach a human.

`@shipispec/tsfix` borrows the same TypeScript Language Service that powers VS Code's "Quick Fix" lightbulb and runs it as a CLI. Point it at a workspace, it fixes typos, missing imports, and did-you-mean errors deterministically — no LLM, no calls home, no config.

Built for the case where you've just generated a few hundred files of TypeScript with an LLM and `tsc --noEmit` is screaming at you.

## Before / after

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

## What it fixes

| TS code | Meaning | What tsfix does |
|---|---|---|
| `TS2304` | Cannot find name | Auto-imports |
| `TS2305` | Module has no exported member | Did-you-mean rename |
| `TS2551` | Property does not exist on T, did you mean Y | Spelling fix |
| `TS2552` | Cannot find name, did you mean Y | Spelling fix |
| `TS2724` | Module member did-you-mean | Import rename |

Against a 14-fixture benchmark spanning typos, did-you-mean cases, multi-file ripples, and 4 API-drift scenarios: **14/14 fixtures pass and 14/25 errors are auto-fixed (56%).** The remaining errors are intentionally outside Layer 0's scope (see below).

## What it does *not* fix

By design, tsfix only applies fixes that are **deterministic** and **non-structural**. It will refuse to:

- Add or remove function declarations
- Insert type annotations or change types
- Modify control flow (`await` insertions, async propagation)
- Rewrite JSX trees
- Add object-literal stub properties

The internal allowlist is two-layered: error codes (`SAFE_FIXABLE_CODES`) and Quick Fix names (`SAFE_FIX_NAMES = ['import', 'fixImport', 'spelling', 'fixSpelling']`). When the language service offers anything outside that allowlist, tsfix abstains and surfaces the error in the result so a higher layer (LLM, human) can pick it up.

## The four-layer model

tsfix is **Layer 0–1** of a larger error-recovery stack. The other layers are LLM-driven and live elsewhere (in your own code, or in companion packages):

```
Layer 0 — Prevention      (prompt rules, exported-API injection — your problem)
Layer 1 — tsfix           (this package: deterministic auto-fix)
─────────────────────────────────────────────────────────────────────────
Layer 2 — Single-file LLM mend (architect + editor split)
Layer 3 — Multi-file LLM mend  (blast-radius search/replace)
Layer 4 — Stub-and-continue    (escape hatch)
```

The bet: roughly half of TypeScript errors in LLM output are deterministically fixable. By catching them in Layer 1, you dodge the LLM tax (latency, cost, nondeterminism) on the easy half.

## Library API

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

Other exports:

- `runInProcessTsc(opts)` — validation only, no fixer. Returns structured diagnostics.
- `runLSPFixerPass(opts)` — Layer 0 fixer alone, no validation loop wrapper.
- `discoverTsFiles(workspaceRoot)` — file-walking helper. Skips `node_modules`, `.next`, `dist`, `build`, `out`, `coverage`, `.git`.

## Trust model

tsfix loads `typescript` from your workspace's `node_modules` — it does **not** bundle its own. This is intentional: it ensures the fixer behaves identically to the `tsc` your project actually compiles with.

> **Run tsfix only on workspaces you trust.** Loading `typescript` from an attacker-controlled `node_modules` is equivalent to running `node_modules/.bin/tsc` against it.

Other surface:

- No network calls.
- No telemetry.
- No background processes.
- No config files written or modified outside `--workspace`.

## Engines

- Node `>=20.9.0`
- TypeScript `>=5.0.0` (peer dep — must be installed in your workspace)

If your workspace has no `node_modules/typescript`, tsfix will fail with a clear error:

```
error: this workspace has no TypeScript installed.
run: npm install --save-dev typescript
```

## Contributing

The contract for adding a fix:

1. **Probe** — write a tiny test workspace with the exact error you want fixable. Drop it under `fixtures/<descriptive-name>/` with an `expected.json` declaring `errorsBefore`, `errorsAfterMax`, `lspFixesAppliedMin/Max`, and `mustPass`.
2. **Verify** — run `npm run benchmark -- --fixture <name>` and inspect what the language service offers (the `fix.fixName` field).
3. **Allowlist change** — if `fixName` is unsafe (`fixMissingFunctionDeclaration`, `addMissingPropertyAndOptional`, etc.), document why we don't trust it. Otherwise, add the error code to `SAFE_FIXABLE_CODES` and the fix name to `SAFE_FIX_NAMES` in `src/tsLanguageServiceFixer.ts`.
4. **Lock it in** — confirm all existing fixtures still pass (`npm run benchmark`). Open a PR.

Each new code/fix-name pair gets its own fixture. We don't trust the language service blindly — we trust it under specific, pinned conditions.

`npm run matrix` runs the same package against 6 distinct project shapes (Next.js, Vite + React, plain `nodenext`, plain `bundler`, plain CommonJS, monorepo with project references). It builds the local tarball and exercises it cold; pre-publish gate.

## License

MIT.

## See also

- `CHANGELOG.md` — release notes per version.
- `ARCHITECTURE.md` — internal design rationale (the four-layer model, the workspace lib-path workaround).
- `STATUS.md` — current snapshot, gaps, and roadmap state.
- `tsc-defense-roadmap.md` — phased plan.
- `docs/internal-orientation.md` — the original SpecToShip-context README, kept for contributors who want the design history.

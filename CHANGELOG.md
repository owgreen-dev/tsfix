# Changelog

All notable changes to `@shipispec/tsfix` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/owgreen-dev/tsfix/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/owgreen-dev/tsfix/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/owgreen-dev/tsfix/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/owgreen-dev/tsfix/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/owgreen-dev/tsfix/releases/tag/v0.1.0

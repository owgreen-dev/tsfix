#!/usr/bin/env node
/**
 * Build the publishable artifacts in `dist/`.
 *
 *   dist/index.js   — library bundle (ESM, what consumers `import`)
 *   dist/index.d.ts — TypeScript declarations (what consumers see in their IDE)
 *   dist/cli.js     — CLI bundle (ESM with shebang, what the bin entry runs)
 *
 * Externals: `typescript` (peer dep — must be loaded from the workspace's
 * node_modules so the lib-path workaround keeps working) and Node built-ins.
 *
 * Why bundle: pre-1a, the package shipped raw `.ts`. Plain Node 22+'s
 * type-stripping refuses files under `node_modules`, so plain `node` could
 * not import the package at all (audit H-E1). `npx @shipispec/tsfix` also
 * failed because the bin wrapper needed `tsx` from local `node_modules`
 * which isn't installed for end users (audit M-E2). Bundling fixes both.
 *
 * Run via `npm run build`. Also runs as `prepublishOnly` so `npm publish`
 * always ships fresh dist/.
 */

import * as esbuild from "esbuild";
import { execSync } from "node:child_process";
import { rmSync, existsSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const distDir = resolve(root, "dist");

console.log("[build] cleaning dist/");
if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });

const sharedOptions = {
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node20.9",
	external: [
		"typescript", // peer dep
		// AI SDK packages stay external: (1) `@vercel/oidc` (transitive of
		// `ai`) uses dynamic require() patterns that fail under esbuild's
		// ESM output at module-init time, breaking plain `node` execution;
		// (2) keeping them external slims the bundle dramatically;
		// (3) all are declared in `dependencies` so npm install pulls them
		// in for consumers who use Layer 2. Add a line for any new provider
		// (`@ai-sdk/X`) added to `buildLanguageModel` in `mendAgent.ts`.
		"ai",
		"@ai-sdk/anthropic",
		"@ai-sdk/openai",
		"@ai-sdk/google",
	],
	logLevel: "info",
	// `import.meta.url` and Node built-in URL imports stay as-is.
	banner: { js: "" },
};

console.log("[build] bundling src/index.ts → dist/index.js");
await esbuild.build({
	...sharedOptions,
	entryPoints: [resolve(root, "src/index.ts")],
	outfile: resolve(distDir, "index.js"),
});

console.log("[build] bundling cli/run-stack.ts → dist/cli.js");
await esbuild.build({
	...sharedOptions,
	entryPoints: [resolve(root, "cli/run-stack.ts")],
	outfile: resolve(distDir, "cli.js"),
	banner: { js: "#!/usr/bin/env node" },
});
// Bin needs to be executable; npm honors the file mode in tarballs.
chmodSync(resolve(distDir, "cli.js"), 0o755);

console.log("[build] emitting type declarations via tsc --emitDeclarationOnly");
execSync(
	`npx tsc --emitDeclarationOnly --declaration --outDir ${distDir}/types ` +
	`--rootDir ${root}/src --module esnext --moduleResolution bundler ` +
	`--target ES2022 --strict --skipLibCheck --esModuleInterop ` +
	`${root}/src/index.ts`,
	{ stdio: "inherit", cwd: root },
);

// tsc emits dist/types/index.d.ts plus per-file declarations. Move the
// public entry to dist/index.d.ts (what `package.json#types` points at)
// and leave the per-file declarations alongside (they're tiny, ship them
// for consumers who do subpath imports later).
const typesIndex = resolve(distDir, "types/index.d.ts");
if (!existsSync(typesIndex)) {
	throw new Error(`expected ${typesIndex} after tsc emit; did the build fail?`);
}
const decl = readFileSync(typesIndex, "utf-8");
writeFileSync(resolve(distDir, "index.d.ts"), decl);
// Also publish the per-file types for callers that want subpath imports.
// (No flattening; tsc already emits a clean tree under dist/types/.)

console.log("[build] done");
console.log("       dist/index.js     — library bundle (ESM)");
console.log("       dist/cli.js       — CLI bundle (ESM, executable)");
console.log("       dist/index.d.ts   — public type declarations");
console.log("       dist/types/       — per-file declarations");

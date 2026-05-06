import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// dryRun.test.ts spins up an in-process tsc + LSP fixer per test;
		// 5s default is fine locally but tight on a cold CI runner.
		testTimeout: 30000,
	},
});

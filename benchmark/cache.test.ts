import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cacheKey,
	makeCachingLLMCall,
	readCacheEntry,
	writeCacheEntry,
	type CacheStats,
} from "./cache.js";
import type { LLMCall } from "../src/mendAgent.js";

let cacheDir: string;

beforeEach(() => {
	cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "tsfix-cache-test-"));
});

afterEach(() => {
	fs.rmSync(cacheDir, { recursive: true, force: true });
});

const sampleParams = {
	systemBlock: "You are a TypeScript code-repair tool.",
	userBlock: "Fix the error in this file.",
	model: "claude-haiku-4-5",
	apiKey: "sk-test",
};

const sampleResponse = {
	text: "edit-block-here",
	inputTokens: 100,
	outputTokens: 50,
};

describe("cacheKey", () => {
	it("produces deterministic hashes for the same inputs", () => {
		const a = cacheKey("sys", "usr", "model");
		const b = cacheKey("sys", "usr", "model");
		expect(a).toBe(b);
	});

	it("produces different hashes when systemBlock differs", () => {
		const a = cacheKey("sys1", "usr", "model");
		const b = cacheKey("sys2", "usr", "model");
		expect(a).not.toBe(b);
	});

	it("produces different hashes when userBlock differs", () => {
		const a = cacheKey("sys", "usr1", "model");
		const b = cacheKey("sys", "usr2", "model");
		expect(a).not.toBe(b);
	});

	it("produces different hashes when model differs", () => {
		const a = cacheKey("sys", "usr", "haiku");
		const b = cacheKey("sys", "usr", "sonnet");
		expect(a).not.toBe(b);
	});

	it("returns a hex string (64 chars for sha256)", () => {
		const k = cacheKey("sys", "usr", "model");
		expect(k).toMatch(/^[0-9a-f]{64}$/);
	});

	it("is not vulnerable to a separator-confusion attack", () => {
		// If we naively concatenated without separators, `"a" + "bc" + "d"`
		// would hash the same as `"ab" + "c" + "d"`. The implementation uses
		// a space separator to keep them distinct.
		const a = cacheKey("a", "bc", "d");
		const b = cacheKey("ab", "c", "d");
		expect(a).not.toBe(b);
	});
});

describe("readCacheEntry / writeCacheEntry", () => {
	it("round-trips an entry", () => {
		const key = cacheKey("s", "u", "m");
		writeCacheEntry(cacheDir, key, sampleResponse);
		expect(readCacheEntry(cacheDir, key)).toEqual(sampleResponse);
	});

	it("returns null for a missing key", () => {
		expect(readCacheEntry(cacheDir, "nonexistent")).toBeNull();
	});

	it("returns null for a corrupted entry (invalid JSON)", () => {
		const key = "deadbeef";
		fs.writeFileSync(path.join(cacheDir, `${key}.json`), "not valid json");
		expect(readCacheEntry(cacheDir, key)).toBeNull();
	});

	it("creates the cache dir on first write", () => {
		const fresh = path.join(cacheDir, "deeper", "nested");
		expect(fs.existsSync(fresh)).toBe(false);
		writeCacheEntry(fresh, "abc", sampleResponse);
		expect(fs.existsSync(fresh)).toBe(true);
	});
});

describe("makeCachingLLMCall", () => {
	it("delegates to the real call on miss + stores the result", async () => {
		const stats: CacheStats = { hits: 0, misses: 0 };
		const real = vi.fn(async () => sampleResponse) as LLMCall;
		const wrapped = makeCachingLLMCall(real, { cacheDir, stats });

		const result = await wrapped(sampleParams);

		expect(result).toEqual(sampleResponse);
		expect(real).toHaveBeenCalledTimes(1);
		expect(stats).toEqual({ hits: 0, misses: 1 });
		// And the entry should be on disk now
		const key = cacheKey(sampleParams.systemBlock, sampleParams.userBlock, sampleParams.model);
		expect(readCacheEntry(cacheDir, key)).toEqual(sampleResponse);
	});

	it("returns the cached entry on second call (real call NOT invoked)", async () => {
		const stats: CacheStats = { hits: 0, misses: 0 };
		const real = vi.fn(async () => sampleResponse) as LLMCall;
		const wrapped = makeCachingLLMCall(real, { cacheDir, stats });

		await wrapped(sampleParams); // miss
		await wrapped(sampleParams); // hit

		expect(real).toHaveBeenCalledTimes(1);
		expect(stats).toEqual({ hits: 1, misses: 1 });
	});

	it("treats different params as different cache entries", async () => {
		const stats: CacheStats = { hits: 0, misses: 0 };
		const real = vi.fn(async () => sampleResponse) as LLMCall;
		const wrapped = makeCachingLLMCall(real, { cacheDir, stats });

		await wrapped(sampleParams);
		await wrapped({ ...sampleParams, userBlock: "different user block" });

		expect(real).toHaveBeenCalledTimes(2);
		expect(stats).toEqual({ hits: 0, misses: 2 });
	});

	it("bypass=true skips the cache entirely (every call goes to real)", async () => {
		const stats: CacheStats = { hits: 0, misses: 0 };
		const real = vi.fn(async () => sampleResponse) as LLMCall;
		const wrapped = makeCachingLLMCall(real, { cacheDir, stats, bypass: true });

		await wrapped(sampleParams);
		await wrapped(sampleParams);

		expect(real).toHaveBeenCalledTimes(2);
		expect(stats).toEqual({ hits: 0, misses: 2 });
		// And nothing should be written to disk
		const key = cacheKey(sampleParams.systemBlock, sampleParams.userBlock, sampleParams.model);
		expect(readCacheEntry(cacheDir, key)).toBeNull();
	});

	it("does not include apiKey in the cache key (so rotating keys doesn't invalidate)", async () => {
		const stats: CacheStats = { hits: 0, misses: 0 };
		const real = vi.fn(async () => sampleResponse) as LLMCall;
		const wrapped = makeCachingLLMCall(real, { cacheDir, stats });

		await wrapped(sampleParams);
		await wrapped({ ...sampleParams, apiKey: "different-key-same-everything-else" });

		// Second call should hit cache — key isn't part of the hash.
		expect(real).toHaveBeenCalledTimes(1);
		expect(stats.hits).toBe(1);
	});

	it("propagates errors from the real call without caching them", async () => {
		const stats: CacheStats = { hits: 0, misses: 0 };
		const err = new Error("rate limit");
		const real = vi.fn(async () => {
			throw err;
		}) as LLMCall;
		const wrapped = makeCachingLLMCall(real, { cacheDir, stats });

		await expect(wrapped(sampleParams)).rejects.toThrow("rate limit");
		// Re-running goes back to the real call (no cached error result)
		await expect(wrapped(sampleParams)).rejects.toThrow("rate limit");
		expect(real).toHaveBeenCalledTimes(2);
		expect(stats).toEqual({ hits: 0, misses: 2 });
	});
});

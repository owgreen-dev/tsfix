/**
 * File-based response cache for the Layer-2 LLM benchmark.
 *
 * Cache key = sha256(systemBlock + " " + userBlock + " " + provider + " " + model).
 * Any change to the system prompt, fixture content, provider, or model
 * invalidates the entry automatically. Provider was added in v0.6.0 when
 * multi-provider support landed — without it, two providers reusing the same
 * model name (rare but possible) would collide.
 *
 * Storage: one JSON file per entry under `cacheDir/<hash>.json`. Each file is
 * tiny (the LLM response text + token counts), so 100 fixtures × ~3 KB =
 * ~300 KB total — negligible.
 *
 * Extracted from `run-llm-benchmark.ts` so the cache logic is unit-testable
 * without spinning up the full benchmark.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { LLMCall } from "../src/mendAgent.js";

export interface CacheEntry {
	text: string;
	inputTokens: number;
	outputTokens: number;
}

export interface CacheStats {
	hits: number;
	misses: number;
}

export function cacheKey(
	systemBlock: string,
	userBlock: string,
	model: string,
	provider: string = "anthropic",
): string {
	return crypto
		.createHash("sha256")
		.update(systemBlock)
		.update(" ")
		.update(userBlock)
		.update(" ")
		.update(provider)
		.update(" ")
		.update(model)
		.digest("hex");
}

export function readCacheEntry(cacheDir: string, key: string): CacheEntry | null {
	const file = path.join(cacheDir, `${key}.json`);
	if (!fs.existsSync(file)) return null;
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8")) as CacheEntry;
	} catch {
		return null;
	}
}

export function writeCacheEntry(cacheDir: string, key: string, entry: CacheEntry): void {
	fs.mkdirSync(cacheDir, { recursive: true });
	const file = path.join(cacheDir, `${key}.json`);
	fs.writeFileSync(file, JSON.stringify(entry));
}

export interface MakeCachingLLMCallOptions {
	cacheDir: string;
	stats: CacheStats;
	bypass?: boolean;
}

/**
 * Wraps an `LLMCall` with cache lookup. On hit, returns the cached entry
 * without invoking the underlying call. On miss, invokes the call and stores
 * the result. With `bypass: true`, every call is forwarded (and not stored)
 * — used for the `--no-cache` flag.
 */
export function makeCachingLLMCall(
	realCall: LLMCall,
	opts: MakeCachingLLMCallOptions,
): LLMCall {
	const { cacheDir, stats, bypass = false } = opts;
	return async (params) => {
		const key = cacheKey(params.systemBlock, params.userBlock, params.model, params.provider);
		if (!bypass) {
			const cached = readCacheEntry(cacheDir, key);
			if (cached) {
				stats.hits++;
				return cached;
			}
		}
		stats.misses++;
		const result = await realCall(params);
		if (!bypass) {
			writeCacheEntry(cacheDir, key, result);
		}
		return result;
	};
}

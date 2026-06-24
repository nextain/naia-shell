import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmModelMeta } from "../types";
import {
	applyCapabilityOverrides,
	fetchNaiaModelCapabilities,
} from "../registry";

function jsonOk(body: unknown) {
	return {
		ok: true,
		status: 200,
		json: async () => body,
	} as unknown as Response;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("fetchNaiaModelCapabilities", () => {
	it("maps the gateway catalog to bare-id → capabilities, filtering unknown caps", () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				jsonOk([
					{ model_key: "gemini-3.1-flash-lite", capabilities: ["llm"] },
					{ model_key: "vertexai:naia-local", capabilities: ["llm", "omni"] },
					{ model_key: "weird", capabilities: ["llm", "bogus-cap"] },
				]),
			),
		);
		return fetchNaiaModelCapabilities("https://gw").then((map) => {
			expect(map).not.toBeNull();
			expect(map?.get("gemini-3.1-flash-lite")).toEqual(["llm"]);
			// provider prefix stripped
			expect(map?.get("naia-local")).toEqual(["llm", "omni"]);
			// unknown capability filtered out
			expect(map?.get("weird")).toEqual(["llm"]);
		});
	});

	it("returns null on a non-ok response (caller keeps static fallback)", () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response),
		);
		return fetchNaiaModelCapabilities("https://gw").then((map) =>
			expect(map).toBeNull(),
		);
	});

	it("returns null when fetch throws", () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
		return fetchNaiaModelCapabilities("https://gw").then((map) =>
			expect(map).toBeNull(),
		);
	});
});

describe("applyCapabilityOverrides", () => {
	const models: LlmModelMeta[] = [
		{ id: "a", label: "A", capabilities: ["llm"] },
		{ id: "b", label: "B", capabilities: ["llm"] },
	];

	it("overrides capabilities for models the gateway declares (gateway = SoT)", () => {
		const map = new Map<string, ["llm", "omni"][number][]>([
			["a", ["llm", "omni"]],
		]);
		const out = applyCapabilityOverrides(models, map as never);
		expect(out[0].capabilities).toEqual(["llm", "omni"]);
		// untouched model keeps static caps, and the original is not mutated
		expect(out[1].capabilities).toEqual(["llm"]);
		expect(models[0].capabilities).toEqual(["llm"]);
	});

	it("returns the list unchanged when capMap is null", () => {
		expect(applyCapabilityOverrides(models, null)).toBe(models);
	});

	it("ignores empty capability arrays (keeps static)", () => {
		const map = new Map([["a", []]]);
		const out = applyCapabilityOverrides(models, map as never);
		expect(out[0].capabilities).toEqual(["llm"]);
	});
});

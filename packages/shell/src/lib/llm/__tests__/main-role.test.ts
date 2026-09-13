import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../config";
import { readMainRole, selectMainRole, writeMainRole } from "../main-role";

const base = (over: Partial<AppConfig> = {}): AppConfig =>
	({ provider: "ollama", model: "qwen3:8b", ...over }) as AppConfig;

describe("readMainRole (#589)", () => {
	it("returns the structured main role with its whole shape", () => {
		const config = base({
			llmRoles: {
				main: {
					provider: "vllm",
					model: "alpha",
					baseUrl: "http://gpu:8000",
					credentialRef: "keychain:vllm",
				},
			},
		});
		expect(readMainRole(config)).toEqual({
			provider: "vllm",
			model: "alpha",
			baseUrl: "http://gpu:8000",
			credentialRef: "keychain:vllm",
		});
	});

	it("falls back to the top-level mirror when no structured main role exists", () => {
		expect(readMainRole(base())).toEqual({ provider: "ollama", model: "qwen3:8b" });
	});
});

describe("writeMainRole (#589)", () => {
	it("writes main, mirrors provider/model and keeps other roles", () => {
		const config = base({
			llmRoles: { sub: { provider: "ollama", model: "small" } },
		});
		const next = writeMainRole(config, { provider: "nextain", model: "deepseek-v4-flash" });
		expect(next.llmRoles?.main).toEqual({ provider: "nextain", model: "deepseek-v4-flash" });
		expect(next.llmRoles?.sub).toEqual({ provider: "ollama", model: "small" });
		expect(next.provider).toBe("nextain");
		expect(next.model).toBe("deepseek-v4-flash");
	});

	it("does not overwrite the mirror with an inheritance marker", () => {
		const next = writeMainRole(base(), { inherit: "sub" });
		expect(next.provider).toBe("ollama");
		expect(next.model).toBe("qwen3:8b");
	});
});

describe("selectMainRole (#589)", () => {
	const persisted = base({
		provider: "vllm",
		model: "alpha",
		llmRoles: {
			main: {
				provider: "vllm",
				model: "alpha",
				baseUrl: "http://gpu:8000",
				credentialRef: "keychain:vllm",
			},
		},
	});

	it("keeps baseUrl and credentialRef when the provider stays the same", () => {
		expect(selectMainRole(persisted, "vllm", "beta")).toEqual({
			provider: "vllm",
			model: "beta",
			baseUrl: "http://gpu:8000",
			credentialRef: "keychain:vllm",
		});
	});

	it("drops the previous provider's baseUrl and credentialRef when the provider changes", () => {
		expect(selectMainRole(persisted, "ollama", "qwen3:8b")).toEqual({
			provider: "ollama",
			model: "qwen3:8b",
		});
	});

	it("works without a persisted configuration", () => {
		expect(selectMainRole(null, "codex", "gpt-5.6-luna")).toEqual({
			provider: "codex",
			model: "gpt-5.6-luna",
		});
	});
});

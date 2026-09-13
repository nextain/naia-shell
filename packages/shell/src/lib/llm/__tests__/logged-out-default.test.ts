import { describe, expect, it, vi } from "vitest";
import { DEFAULT_LOCAL_LLM_MODEL, DEFAULT_OLLAMA_HOST } from "../../config";
import {
	NO_LLM,
	chooseLoggedOutLlm,
	keepsProviderWhenLoggedOut,
	resolveLoggedOutLlm,
} from "../logged-out-default";

describe("chooseLoggedOutLlm (FR-LLM-LOGOUT.1)", () => {
	it("returns no LLM when Ollama is unreachable", () => {
		expect(chooseLoggedOutLlm({ connected: false, modelIds: ["qwen3:8b"] })).toEqual(
			NO_LLM,
		);
	});

	it("returns no LLM when Ollama has no installed model", () => {
		expect(chooseLoggedOutLlm({ connected: true, modelIds: [] })).toEqual(NO_LLM);
	});

	it("prefers the default local model when it is installed", () => {
		expect(
			chooseLoggedOutLlm({
				connected: true,
				modelIds: ["qwen3:8b", DEFAULT_LOCAL_LLM_MODEL],
			}),
		).toEqual({ provider: "ollama", model: DEFAULT_LOCAL_LLM_MODEL });
	});

	it("falls back to the first installed model", () => {
		expect(
			chooseLoggedOutLlm({ connected: true, modelIds: ["qwen3:8b", "gemma3:4b"] }),
		).toEqual({ provider: "ollama", model: "qwen3:8b" });
	});

	it("never chooses gemini or a keyless Naia account", () => {
		for (const probe of [
			{ connected: false, modelIds: [] },
			{ connected: true, modelIds: [] },
			{ connected: true, modelIds: ["qwen3:8b"] },
		]) {
			expect(["", "ollama"]).toContain(chooseLoggedOutLlm(probe).provider);
		}
	});
});

describe("resolveLoggedOutLlm", () => {
	it("probes the configured host, or the default host when none is set", async () => {
		const probe = vi.fn().mockResolvedValue({ models: [], connected: false });
		await resolveLoggedOutLlm("http://gpu-box:11434", probe);
		await resolveLoggedOutLlm(undefined, probe);
		expect(probe.mock.calls.map((call) => call[0])).toEqual([
			"http://gpu-box:11434",
			DEFAULT_OLLAMA_HOST,
		]);
	});

	it("maps installed models to the chosen model", async () => {
		const probe = vi.fn().mockResolvedValue({
			models: [{ id: "qwen3:8b", label: "qwen3:8b" }],
			connected: true,
		});
		await expect(resolveLoggedOutLlm(undefined, probe)).resolves.toEqual({
			provider: "ollama",
			model: "qwen3:8b",
		});
	});

	it("treats a probe that does not answer in time as no LLM", async () => {
		const probe = vi.fn().mockReturnValue(new Promise(() => {}));
		await expect(resolveLoggedOutLlm(undefined, probe, 10)).resolves.toEqual(NO_LLM);
	});

	it("treats a probe failure as no LLM", async () => {
		const probe = vi.fn().mockRejectedValue(new Error("offline"));
		await expect(resolveLoggedOutLlm(undefined, probe)).resolves.toEqual(NO_LLM);
	});
});

describe("keepsProviderWhenLoggedOut", () => {
	it("keeps CLI and local providers", () => {
		for (const id of ["ollama", "vllm", "claude-code-cli", "codex", "grok"]) {
			expect(keepsProviderWhenLoggedOut(id)).toBe(true);
		}
	});

	it("does not keep gemini, the Naia account, or an empty provider", () => {
		for (const id of ["gemini", "nextain", "", undefined]) {
			expect(keepsProviderWhenLoggedOut(id)).toBe(false);
		}
	});
});

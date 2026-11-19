import { afterEach, describe, expect, it } from "vitest";
import { registerWebLlmProvider } from "../../web-runtime/llm-provider";
import { setWebAssetsModeForTests } from "../../web-runtime/web-assets";
import { listLlmProviders, unregisterLlmProvider } from "../registry";

afterEach(() => {
	setWebAssetsModeForTests(null);
	unregisterLlmProvider("webllm");
});

describe("R1: web brain provider list", () => {
	it("R1: web mode lists only providers the browser worker can run", () => {
		registerWebLlmProvider();
		setWebAssetsModeForTests(true);
		const ids = listLlmProviders().map((p) => p.id);
		expect(ids).toEqual(["nextain", "webllm"]);
		for (const hidden of ["ollama", "vllm", "codex", "claude-code-cli", "grok"]) {
			expect(ids).not.toContain(hidden);
		}
	});

	it("R1: desktop keeps local and CLI providers", () => {
		setWebAssetsModeForTests(false);
		const ids = listLlmProviders().map((p) => p.id);
		expect(ids).toEqual(
			expect.arrayContaining(["nextain", "ollama", "vllm", "codex", "claude-code-cli", "grok"]),
		);
	});
});

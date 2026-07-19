import { afterEach, describe, expect, it, vi } from "vitest";
import { unloadOllamaModel } from "../local-profile-runtime";

describe("unloadOllamaModel", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("requests model eviction without stopping the Ollama server", async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		vi.stubGlobal("fetch", fetchMock);

		await unloadOllamaModel("http://localhost:11434/", "demo-model");

		expect(fetchMock).toHaveBeenCalledWith(
			"http://localhost:11434/api/generate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ model: "demo-model", keep_alive: 0 }),
			}),
		);
	});

	it("skips an incomplete endpoint or model", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await unloadOllamaModel("", "demo-model");
		await unloadOllamaModel("http://localhost:11434", "");

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reports a rejected unload request", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: false, status: 500 }),
		);

		await expect(
			unloadOllamaModel("http://localhost:11434", "demo-model"),
		).rejects.toThrow("Ollama unload failed: HTTP 500");
	});
});

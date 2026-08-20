import { describe, expect, it } from "vitest";
import { buildNaiaConfigEnv } from "../adk-store";

describe("Ollama agent config", () => {
	it("preserves an OpenAI-compatible /v1 base URL without duplicating it", () => {
		expect(
			buildNaiaConfigEnv({
				provider: "ollama",
				model: "qwen3.8",
				ollamaHost: "https://gpu.example/runtime/v1/",
			}),
		).toMatchObject({
			NAIA_MAIN_PROVIDER: "ollama",
			NAIA_MAIN_MODEL: "qwen3.8",
			OPENAI_BASE_URL: "https://gpu.example/runtime/v1",
		});
	});
});

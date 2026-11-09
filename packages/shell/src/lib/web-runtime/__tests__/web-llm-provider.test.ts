// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../config";
import { isApiKeyOptional, providerSupportsRole } from "../../llm/registry";
import { installWebRuntime } from "../install";
import { getDefaultLlmModel } from "../../llm/registry";

describe("web-llm-provider", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("registers webllm provider while defaulting to the server model", () => {
		localStorage.clear();
		installWebRuntime();

		expect(isApiKeyOptional("webllm")).toBe(true);
		expect(providerSupportsRole("webllm", "main")).toBe(true);

		const config = loadConfig();
		expect(config?.provider).toBe("nextain");
		expect(config?.model).toBe(getDefaultLlmModel("nextain"));
	});

	it("preserves existing naia-config if already present", () => {
		const existingConfig = { provider: "ollama", model: "llama3:latest" };
		localStorage.setItem("naia-config", JSON.stringify(existingConfig));

		installWebRuntime();

		const config = loadConfig();
		expect(config?.provider).toBe("ollama");
		expect(config?.model).toBe("llama3:latest");
	});
});

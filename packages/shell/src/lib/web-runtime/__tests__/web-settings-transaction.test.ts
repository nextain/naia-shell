// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readNaiaConfig, writeNaiaConfigAtPath } from "../../adk-store";
import { installWebRuntime } from "../install";
import { createMemoryWebFs, setWebFsForTests } from "../web-fs";
import { WEB_LLM_MODEL_ID } from "../webllm-model";

describe("web-settings-transaction", () => {
	const originalTauriInternals = (window as unknown as { __TAURI_INTERNALS__?: unknown })
		.__TAURI_INTERNALS__;

	let memoryFs: ReturnType<typeof createMemoryWebFs>;

	beforeEach(() => {
		memoryFs = createMemoryWebFs();
		setWebFsForTests(memoryFs);
		installWebRuntime();
	});

	afterEach(() => {
		setWebFsForTests(null);
		if (originalTauriInternals !== undefined) {
			(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
				originalTauriInternals;
		} else {
			delete (window as unknown as { __TAURI_INTERNALS__?: unknown })
				.__TAURI_INTERNALS__;
		}
	});

	it("executes full writeNaiaConfigAtPath transaction without rejection and verifies persisted files", async () => {
		const newConfig = {
			provider: "webllm",
			model: WEB_LLM_MODEL_ID,
			agentName: "TX-NAME",
			persona: "You are TX-NAME.",
			onboardingComplete: true,
		};

		await expect(
			writeNaiaConfigAtPath(newConfig, "opfs://naia-adk"),
		).resolves.toBeUndefined();

		const readBack = await readNaiaConfig("opfs://naia-adk");
		expect(readBack).not.toBeNull();
		expect(readBack?.agentName).toBe("TX-NAME");

		const hasUiConfig = await memoryFs.exists(
			"naia-adk/naia-settings/ui-config.json",
		);
		expect(hasUiConfig).toBe(true);

		const uiConfigRaw = await memoryFs.readText(
			"naia-adk/naia-settings/ui-config.json",
		);
		expect(uiConfigRaw).not.toBeNull();
		expect(uiConfigRaw).not.toBe("");
	});
});

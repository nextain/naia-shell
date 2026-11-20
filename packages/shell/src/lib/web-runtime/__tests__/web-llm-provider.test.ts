// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../config";
import {
	getDefaultLlmModel,
	isApiKeyOptional,
	providerSupportsRole,
} from "../../llm/registry";
import * as agentBridge from "../agent-bridge";
import { bootWebRuntimeAndModel } from "../auto-install";
import { installWebRuntime } from "../install";
import { createMemoryWebFs, setWebFsForTests } from "../web-fs";
import { resetWebModelStatusForTests } from "../web-model-status";
import { handleWebWorkspaceCommand } from "../web-workspace-commands";
import { WEB_LLM_FALLBACK_F32 } from "../webllm-model";

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

describe("official web first boot", () => {
	const workspacePath = "opfs://naia-adk";
	const gpuDescriptor = Object.getOwnPropertyDescriptor(navigator, "gpu");
	const requestAdapter = vi.fn(async () => ({ features: new Set(["shader-f16"]) }));
	const postMessage = vi.fn();

	beforeEach(() => {
		localStorage.clear();
		Object.defineProperty(navigator, "gpu", {
			configurable: true,
			value: { requestAdapter },
		});
		requestAdapter.mockClear();
		postMessage.mockClear();
		vi.spyOn(agentBridge, "getStartableAgentBridge").mockReturnValue(
			agentBridge.createAgentBridge({
				createWorker: () => ({ postMessage, addEventListener: vi.fn() }),
				emit: vi.fn(),
			}),
		);
	});

	afterEach(() => {
		if (gpuDescriptor) Object.defineProperty(navigator, "gpu", gpuDescriptor);
		else Reflect.deleteProperty(navigator, "gpu");
		setWebFsForTests(null);
		resetWebModelStatusForTests();
		localStorage.clear();
		vi.restoreAllMocks();
	});

	it.each([false, true])(
		"chooses cloud and starts the worker without an on-device model (workspace provisioned: %s)",
		async (provisionWorkspace) => {
			const fs = createMemoryWebFs();
			setWebFsForTests(fs);
			await bootWebRuntimeAndModel({
				consumeAuthCallback: async () => {},
				isLoginRequired: () => false,
				checkAdkStartup: async () => {
					if (provisionWorkspace) {
						const initial = (await handleWebWorkspaceCommand(
							"read_naia_config",
							{ adkPath: workspacePath },
							fs,
						)) as string;
						expect(JSON.parse(initial)).toMatchObject({
							provider: "nextain",
							model: getDefaultLlmModel("nextain"),
						});
					}
				},
			});

			expect(loadConfig()).toMatchObject({
				provider: "nextain",
				model: getDefaultLlmModel("nextain"),
			});
			await vi.waitFor(() => {
				expect(postMessage).toHaveBeenCalledExactlyOnceWith(
					{ kind: "naia-agent-connect", model: null },
					[expect.any(MessagePort)],
				);
			});
			expect(requestAdapter).not.toHaveBeenCalled();
		},
	);

	it("still starts the explicitly saved on-device model from the workspace", async () => {
		const fs = createMemoryWebFs();
		setWebFsForTests(fs);
		await fs.writeBytes(
			"naia-adk/naia-settings/config.json",
			JSON.stringify({
				provider: "nextain",
				llmRoles: {
					main: { provider: "webllm", model: WEB_LLM_FALLBACK_F32 },
				},
				webAutoDefaultModel: false,
			}),
		);
		await bootWebRuntimeAndModel({
			consumeAuthCallback: async () => {},
			isLoginRequired: () => false,
			checkAdkStartup: async () => {},
		});

		await vi.waitFor(() => {
			expect(postMessage).toHaveBeenCalledExactlyOnceWith(
				{ kind: "naia-agent-connect", model: WEB_LLM_FALLBACK_F32 },
				[expect.any(MessagePort)],
			);
		});
		expect(requestAdapter).toHaveBeenCalledTimes(1);
	});
});

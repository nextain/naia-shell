// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
	invoke,
	convertFileSrc: (path: string) => path,
}));
vi.mock("../secure-store", () => ({
	getSecretKey: async () => null,
	deleteSecretKey: async () => {},
	SECRET_KEYS: ["apiKey", "naiaKey", "memoryLlmApiKey", "subLlmApiKey"],
}));

import {
	readNaiaConfig,
	readNaiaUiConfig,
	writeNaiaConfigAtPath,
} from "../adk-store";
import { type AppConfig, mergeBootConfig } from "../config";
import { readConfiguredLlmRoles, resolveEffectiveLlmRoles, writeConfiguredLlmRole } from "../llm/roles";
import {
	createOpfsWebFs,
	type WebFsDirectoryHandle,
} from "../web-runtime/web-fs";
import { handleWebWorkspaceCommand } from "../web-runtime/web-workspace-commands";

const main = { provider: "nextain", model: "gpt-6.1-terra" };
const sub = { provider: "nextain", model: "gpt-6-luna" };
const memory = {
	provider: "ollama",
	model: "memory-model",
	baseUrl: "http://127.0.0.1:11434",
};

// Browser directory-handle double: exercise the production OPFS adapter itself.
function directory(): WebFsDirectoryHandle {
	const dirs = new Map<string, WebFsDirectoryHandle>();
	const files = new Map<string, string>();
	const missing = () => new DOMException("Not found", "NotFoundError");
	return {
		async getDirectoryHandle(name, options) {
			if (!dirs.has(name) && options?.create) dirs.set(name, directory());
			const child = dirs.get(name);
			if (!child) throw missing();
			return child;
		},
		async getFileHandle(name, options) {
			if (!files.has(name) && options?.create) files.set(name, "");
			if (!files.has(name)) throw missing();
			return {
				async getFile() {
					return { text: async () => files.get(name) ?? "" };
				},
				async createWritable() {
					return {
						async write(data) {
							files.set(
								name,
								typeof data === "string" ? data : await data.text(),
							);
						},
						async close() {},
					};
				},
			};
		},
		async removeEntry(name) {
			files.delete(name);
		},
	};
}

function selections() {
	const initial: AppConfig = {
		provider: main.provider,
		model: main.model,
		apiKey: "test-secret",
		theme: "midnight",
		llmRoles: { memory },
	};
	return writeConfiguredLlmRole(
		writeConfiguredLlmRole(initial, "main", main),
		"sub",
		sub,
	);
}

describe("IT-SM-02 / IT-SM-11 main and small model persistence", () => {
	beforeEach(() => {
		localStorage.clear();
		invoke.mockReset();
	});

	it("preserves explicit legacy small and separate memory selections", () => {
		const config = {
			provider: main.provider,
			model: main.model,
			apiKey: "",
			subLlmProvider: sub.provider,
			subLlmModel: sub.model,
			memoryLlmProvider: "ollama" as const,
			memoryLlmModel: memory.model,
		};
		expect(readConfiguredLlmRoles(config)).toMatchObject({
			main,
			sub,
			memory: { provider: "ollama", model: memory.model },
		});
	});

	it("IT-SM-11 inherits a legacy memory-only model without changing its stored fields", () => {
		const config: AppConfig = {
			provider: main.provider,
			model: main.model,
			apiKey: "",
			memoryLlmProvider: "ollama",
			memoryLlmModel: "memory-model",
			memoryLlmBaseUrl: "http://127.0.0.1:11434",
		};
		expect(readConfiguredLlmRoles(config).sub).toEqual({ inherit: "memory" });
		const effective = resolveEffectiveLlmRoles(config);
		expect(effective.ok && effective.roles.find((role) => role.role === "sub")).toMatchObject(memory);
		const changed = writeConfiguredLlmRole(config, "sub", sub);
		expect(readConfiguredLlmRoles(changed).sub).toEqual(sub);
		expect(changed.memoryLlmProvider).toBe(config.memoryLlmProvider);
		expect(changed.memoryLlmModel).toBe(config.memoryLlmModel);
		expect(changed.memoryLlmBaseUrl).toBe(config.memoryLlmBaseUrl);
	});

	it("does not turn a separate memory selection into a small model selection", () => {
		const roles = readConfiguredLlmRoles({
			provider: main.provider,
			model: main.model,
			apiKey: "",
			llmRoles: { memory },
		});
		expect(roles.sub).toEqual({ inherit: "main" });
		expect(roles.memory).toEqual(memory);
	});

	it("desktop writes and restores both slots for each workspace without storing credentials in either config", async () => {
		const files = new Map<string, string>();
		invoke.mockImplementation(
			async (command: string, args?: { adkPath?: string; json?: string }) => {
				if (
					command === "write_naia_config" ||
					command === "write_naia_ui_config"
				) {
					files.set(
						`${args?.adkPath}/${command === "write_naia_config" ? "config" : "ui"}`,
						args?.json ?? "",
					);
					return;
				}
				if (command === "read_naia_config" || command === "read_naia_ui_config")
					return (
						files.get(
							`${args?.adkPath}/${command === "read_naia_config" ? "config" : "ui"}`,
						) ?? ""
					);
				return undefined;
			},
		);
		const first = selections();
		const second = writeConfiguredLlmRole(first, "sub", {
			provider: "ollama",
			model: "qwen3:4b",
		});
		await writeNaiaConfigAtPath({ ...first }, "/workspace/a");
		await writeNaiaConfigAtPath({ ...second }, "/workspace/b");
		localStorage.clear();
		for (const [path, expectedSub] of [
			["/workspace/a", sub],
			["/workspace/b", { provider: "ollama", model: "qwen3:4b" }],
		] as const) {
			const agent = await readNaiaConfig(path);
			const ui = await readNaiaUiConfig(path);
			const restored = mergeBootConfig(null, agent ? { ...agent } : null, ui);
			expect(restored?.llmRoles).toMatchObject({
				main,
				sub: expectedSub,
				memory,
			});
			expect(ui).not.toHaveProperty("llmRoles");
			expect(files.get(`${path}/config`)).not.toContain("test-secret");
			expect(files.get(`${path}/ui`)).not.toContain("test-secret");
		}
	});

	it("web workspace restores roles from the OPFS-backed config after cache loss", async () => {
		const root = directory();
		const fs = createOpfsWebFs(async () => root);
		invoke.mockImplementation((command: string, args: unknown) =>
			handleWebWorkspaceCommand(command, args, fs),
		);
		await writeNaiaConfigAtPath({ ...selections() }, "opfs://naia-adk");
		localStorage.clear();
		// A fresh adapter simulates a restarted runtime retaining the same OPFS root.
		const restarted = createOpfsWebFs(async () => root);
		invoke.mockImplementation((command: string, args: unknown) =>
			handleWebWorkspaceCommand(command, args, restarted),
		);
		const agent = await readNaiaConfig("opfs://naia-adk");
		const ui = await readNaiaUiConfig("opfs://naia-adk");
		const restored = mergeBootConfig(null, agent ? { ...agent } : null, ui);
		expect(restored?.llmRoles).toMatchObject({ main, sub, memory });
		expect(restored).toMatchObject({
			provider: main.provider,
			model: main.model,
			subLlmProvider: sub.provider,
			subLlmModel: sub.model,
		});
		expect(ui).not.toHaveProperty("llmRoles");
		expect(
			await fs.readText("naia-adk/naia-settings/config.json"),
		).not.toContain("test-secret");
		expect(
			await fs.readText("naia-adk/naia-settings/ui-config.json"),
		).not.toContain("test-secret");
	});

	it.each(["desktop", "web"])("IT-SM-02 preserves valid thinking levels in %s config JSON", async (platform) => {
		const root = directory();
		const fs = createOpfsWebFs(async () => root);
		const files = new Map<string, string>();
		invoke.mockImplementation(async (command: string, args?: { adkPath?: string; json?: string }) => {
			if (platform === "web") return handleWebWorkspaceCommand(command, args, fs);
			if (command === "write_naia_config" || command === "write_naia_ui_config") { files.set(command.replace("write_", ""), args?.json ?? ""); return; }
			if (command === "read_naia_config" || command === "read_naia_ui_config") return files.get(command.replace("read_", "")) ?? "";
			return undefined;
		});
		const path = platform === "web" ? "opfs://naia-adk" : "/workspace/thinking";
		await writeNaiaConfigAtPath({ ...selections(), mainModelThinkingLevels: { '["nextain","gpt-6.1-terra"]': "xhigh" }, llmRoles: { main: { provider: "nextain", model: "gpt-6.1-terra", thinkingLevel: "xhigh" }, sub: { provider: "nextain", model: "gpt-5.6-luna", thinkingLevel: "low" }, memory: { provider: "ollama", model: "memory", thinkingLevel: "invalid" } } }, path);
		const raw = platform === "web" ? await fs.readText("naia-adk/naia-settings/config.json") : files.get("naia_config");
		const parsed = JSON.parse(raw!);
		expect(parsed.llmRoles.main.thinkingLevel).toBe("xhigh");
		expect(parsed.llmRoles.sub.thinkingLevel).toBe("low");
		expect(parsed.llmRoles.memory.thinkingLevel).toBeUndefined();
		expect(parsed.mainModelThinkingLevels).toEqual({ '["nextain","gpt-6.1-terra"]': "xhigh" });
		expect((await readNaiaUiConfig(path))?.mainModelThinkingLevels).toBeUndefined();
		const reopened = await readNaiaConfig(path);
		expect(reopened?.llmRoles?.main?.thinkingLevel).toBe("xhigh");
		expect(reopened?.llmRoles?.sub?.thinkingLevel).toBe("low");
		expect((reopened as (Partial<AppConfig> & { mainModelThinkingLevels?: Record<string, string> }) | null)?.mainModelThinkingLevels).toEqual({ '["nextain","gpt-6.1-terra"]': "xhigh" });
	});

	it.each(["desktop", "web"])("IT-SM-11 restores the legacy memory-only selection through %s storage", async (platform) => {
		const root = directory();
		const fs = createOpfsWebFs(async () => root);
		const files = new Map<string, string>();
		invoke.mockImplementation(async (command: string, args?: { adkPath?: string; json?: string }) => {
			if (platform === "web") return handleWebWorkspaceCommand(command, args, fs);
			if (command === "write_naia_config" || command === "write_naia_ui_config") {
				files.set(command.replace("write_", ""), args?.json ?? "");
				return;
			}
			if (command === "read_naia_config" || command === "read_naia_ui_config") return files.get(command.replace("read_", "")) ?? "";
			return undefined;
		});
		const path = platform === "web" ? "opfs://naia-adk" : "/workspace/legacy";
		const original: AppConfig = { provider: main.provider, model: main.model, apiKey: "", memoryLlmProvider: "ollama", memoryLlmModel: memory.model, memoryLlmBaseUrl: memory.baseUrl };
		await writeNaiaConfigAtPath({ ...original }, path);
		localStorage.clear();
		const saved = await readNaiaConfig(path);
		const restored = mergeBootConfig(null, saved ? { ...saved } : null, await readNaiaUiConfig(path)) as unknown as AppConfig | null;
		expect(restored).toBeTruthy();
		expect(readConfiguredLlmRoles(restored!).sub).toEqual({ inherit: "memory" });
		const effective = resolveEffectiveLlmRoles(restored!);
		expect(effective.ok && effective.roles.find((role) => role.role === "sub")).toMatchObject(memory);
		expect(restored).toMatchObject({ memoryLlmProvider: "ollama", memoryLlmModel: memory.model, memoryLlmBaseUrl: memory.baseUrl });
		await writeNaiaConfigAtPath({ ...writeConfiguredLlmRole(restored!, "sub", sub) }, path);
		const selected = await readNaiaConfig(path);
		const reopened = mergeBootConfig(null, selected ? { ...selected } : null, await readNaiaUiConfig(path)) as unknown as AppConfig | null;
		expect(readConfiguredLlmRoles(reopened!).sub).toEqual(sub);
		expect(reopened).toMatchObject({ memoryLlmProvider: "ollama", memoryLlmModel: memory.model, memoryLlmBaseUrl: memory.baseUrl });
	});
});

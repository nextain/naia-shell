// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Tauri mocks ───────────────────────────────────────────────────────────────
// vi.mock is hoisted, so factory vars must be declared with vi.hoisted().

const { mockInvoke, mockConvertFileSrc } = vi.hoisted(() => ({
	mockInvoke: vi.fn(),
	mockConvertFileSrc: vi.fn(
		(path: string) => `asset://localhost/${path.replace(/\\/g, "/")}`,
	),
}));
const secureState = vi.hoisted(() => ({
	naiaKey: null as string | null,
	deleted: [] as string[],
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: mockInvoke,
	convertFileSrc: mockConvertFileSrc,
}));

vi.mock("../secure-store", () => ({
	getSecretKey: (name: string) =>
		Promise.resolve(name === "naiaKey" ? secureState.naiaKey : null),
	deleteSecretKey: (name: string) => {
		secureState.deleted.push(name);
		return Promise.resolve();
	},
	SECRET_KEYS: ["apiKey", "naiaKey", "memoryLlmApiKey"],
}));

import {
	applyModelSelectionToConfig,
	applyWorkspaceConfigToLocal,
	beginNaiaConfigHydration,
	buildNaiaConfigEnv,
	clearAdkPath,
	completeNaiaConfigHydration,
	copyBundledAssets,
	getAdkPath,
	isAdkInitialized,
	listNaiaAssets,
	readNaiaConfig,
	readNaiaUiConfig,
	resetNaiaPersistedSettings,
	setAdkPath,
	syncMainRoleOpenAiBaseUrl,
	toAssetUrl,
	writeAgentKeyStrict,
	writeNaiaConfig,
	writeNaiaConfigAtPath,
	writeNaiaUiConfig,
} from "../adk-store";

// ── UC-MODEL-SELECT cross-seam contract ─────────────────────────────────────────
// Regression guard for 2026-06-17: UI model selection MUST become the agent's
// persisted config (model field + NAIA_MAIN_MODEL env). The bug was a stale omni
// model surviving a chat-model selection because the selection never persisted.
describe("applyModelSelectionToConfig (UI selection → persisted agent config)", () => {
	it("overrides a stale omni model with the freshly-selected chat model", () => {
		const stale = {
			provider: "nextain",
			model: "gemini-2.5-flash-live",
			naiaKey: "naia-x",
			NAIA_MAIN_MODEL: "gemini-2.5-flash-live",
		};
		const out = applyModelSelectionToConfig(
			stale,
			"nextain",
			"gemini-3.1-flash-lite",
		);
		expect(out.model).toBe("gemini-3.1-flash-lite");
		expect(out.NAIA_MAIN_MODEL).toBe("gemini-3.1-flash-lite");
		expect(out.NAIA_MAIN_PROVIDER).toBe("naia"); // nextain → "naia" env
		expect(out.llmRoles).toEqual({
			main: { provider: "nextain", model: "gemini-3.1-flash-lite" },
		});
	});
	it("carries a provider switch through to NAIA_MAIN_PROVIDER/MODEL", () => {
		const out = applyModelSelectionToConfig(
			{ provider: "nextain", model: "gemini-3.1-flash-lite" },
			"zai",
			"glm-5.1",
		);
		expect(out.provider).toBe("zai");
		expect(out.model).toBe("glm-5.1");
		expect(out.NAIA_MAIN_MODEL).toBe("glm-5.1");
		expect(out.NAIA_MAIN_PROVIDER).toBe("zai");
	});
	it("handles a null current config", () => {
		const out = applyModelSelectionToConfig(
			null,
			"nextain",
			"gemini-3.1-flash-lite",
		);
		expect(out.model).toBe("gemini-3.1-flash-lite");
		expect(out.NAIA_MAIN_MODEL).toBe("gemini-3.1-flash-lite");
	});
});

// ── helpers ───────────────────────────────────────────────────────────────────

const WIN_ADK = "C:\\work\\naia-adk";
const UNIX_ADK = "/home/user/naia-adk";

beforeEach(() => {
	localStorage.clear();
	mockInvoke.mockReset();
	// Native read commands return an empty string for a missing file. Keep that
	// contract in the default mock while other commands resolve without a value.
	mockInvoke.mockImplementation(async (command: string) => {
		if (command === "read_naia_config" || command === "read_naia_ui_config") {
			return "";
		}
		return undefined;
	});
	mockConvertFileSrc.mockClear();
	secureState.naiaKey = null;
	secureState.deleted = [];
});

afterEach(() => {
	localStorage.clear();
});

// ── getAdkPath / setAdkPath / clearAdkPath ────────────────────────────────────

describe("getAdkPath", () => {
	it("returns null when not set", () => {
		expect(getAdkPath()).toBeNull();
	});

	it("returns the stored path after setAdkPath", () => {
		setAdkPath(WIN_ADK);
		expect(getAdkPath()).toBe(WIN_ADK);
	});

	it("strips trailing backslash on Windows path", () => {
		setAdkPath("C:\\work\\naia-adk\\");
		expect(getAdkPath()).toBe(WIN_ADK);
	});

	it("strips trailing slash on Unix path", () => {
		setAdkPath("/home/user/naia-adk/");
		expect(getAdkPath()).toBe(UNIX_ADK);
	});
});

describe("setAdkPath native binding", () => {
	it("waits for the native agent workspace rebind", async () => {
		await setAdkPath(WIN_ADK);

		expect(mockInvoke).toHaveBeenCalledWith("write_naia_path_cache", {
			adkPath: WIN_ADK,
		});
		expect(getAdkPath()).toBe(WIN_ADK);
	});

	it("surfaces a native rebind failure while retaining the bootstrap path", async () => {
		mockInvoke.mockRejectedValueOnce(new Error("agent restart failed"));

		await expect(setAdkPath(WIN_ADK)).rejects.toThrow("agent restart failed");
		expect(getAdkPath()).toBe(WIN_ADK);
	});

	// #447-6 regression: config.workspaceRoot is an adkPath mirror. A stale
	// workspaceRoot that survived a partial reset used to outrank the freshly
	// selected adk path (WorkspaceCenterArea prefers config.workspaceRoot), so the
	// old repo kept being opened. setAdkPath must re-sync the mirror.
	it("re-syncs a stale config.workspaceRoot to the selected adk path", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({ workspaceRoot: "D:\\alpha-adk", provider: "nextain" }),
		);

		await setAdkPath(WIN_ADK);

		const cfg = JSON.parse(localStorage.getItem("naia-config") ?? "{}");
		expect(cfg.workspaceRoot).toBe(WIN_ADK);
		expect(cfg.provider).toBe("nextain"); // other fields untouched
	});
});

describe("isAdkInitialized", () => {
	it("returns false when path not set", () => {
		expect(isAdkInitialized()).toBe(false);
	});

	it("returns true after setAdkPath", () => {
		setAdkPath(WIN_ADK);
		expect(isAdkInitialized()).toBe(true);
	});
});

describe("clearAdkPath", () => {
	it("removes stored path", () => {
		setAdkPath(WIN_ADK);
		clearAdkPath();
		expect(getAdkPath()).toBeNull();
		expect(isAdkInitialized()).toBe(false);
	});
});

describe("resetNaiaPersistedSettings", () => {
	it("removes file-backed config and secure keys before clearing the bootstrap cache", async () => {
		setAdkPath(WIN_ADK);
		localStorage.setItem("naia-config", JSON.stringify({ provider: "ollama" }));

		await resetNaiaPersistedSettings();

		expect(mockInvoke).toHaveBeenCalledWith("reset_naia_config_files", {
			adkPath: WIN_ADK,
		});
		expect(secureState.deleted).toEqual([
			"apiKey",
			"naiaKey",
			"memoryLlmApiKey",
		]);
		expect(localStorage.getItem("naia-config")).toBeNull();
		expect(getAdkPath()).toBeNull();
	});

	it("keeps the bootstrap cache retryable when native reset fails", async () => {
		setAdkPath(WIN_ADK);
		localStorage.setItem("naia-config", "{}");
		mockInvoke.mockImplementation((command: string) => {
			if (command === "reset_naia_config_files") {
				return Promise.reject(new Error("locked"));
			}
			return Promise.resolve(undefined);
		});

		await expect(resetNaiaPersistedSettings()).rejects.toThrow("locked");
		expect(getAdkPath()).toBe(WIN_ADK);
		expect(localStorage.getItem("naia-config")).toBe("{}");
		expect(secureState.deleted).toEqual([]);
	});
});

describe("writeAgentKeyStrict", () => {
	it("persists a Google Gemini credential under GEMINI_API_KEY", async () => {
		await setAdkPath(WIN_ADK);

		await writeAgentKeyStrict("gemini", "apiKey", "google-test-key");

		expect(mockInvoke).toHaveBeenCalledWith("write_agent_key", {
			adkPath: WIN_ADK,
			envKey: "GEMINI_API_KEY",
			value: "google-test-key",
		});
	});
});

// ── toAssetUrl ─────────────────────────────────────────────────────────────────

describe("toAssetUrl", () => {
	it("converts a Windows absolute path to an asset:// URL", () => {
		const url = toAssetUrl(
			"C:\\work\\naia-adk\\naia-settings\\background\\bg.png",
		);
		expect(url).toContain("asset://");
		expect(url).toContain("bg.png");
	});

	it("converts a Unix absolute path to an asset:// URL", () => {
		const url = toAssetUrl(
			"/home/user/naia-adk/naia-settings/vrm-files/naia.vrm",
		);
		expect(url).toContain("asset://");
		expect(url).toContain("naia.vrm");
	});
});

// ── listNaiaAssets ─────────────────────────────────────────────────────────────

describe("listNaiaAssets", () => {
	it("returns empty array when adk path not set", async () => {
		const result = await listNaiaAssets("vrm-files");
		expect(result).toEqual([]);
		expect(mockInvoke).not.toHaveBeenCalled();
	});

	it("calls invoke with correct args and maps filenames to absolute paths (Windows)", async () => {
		await setAdkPath(WIN_ADK);
		mockInvoke.mockResolvedValue(["01-OL_Woman.vrm", "02-Hood_Boy.vrm"]);

		const result = await listNaiaAssets("vrm-files");

		expect(mockInvoke).toHaveBeenCalledWith("list_naia_assets", {
			adkPath: WIN_ADK,
			subdir: "vrm-files",
		});
		expect(result).toHaveLength(2);
		expect(result[0]).toContain("naia-settings");
		expect(result[0]).toContain("vrm-files");
		expect(result[0]).toContain("01-OL_Woman.vrm");
	});

	it("calls invoke with correct args and maps filenames to absolute paths (Unix)", async () => {
		setAdkPath(UNIX_ADK);
		mockInvoke.mockResolvedValue([
			"background-space.png",
			"anime-rainbow-landscape.jpg",
		]);

		const result = await listNaiaAssets("background");

		expect(result[0]).toContain("naia-settings");
		expect(result[0]).toContain("background");
		expect(result[0]).toContain("background-space.png");
	});

	it("returns empty array on invoke error", async () => {
		setAdkPath(WIN_ADK);
		mockInvoke.mockRejectedValue(new Error("Permission denied"));

		const result = await listNaiaAssets("background");
		expect(result).toEqual([]);
	});

	it("works for bgm-musics subdir", async () => {
		setAdkPath(WIN_ADK);
		mockInvoke.mockResolvedValue(["Afternoon Whispers.mp3", "lounge.mp3"]);

		const result = await listNaiaAssets("bgm-musics");
		expect(result[0]).toContain("bgm-musics");
		expect(result[0]).toContain("Afternoon Whispers.mp3");
	});
});

// ── readNaiaConfig / writeNaiaConfig ──────────────────────────────────────────

describe("readNaiaConfig", () => {
	it("returns null when adk path not set", async () => {
		expect(await readNaiaConfig()).toBeNull();
	});

	it("throws on invoke error", async () => {
		setAdkPath(WIN_ADK);
		mockInvoke.mockRejectedValue(new Error("File not found"));
		await expect(readNaiaConfig()).rejects.toThrow("File not found");
	});

	it("returns null for empty string response", async () => {
		setAdkPath(WIN_ADK);
		mockInvoke.mockResolvedValue("");
		expect(await readNaiaConfig()).toBeNull();
	});

	it("throws for malformed and non-object responses", async () => {
		setAdkPath(WIN_ADK);
		mockInvoke.mockResolvedValueOnce("not-json");
		await expect(readNaiaConfig()).rejects.toThrow();
		mockInvoke.mockResolvedValueOnce("[]");
		await expect(readNaiaConfig()).rejects.toThrow("invalid_json");
	});

	it("parses and returns config JSON", async () => {
		setAdkPath(WIN_ADK);
		mockInvoke.mockResolvedValue(
			JSON.stringify({ provider: "gemini", apiKey: "key123" }),
		);

		const config = await readNaiaConfig();
		expect(config).not.toBeNull();
		expect(config?.provider).toBe("gemini");
		expect(config?.apiKey).toBe("key123");
	});
});

describe("writeNaiaConfig", () => {
	it("scopes and normalizes an OpenAI-compatible base URL", () => {
		expect(
			buildNaiaConfigEnv({
				provider: "openai",
				openaiBaseUrl: "http://gpu:11435/v1/",
			}),
		).toMatchObject({ OPENAI_BASE_URL: "http://gpu:11435/v1" });
		expect(
			buildNaiaConfigEnv({
				provider: "gemini",
				openaiBaseUrl: "http://stale/v1",
			}),
		).not.toHaveProperty("OPENAI_BASE_URL");
	});
	it("does nothing when adk path not set", async () => {
		await writeNaiaConfig({ provider: "gemini" });
		expect(mockInvoke).not.toHaveBeenCalled();
	});

	it("calls invoke with serialized JSON", async () => {
		setAdkPath(WIN_ADK);
		mockInvoke.mockImplementation(async (command: string) =>
			command === "read_naia_ui_config" ? "" : undefined,
		);

		await writeNaiaConfig({ provider: "openai", model: "gpt-4o" });

		expect(mockInvoke).toHaveBeenCalledWith("write_naia_config", {
			adkPath: WIN_ADK,
			json: JSON.stringify(
				{
					provider: "openai",
					model: "gpt-4o",
					NAIA_MAIN_PROVIDER: "openai",
					NAIA_MAIN_MODEL: "gpt-4o",
				},
				null,
				2,
			),
		});
	});

	it("persists config, UI config, slots manifest, then reloads the agent in order", async () => {
		setAdkPath(WIN_ADK);
		mockInvoke.mockClear();
		mockInvoke.mockImplementation(async (command: string) => {
			if (command === "read_naia_ui_config") return "{}";
			if (command === "detect_gpu_vram") return null;
			return undefined;
		});

		await writeNaiaConfig({
			provider: "openai",
			model: "gpt-4o",
			theme: "ocean",
		});

		const transactionStages = mockInvoke.mock.calls
			.map(([command]) => command)
			.filter((command) =>
				[
					"write_naia_config",
					"write_naia_ui_config",
					"write_slots_manifest",
					"reload_agent_settings",
				].includes(command),
			);
		expect(transactionStages).toEqual([
			"write_naia_config",
			"write_naia_ui_config",
			"write_slots_manifest",
			"reload_agent_settings",
		]);
		expect(mockInvoke).toHaveBeenCalledWith("reload_agent_settings");
	});

	it("rejects visibly when the running agent cannot apply memory settings", async () => {
		setAdkPath(WIN_ADK);
		mockInvoke.mockImplementation(async (command: string) => {
			if (command === "read_naia_ui_config") return "{}";
			if (command === "detect_gpu_vram") return null;
			if (command === "reload_agent_settings") {
				throw new Error("previous memory retained: invalid memory role");
			}
			return undefined;
		});

		await expect(
			writeNaiaConfig({ provider: "openai", model: "gpt-4o" }),
		).rejects.toThrow("previous memory retained");
	});

	it("rejects visibly when the primary config write fails and stops the transaction", async () => {
		setAdkPath(WIN_ADK);
		mockInvoke.mockClear();
		mockInvoke.mockImplementation(async (command: string) => {
			if (command === "write_naia_config") {
				throw new Error("config disk full");
			}
			return undefined;
		});

		await expect(
			writeNaiaConfig({ provider: "openai", model: "gpt-4o" }),
		).rejects.toThrow("config disk full");
		expect(
			mockInvoke.mock.calls
				.filter(([command]) => command !== "write_naia_path_cache")
				.map(([command]) => command),
		).toEqual([
			"write_naia_config",
		]);
	});

	it("rejects visibly when the paired UI config write fails", async () => {
		setAdkPath(WIN_ADK);
		mockInvoke.mockImplementation(async (command: string) => {
			if (command === "read_naia_ui_config") return "";
			if (command === "write_naia_ui_config") {
				throw new Error("ui disk full");
			}
			return undefined;
		});

		await expect(
			writeNaiaConfig({ provider: "openai", model: "gpt-4o" }),
		).rejects.toThrow("ui-config write failed");
		expect(
			mockInvoke.mock.calls
				.filter(([command]) => command !== "write_naia_path_cache")
				.map(([command]) => command),
		).toEqual([
			"write_naia_config",
			"read_naia_ui_config",
			"write_naia_ui_config",
		]);
	});

	it("pins the request path and config snapshot for queued writes", async () => {
		setAdkPath(WIN_ADK);
		let releaseFirst!: () => void;
		const firstWriteFinished = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		mockInvoke.mockImplementation(async (command: string, args?: unknown) => {
			if (command === "write_naia_config") {
				const json = (args as { json: string }).json;
				if (JSON.parse(json).model === "first") await firstWriteFinished;
			}
			if (command === "read_naia_ui_config") return "";
			if (command === "detect_gpu_vram") return null;
			return undefined;
		});

		const first = { provider: "openai", model: "first" };
		const second = { provider: "openai", model: "second" };
		const firstWrite = writeNaiaConfig(first);
		const secondWrite = writeNaiaConfig(second);
		second.model = "mutated-after-enqueue";
		localStorage.setItem("naia-adk-path", UNIX_ADK);
		releaseFirst();
		await Promise.all([firstWrite, secondWrite]);

		const configWrites = mockInvoke.mock.calls.filter(
			([command]) => command === "write_naia_config",
		);
		expect(configWrites).toHaveLength(2);
		expect(configWrites.map(([, args]) => (args as { adkPath: string }).adkPath)).toEqual([
			WIN_ADK,
			WIN_ADK,
		]);
		expect(
			configWrites.map(([, args]) => JSON.parse((args as { json: string }).json).model),
		).toEqual(["first", "second"]);

		const pairedWrites = mockInvoke.mock.calls.filter(
			([command]) =>
				command === "write_naia_ui_config" || command === "write_slots_manifest",
		);
		expect(pairedWrites).toHaveLength(4);
		expect(
			pairedWrites.map(([, args]) => (args as { adkPath: string }).adkPath),
		).toEqual([WIN_ADK, WIN_ADK, WIN_ADK, WIN_ADK]);
	});

	it("does not write a config queued during hydration after the gate opens", async () => {
		setAdkPath(WIN_ADK);
		beginNaiaConfigHydration();
		const pendingWrite = writeNaiaConfig({
			provider: "openai",
			model: "stale-before-hydration",
		});
		completeNaiaConfigHydration();
		await pendingWrite;
		expect(
			mockInvoke.mock.calls.some(([command]) => command === "write_naia_config"),
		).toBe(false);
	});

	it("allows setup to persist the selected ADK while ordinary hydration writes stay gated", async () => {
		setAdkPath(WIN_ADK);
		beginNaiaConfigHydration();

		const selectedWrite = writeNaiaConfigAtPath(
			{ provider: "openai", model: "selected-adk-model" },
			WIN_ADK,
		);
		const blockedWrite = writeNaiaConfig({
			provider: "openai",
			model: "stale-local-cache",
		});

		await selectedWrite;
		await blockedWrite;
		completeNaiaConfigHydration();

		const configWrites = mockInvoke.mock.calls.filter(
			([command]) => command === "write_naia_config",
		);
		expect(configWrites).toHaveLength(1);
		expect(configWrites[0]?.[1]).toEqual(
			expect.objectContaining({ adkPath: WIN_ADK }),
		);
		expect(
			JSON.parse((configWrites[0]?.[1] as { json: string }).json).model,
		).toBe("selected-adk-model");
	});

	it("does not borrow the newly selected ADK credential for a queued old-path manifest", async () => {
		setAdkPath(WIN_ADK);
		secureState.naiaKey = "credential-from-new-selection";
		mockInvoke.mockImplementation(async (command: string) => {
			if (command === "write_naia_config") {
				// Simulate a workspace switch while the old path is awaiting native I/O.
				localStorage.setItem("naia-adk-path", UNIX_ADK);
			}
			if (command === "read_naia_ui_config") return "";
			if (command === "detect_gpu_vram") return null;
			return undefined;
		});

		await writeNaiaConfigAtPath(
			{ provider: "nextain", model: "old-workspace-model" },
			WIN_ADK,
		);

		const manifestCall = mockInvoke.mock.calls.find(
			([command]) => command === "write_slots_manifest",
		);
		const manifest = JSON.parse((manifestCall?.[1] as { json: string }).json);
		expect(manifest.gate.naiaAccount).toBe(false);
	});

	it("completes an approved write when hydration starts while it waits", async () => {
		setAdkPath(WIN_ADK);
		let releaseFirst!: () => void;
		const firstWriteFinished = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let firstWriteStarted!: () => void;
		const firstWriteStartedPromise = new Promise<void>((resolve) => {
			firstWriteStarted = resolve;
		});
		mockInvoke.mockImplementation(async (command: string) => {
			if (command === "write_naia_config") {
				firstWriteStarted();
				await firstWriteFinished;
			}
			if (command === "read_naia_ui_config") return "";
			if (command === "detect_gpu_vram") return null;
			return undefined;
		});

		const firstWrite = writeNaiaConfig({
			provider: "openai",
			model: "approved-before-hydration",
		});
		await firstWriteStartedPromise;
		beginNaiaConfigHydration();
		const secondWrite = writeNaiaConfig({
			provider: "openai",
			model: "blocked-during-hydration",
		});

		releaseFirst();
		try {
			await firstWrite;
			await secondWrite;

			const configWrites = mockInvoke.mock.calls.filter(
				([command]) => command === "write_naia_config",
			);
			expect(configWrites).toHaveLength(1);
			expect(
				JSON.parse((configWrites[0]?.[1] as { json: string }).json).model,
			).toBe("approved-before-hydration");
			const uiWrites = mockInvoke.mock.calls.filter(
				([command]) => command === "write_naia_ui_config",
			);
			expect(uiWrites).toHaveLength(1);
		} finally {
			completeNaiaConfigHydration();
		}
	});

	it("serializes direct UI patches behind a full config write", async () => {
		setAdkPath(WIN_ADK);
		let releaseConfigWrite!: () => void;
		const configWriteStarted = new Promise<void>((resolve) => {
			releaseConfigWrite = resolve;
		});
		mockInvoke.mockImplementation(async (command: string) => {
			if (command === "write_naia_config") await configWriteStarted;
			if (command === "read_naia_ui_config") return "";
			if (command === "detect_gpu_vram") return null;
			return undefined;
		});

		const fullWrite = writeNaiaConfig({
			provider: "openai",
			model: "full-config",
		});
		const uiWrite = writeNaiaUiConfig({ theme: "dark" });
		await Promise.resolve();
		expect(
			mockInvoke.mock.calls.filter(
				([command]) => command === "write_naia_ui_config",
			),
		).toHaveLength(0);
		releaseConfigWrite();
		await Promise.all([fullWrite, uiWrite]);

		const uiWrites = mockInvoke.mock.calls.filter(
			([command]) => command === "write_naia_ui_config",
		);
		expect(uiWrites).toHaveLength(2);
		expect(JSON.parse((uiWrites[0]?.[1] as { json: string }).json)).toEqual({});
		expect(JSON.parse((uiWrites[1]?.[1] as { json: string }).json)).toEqual({
			theme: "dark",
		});
	});

	it("writes the current flat memory contract to config.json and strips secrets", async () => {
		setAdkPath(WIN_ADK);
		await writeNaiaConfig({
			provider: "openai",
			model: "gpt-4o",
			memoryAdapter: "qdrant",
			memoryEmbeddingProvider: "vllm",
			memoryEmbeddingBaseUrl: "http://127.0.0.1:8000/v1",
			memoryEmbeddingModel: "nomic-embed-text",
			memoryEmbeddingApiKey: "must-stay-in-keychain",
			qdrantUrl: "http://127.0.0.1:6333",
			qdrantApiKey: "must-stay-in-keychain",
		});

		const call = mockInvoke.mock.calls.find(
			([command]) => command === "write_naia_config",
		);
		const written = JSON.parse((call?.[1] as { json: string }).json);
		expect(written).toMatchObject({
			memoryAdapter: "qdrant",
			memoryEmbeddingProvider: "vllm",
			memoryEmbeddingBaseUrl: "http://127.0.0.1:8000/v1",
			memoryEmbeddingModel: "nomic-embed-text",
			qdrantUrl: "http://127.0.0.1:6333",
			NAIA_EMBED_PROVIDER: "vllm",
			NAIA_EMBED_MODEL: "nomic-embed-text",
			NAIA_EMBED_BASE_URL: "http://127.0.0.1:8000/v1",
		});
		expect(written).not.toHaveProperty("memoryEmbeddingApiKey");
		expect(written).not.toHaveProperty("qdrantApiKey");
		expect(JSON.stringify(written)).not.toContain("must-stay-in-keychain");
	});

	it("drops stale derived env aliases and regenerates only current values", async () => {
		setAdkPath(WIN_ADK);
		mockInvoke.mockImplementation(async (command: string) =>
			command === "read_naia_ui_config" ? "" : undefined,
		);

		await writeNaiaConfig({
			provider: "nextain",
			model: "gemini-3.5-flash",
			OPENAI_BASE_URL: "http://stale-ollama.test/v1",
			NAIA_LLM_PROVIDER: "ollama",
			NAIA_LLM_MODEL: "stale-memory-model",
		});

		const call = mockInvoke.mock.calls.find(
			([name]) => name === "write_naia_config",
		);
		const written = JSON.parse((call?.[1] as { json: string }).json);
		expect(written).not.toHaveProperty("OPENAI_BASE_URL");
		expect(written).not.toHaveProperty("NAIA_LLM_PROVIDER");
		expect(written).not.toHaveProperty("NAIA_LLM_MODEL");
		expect(written.NAIA_MAIN_PROVIDER).toBe("naia");
		expect(written.NAIA_MAIN_MODEL).toBe("gemini-3.5-flash");
	});

	it("preserves the member slots gate when the public config omits the secure Naia key", async () => {
		setAdkPath(WIN_ADK);
		secureState.naiaKey = "secure-member-key";
		mockInvoke.mockImplementation(async (command: string) =>
			command === "read_naia_ui_config" ? "" : undefined,
		);

		await writeNaiaConfig({
			provider: "nextain",
			model: "gemini-2.5-flash-live",
			localGpuTier: "laptop-4060-8g",
			local8gFocus: "both",
		});

		const call = mockInvoke.mock.calls.find(
			([name]) => name === "write_slots_manifest",
		);
		const manifest = JSON.parse((call?.[1] as { json: string }).json);
		expect(manifest.gate).toEqual({ naiaAccount: true, mode: "naia" });
		expect(JSON.stringify(manifest)).not.toContain("secure-member-key");
	});

	it("llmRoles는 opaque credentialRef만 보존하고 중첩 token/apiKey를 제거한다", async () => {
		setAdkPath(WIN_ADK);
		mockInvoke.mockImplementation(async (command: string) =>
			command === "read_naia_ui_config" ? "" : undefined,
		);
		await writeNaiaConfig({
			provider: "codex",
			model: "gpt-5.4",
			llmRoles: {
				main: {
					provider: "codex",
					model: "gpt-5.4",
					credentialRef: "codex-login",
					apiKey: "must-not-write",
					token: "must-not-write",
				},
			},
		});
		const call = mockInvoke.mock.calls.find(
			([name]) => name === "write_naia_config",
		);
		const written = JSON.parse((call?.[1] as { json: string }).json);
		expect(written.llmRoles.main).toEqual({
			provider: "codex",
			model: "gpt-5.4",
			credentialRef: "codex-login",
		});
		expect(JSON.stringify(written)).not.toContain("must-not-write");
	});
});

// ── ui-config 분리(FR-WS.2) + 워크스페이스 전환 복원(FR-WS.1/.3) ─────────────────

describe("writeNaiaUiConfig (UI 정체성만 ui-config.json 으로 분리)", () => {
	it("does nothing when adk path not set", async () => {
		await writeNaiaUiConfig({ vrmModel: "a.vrm" });
		expect(mockInvoke).not.toHaveBeenCalled();
	});

	it("persists modelSortMode only in ui-config", async () => {
		setAdkPath(WIN_ADK);
		await writeNaiaConfig({
			provider: "openai",
			model: "gpt-4o",
			modelSortMode: "performance",
		});

		const configCall = mockInvoke.mock.calls.find(
			([command]) => command === "write_naia_config",
		);
		const uiCall = mockInvoke.mock.calls.find(
			([command]) => command === "write_naia_ui_config",
		);
		expect(
			JSON.parse((configCall?.[1] as { json: string }).json),
		).not.toHaveProperty("modelSortMode");
		expect(
			JSON.parse((uiCall?.[1] as { json: string }).json).modelSortMode,
		).toBe("performance");
	});

	// FR-CONFIG-SOT.4 — ui-config.json 은 UI_ONLY 전체를 저장한다(세션/휘발 상태만 제외).
	//   이전 계약은 UI_IDENTITY 9개만 저장 → theme·vllmTtsHost 등이 어느 파일에도 SoT 가 없어 부팅 리셋.
	it("writes ALL UI settings (not just identity), dropping provider/secret keys", async () => {
		setAdkPath(WIN_ADK);
		await writeNaiaUiConfig({
			provider: "openai", // agent 키(config.json) → 제외
			naiaKey: "secret", // 시크릿 → 제외
			vrmModel: "a.vrm", // UI 정체성 → 저장
			theme: "ocean", // UI 설정 → 이제 저장됨(이전엔 제외됐다)
			vllmTtsHost: "http://localhost:22600", // 로컬 보이스 호스트 → 저장(회귀 대상)
			appPosition: "left", // 앱 레이아웃 → 저장
			bgmVolume: 0.5, // BGM 볼륨 → 저장
			locale: "ko", // 로케일 → 저장
			uiPreferences: { chatMode: "app" }, // grouped shell preferences → 저장
		});
		const [, arg] = mockInvoke.mock.calls.find(
			([name]) => name === "write_naia_ui_config",
		)!;
		const written = JSON.parse((arg as { json: string }).json);
		// 저장돼야 할 UI 설정 (회귀 방지 핵심)
		expect(written.vrmModel).toBe("a.vrm");
		expect(written.theme).toBe("ocean");
		expect(written.vllmTtsHost).toBe("http://localhost:22600");
		expect(written.appPosition).toBe("left");
		expect(written.bgmVolume).toBe(0.5);
		expect(written.locale).toBe("ko");
		expect(written.uiPreferences).toEqual({ chatMode: "app" });
		// agent 키·시크릿은 ui-config 에 안 들어간다
		expect(written).not.toHaveProperty("provider");
		expect(written).not.toHaveProperty("naiaKey");
	});

	it("does NOT persist volatile session state (discord/bgmPlaying)", async () => {
		setAdkPath(WIN_ADK);
		await writeNaiaUiConfig({
			theme: "ocean",
			discordSessionMigrated: true, // 세션 상태 → 제외
			lastProcessedDiscordMessageId: "123", // 세션 상태 → 제외
			bgmPlaying: true, // 휘발 재생상태 → 제외
		});
		const [, arg] = mockInvoke.mock.calls.find(
			([name]) => name === "write_naia_ui_config",
		)!;
		const written = JSON.parse((arg as { json: string }).json);
		expect(written.theme).toBe("ocean");
		expect(written).not.toHaveProperty("discordSessionMigrated");
		expect(written).not.toHaveProperty("lastProcessedDiscordMessageId");
		expect(written).not.toHaveProperty("bgmPlaying");
	});

	it("restores durable YouTube track metadata and volume without resuming playback", async () => {
		setAdkPath(WIN_ADK);
		await writeNaiaUiConfig({
			bgmSource: "youtube",
			bgmYoutubeVideoId: "video-123",
			bgmYoutubeTitle: "Saved track",
			bgmYoutubeChannel: "Saved channel",
			bgmYoutubeThumbnail: "https://i.ytimg.com/vi/video-123/default.jpg",
			bgmVolume: 0.35,
			bgmPlaying: true,
		});
		const writeCall = mockInvoke.mock.calls.find(
			([command]) => command === "write_naia_ui_config",
		);
		const persistedJson = (writeCall?.[1] as { json: string }).json;
		expect(JSON.parse(persistedJson)).not.toHaveProperty("bgmPlaying");

		mockInvoke.mockReset();
		mockInvoke.mockImplementation(async (command: string) => {
			if (command === "read_naia_config") {
				return JSON.stringify({ provider: "openai", model: "gpt-4o" });
			}
			if (command === "read_naia_ui_config") return persistedJson;
			return undefined;
		});
		await applyWorkspaceConfigToLocal();

		const restored = JSON.parse(localStorage.getItem("naia-config") ?? "{}");
		expect(restored).toMatchObject({
			bgmSource: "youtube",
			bgmYoutubeVideoId: "video-123",
			bgmYoutubeTitle: "Saved track",
			bgmYoutubeChannel: "Saved channel",
			bgmYoutubeThumbnail: "https://i.ytimg.com/vi/video-123/default.jpg",
			bgmVolume: 0.35,
		});
		expect(restored).not.toHaveProperty("bgmPlaying");
	});

	it("preserves unowned persisted choices when a boot-time UI patch is partial", async () => {
		setAdkPath(WIN_ADK);
		mockInvoke.mockImplementation(async (command: string) => {
			if (command === "read_naia_ui_config") {
				return JSON.stringify({
					avatarProvider: "naia-video-avatar",
					nvaModel: "naia",
					vllmTtsHost: "http://127.0.0.1:8910",
				});
			}
			return undefined;
		});

		await writeNaiaUiConfig({ bgmVolume: 0.3, ttsEnabled: false });

		const [, arg] = mockInvoke.mock.calls.find(
			([name]) => name === "write_naia_ui_config",
		)!;
		expect(JSON.parse((arg as { json: string }).json)).toEqual({
			avatarProvider: "naia-video-avatar",
			nvaModel: "naia",
			vllmTtsHost: "http://127.0.0.1:8910",
			bgmVolume: 0.3,
			ttsEnabled: false,
		});
	});

	it("removes a choice only when the caller explicitly provides undefined", async () => {
		setAdkPath(WIN_ADK);
		mockInvoke.mockImplementation(async (command: string) => {
			if (command === "read_naia_ui_config")
				return JSON.stringify({ vrmModel: "selected.vrm", theme: "ocean" });
			return undefined;
		});

		await writeNaiaUiConfig({ vrmModel: undefined });

		const [, arg] = mockInvoke.mock.calls.find(
			([name]) => name === "write_naia_ui_config",
		)!;
		expect(JSON.parse((arg as { json: string }).json)).toEqual({
			theme: "ocean",
		});
	});

	// 회귀 방지 — 로컬 보이스 호스트가 write→read 왕복에서 살아남는가 (루크 발견 버그).
	it("round-trips vllmTtsHost through ui-config (regression: local voice host reset)", async () => {
		setAdkPath(WIN_ADK);
		await writeNaiaUiConfig({
			vllmTtsHost: "http://tts.example.invalid:22600",
		});
		const [, arg] = mockInvoke.mock.calls.find(
			([name]) => name === "write_naia_ui_config",
		)!;
		const written = (arg as { json: string }).json;
		// 그 JSON 을 read 가 그대로 파싱해 돌려준다.
		mockInvoke.mockResolvedValue(written);
		expect((await readNaiaUiConfig())?.vllmTtsHost).toBe(
			"http://tts.example.invalid:22600",
		);
	});
});

describe("readNaiaUiConfig", () => {
	it("returns null when adk path not set", async () => {
		expect(await readNaiaUiConfig()).toBeNull();
	});

	it("parses ui-config JSON", async () => {
		setAdkPath(WIN_ADK);
		mockInvoke.mockResolvedValue(JSON.stringify({ vrmModel: "b.vrm" }));
		expect((await readNaiaUiConfig())?.vrmModel).toBe("b.vrm");
	});

	it("throws on I/O, malformed, and non-object responses", async () => {
		setAdkPath(WIN_ADK);
		mockInvoke.mockRejectedValueOnce(new Error("permission denied"));
		await expect(readNaiaUiConfig()).rejects.toThrow("permission denied");
		mockInvoke.mockResolvedValueOnce("not-json");
		await expect(readNaiaUiConfig()).rejects.toThrow();
		mockInvoke.mockResolvedValueOnce("null");
		await expect(readNaiaUiConfig()).rejects.toThrow("invalid_json");
	});
});

describe("writeNaiaConfig also persists ui-config (FR-WS.2)", () => {
	it("calls both write_naia_config (stripped) and write_naia_ui_config (ALL UI settings)", async () => {
		setAdkPath(WIN_ADK);
		await writeNaiaConfig({
			provider: "openai",
			model: "gpt-4o",
			vrmModel: "a.vrm",
			theme: "ocean",
			vllmTtsHost: "http://localhost:22600",
		});
		// config.json: UI keys stripped (vrmModel/theme/vllmTtsHost gone — stripForAgent)
		expect(mockInvoke).toHaveBeenCalledWith("write_naia_config", {
			adkPath: WIN_ADK,
			json: JSON.stringify(
				{
					provider: "openai",
					model: "gpt-4o",
					NAIA_MAIN_PROVIDER: "openai",
					NAIA_MAIN_MODEL: "gpt-4o",
				},
				null,
				2,
			),
		});
		// ui-config.json: ALL UI settings (FR-CONFIG-SOT.4 — theme·vllmTtsHost 도 저장,
		//   이전엔 UI_IDENTITY 9개만 저장해 이들이 어느 파일에도 SoT 가 없었다).
		const [, arg] = mockInvoke.mock.calls.find(
			([name]) => name === "write_naia_ui_config",
		)!;
		const written = JSON.parse((arg as { json: string }).json);
		expect(written.vrmModel).toBe("a.vrm");
		expect(written.theme).toBe("ocean");
		expect(written.vllmTtsHost).toBe("http://localhost:22600");
		// agent 키는 ui-config 에 안 들어간다
		expect(written).not.toHaveProperty("provider");
		expect(written).not.toHaveProperty("model");
	});
});

describe("applyWorkspaceConfigToLocal (전환 복원 FR-WS.1/.3)", () => {
	it("merges config.json + ui-config.json into localStorage naia-config", async () => {
		setAdkPath(WIN_ADK);
		mockInvoke.mockImplementation(async (cmd: string) => {
			if (cmd === "read_naia_config")
				return JSON.stringify({
					persona: "P",
					provider: "nextain",
					model: "m",
					OPENAI_BASE_URL: "http://stale-ollama.test/v1",
					NAIA_LLM_PROVIDER: "ollama",
				});
			if (cmd === "read_naia_ui_config")
				return JSON.stringify({
					vrmModel: "ws.vrm",
					backgroundImage: "ws.png",
					modelSortMode: "performance",
				});
			return undefined;
		});
		await applyWorkspaceConfigToLocal();
		const stored = JSON.parse(localStorage.getItem("naia-config") ?? "{}");
		expect(stored.persona).toBe("P"); // config.json 복원
		expect(stored.model).toBe("m");
		expect(stored.vrmModel).toBe("ws.vrm"); // ui-config.json 복원
		expect(stored.backgroundImage).toBe("ws.png");
		expect(stored.modelSortMode).toBe("performance");
		expect(stored.OPENAI_BASE_URL).toBeUndefined();
		expect(stored.NAIA_LLM_PROVIDER).toBeUndefined();
		expect(stored.workspaceRoot).toBe(WIN_ADK);
		expect(stored.onboardingComplete).toBe(true);
	});

	it("survives missing files — identity keys absent (bundle fallback)", async () => {
		setAdkPath(WIN_ADK);
		mockInvoke.mockResolvedValue(""); // both reads empty
		await applyWorkspaceConfigToLocal();
		const stored = JSON.parse(localStorage.getItem("naia-config") ?? "{}");
		expect(stored.vrmModel).toBeUndefined();
		expect(stored.workspaceRoot).toBe(WIN_ADK);
	});
});

// ── copyBundledAssets ─────────────────────────────────────────────────────────

describe("copyBundledAssets", () => {
	it("calls invoke copy_bundled_assets with adkPath", async () => {
		mockInvoke.mockResolvedValue(undefined);
		await copyBundledAssets(WIN_ADK);
		expect(mockInvoke).toHaveBeenCalledWith("copy_bundled_assets", {
			adkPath: WIN_ADK,
		});
	});

	it("throws copy errors so setup can surface them", async () => {
		mockInvoke.mockRejectedValue(
			new Error("Bundled assets directory not found"),
		);
		await expect(copyBundledAssets(WIN_ADK)).rejects.toThrow(
			"Bundled assets directory not found",
		);
	});
});
// ── #515 — openai 커스텀 호스트의 llmRoles.main.baseUrl 동기화 ─────────────────
// agent 는 chat_request 의 provider 를 받지 않고(grpc-codec "provider 제거=정본")
// config.json 의 llmRoles.main 만 읽는다. 최상위 openaiBaseUrl 이 main.baseUrl 로
// 동기화되지 않으면 채팅이 기본 api.openai.com 으로 새는 실측 결함의 회귀 가드.
describe("syncMainRoleOpenAiBaseUrl (#515)", () => {
	it("injects the normalized custom host into llmRoles.main for openai", () => {
		const cfg: Record<string, unknown> = {
			provider: "openai",
			model: "unlocked",
			openaiBaseUrl: "http://100.91.187.24:11435/v1/",
			llmRoles: { main: { provider: "openai", model: "unlocked" } },
		};
		syncMainRoleOpenAiBaseUrl(cfg);
		expect(cfg.llmRoles).toMatchObject({
			main: {
				provider: "openai",
				model: "unlocked",
				baseUrl: "http://100.91.187.24:11435/v1",
			},
		});
	});

	it("creates llmRoles.main from top-level fields when roles are absent", () => {
		const cfg: Record<string, unknown> = {
			provider: "openai",
			model: "gpt-4o",
			openaiBaseUrl: "http://gpu:8000",
		};
		syncMainRoleOpenAiBaseUrl(cfg);
		expect(cfg.llmRoles).toMatchObject({
			main: { provider: "openai", model: "gpt-4o", baseUrl: "http://gpu:8000/v1" },
		});
	});

	it("removes a fossil baseUrl when the custom host is cleared", () => {
		const cfg: Record<string, unknown> = {
			provider: "openai",
			model: "gpt-4o",
			llmRoles: {
				main: { provider: "openai", model: "gpt-4o", baseUrl: "http://old/v1" },
			},
		};
		syncMainRoleOpenAiBaseUrl(cfg);
		expect(
			(cfg.llmRoles as { main: Record<string, unknown> }).main,
		).not.toHaveProperty("baseUrl");
	});

	it("leaves non-openai mains and inherit markers untouched", () => {
		const nextain: Record<string, unknown> = {
			provider: "nextain",
			openaiBaseUrl: "http://gpu:8000/v1",
			llmRoles: { main: { provider: "nextain", model: "deepseek-v4-flash" } },
		};
		syncMainRoleOpenAiBaseUrl(nextain);
		expect(
			(nextain.llmRoles as { main: Record<string, unknown> }).main,
		).not.toHaveProperty("baseUrl");

		const inherited: Record<string, unknown> = {
			provider: "openai",
			openaiBaseUrl: "http://gpu:8000/v1",
			llmRoles: { main: { inherit: "expert" } },
		};
		syncMainRoleOpenAiBaseUrl(inherited);
		expect(inherited.llmRoles).toEqual({ main: { inherit: "expert" } });
	});

	it("writeNaiaConfig persists the synced main baseUrl to the agent config", async () => {
		setAdkPath(WIN_ADK);
		mockInvoke.mockClear();
		mockInvoke.mockImplementation(async (command: string) => {
			if (command === "read_naia_ui_config") return "{}";
			if (command === "detect_gpu_vram") return null;
			return undefined;
		});

		await writeNaiaConfig({
			provider: "openai",
			model: "unlocked",
			openaiBaseUrl: "http://100.91.187.24:11435",
			llmRoles: { main: { provider: "openai", model: "unlocked" } },
		});

		const writeCall = mockInvoke.mock.calls.find(
			([command]) => command === "write_naia_config",
		);
		expect(writeCall).toBeDefined();
		const persisted = JSON.parse(
			(writeCall?.[1] as { json: string }).json,
		) as { llmRoles?: { main?: { baseUrl?: string } } };
		expect(persisted.llmRoles?.main?.baseUrl).toBe(
			"http://100.91.187.24:11435/v1",
		);
	});
});

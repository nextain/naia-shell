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

vi.mock("@tauri-apps/api/core", () => ({
	invoke: mockInvoke,
	convertFileSrc: mockConvertFileSrc,
}));

import {
	buildNaiaConfigEnv,
	clearAdkPath,
	copyBundledAssets,
	getAdkPath,
	isAdkInitialized,
	listNaiaAssets,
	readNaiaConfig,
	setAdkPath,
	toAssetUrl,
	writeNaiaConfig,
} from "../adk-store";

// ── helpers ───────────────────────────────────────────────────────────────────

const WIN_ADK = "D:\\Users\\luke\\naia-adk";
const UNIX_ADK = "/home/luke/naia-adk";

beforeEach(() => {
	localStorage.clear();
	mockInvoke.mockReset();
	// Default: any invoke resolves. setAdkPath fires a fire-and-forget
	// invoke("write_naia_path_cache").catch(...); without a resolved default the
	// reset mock returns undefined and the .catch() throws (#313 Naia Local).
	mockInvoke.mockResolvedValue(undefined);
	mockConvertFileSrc.mockClear();
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
		setAdkPath("D:\\Users\\luke\\naia-adk\\");
		expect(getAdkPath()).toBe(WIN_ADK);
	});

	it("strips trailing slash on Unix path", () => {
		setAdkPath("/home/luke/naia-adk/");
		expect(getAdkPath()).toBe(UNIX_ADK);
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

// ── toAssetUrl ─────────────────────────────────────────────────────────────────

describe("toAssetUrl", () => {
	it("converts a Windows absolute path to an asset:// URL", () => {
		const url = toAssetUrl(
			"D:\\Users\\luke\\naia-adk\\naia-settings\\background\\bg.png",
		);
		expect(url).toContain("asset://");
		expect(url).toContain("bg.png");
	});

	it("converts a Unix absolute path to an asset:// URL", () => {
		const url = toAssetUrl(
			"/home/luke/naia-adk/naia-settings/vrm-files/naia.vrm",
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
		setAdkPath(WIN_ADK);
		mockInvoke.mockResolvedValue([
			"01-Sendagaya-Shino-uniform.vrm",
			"02-Sakurada-Fumiriya.vrm",
		]);

		const result = await listNaiaAssets("vrm-files");

		expect(mockInvoke).toHaveBeenCalledWith("list_naia_assets", {
			adkPath: WIN_ADK,
			subdir: "vrm-files",
		});
		expect(result).toHaveLength(2);
		expect(result[0]).toContain("naia-settings");
		expect(result[0]).toContain("vrm-files");
		expect(result[0]).toContain("01-Sendagaya-Shino-uniform.vrm");
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

	it("returns null on invoke error", async () => {
		setAdkPath(WIN_ADK);
		mockInvoke.mockRejectedValue(new Error("File not found"));
		expect(await readNaiaConfig()).toBeNull();
	});

	it("returns null for empty string response", async () => {
		setAdkPath(WIN_ADK);
		mockInvoke.mockResolvedValue("");
		expect(await readNaiaConfig()).toBeNull();
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
	it("does nothing when adk path not set", async () => {
		await writeNaiaConfig({ provider: "gemini" });
		expect(mockInvoke).not.toHaveBeenCalled();
	});

	it("calls invoke with serialized JSON", async () => {
		setAdkPath(WIN_ADK);
		mockInvoke.mockResolvedValue(undefined);

		await writeNaiaConfig({ provider: "openai", model: "gpt-4o" });

		expect(mockInvoke).toHaveBeenCalledWith("write_naia_config", {
			adkPath: WIN_ADK,
			json: JSON.stringify({ provider: "openai", model: "gpt-4o" }, null, 2),
		});
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

// UC12: buildNaiaConfigEnv 가 naia-settings/config.json 에 쓰는 필드는 new-naia-agent
// provider-resolver(resolveProviderSpec)가 읽는 필드와 **같은 계약**이어야 한다. 이 테스트가
// OS-영속 측에서 그 필드명을 잠근다(에이전트 측 provider-resolver.test.ts 가 읽기 측을 잠금).
describe("buildNaiaConfigEnv (UC12 — 에이전트 provider 선택 계약)", () => {
	it("nextain → NAIA_MAIN_PROVIDER=naia + NAIA_ANYLLM_BASE_URL", () => {
		const env = buildNaiaConfigEnv({ provider: "nextain", model: "naia-1", naiaGatewayUrl: "wss://gw" });
		expect(env.NAIA_MAIN_PROVIDER).toBe("naia"); // resolver 가 nextain↔naia 정규화에 맞춤
		expect(env.NAIA_MAIN_MODEL).toBe("naia-1");
		expect(env.NAIA_ANYLLM_BASE_URL).toBe("wss://gw");
	});

	it("glm → NAIA_MAIN_PROVIDER=glm + NAIA_MAIN_MODEL", () => {
		const env = buildNaiaConfigEnv({ provider: "glm", model: "glm-4.6" });
		expect(env.NAIA_MAIN_PROVIDER).toBe("glm");
		expect(env.NAIA_MAIN_MODEL).toBe("glm-4.6");
	});

	it("ollama → OPENAI_BASE_URL = host + /v1 (resolver ollama/openai-compat 입력)", () => {
		const env = buildNaiaConfigEnv({ provider: "ollama", model: "gemma3:4b", ollamaHost: "http://localhost:11434" });
		expect(env.NAIA_MAIN_PROVIDER).toBe("ollama");
		expect(env.OPENAI_BASE_URL).toBe("http://localhost:11434/v1");
	});

	it("vllm → OPENAI_BASE_URL = host + /v1", () => {
		const env = buildNaiaConfigEnv({ provider: "vllm", model: "qwen", vllmHost: "http://h:8000" });
		expect(env.OPENAI_BASE_URL).toBe("http://h:8000/v1");
	});
});

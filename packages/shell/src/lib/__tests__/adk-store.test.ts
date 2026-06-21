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
	applyModelSelectionToConfig,
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
		const out = applyModelSelectionToConfig(stale, "nextain", "gemini-3.1-flash-lite");
		expect(out.model).toBe("gemini-3.1-flash-lite");
		expect(out.NAIA_MAIN_MODEL).toBe("gemini-3.1-flash-lite");
		expect(out.NAIA_MAIN_PROVIDER).toBe("naia"); // nextain → "naia" env
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
		const out = applyModelSelectionToConfig(null, "nextain", "gemini-3.1-flash-lite");
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
		setAdkPath("C:\\work\\naia-adk\\");
		expect(getAdkPath()).toBe(WIN_ADK);
	});

	it("strips trailing slash on Unix path", () => {
		setAdkPath("/home/user/naia-adk/");
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

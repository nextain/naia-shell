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
	applyWorkspaceConfigToLocal,
	clearAdkPath,
	copyBundledAssets,
	getAdkPath,
	isAdkInitialized,
	listNaiaAssets,
	readNaiaConfig,
	readNaiaUiConfig,
	setAdkPath,
	toAssetUrl,
	writeNaiaConfig,
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

	it("llmRoles는 opaque credentialRef만 보존하고 중첩 token/apiKey를 제거한다", async () => {
		setAdkPath(WIN_ADK);
		mockInvoke.mockResolvedValue(undefined);
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
		const call = mockInvoke.mock.calls.find(([name]) => name === "write_naia_config");
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
			panelPosition: "left", // 패널 레이아웃 → 저장
			bgmVolume: 0.5, // BGM 볼륨 → 저장
			locale: "ko", // 로케일 → 저장
		});
		const [, arg] = mockInvoke.mock.calls.find(
			([name]) => name === "write_naia_ui_config",
		)!;
		const written = JSON.parse((arg as { json: string }).json);
		// 저장돼야 할 UI 설정 (회귀 방지 핵심)
		expect(written.vrmModel).toBe("a.vrm");
		expect(written.theme).toBe("ocean");
		expect(written.vllmTtsHost).toBe("http://localhost:22600");
		expect(written.panelPosition).toBe("left");
		expect(written.bgmVolume).toBe(0.5);
		expect(written.locale).toBe("ko");
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

	// 회귀 방지 — 로컬 보이스 호스트가 write→read 왕복에서 살아남는가 (루크 발견 버그).
	it("round-trips vllmTtsHost through ui-config (regression: local voice host reset)", async () => {
		setAdkPath(WIN_ADK);
		await writeNaiaUiConfig({ vllmTtsHost: "http://tts.example.invalid:22600" });
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
			json: JSON.stringify({ provider: "openai", model: "gpt-4o" }, null, 2),
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
				return JSON.stringify({ persona: "P", provider: "nextain", model: "m" });
			if (cmd === "read_naia_ui_config")
				return JSON.stringify({ vrmModel: "ws.vrm", backgroundImage: "ws.png" });
			return undefined;
		});
		await applyWorkspaceConfigToLocal();
		const stored = JSON.parse(localStorage.getItem("naia-config") ?? "{}");
		expect(stored.persona).toBe("P"); // config.json 복원
		expect(stored.model).toBe("m");
		expect(stored.vrmModel).toBe("ws.vrm"); // ui-config.json 복원
		expect(stored.backgroundImage).toBe("ws.png");
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

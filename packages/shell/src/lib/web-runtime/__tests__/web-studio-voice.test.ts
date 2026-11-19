// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, saveConfig } from "../../config";
import { setWebAssetsModeForTests } from "../web-assets";
import {
	STUDIO_PENDING_CHARACTER_STORAGE_KEY,
	consumePendingStudioCharacterCard,
	normalizeStudioVoiceId,
} from "../web-studio-handoff";

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn().mockResolvedValue("standard"),
}));

function studioCard(name: string, naiaStudio: Record<string, unknown>) {
	return {
		spec: "chara_card_v2",
		spec_version: "2.0",
		data: {
			name,
			description: `${name} 설명`,
			first_mes: "안녕!",
			extensions: { naia_studio: naiaStudio },
		},
	};
}

async function applyCard(card: unknown) {
	localStorage.setItem(STUDIO_PENDING_CHARACTER_STORAGE_KEY, JSON.stringify(card));
	const res = await consumePendingStudioCharacterCard();
	expect(res).toMatchObject({ handled: true, ok: true });
	return loadConfig();
}

describe("R16 Studio → web shell applies character and voice together", () => {
	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		setWebAssetsModeForTests(true);
	});

	afterEach(() => {
		setWebAssetsModeForTests(null);
		vi.restoreAllMocks();
	});

	it("R16 normalizes Studio voice ids to the gateway form", () => {
		expect(normalizeStudioVoiceId("cc0-ko-female-01")).toBe("naia-voice:cc0-ko-female-01");
		expect(normalizeStudioVoiceId("tpl-jina")).toBe("naia-voice:tpl-jina");
		expect(normalizeStudioVoiceId("naia-voice:tpl-minho")).toBe("naia-voice:tpl-minho");
		expect(normalizeStudioVoiceId("ko-KR-SunHi:DragonHDLatestNeural")).toBe(
			"ko-KR-SunHi:DragonHDLatestNeural",
		);
		expect(normalizeStudioVoiceId("ko-KR-Chirp3-HD-Kore")).toBe("ko-KR-Chirp3-HD-Kore");
		expect(normalizeStudioVoiceId("user-voice:abc")).toBeUndefined();
		expect(normalizeStudioVoiceId("  ")).toBeUndefined();
	});

	it("R16 a Studio card with avatar_id + bare voice_id switches avatar and Naia voice", async () => {
		saveConfig({
			provider: "webllm",
			model: "Qwen3-4B-q4f32_1-MLC",
			apiKey: "",
			ttsVoice: "ko-KR-SunHi:DragonHDLatestNeural",
		});
		const cfg = await applyCard(
			studioCard("민호", { avatar_id: "av-def-minho-anime", voice_id: "cc0-ko-male-02" }),
		);
		expect(cfg?.ttsVoice).toBe("naia-voice:cc0-ko-male-02");
		expect(cfg?.avatarProvider).toBe("naia-video-avatar");
	});

	it("R16 a new character without a usable voice drops the previous character's voice", async () => {
		await applyCard(studioCard("지나", { canonical_key: "av-def-jina-anime", voice_id: "tpl-jina" }));
		expect(loadConfig()?.ttsVoice).toBe("naia-voice:tpl-jina");
		const cfg = await applyCard(studioCard("민호", { canonical_key: "av-def-minho-anime" }));
		expect(cfg?.ttsVoice).toBeUndefined();
		const cfg2 = await applyCard(
			studioCard("루아", { canonical_key: "av-def-jina-anime", voice_id: "user-voice:u1" }),
		);
		expect(cfg2?.ttsVoice).toBeUndefined();
	});
});

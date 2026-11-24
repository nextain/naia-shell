// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTtsVoiceId } from "../../../components/chat-voice-utils";
import { loadConfig, saveConfig } from "../../config";
import { resolveEffectiveTtsProvider } from "../../tts/resolve-web-tts-provider";
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
	const config = loadConfig();
	if (!config) throw new Error("Studio handoff did not save config");
	return config;
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

	it("R16 applies both the avatar and an effective cloud voice from browser TTS", async () => {
		saveConfig({
			provider: "webllm",
			model: "Qwen3-4B-q4f32_1-MLC",
			apiKey: "",
			ttsProvider: "browser",
			ttsVoice: "A browser voice",
		});
		const applied = vi.fn(() => loadConfig());
		window.addEventListener("naia-config-changed", applied, { once: true });
		const cfg = await applyCard(
			studioCard("민호", { avatar_id: "av-def-minho-anime", voice_id: "cc0-ko-male-02" }),
		);
		expect(applied).toHaveReturnedWith(expect.objectContaining({
			avatarProvider: "naia-video-avatar",
			nvaModel: "minho-anime",
			ttsProvider: "nextain",
			ttsVoice: "naia-voice:cc0-ko-male-02",
			ttsEnabled: true,
		}));
		const ttsProvider = resolveEffectiveTtsProvider(cfg, "fixture-key", { knownCredits: 100 });
		expect(ttsProvider).toBe("nextain");
		expect(resolveTtsVoiceId({ ...cfg, ttsProvider })).toBe("naia-voice:cc0-ko-male-02");
		expect(resolveEffectiveTtsProvider(cfg, undefined)).toBe("browser");
		expect(resolveEffectiveTtsProvider(cfg, "fixture-key", { knownCredits: 0 })).toBe("browser");
	});

	it("R16 preserves an explicit preference to keep spoken replies off", async () => {
		saveConfig({ provider: "nextain", model: "test-model", apiKey: "", ttsEnabled: false });
		const cfg = await applyCard(
			studioCard("지나", { avatar_id: "av-def-jina-original", voice_id: "tpl-jina" }),
		);
		expect(cfg.ttsEnabled).toBe(false);
		expect(cfg.ttsVoice).toBe("naia-voice:tpl-jina");
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

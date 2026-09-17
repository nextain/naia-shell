import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listTtsProviderMetas } from "../../tts/registry";
import { listSttProviders } from "../../stt/registry";
import { LIVE_PROVIDER_LABELS } from "../types";

/**
 * #603 absence proof: third-party cloud voice providers must not reappear.
 */
describe("#603 third-party cloud voice absent", () => {
	const root = join(import.meta.dirname, "../../..");

	it("deleted live modules stay gone", () => {
		for (const rel of [
			"lib/voice/gemini-live.ts",
			"lib/voice/gemini-live-proxy.ts",
			"lib/voice/openai-realtime.ts",
			"src-tauri/src/gemini_live.rs",
		]) {
			expect(() => readFileSync(join(root, rel), "utf8")).toThrow();
		}
	});

	it("TTS registry keeps only retained providers", () => {
		const ids = listTtsProviderMetas().map((m) => m.id);
		expect(ids).not.toContain("google");
		expect(ids).not.toContain("openai");
		expect(ids).not.toContain("elevenlabs");
		expect(ids).toEqual(
			expect.arrayContaining(["browser", "edge", "nextain", "naia-local-voice"]),
		);
	});

	it("STT registry has no Google/ElevenLabs/Naia-Google cloud STT", () => {
		const ids = listSttProviders().map((m) => m.id);
		expect(ids).not.toContain("google");
		expect(ids).not.toContain("elevenlabs");
		expect(ids).not.toContain("nextain");
	});

	it("live provider labels have no Gemini/OpenAI/Naia-Google live", () => {
		const ids = Object.keys(LIVE_PROVIDER_LABELS);
		expect(ids).not.toContain("gemini-live");
		expect(ids).not.toContain("openai-realtime");
		expect(ids).not.toContain("naia");
		expect(ids).toEqual(
			expect.arrayContaining(["azure-voice-live", "naia-omni", "vllm-omni"]),
		);
	});
});

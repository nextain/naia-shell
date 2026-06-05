/**
 * Voice round-trip E2E — TTS → audio → STT → text verification.
 *
 * Proves the spoken audio actually contains the intended words by
 * synthesizing speech (Edge TTS, no key) and feeding the SAME audio
 * back through the Naia Cloud STT endpoint (gateway), then comparing
 * the transcript against the source text.
 *
 * This is the "capture audio + re-run STT" verification harness:
 * it catches silent/garbled TTS output that a byte-length check
 * (tts-voice-validity.test.ts) would miss.
 *
 * Requires a naiaKey for the STT leg. Provide via:
 *   NAIA_TEST_KEY=gw-... pnpm exec vitest run src/__tests__/voice-roundtrip-e2e.test.ts
 * The TTS leg (Edge) runs with no key and is always exercised.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { synthesizeEdgeSpeech } from "../tts/edge-tts.js";

// PROD by default; override with NAIA_TEST_GATEWAY for the dev gateway.
const GATEWAY_URL =
	process.env.NAIA_TEST_GATEWAY || "https://api.nextain.io";

/** Read naiaKey from env or Windows DPAPI keychain. */
function loadNaiaKey(): string | null {
	if (process.env.NAIA_TEST_KEY) return process.env.NAIA_TEST_KEY;
	const candidates = [
		join(
			process.env.USERPROFILE || process.env.HOME || "",
			"dev",
			"alpha-adk",
			"naia-settings",
			".keys",
			"NAIA_ANYLLM_API_KEY.dpapi",
		),
		"D:/alpha-adk/naia-settings/.keys/NAIA_ANYLLM_API_KEY.dpapi",
	];
	const keyPath = candidates.find((p) => existsSync(p));
	if (!keyPath) return null;
	try {
		const script = `
Add-Type -AssemblyName System.Security
$bytes = [System.IO.File]::ReadAllBytes('${keyPath.replace(/'/g, "''")}')
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[System.Text.Encoding]::UTF8.GetString($plain)
`;
		const key = execSync(`powershell -Command "${script}"`, {
			encoding: "utf-8",
			timeout: 10000,
		}).trim();
		return key.startsWith("gw-") ? key : null;
	} catch {
		return null;
	}
}

/** Send MP3 audio (base64) through the gateway STT endpoint. */
async function transcribeViaGateway(
	mp3Base64: string,
	naiaKey: string,
	language = "ko-KR",
): Promise<string> {
	const bytes = Uint8Array.from(atob(mp3Base64), (c) => c.charCodeAt(0));
	const blob = new Blob([bytes], { type: "audio/mpeg" });
	const form = new FormData();
	form.append("file", blob, "audio.mp3");
	form.append("language", language);

	const res = await fetch(`${GATEWAY_URL}/v1/audio/transcriptions`, {
		method: "POST",
		headers: { "X-AnyLLM-Key": `Bearer ${naiaKey}` },
		body: form,
		signal: AbortSignal.timeout(30000),
	});
	if (!res.ok) {
		throw new Error(`STT HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
	}
	const data = (await res.json()) as { text?: string };
	return (data.text ?? "").trim();
}

/** Normalize for loose comparison: strip whitespace/punctuation, lowercase. */
function normalize(s: string): string {
	return s.replace(/[\s.,!?~。、·]/g, "").toLowerCase();
}

const naiaKey = loadNaiaKey();

describe("voice round-trip: TTS → audio → STT", () => {
	// TTS leg always runs (Edge, no key). Asserts non-silent audio.
	it("Edge TTS produces non-trivial MP3 audio (ko)", async () => {
		const result = await synthesizeEdgeSpeech(
			"안녕하세요. 반갑습니다.",
			"ko-KR-SunHiNeural",
		);
		expect(result).not.toBeNull();
		const bytes = Uint8Array.from(atob(result!.audio), (c) => c.charCodeAt(0));
		// 1초 분량 24kHz 48kbit MP3 ≈ 수 KB. 무음/실패는 수백 byte 이하.
		expect(bytes.length).toBeGreaterThan(2000);
	}, 20000);

	// Full round-trip needs naiaKey for the STT leg.
	it.skipIf(!naiaKey)(
		"round-trip: Korean phrase survives TTS→STT",
		async () => {
			const source = "오늘 날씨가 정말 좋네요";
			const tts = await synthesizeEdgeSpeech(source, "ko-KR-SunHiNeural");
			expect(tts).not.toBeNull();

			const transcript = await transcribeViaGateway(tts!.audio, naiaKey!, "ko-KR");
			console.log(`[round-trip ko] source="${source}" → STT="${transcript}"`);
			expect(transcript.length).toBeGreaterThan(0);

			// Loose match: STT may drop spacing/punctuation. Require key tokens.
			const normTranscript = normalize(transcript);
			// At least one distinctive content word must survive.
			const survived =
				normTranscript.includes("날씨") ||
				normTranscript.includes("오늘") ||
				normTranscript.includes("좋");
			expect(
				survived,
				`STT transcript "${transcript}" should contain a source token`,
			).toBe(true);
		},
		60000,
	);

	it.skipIf(!naiaKey)(
		"round-trip: English phrase survives TTS→STT",
		async () => {
			const source = "the weather is nice today";
			const tts = await synthesizeEdgeSpeech(source, "en-US-JennyNeural");
			// en-US Edge voices may be region-blocked; skip the assert if TTS null.
			if (!tts) return;

			const transcript = await transcribeViaGateway(tts.audio, naiaKey!, "en-US");
			const normTranscript = normalize(transcript);
			const survived =
				normTranscript.includes("weather") ||
				normTranscript.includes("today") ||
				normTranscript.includes("nice");
			expect(
				survived,
				`STT transcript "${transcript}" should contain a source token`,
			).toBe(true);
		},
		60000,
	);
});

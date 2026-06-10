/**
 * Voice Provider E2E tests: verify real WebSocket connections to Live APIs.
 *
 * Prerequisites:
 *   - shell/.env with GEMINI_API_KEY, OPENAI_API_KEY
 *
 * Opt-in (skipped by default):
 *   VOICE_E2E=1 pnpm exec vitest run src/lib/voice/__tests__/voice-e2e.test.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocketNode from "ws";
import { createGeminiLiveSession } from "../gemini-live";
import { createOpenAIRealtimeSession } from "../openai-realtime";
import type { VoiceSession } from "../types";

const VOICE_E2E = process.env.VOICE_E2E === "1";
const TIMEOUT = 30_000;

// Polyfill browser WebSocket with Node.js ws
beforeAll(() => {
	if (!VOICE_E2E) return;
	(globalThis as any).WebSocket = WebSocketNode;
});

/** Load keys from shell/.env */
function loadEnvKeys(): Record<string, string> {
	const candidates = [
		resolve(__dirname, "../../../../.env"),
		"/var/home/luke/dev/naia-os/shell/.env",
	];
	for (const p of candidates) {
		if (!existsSync(p)) continue;
		try {
			const content = readFileSync(p, "utf-8");
			const keys: Record<string, string> = {};
			for (const line of content.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith("#")) continue;
				const eq = trimmed.indexOf("=");
				if (eq === -1) continue;
				keys[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
			}
			return keys;
		} catch {}
	}
	return {};
}

const envKeys = VOICE_E2E ? loadEnvKeys() : {};
function getKey(name: string): string {
	return process.env[name] || envKeys[name] || "";
}

describe.skipIf(!VOICE_E2E)("Voice E2E — Real API connections", () => {
	let session: VoiceSession | null = null;

	afterEach(() => {
		session?.disconnect();
		session = null;
	});

	describe("Gemini Live (Direct mode)", () => {
		const apiKey = getKey("GEMINI_API_KEY");

		it.skipIf(!apiKey)(
			"connects and receives setupComplete",
			async () => {
				session = createGeminiLiveSession();
				await session.connect({
					provider: "gemini-live",
					googleApiKey: apiKey,
					model: "gemini-2.5-flash-native-audio-preview-12-2025",
					voice: "Kore",
					systemInstruction: "Reply briefly in Korean.",
				});
				expect(session.isConnected).toBe(true);
			},
			TIMEOUT,
		);

		it.skipIf(!apiKey)(
			"sends audio and receives audio response",
			async () => {
				session = createGeminiLiveSession();

				const audioReceived = new Promise<string>((resolve) => {
					session!.onAudio = (pcm) => resolve(pcm);
				});
				const turnEnded = new Promise<void>((resolve) => {
					session!.onTurnEnd = () => resolve();
				});

				await session.connect({
					provider: "gemini-live",
					googleApiKey: apiKey,
					model: "gemini-2.5-flash-native-audio-preview-12-2025",
					voice: "Kore",
					systemInstruction: "Say hello briefly in Korean.",
				});

				// Send text to trigger a response (more reliable than silent audio)
				session.sendText("안녕하세요");

				// Wait for audio response (up to 20s)
				const audio = await Promise.race([
					audioReceived,
					new Promise<string>((_, reject) =>
						setTimeout(
							() => reject(new Error("No audio received within timeout")),
							20000,
						),
					),
				]);
				expect(audio.length).toBeGreaterThan(0);

				// Wait for turn to end
				await Promise.race([
					turnEnded,
					new Promise<void>((resolve) => setTimeout(resolve, 10000)),
				]);
			},
			TIMEOUT,
		);
	});

	describe("OpenAI Realtime", () => {
		const apiKey = getKey("OPENAI_API_KEY");

		it.skipIf(!apiKey)(
			"connects and receives session.created",
			async () => {
				session = createOpenAIRealtimeSession();
				await session.connect({
					provider: "openai-realtime",
					apiKey,
					model: "gpt-4o-mini-realtime-preview",
					voice: "alloy",
					systemInstruction: "Reply briefly in Korean.",
				});
				expect(session.isConnected).toBe(true);
			},
			TIMEOUT,
		);

		it.skipIf(!apiKey)(
			"sends text and receives audio response",
			async () => {
				session = createOpenAIRealtimeSession();

				const audioReceived = new Promise<string>((resolve) => {
					session!.onAudio = (pcm) => resolve(pcm);
				});

				await session.connect({
					provider: "openai-realtime",
					apiKey,
					model: "gpt-4o-mini-realtime-preview",
					voice: "alloy",
					systemInstruction: "Say hello briefly in Korean.",
				});

				// Send text to trigger a response
				session.sendText("안녕하세요");

				const audio = await Promise.race([
					audioReceived,
					new Promise<string>((_, reject) =>
						setTimeout(
							() => reject(new Error("No audio received within timeout")),
							20000,
						),
					),
				]);
				expect(audio.length).toBeGreaterThan(0);
			},
			TIMEOUT,
		);
	});
});

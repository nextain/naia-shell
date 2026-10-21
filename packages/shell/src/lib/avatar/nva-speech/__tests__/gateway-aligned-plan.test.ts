import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Logger } from "../../../logger";
import { createGatewayAlignedPlanSource } from "../gateway-aligned-plan";

function wav(seconds: number, rate = 24000): Uint8Array {
	const samples = Math.round(seconds * rate);
	const bytes = new Uint8Array(44 + samples * 2);
	const view = new DataView(bytes.buffer);
	const put = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++)
			bytes[offset + i] = text.charCodeAt(i);
	};
	put(0, "RIFF");
	view.setUint32(4, 36 + samples * 2, true);
	put(8, "WAVE");
	put(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, rate, true);
	view.setUint32(28, rate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	put(36, "data");
	view.setUint32(40, samples * 2, true);
	return bytes;
}

const bytes = wav(0.5);
const audioBase64 = Buffer.from(bytes).toString("base64");
const sha = createHash("sha256").update(bytes).digest("hex");
const TEXT = "안녕하세요.";

function alignedPlan(overrides: Record<string, unknown> = {}) {
	return {
		version: "1",
		quality_mode: "aligned",
		text: TEXT,
		aligner: {
			provider: "mfa",
			version: "3.3.9",
			model_sha256: "0".repeat(64),
		},
		audio: { sha256: sha, duration_us: 500_000 },
		events: [
			{ unit: "vowel-open", start_us: 0, end_us: 200_000 },
			{ unit: "sil", start_us: 200_000, end_us: 500_000 },
		],
		...overrides,
	};
}

function source(reply: unknown, status = 200) {
	const fetchImpl = vi.fn(
		async () => new Response(JSON.stringify(reply), { status }),
	);
	const get = createGatewayAlignedPlanSource({
		getConfig: () => ({ gatewayUrl: "https://gw.example/", naiaKey: "key-1" }),
		fetchImpl: fetchImpl as unknown as typeof fetch,
	});
	return { get, fetchImpl };
}

const whole = { kind: "whole" as const, audioBase64, durationSeconds: 0.5 };

describe("gateway aligned plan source (shell_audio, SoT 8)", () => {
	it("sends the exact sound bytes and sentence to the studio speech-plan route", async () => {
		const { get, fetchImpl } = source({ plan: alignedPlan() });
		const plan = await get({ text: ` ${TEXT} `, audio: whole });
		expect(plan?.quality_mode).toBe("aligned");
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe("https://gw.example/v1/studio/speech-plan?wait=true");
		expect((init.headers as Record<string, string>)["X-AnyLLM-Key"]).toBe(
			"Bearer key-1",
		);
		const body = JSON.parse(String(init.body));
		expect(body.source.kind).toBe("shell_audio");
		expect(body.source.audio_base64).toBe(audioBase64);
		expect(body.text).toBe(TEXT);
	});

	it("logs one safe result line with reason, elapsed time and only the audio hash prefix", async () => {
		const debug = vi.spyOn(Logger, "debug").mockImplementation(() => {});
		const { get } = source({ plan: alignedPlan() });
		expect(await get({ text: "private sentence", audio: whole })).toBeNull();
		expect(debug).toHaveBeenCalledTimes(1);
		expect(debug).toHaveBeenCalledWith(
			"GatewayAlignedPlan",
			"aligned plan unavailable",
			expect.objectContaining({
				result: "null",
				reason: "no_hangul",
				elapsedMs: expect.any(Number),
				sha: sha.slice(0, 8),
				textLength: "private sentence".length,
			}),
		);
		const serializedLogs = JSON.stringify(debug.mock.calls);
		expect(serializedLogs).not.toContain("private sentence");
		expect(serializedLogs).not.toContain(sha);
		expect(serializedLogs).not.toContain("key-1");
	});

	it.each([
		[
			"another sound",
			{ audio: { sha256: "0".repeat(64), duration_us: 500_000 } },
		],
		["another sentence", { text: "다른 문장." }],
		["a browser-timed plan", { quality_mode: "browser-timed" }],
		["an approximate plan", { quality_mode: "approximate" }],
		[
			"another length",
			{
				audio: { sha256: sha, duration_us: 900_000 },
				events: [{ unit: "sil", start_us: 0, end_us: 900_000 }],
			},
		],
	])("refuses %s", async (_name, overrides) => {
		const { get } = source({ plan: alignedPlan(overrides) });
		expect(await get({ text: TEXT, audio: whole })).toBeNull();
	});

	it("gateway failure leaves the avatar idle", async () => {
		const { get } = source({ detail: "x" }, 503);
		expect(await get({ text: TEXT, audio: whole })).toBeNull();
	});

	it("does not call the gateway for non-Korean text, streams, non-WAV, or no login", async () => {
		const { get, fetchImpl } = source({ plan: alignedPlan() });
		expect(await get({ text: "hello", audio: whole })).toBeNull();
		expect(
			await get({
				text: TEXT,
				audio: { kind: "pcm-stream", stream: {} as never },
			}),
		).toBeNull();
		expect(
			await get({
				text: TEXT,
				audio: {
					kind: "whole",
					audioBase64: "SUQzAAAA",
					durationSeconds: null,
				},
			}),
		).toBeNull();
		const noKey = createGatewayAlignedPlanSource({
			getConfig: () => ({ gatewayUrl: "https://gw.example" }),
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(await noKey({ text: TEXT, audio: whole })).toBeNull();
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

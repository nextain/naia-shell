/**
 * Tests for ref-audio-api error mapping — focus on W5 매진 (sold-out) UX.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config", () => ({
	LAB_GATEWAY_URL: "https://gateway.test",
	getNaiaKeySecure: vi.fn().mockResolvedValue("gw-test-key"),
}));

vi.mock("../ref-audio", () => ({
	encodeRefAudio: vi.fn().mockResolvedValue("UklGRiQAAABXQVZF"),
	RefAudioEncodeError: class extends Error {},
}));

vi.mock("../../logger", () => ({
	Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	RefAudioApiError,
	applyRefAudioPreset,
	getRefAudioContent,
	getRefAudioPresets,
	getRefAudioStatus,
	uploadRefAudio,
} from "../ref-audio-api";

const originalFetch = globalThis.fetch;

describe("ref-audio-api error mapping (W5 매진 UX 포함)", () => {
	const mockFetch = vi.fn();

	beforeEach(() => {
		globalThis.fetch = mockFetch as unknown as typeof fetch;
		mockFetch.mockReset();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("503 + error=sold-out → 'sold-out' code (gateway 매진)", async () => {
		mockFetch.mockResolvedValue(
			new Response(JSON.stringify({ error: "sold-out" }), { status: 503 }),
		);
		await expect(
			uploadRefAudio(new Blob([new Uint8Array([1, 2, 3])])),
		).rejects.toMatchObject({ code: "sold-out", status: 503 });
	});

	it("503 (다른 backend overload) → 'sold-out' code (UX 동등 처리)", async () => {
		mockFetch.mockResolvedValue(
			new Response("Service Unavailable", { status: 503 }),
		);
		await expect(
			uploadRefAudio(new Blob([new Uint8Array([1, 2, 3])])),
		).rejects.toMatchObject({ code: "sold-out" });
	});

	it("402 → 'credit-insufficient' (기존 회귀 X)", async () => {
		mockFetch.mockResolvedValue(
			new Response(JSON.stringify({ error: "credit-insufficient" }), {
				status: 402,
			}),
		);
		await expect(
			uploadRefAudio(new Blob([new Uint8Array([1, 2, 3])])),
		).rejects.toMatchObject({ code: "credit-insufficient" });
	});

	it("getRefAudioStatus 503 → 'sold-out' (read-only path 매진)", async () => {
		mockFetch.mockResolvedValue(
			new Response(JSON.stringify({ error: "sold-out" }), { status: 503 }),
		);
		await expect(getRefAudioStatus()).rejects.toMatchObject({
			code: "sold-out",
			status: 503,
		});
	});

	it("RefAudioApiError 인스턴스 + detail body 보존", async () => {
		mockFetch.mockResolvedValue(
			new Response(
				JSON.stringify({ error: "sold-out", retry_after_seconds: 90 }),
				{ status: 503 },
			),
		);
		try {
			await uploadRefAudio(new Blob([new Uint8Array([1])]));
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(RefAudioApiError);
			const apiErr = err as RefAudioApiError;
			expect(apiErr.code).toBe("sold-out");
			expect(apiErr.detail.retry_after_seconds).toBe(90);
		}
	});
});

// ── REF-AUDIO-PRESET-CONTRACT §6.1 (P1-P7) ──
describe("ref-audio preset (CONTRACT P1-P7)", () => {
	const mockFetch = vi.fn();

	beforeEach(() => {
		globalThis.fetch = mockFetch as unknown as typeof fetch;
		mockFetch.mockReset();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	const SAMPLE_PRESET = {
		id: "aihub-10-female-30s-01",
		name: "여성 30대 (차분)",
		locale: "ko",
		gender: "female",
		age_range: "30s",
		duration_seconds: 8.2,
		sample_url: "https://storage.googleapis.com/x/female-30s-01.wav",
		sample_format: "wav",
		source: "aihub-10",
		license: "research-internal",
	};

	it("P1: preset list fetch → maps snake_case to camelCase", async () => {
		mockFetch.mockResolvedValue(
			new Response(
				JSON.stringify({ presets: [SAMPLE_PRESET], total: 1 }),
				{ status: 200 },
			),
		);
		const list = await getRefAudioPresets();
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({
			id: "aihub-10-female-30s-01",
			ageRange: "30s",
			sampleUrl: "https://storage.googleapis.com/x/female-30s-01.wav",
			durationSeconds: 8.2,
		});
	});

	it("P1b: presets without id/sample_url are filtered out", async () => {
		mockFetch.mockResolvedValue(
			new Response(
				JSON.stringify({
					presets: [SAMPLE_PRESET, { name: "broken" }],
					total: 2,
				}),
				{ status: 200 },
			),
		);
		const list = await getRefAudioPresets();
		expect(list).toHaveLength(1);
	});

	it("P4: preset 적용 성공 → {presetId, name, appliedAt}", async () => {
		mockFetch.mockResolvedValue(
			new Response(
				JSON.stringify({
					active: {
						kind: "preset",
						preset_id: "aihub-10-female-30s-01",
						name: "여성 30대 (차분)",
						applied_at: "2026-05-29T15:32:11Z",
					},
				}),
				{ status: 200 },
			),
		);
		const r = await applyRefAudioPreset("aihub-10-female-30s-01");
		expect(r.presetId).toBe("aihub-10-female-30s-01");
		expect(r.appliedAt).toBe("2026-05-29T15:32:11Z");
	});

	it("P5: preset 미존재 → 'preset-not-found' (404)", async () => {
		mockFetch.mockResolvedValue(
			new Response(
				JSON.stringify({ error: "preset-not-found", preset_id: "nope" }),
				{ status: 404 },
			),
		);
		await expect(applyRefAudioPreset("nope")).rejects.toMatchObject({
			code: "preset-not-found",
			status: 404,
		});
	});

	it("P6: 인증 실패 → 'unauthenticated' (401)", async () => {
		mockFetch.mockResolvedValue(
			new Response(JSON.stringify({ error: "auth" }), { status: 401 }),
		);
		await expect(applyRefAudioPreset("x")).rejects.toMatchObject({
			code: "unauthenticated",
		});
	});

	it("P7: GET /v1/ref-audio with kind=preset → active.kind preserved", async () => {
		mockFetch.mockResolvedValue(
			new Response(
				JSON.stringify({
					active: {
						kind: "preset",
						preset_id: "aihub-10-female-30s-01",
						preset_name: "여성 30대 (차분)",
						duration_seconds: 8.2,
					},
					history_count: 1,
				}),
				{ status: 200 },
			),
		);
		const status = await getRefAudioStatus();
		expect(status.active?.kind).toBe("preset");
		expect(status.active?.presetId).toBe("aihub-10-female-30s-01");
		expect(status.active?.presetName).toBe("여성 30대 (차분)");
	});

	it("backward compat: no kind + uploaded_at → kind='upload'", async () => {
		mockFetch.mockResolvedValue(
			new Response(
				JSON.stringify({
					active: {
						uploaded_at: "2026-05-29T10:00:00Z",
						size_bytes: 12345,
						duration_seconds: 7.5,
					},
				}),
				{ status: 200 },
			),
		);
		const status = await getRefAudioStatus();
		expect(status.active?.kind).toBe("upload");
		expect(status.active?.durationSeconds).toBe(7.5);
	});

	it("preset list network error → 'network' code", async () => {
		mockFetch.mockRejectedValue(new Error("offline"));
		await expect(getRefAudioPresets()).rejects.toMatchObject({
			code: "network",
		});
	});
});

// ── getRefAudioContent (in-app preview transport) ──
describe("getRefAudioContent (upload preview)", () => {
	const mockFetch = vi.fn();

	beforeEach(() => {
		globalThis.fetch = mockFetch as unknown as typeof fetch;
		mockFetch.mockReset();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("200 → WAV blob, GET content with Bearer Authorization", async () => {
		mockFetch.mockResolvedValue(
			new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }), {
				status: 200,
			}),
		);
		const blob = await getRefAudioContent();
		expect(blob).toBeInstanceOf(Blob);
		const [url, init] = mockFetch.mock.calls[0];
		expect(url).toBe("https://gateway.test/v1/ref-audio/content");
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bearer gw-test-key",
		);
	});

	it("404 no-active-ref → 'no-active-ref' code (preset has no GCS blob)", async () => {
		mockFetch.mockResolvedValue(
			new Response(JSON.stringify({ error: "no-active-ref" }), { status: 404 }),
		);
		await expect(getRefAudioContent()).rejects.toMatchObject({
			code: "no-active-ref",
			status: 404,
		});
	});

	it("network error → 'network' code", async () => {
		mockFetch.mockRejectedValue(new Error("offline"));
		await expect(getRefAudioContent()).rejects.toMatchObject({
			code: "network",
		});
	});
});

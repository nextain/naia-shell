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

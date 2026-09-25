// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { synthesizeTts } from "../synthesize";
import {
	getVoiceEngineBootGeneration,
	isVoiceWarmingHold,
	resetVoiceEngineBootGenerationForTest,
	setVoiceWarmingHoldForTest,
} from "../warming-hold";

describe("warming-hold and engine-boot-retry separation (새 구멍 1)", () => {
	beforeEach(() => {
		resetVoiceEngineBootGenerationForTest();
		setVoiceWarmingHoldForTest(false);
	});

	it("naia:voice-model-preparing changes warming state but does NOT bump engineBootGeneration", () => {
		const initialGen = getVoiceEngineBootGeneration();
		window.dispatchEvent(
			new CustomEvent("naia:voice-model-preparing", { detail: true }),
		);
		expect(isVoiceWarmingHold()).toBe(true);
		expect(getVoiceEngineBootGeneration()).toBe(initialGen);

		window.dispatchEvent(
			new CustomEvent("naia:voice-model-preparing", { detail: false }),
		);
		expect(isVoiceWarmingHold()).toBe(false);
		expect(getVoiceEngineBootGeneration()).toBe(initialGen);
	});

	it("naia:voice-engine-boot-retry bumps engineBootGeneration", () => {
		const initialGen = getVoiceEngineBootGeneration();
		window.dispatchEvent(new CustomEvent("naia:voice-engine-boot-retry"));
		expect(getVoiceEngineBootGeneration()).toBe(initialGen + 1);
		window.dispatchEvent(new CustomEvent("naia:voice-engine-boot-retry"));
		expect(getVoiceEngineBootGeneration()).toBe(initialGen + 2);
	});

	it("synthesizeTts dispatches naia:voice-engine-boot-retry on loopback connection retry", async () => {
		vi.useFakeTimers();
		const initialGen = getVoiceEngineBootGeneration();
		const preparingEvents: boolean[] = [];
		let retryEvents = 0;
		const onPreparing = (e: Event) =>
			preparingEvents.push(!!(e as CustomEvent<boolean>).detail);
		const onRetry = () => {
			retryEvents++;
		};
		window.addEventListener("naia:voice-model-preparing", onPreparing);
		window.addEventListener("naia:voice-engine-boot-retry", onRetry);

		const wavBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00]);
		const wavResponse = () => ({
			ok: true,
			status: 200,
			headers: new Headers({ "content-type": "audio/wav" }),
			json: async () => ({}),
			text: async () => "",
			arrayBuffer: async () => wavBytes.buffer.slice(0),
		});

		try {
			const fetchMock = vi
				.fn()
				.mockRejectedValueOnce(new TypeError("Failed to fetch"))
				.mockResolvedValueOnce(wavResponse());
			vi.stubGlobal("fetch", fetchMock);

			const synthPromise = synthesizeTts({
				text: "test loopback retry",
				provider: "naia-local-voice",
				vllmTtsHost: "http://127.0.0.1:8910",
			});
			await vi.advanceTimersByTimeAsync(1_000);
			await synthPromise;

			expect(retryEvents).toBe(1);
			expect(preparingEvents).toContain(true);
			expect(getVoiceEngineBootGeneration()).toBe(initialGen + 1);
		} finally {
			window.removeEventListener("naia:voice-model-preparing", onPreparing);
			window.removeEventListener("naia:voice-engine-boot-retry", onRetry);
			vi.useRealTimers();
		}
	});
});

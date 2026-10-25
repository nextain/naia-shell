import { describe, expect, it } from "vitest";
import {
	liveVoiceRequiresNaiaKey,
	resolveLiveProvider,
} from "../resolve-live-provider";

describe("resolveLiveProvider (#603)", () => {
	it("routes azure-realtime omni to azure-voice-live", () => {
		expect(
			resolveLiveProvider({
				isOmni: true,
				provider: "nextain",
				model: "azure-realtime",
				hasNaiaKey: true,
			}),
		).toBe("azure-voice-live");
	});

	it("maps retired gemini live models to azure-voice-live", () => {
		expect(
			resolveLiveProvider({
				isOmni: true,
				provider: "nextain",
				model: "gemini-2.5-flash-live",
				hasNaiaKey: true,
			}),
		).toBe("azure-voice-live");
	});

	it("does not send azure-realtime to a removed Gemini live path", () => {
		expect(
			resolveLiveProvider({
				isOmni: true,
				provider: "nextain",
				model: "azure-realtime",
				hasNaiaKey: true,
			}),
		).toBe("azure-voice-live");
	});

	it("routes local vllm to vllm-omni", () => {
		expect(
			resolveLiveProvider({
				isOmni: false,
				provider: "vllm",
				hasNaiaKey: false,
			}),
		).toBe("vllm-omni");
	});
});

describe("liveVoiceRequiresNaiaKey", () => {
	it("requires the Naia key for Azure Voice Live", () => {
		expect(
			liveVoiceRequiresNaiaKey({
				liveProvider: "azure-voice-live",
				provider: "nextain",
			}),
		).toBe(true);
	});

	it("requires the Naia key for the cloud naia-omni gateway", () => {
		expect(
			liveVoiceRequiresNaiaKey({
				liveProvider: "naia-omni",
				provider: "nextain",
			}),
		).toBe(true);
	});

	it("keeps a user's own vLLM omni server keyless (FR-VOICE-CLOUD-OFF.1)", () => {
		const liveProvider = resolveLiveProvider({
			isOmni: true,
			provider: "vllm",
			model: "naia-0.9-omni-24g",
			hasNaiaKey: false,
		});
		expect(liveProvider).toBe("naia-omni");
		expect(liveVoiceRequiresNaiaKey({ liveProvider, provider: "vllm" })).toBe(
			false,
		);
	});

	it("does not gate the vllm-omni route", () => {
		expect(
			liveVoiceRequiresNaiaKey({ liveProvider: "vllm-omni", provider: "vllm" }),
		).toBe(false);
	});
});

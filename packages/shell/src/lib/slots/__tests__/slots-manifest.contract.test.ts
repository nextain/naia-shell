import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../config";
import {
	buildSlotsManifest,
	parseSlotsManifest,
	serializeSlotsManifest,
	SLOTS_MANIFEST_VERSION,
} from "../manifest";

/**
 * Phase 2 — slots-manifest 계약(§5.2.1/2.2). naia-os write ↔ windows-manager read.
 * AppConfig → 구조화 매니페스트(비밀 0). wm 이 로컬 서비스 구동 결정의 입력.
 */
const naiaConfig: AppConfig = {
	provider: "nextain",
	model: "gemini-3.5-flash",
	naiaKey: "nk",
	memoryLlmProvider: "naia",
	memoryLlmModel: "gemini-3.1-flash-lite",
	memoryEmbeddingProvider: "offline",
	memoryOfflineModel: "all-MiniLM-L6-v2",
	sttProvider: "vosk",
	ttsProvider: "nextain",
	naiaLocalUrl: "ws://127.0.0.1:8892",
	localGpuTier: "auto",
} as AppConfig;

describe("slots-manifest · 빌드(AppConfig → 매니페스트)", () => {
	it("version=1 고정 + gate(naiaAccount/mode) 파생", () => {
		const m = buildSlotsManifest(naiaConfig);
		expect(m.version).toBe(SLOTS_MANIFEST_VERSION);
		expect(m.gate).toEqual({ naiaAccount: true, mode: "naia" });
	});

	it("6 슬롯 값 포함(main/sub/embedding/stt/tts/avatar)", () => {
		const m = buildSlotsManifest(naiaConfig);
		expect(m.slots.main).toEqual({ provider: "nextain", model: "gemini-3.5-flash" });
		expect(m.slots.sub).toEqual({ provider: "naia", model: "gemini-3.1-flash-lite" });
		expect(m.slots.embedding).toEqual({ provider: "offline", model: "all-MiniLM-L6-v2" });
		expect(m.slots.stt).toEqual({ provider: "vosk" });
		expect(m.slots.tts).toEqual({ provider: "nextain" });
		expect(m.slots.avatar.localUrl).toBe("ws://127.0.0.1:8892");
	});

	it("비밀(naiaKey/apiKey) 절대 미포함 — wm 으로 새는 비밀 누수 0", () => {
		const m = buildSlotsManifest(naiaConfig);
		const json = serializeSlotsManifest(m);
		expect(json).not.toContain("nk");
		expect(json).not.toContain("naiaKey");
		expect(json).not.toContain("apiKey");
	});

	it("byo 게이트 = mode 'byo'(naiaKey 부재)", () => {
		const m = buildSlotsManifest({ provider: "gemini", model: "gpt-4o" } as AppConfig);
		expect(m.gate).toEqual({ naiaAccount: false, mode: "byo" });
	});

	it("GPU 정보 옵션(detectedVramGb/tier)", () => {
		const m = buildSlotsManifest(naiaConfig, { detectedVramGb: 24 });
		expect(m.gpu.detectedVramGb).toBe(24);
		// ★"auto" 는 해석된 tier id 로 기록 — wm loader(EXCLUSIVE_8G_TIERS) 가 매칭해야
		// avatar_ditto_trt 를 선택. "auto" 를 그대로 쓰면 loader 가 avatar 를 안 띄움(캐릭터 미표시).
		expect(m.gpu.tier).toBe("full-realtime-24g");
	});

	it("★auto tier 해석 — 8GB → local-llm-avatar-8g(wm loader 가 avatar 매칭)", () => {
		const m = buildSlotsManifest(naiaConfig, { detectedVramGb: 8 });
		expect(m.gpu.tier).toBe("local-llm-avatar-8g");
	});

	it("★auto tier — VRAM 미검출 시 tier 생략(loader 가 --gpu 로 폴백)", () => {
		const m = buildSlotsManifest(naiaConfig);
		expect(m.gpu.tier).toBeUndefined();
	});

	it("★명시 tier id 는 정규화(구 id 호환) 후 기록", () => {
		const m = buildSlotsManifest(
			// 레거시 저장값(구 티어 id)은 loadConfig 로만 들어옴 — 타입엔 없어 unknown 경유 캐스트.
			{ ...naiaConfig, localGpuTier: "avatar-or-voice-8g" } as unknown as AppConfig,
			{ detectedVramGb: 8 },
		);
		expect(m.gpu.tier).toBe("local-llm-avatar-8g");
	});
});

describe("slots-manifest · 파스/검증(fail-closed)", () => {
	it("유효 매니페스트 round-trip(build → serialize → parse)", () => {
		const m = buildSlotsManifest(naiaConfig);
		const parsed = parseSlotsManifest(JSON.parse(serializeSlotsManifest(m)));
		expect(parsed).toEqual(m);
	});

	it("version 불일치 = null(미래/과거 매니페스트 안전하게 거부)", () => {
		expect(parseSlotsManifest({ version: 2, slots: {}, gate: {} })).toBeNull();
		expect(parseSlotsManifest({ version: 0, slots: {}, gate: {} })).toBeNull();
	});

	it("비객체/null/구조 누락 = null", () => {
		expect(parseSlotsManifest(null)).toBeNull();
		expect(parseSlotsManifest("x")).toBeNull();
		expect(parseSlotsManifest({ version: 1 })).toBeNull(); // slots/gate 누락
	});
});

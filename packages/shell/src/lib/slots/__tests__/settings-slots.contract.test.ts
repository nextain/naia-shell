import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../config";
import {
	applyNaiaSlotDefaults,
	deriveGate,
	deriveGateFromConfig,
	NAIA_SLOT_DEFAULTS,
	readSlots,
	SLOT_FIELD_MAP,
	SLOT_GROUPS,
	SLOT_IDS,
	writeSlot,
	type GateMode,
	type SlotId,
} from "../model";

/**
 * S-SLOT 계약 테스트 — FR-SLOT.1~5 (docs/requirements.md), R1/R2 정정 반영.
 * 순수 모델(I/O 0): 게이트 파생·6슬롯 독립·Gemini 기본값·필드명 유지.
 * SoT: .agents/progress/naia-model-slots-architecture-2026-06-28.md
 */
describe("S-SLOT · FR-SLOT.1 게이트 파생 (binary, naiaKey, GPU 무관)", () => {
	it("naiaKey 존재 = naia 게이트(크레딧 접근)", () => {
		expect(deriveGate(true)).toBe<"naia">("naia");
	});

	it("naiaKey 부재 = byo 게이트", () => {
		expect(deriveGate(false)).toBe<"byo">("byo");
	});

	it("게이트 파생은 naiaKey 에만 의존 — detectGpuVramGb/localGpuTier 무관 (R1-3)", () => {
		// GPU 없는 naia 계정도 naia 게이트. GPU 있는 비계정도 byo.
		expect(deriveGateFromConfig({ naiaKey: "nk" } as AppConfig)).toBe("naia");
		expect(
			deriveGateFromConfig({
				naiaKey: "nk",
				localGpuTier: "off",
			} as AppConfig),
		).toBe("naia");
		expect(
			deriveGateFromConfig({ localGpuTier: "full-local-24g" } as AppConfig),
		).toBe("byo");
	});

	it("null config = byo (게이트 미충족)", () => {
		expect(deriveGateFromConfig(null)).toBe("byo");
	});

	it("GateMode = naia | byo (3-profile 잔재 아님)", () => {
		const g: GateMode = deriveGate(true);
		expect(["naia", "byo"]).toContain(g);
	});
});

describe("S-SLOT · FR-SLOT.2 6슬롯 + 3그룹 구조 (각각 독립 설정)", () => {
	it("SLOT_IDS = main·sub·embedding·stt·tts·avatar (6개, 순서 권위)", () => {
		expect(SLOT_IDS).toEqual([
			"main",
			"sub",
			"embedding",
			"stt",
			"tts",
			"avatar",
		]);
	});

	it("SLOT_GROUPS = Brain[main,sub,embed]·Voice[stt,tts]·Avatar[avatar] (R1-5)", () => {
		const groups = SLOT_GROUPS.map((g) => [g.id, g.slots]);
		expect(groups).toEqual([
			["brain", ["main", "sub", "embedding"]],
			["voice", ["stt", "tts"]],
			["avatar", ["avatar"]],
		]);
	});

	it("3그룹은 6슬롯을 중복·누락 없이 완전 분할", () => {
		const covered = SLOT_GROUPS.flatMap((g) => g.slots);
		expect(covered.sort()).toEqual([...SLOT_IDS].sort());
		const uniq = new Set(covered);
		expect(uniq.size).toBe(covered.length); // 중복 0
	});

	it("writeSlot 은 해당 슬롯만 변경 — 타 슬롯 무관 (독립성)", () => {
		const base: AppConfig = {
			provider: "gemini",
			model: "gemini-3.5-flash",
			apiKey: "k",
			naiaKey: "nk",
			memoryLlmProvider: "naia",
			memoryLlmModel: "gemini-3.1-flash-lite",
			memoryEmbeddingProvider: "offline",
			memoryOfflineModel: "all-MiniLM-L6-v2",
			sttProvider: "vosk",
			ttsProvider: "nextain",
		} as AppConfig;

		// main 만 바꿔도 sub/embed/stt/tts 불변
		const after = writeSlot(base, "main", { provider: "ollama", model: "llama3" });
		expect(after.provider).toBe("ollama");
		expect(after.model).toBe("llama3");
		expect(after.memoryLlmProvider).toBe("naia"); // sub 불변
		expect(after.memoryLlmModel).toBe("gemini-3.1-flash-lite");
		expect(after.memoryEmbeddingProvider).toBe("offline"); // embed 불변
		expect(after.sttProvider).toBe("vosk"); // stt 불변
		expect(after.ttsProvider).toBe("nextain"); // tts 불변

		// stt 만 바꿔도 main 불변
		const after2 = writeSlot(base, "stt", { provider: "whisper" });
		expect(after2.sttProvider).toBe("whisper");
		expect(after2.provider).toBe("gemini"); // main 불변
		expect(after2.model).toBe("gemini-3.5-flash");
	});

	it("readSlots 는 6슬롯 전체 스냅샷 반환", () => {
		const cfg: AppConfig = {
			provider: "nextain",
			model: "gemini-3.5-flash",
			memoryLlmProvider: "naia",
			memoryLlmModel: "gemini-3.1-flash-lite",
			memoryEmbeddingProvider: "offline",
			memoryOfflineModel: "all-MiniLM-L6-v2",
			sttProvider: "vosk",
			ttsProvider: "nextain",
		} as AppConfig;
		const snap = readSlots(cfg);
		expect(snap.main).toEqual({ provider: "nextain", model: "gemini-3.5-flash" });
		expect(snap.sub).toEqual({ provider: "naia", model: "gemini-3.1-flash-lite" });
		expect(snap.embedding).toEqual({ provider: "offline", model: "all-MiniLM-L6-v2" });
		expect(snap.stt).toEqual({ provider: "vosk" });
		expect(snap.tts).toEqual({ provider: "nextain" });
	});
});

describe("S-SLOT · FR-SLOT.5 필드명 유지 (memoryLlmProvider, rename 아님)", () => {
	it("sub 슬롯 config 키 = memoryLlmProvider/memoryLlmModel (R1-1, Phase 3.4 dual-write 전까지 유지)", () => {
		expect(SLOT_FIELD_MAP.sub).toEqual([
			"memoryLlmProvider",
			"memoryLlmModel",
		]);
	});

	it("embedding 슬롯 config 키 = memoryEmbeddingProvider/memoryOfflineModel|memoryEmbeddingModel", () => {
		expect(SLOT_FIELD_MAP.embedding).toContain("memoryEmbeddingProvider");
	});

	it("writeSlot(sub) 가 subLlmProvider(신규명) 가 아닌 memoryLlmProvider 에 기록", () => {
		const cfg = {} as AppConfig;
		const after = writeSlot(cfg, "sub", { provider: "ollama", model: "llama3" });
		expect((after as unknown as Record<string, unknown>).memoryLlmProvider).toBe("ollama");
		expect((after as unknown as Record<string, unknown>).memoryLlmModel).toBe("llama3");
		expect((after as unknown as Record<string, unknown>).subLlmProvider).toBeUndefined();
	});
});

describe("S-SLOT · FR-SLOT.3 naia 계정 Gemini 기본값 자동 적용 (R2-1, §9 #5 해결)", () => {
	it("NAIA_SLOT_DEFAULTS main = nextain / gemini-3.5-flash (실존 모델, §9 #5)", () => {
		expect(NAIA_SLOT_DEFAULTS.main).toEqual({
			provider: "nextain",
			model: "gemini-3.5-flash",
		});
		// stale hardcode gemini-2.5-flash 회귀 금지
		expect(NAIA_SLOT_DEFAULTS.main.model).not.toBe("gemini-2.5-flash");
	});

	it("NAIA_SLOT_DEFAULTS sub = naia / gemini-3.1-flash-lite", () => {
		expect(NAIA_SLOT_DEFAULTS.sub).toEqual({
			provider: "naia",
			model: "gemini-3.1-flash-lite",
		});
	});

	it("NAIA_SLOT_DEFAULTS embedding = CPU offline / all-MiniLM-L6-v2 (R2-1)", () => {
		expect(NAIA_SLOT_DEFAULTS.embedding).toEqual({
			provider: "offline",
			model: "all-MiniLM-L6-v2",
		});
	});

	it("NAIA_SLOT_DEFAULTS stt = 무료 오프라인 (Naia Voice)", () => {
		// vosk/whisper 둘 다 오프라인 무료 — wire 값 보존(R1-2), 라벨만 Naia Voice.
		expect(["vosk", "whisper"]).toContain(NAIA_SLOT_DEFAULTS.stt.provider);
	});

	it("NAIA_SLOT_DEFAULTS tts = naia 클라우드(Gemini TTS 경로)", () => {
		expect(NAIA_SLOT_DEFAULTS.tts.provider).toBe("nextain");
	});

	it("applyNaiaSlotDefaults 는 미설정 슬롯에만 기본값 적용 — 사용자 override 보존", () => {
		// 빈 config → 전 슬롯 기본값
		const filled = applyNaiaSlotDefaults({} as AppConfig);
		expect(filled.provider).toBe("nextain");
		expect(filled.model).toBe("gemini-3.5-flash");
		expect(filled.memoryLlmProvider).toBe("naia");
		expect(filled.memoryLlmModel).toBe("gemini-3.1-flash-lite");
		expect(filled.memoryEmbeddingProvider).toBe("offline");
		expect(filled.memoryOfflineModel).toBe("all-MiniLM-L6-v2");
		expect(filled.sttProvider).toBe(NAIA_SLOT_DEFAULTS.stt.provider);
		expect(filled.ttsProvider).toBe("nextain");
	});

	it("applyNaiaSlotDefaults 는 사용자가 이미 설정한 슬롯을 덮어쓰지 않음 (idempotent·비파괴)", () => {
		const userSet: AppConfig = {
			provider: "ollama",
			model: "llama3",
			memoryLlmProvider: "ollama",
			sttProvider: "whisper",
		} as AppConfig;
		const after = applyNaiaSlotDefaults(userSet);
		expect(after.provider).toBe("ollama"); // 보존
		expect(after.model).toBe("llama3"); // 보존
		expect(after.memoryLlmProvider).toBe("ollama"); // 보존
		expect(after.sttProvider).toBe("whisper"); // 보존
		// 설정 안 한 슬롯은 기본값
		expect(after.memoryEmbeddingProvider).toBe("offline");
		expect(after.ttsProvider).toBe("nextain");
	});

	it("applyNaiaSlotDefaults 는 게이트 무관 호출 가능 — 게이트 통과 지점에서 호출(1.3)", () => {
		// 순수 함수: 게이트 판단은 호출처 책임. 여기는 비파괴 기본값 적용만 검증.
		const a = applyNaiaSlotDefaults({} as AppConfig);
		const b = applyNaiaSlotDefaults(a); // 두 번째 적용 = 무변화(idempotent)
		expect(b).toEqual(a);
	});
});

describe("S-SLOT · 슬롯 ID·그룹 불변식", () => {
	it("SlotId = 6값 고정", () => {
		const ids: SlotId[] = ["main", "sub", "embedding", "stt", "tts", "avatar"];
		expect(ids).toHaveLength(6);
	});

	it("각 슬롯은 정확히 한 그룹에 속함", () => {
		for (const id of SLOT_IDS) {
			const owners = SLOT_GROUPS.filter((g) => g.slots.includes(id));
			expect(owners).toHaveLength(1);
		}
	});
});

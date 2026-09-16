import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../config";
import {
	type GateMode,
	NAIA_SLOT_DEFAULTS,
	SLOT_FIELD_MAP,
	SLOT_GROUPS,
	SLOT_IDS,
	type SlotId,
	applyNaiaSlotDefaults,
	deriveGate,
	deriveGateFromConfig,
	effectiveMainRole,
	effectiveTtsProvider,
	readSlots,
	writeSlot,
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
			deriveGateFromConfig({ localGpuTier: "full-realtime-24g" } as AppConfig),
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
			subLlmProvider: "naia",
			subLlmModel: "gemini-3.1-flash-lite",
			memoryLlmProvider: "ollama",
			memoryLlmModel: "memory-model",
			memoryEmbeddingProvider: "offline",
			memoryOfflineModel: "all-MiniLM-L6-v2",
			sttProvider: "vosk",
			ttsProvider: "nextain",
		} as AppConfig;

		// main 만 바꿔도 sub/embed/stt/tts 불변
		const after = writeSlot(base, "main", {
			provider: "ollama",
			model: "llama3",
		});
		expect(after.provider).toBe("ollama");
		expect(after.model).toBe("llama3");
		expect(after.subLlmProvider).toBe("naia"); // sub 불변
		expect(after.subLlmModel).toBe("gemini-3.1-flash-lite");
		expect(after.memoryLlmProvider).toBe("ollama"); // memory 불변
		expect(after.memoryLlmModel).toBe("memory-model");
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
			subLlmProvider: "naia",
			subLlmModel: "gemini-3.1-flash-lite",
			memoryLlmProvider: "ollama",
			memoryLlmModel: "memory-model",
			memoryEmbeddingProvider: "offline",
			memoryOfflineModel: "all-MiniLM-L6-v2",
			sttProvider: "vosk",
			ttsProvider: "nextain",
		} as AppConfig;
		const snap = readSlots(cfg);
		expect(snap.main).toEqual({
			provider: "nextain",
			model: "gemini-3.5-flash",
		});
		expect(snap.sub).toEqual({
			provider: "naia",
			model: "gemini-3.1-flash-lite",
		});
		expect(snap.embedding).toEqual({
			provider: "offline",
			model: "all-MiniLM-L6-v2",
		});
		expect(snap.stt).toEqual({ provider: "vosk" });
		expect(snap.tts).toEqual({ provider: "nextain" });
	});

	it("readSlots keeps GPU-free NVA selected while logged out", () => {
		const snap = readSlots({
			provider: "nextain",
			model: "gemini-3.5-flash",
			apiKey: "",
			avatarProvider: "naia-video-avatar",
			nvaModel: "remote-avatar.nva",
			liveProvider: "edge-tts",
			liveModel: "fallback.vrm",
			localGpuTier: "auto",
			naiaKey: "",
		} as AppConfig);

		expect(snap.avatar).toEqual({
			provider: "naia-video-avatar",
			model: "remote-avatar.nva",
			voiceRefUrl: undefined,
		});
	});
});

describe("S-SLOT · FR-SLOT.5 sub/memory SoT separation", () => {
	it("sub 슬롯 config 키 = subLlmProvider/subLlmModel", () => {
		expect(SLOT_FIELD_MAP.sub).toEqual(["subLlmProvider", "subLlmModel"]);
	});

	it("embedding 슬롯 config 키 = memoryEmbeddingProvider/memoryOfflineModel|memoryEmbeddingModel", () => {
		expect(SLOT_FIELD_MAP.embedding).toContain("memoryEmbeddingProvider");
	});

	it("writeSlot(sub) 가 structured role과 subLlm mirror만 갱신", () => {
		const cfg = {
			memoryLlmProvider: "vllm",
			memoryLlmModel: "memory-model",
		} as AppConfig;
		const after = writeSlot(cfg, "sub", {
			provider: "ollama",
			model: "llama3",
		});
		expect(after.llmRoles?.sub).toEqual({
			provider: "ollama",
			model: "llama3",
			inherit: undefined,
		});
		expect(after.subLlmProvider).toBe("ollama");
		expect(after.subLlmModel).toBe("llama3");
		expect(after.memoryLlmProvider).toBe("vllm");
		expect(after.memoryLlmModel).toBe("memory-model");
	});

	it("readSlots 는 structured sub를 memory legacy mirror보다 우선", () => {
		const snap = readSlots({
			provider: "nextain",
			model: "gemini-3.5-flash",
			apiKey: "",
			llmRoles: {
				sub: { provider: "gemini", model: "sub-model" },
				memory: { provider: "ollama", model: "memory-model" },
			},
			memoryLlmProvider: "ollama",
			memoryLlmModel: "memory-model",
		});
		expect(snap.sub).toEqual({ provider: "gemini", model: "sub-model" });
	});
});

describe("S-SLOT · FR-SLOT.3 naia 계정 Gemini 기본값 자동 적용 (R2-1, §9 #5 해결)", () => {
	it("NAIA_SLOT_DEFAULTS main = nextain / deepseek-v4-flash (2026-08-08 기본모델 변경)", () => {
		expect(NAIA_SLOT_DEFAULTS.main).toEqual({
			provider: "nextain",
			model: "deepseek-v4-flash",
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

	it("NAIA_SLOT_DEFAULTS embedding = CPU offline / multilingual-e5-large (한국어 우선, 2026-07-15)", () => {
		expect(NAIA_SLOT_DEFAULTS.embedding).toEqual({
			provider: "offline",
			model: "multilingual-e5-large",
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
		expect(filled.model).toBe("deepseek-v4-flash");
		expect(filled.subLlmProvider).toBe("naia");
		expect(filled.subLlmModel).toBe("gemini-3.1-flash-lite");
		expect(filled.llmRoles?.sub).toMatchObject({
			provider: "naia",
			model: "gemini-3.1-flash-lite",
		});
		expect(filled.memoryLlmProvider).toBeUndefined();
		expect(filled.memoryEmbeddingProvider).toBe("offline");
		// 한국어 우선: 기본 오프라인 임베딩 = 다국어 e5 (2026-07-15 승인)
		expect(filled.memoryOfflineModel).toBe("multilingual-e5-large");
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
		expect(after.memoryLlmProvider).toBe("ollama"); // memory 보존
		expect(after.subLlmProvider).toBe("naia"); // 미설정 sub 기본값
		expect(after.sttProvider).toBe("whisper"); // 보존
		// 설정 안 한 슬롯은 기본값
		expect(after.memoryEmbeddingProvider).toBe("offline");
		expect(after.ttsProvider).toBe("nextain");
	});

	it("repairs an inherited main role from the valid top-level login selection", () => {
		const after = applyNaiaSlotDefaults({
			provider: "nextain",
			model: "deepseek-v4-flash",
			llmRoles: { main: { inherit: "sub" } },
		} as AppConfig);

		expect(after.llmRoles?.main).toEqual({
			provider: "nextain",
			model: "deepseek-v4-flash",
			inherit: undefined,
		});
		expect(after.provider).toBe("nextain");
		expect(after.model).toBe("deepseek-v4-flash");
	});

	it("creates an explicit structured main mirror for legacy top-level config", () => {
		const after = applyNaiaSlotDefaults({
			provider: "ollama",
			model: "llama3",
		} as AppConfig);

		expect(after.llmRoles?.main).toMatchObject({
			provider: "ollama",
			model: "llama3",
		});
		expect(after.llmRoles?.main?.inherit).toBeUndefined();
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

describe("S-EMBKO · FR-SLOT.6 한글 오프라인 임베딩 모델 노출 (2026-07-15)", () => {
	it("offline embedding 슬롯이 다국어(한국어) 모델 multilingual-e5-large 를 수용 — write→read roundtrip", () => {
		const base: AppConfig = {
			memoryEmbeddingProvider: "offline",
			memoryOfflineModel: "all-mpnet-base-v2",
		} as AppConfig;
		// 영어 전용 → 다국어(한국어) 모델로 교체
		const after = writeSlot(base, "embedding", {
			provider: "offline",
			model: "multilingual-e5-large",
		});
		expect(after.memoryOfflineModel).toBe("multilingual-e5-large");
		// readSlots 는 provider=offline 일 때 memoryOfflineModel 을 반환(비-offline 경로 memoryEmbeddingModel 아님)
		expect(readSlots(after).embedding).toEqual({
			provider: "offline",
			model: "multilingual-e5-large",
		});
	});

	it("multilingual 모델 교체는 embedding 슬롯만 변경 — 타 슬롯·device 불변 (독립성)", () => {
		// writeSlot(embedding) 계약: offline 모델은 provider="offline" 을 value 에 함께
		// 전달해야 memoryOfflineModel 로 라우팅됨(model.ts:156 — model만 주면 비-offline
		// 필드 memoryEmbeddingModel 로 감). UI/설정 경로는 provider 를 항상 동반한다.
		const base: AppConfig = {
			provider: "ollama",
			model: "llama3",
			memoryEmbeddingProvider: "offline",
			memoryOfflineModel: "all-MiniLM-L6-v2",
			memoryEmbeddingDevice: "cpu",
		} as AppConfig;
		const after = writeSlot(base, "embedding", {
			provider: "offline",
			model: "multilingual-e5-large",
		});
		expect(after.memoryEmbeddingProvider).toBe("offline"); // offline=CPU 경로 유지
		expect(after.memoryEmbeddingDevice).toBe("cpu"); // device 불변(별도 필드)
		expect(after.memoryOfflineModel).toBe("multilingual-e5-large");
		expect(after.provider).toBe("ollama"); // main 슬롯 불변(독립성)
		expect(after.model).toBe("llama3");
	});

	it("경량 다국어 모델 paraphrase-multilingual-MiniLM-L12-v2 도 offline 슬롯에 수용", () => {
		const after = writeSlot({} as AppConfig, "embedding", {
			provider: "offline",
			model: "paraphrase-multilingual-MiniLM-L12-v2",
		});
		expect(after.memoryEmbeddingProvider).toBe("offline");
		expect(after.memoryOfflineModel).toBe(
			"paraphrase-multilingual-MiniLM-L12-v2",
		);
		expect(readSlots(after).embedding).toEqual({
			provider: "offline",
			model: "paraphrase-multilingual-MiniLM-L12-v2",
		});
	});
});

/**
 * #575 — 프로파일 카드와 설정 탭이 **같은 값**을 말한다.
 *
 * 관측: VOICE 카드가 "TTS 미설정" 인데 바로 아래 드롭다운은 Microsoft Edge TTS 였고,
 * BRAIN 카드는 "— / gemini-3.7-flash" 인데 두뇌 탭은 Naia / DeepSeek V4 Flash 였다.
 * 둘 다 자기 출처로는 옳았다 — 출처가 둘이라 갈렸다. 값을 두 군데서 계산하지 않는다.
 */
describe("#575 · 카드와 탭은 한 출처에서 읽는다", () => {
	it("main 은 llmRoles 가 정본이고 옛 최상위 거울이 아니다", () => {
		// 시딩(#568)은 llmRoles.main 만 쓰고, 화면 하이드레이션이 최상위 provider 를
		// 예전 기본값으로 되쓴다. 카드가 거울을 읽으면 공급자 자리가 대시가 된다.
		const cfg = {
			provider: "",
			model: "gemini-3.7-flash",
			llmRoles: {
				main: { provider: "nextain", model: "deepseek-v4-flash" },
			},
		} as unknown as AppConfig;

		expect(effectiveMainRole(cfg)).toEqual({
			provider: "nextain",
			model: "deepseek-v4-flash",
		});
		// 카드가 그리는 값도 같다.
		expect(readSlots(cfg).main).toEqual({
			provider: "nextain",
			model: "deepseek-v4-flash",
		});
	});

	it("llmRoles 가 없으면 예전처럼 최상위 값을 쓴다", () => {
		const cfg = {
			provider: "nextain",
			model: "gemini-3.5-flash",
		} as unknown as AppConfig;
		expect(readSlots(cfg).main).toEqual({
			provider: "nextain",
			model: "gemini-3.5-flash",
		});
	});

	it("저장된 TTS 공급자가 없어도 카드는 미설정이라 하지 않는다", () => {
		// 기본값이 음성 탭의 useState 에만 있던 동안, 저장된 값이 없으면 카드는
		// 빈 값(→ "미설정")을, 드롭다운은 Edge 를 보여 줬다.
		const cfg = {} as AppConfig;
		expect(effectiveTtsProvider(cfg)).toBe("edge");
		expect(readSlots(cfg).tts.provider).toBe("edge");
		expect(readSlots(cfg).tts.provider).toBe(effectiveTtsProvider(cfg));
	});

	it("옛 ttsEngine 도 같은 규칙으로 푼다", () => {
		expect(effectiveTtsProvider({ ttsEngine: "google" } as unknown as AppConfig)).toBe(
			"google",
		);
		expect(effectiveTtsProvider({ ttsEngine: "gateway" } as AppConfig)).toBe(
			"edge",
		);
	});

	it("음성 탭이 그 기본값을 스스로 다시 적지 않는다", async () => {
		// 규칙이 두 자리에 있으면 한쪽만 고쳐져 다시 갈린다. 탭은 공용 함수를 부르고,
		// 인라인 `"edge"` 폴백을 자기 상태 초기값에 다시 적지 않는다.
		const { readFileSync } = await import("node:fs");
		const { fileURLToPath } = await import("node:url");
		const source = readFileSync(
			fileURLToPath(
				new URL("../../../components/SettingsTab.tsx", import.meta.url),
			),
			"utf8",
		);
		expect(source).toContain("effectiveTtsProvider((existing ?? {}) as AppConfig)");
		expect(source).not.toContain('existing?.ttsEngine === "gateway"');
	});

	it("저장된 값이 있으면 그것이 이긴다", () => {
		const cfg = { ttsProvider: "nextain", ttsEngine: "google" } as unknown as AppConfig;
		expect(effectiveTtsProvider(cfg)).toBe("nextain");
		expect(readSlots(cfg).tts.provider).toBe("nextain");
	});
});

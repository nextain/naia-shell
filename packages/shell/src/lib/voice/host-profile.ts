import { Logger } from "../logger";

/**
 * 이 기계의 로컬 음성 프로파일 (#537).
 *
 * 프로파일 이름은 운영체제와 가속기가 정하는 하드웨어 사실이다. 예전에는
 * 화면 세 곳이 `windows_trt_6g` 를 직접 박아 두었고, 그래서 기계가 바뀌면 세
 * 곳을 함께 고쳐야 했다. 이름을 아는 곳은 이제 백엔드 한 곳이다.
 *
 * 한 번 물어 세션 동안 들고 있는다. 카드 여유는 바뀌지만 프로파일과 카드
 * 개수는 기동 중에 바뀌지 않는다.
 */

export interface VoiceHostGpu {
	index: number;
	freeMib: number;
	totalMib: number;
}

export interface VoiceHostProfile {
	/** 이 기계에 맞는 프로파일. 맞는 것이 없으면 null. */
	profile: string | null;
	gpus: VoiceHostGpu[];
	/** 설정으로 카드를 고르게 할 것인가. 한 장뿐이면 고를 것이 없다. */
	gpuChoiceIsMeaningful: boolean;
	/** 아무것도 고르지 않았을 때 올라갈 카드. */
	defaultGpuIndex: number | null;
}

const UNKNOWN: VoiceHostProfile = {
	profile: null,
	gpus: [],
	gpuChoiceIsMeaningful: false,
	defaultGpuIndex: null,
};

let cached: Promise<VoiceHostProfile> | null = null;

export async function voiceHostProfile(): Promise<VoiceHostProfile> {
	if (!cached) {
		cached = (async () => {
			try {
				const { invoke } = await import("@tauri-apps/api/core");
				const raw = await invoke<VoiceHostProfile>("voice_host_profile");
				return { ...UNKNOWN, ...raw };
			} catch (error) {
				// 물어보지 못한 것과 맞는 프로파일이 없는 것을 구분해 남긴다. 못 물은 결과는
				// 캐시하지 않는다 — 일시 실패가 세션 내내 "프로파일 없음"으로 남지 않게.
				cached = null;
				Logger.warn("VoiceHostProfile", "프로파일을 묻지 못했습니다", {
					error: String(error),
				});
				return UNKNOWN;
			}
		})();
	}
	return cached;
}

/** 테스트에서 기계를 바꿔 끼우기 위한 자리. */
export function resetVoiceHostProfileCache(): void {
	cached = null;
}

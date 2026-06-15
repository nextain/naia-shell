// ── new-naia 이식 코어 결선 (UC12 온보딩 graft seam) ──
// chat-service.ts(UC1) 와 동일 패턴: isNewCore() 일 때 OnboardingWizard 가 이 seam 을 경유 →
// 새 core OnboardingController 로 flow(단계/assets/게이트) + 완료(completeWith §D) 처리.
// 미설정(기본)=기존 saveConfig/writeNaiaConfig 경로 보존(비파괴·지속가능).
//
// deps 는 여기서 셸 함수(invoke/config/adk-store/opener)를 주입 — core 는 @tauri-apps 미의존(직교, substrate-agnostic).
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
	makeShellOnboarding,
	type StepInput,
	toNaiaConfig,
} from "@nextain/naia-os-core/shell-compat";

// 셸 OnboardingWizard 가 submit 입력을 구성할 때 쓰는 타입(type-only 재노출, 직교).
export type { StepInput };
import { getAdkPath, setAdkPath } from "./adk-store";
import {
	type AppConfig,
	isOnboardingComplete,
	loadConfig,
	loadConfigWithSecrets,
	NAIA_WEB_BASE_URL,
	saveConfig,
} from "./config";

// 셸 AppConfig(특정 타입) ↔ core LiveDeps(Record<string,unknown>) 경계 어댑트 — 직교 유지(core 는 셸 타입 무지).
type FlatConfig = Record<string, unknown>;

/** 단계 전이로 graft 가 셸에 노출하는 자산 참조(셸은 path 에서 UI URL 전략 재유도).
 *  type 은 core 포트 AssetRef 와 동일(image|video) — 셸은 path 만 읽음(url/type 미사용). */
export interface CoreAssetRef {
	readonly url: string;
	readonly label: string;
	readonly path: string;
	readonly type: "image" | "video";
}

// 셸 함수 주입 묶음(completeWith 와 session 이 공유 — 동일 deps 구성).
function buildDeps() {
	return {
		f0: {
			invoke,
			loadConfig: () => loadConfig() as FlatConfig | null,
			saveConfig: (c: FlatConfig) => saveConfig(c as unknown as AppConfig),
			loadConfigWithSecrets: async () =>
				(await loadConfigWithSecrets()) as FlatConfig | null,
			getAdkPath,
			setAdkPath,
			isOnboardingComplete,
		},
		uc12: {
			invoke,
			openUrl,
			convertFileSrc,
			loginUrl: NAIA_WEB_BASE_URL,
		},
	};
}

/** step-flow graft(step2)에서 셸 OnboardingWizard 가 보유(useRef)하는 stateful 세션.
 *  컨트롤러 1 인스턴스를 감싸 — submit 가 draft 누적 + 순서 불변식 + provider-naia 게이트를 core-owned 로,
 *  onNaiaAuthCallback 이 게이트 해제(+ NAIA_ANYLLM_API_KEY 키체인=completeWith 와 idempotent).
 *  ⚠️ 영속은 completeWith(셸 snapshot) — submit 의 core draft 는 persist 에 안 쓰임(§D 설계의도). */
export interface OnboardingSession {
	/** core 가 LISTING 소유(adkPath.get + list_naia_assets). 셸은 path 에서 URL 전략 재유도(blob/asset). */
	assets(kind: "vrm-files" | "background"): Promise<readonly CoreAssetRef[]>;
	/** 단계 input 적용 + 전이. 반환 step = 전이 후(게이트 차단 시 동일 step). */
	submit(input: StepInput): Promise<{ step: string }>;
	/** naia OAuth callback 의 core 반영(naiaLoginDone=게이트해제 + 키체인). idempotent. */
	onNaiaAuthCallback(naiaKey: string): Promise<{ step: string }>;
	currentStep(): string;
	/** §D — 셸 snapshot(flat) 으로 완료 영속(secret=키체인 전담, markComplete). */
	completeWith(flat: FlatConfig): Promise<void>;
}

export function makeOnboardingSession(): OnboardingSession {
	const ctrl = makeShellOnboarding(buildDeps());
	return {
		assets: (kind) => ctrl.assets(kind) as Promise<readonly CoreAssetRef[]>,
		submit: async (input) => ({ step: (await ctrl.submit(input)).step }),
		onNaiaAuthCallback: async (naiaKey) => ({
			step: (await ctrl.onNaiaAuthCallback({ naiaKey })).step,
		}),
		currentStep: () => ctrl.current().step,
		completeWith: (flat) => ctrl.completeWith(toNaiaConfig(flat)),
	};
}

/**
 * 온보딩 완료를 새 core 로 영속(UC12 graft step1, one-shot 호환). flat = old localStorage 형태.
 * step-flow 미사용 경로(또는 backward compat)용 — 내부적으로 session.completeWith 와 동일.
 */
export async function completeOnboardingNewCore(
	flat: FlatConfig,
): Promise<void> {
	await makeOnboardingSession().completeWith(flat);
}

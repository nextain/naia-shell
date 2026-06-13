// ── new-naia 이식 코어 결선 (UC12 온보딩 완료 graft seam) ──
// chat-service.ts(UC1) 와 동일 패턴: isNewCore() 일 때 OnboardingWizard.handleComplete 가
// 이 seam 을 경유 → 새 core OnboardingController.completeWith(신규계약 §D) 로 영속.
// 미설정(기본)=기존 saveConfig/writeNaiaConfig 경로 보존(비파괴·지속가능).
//
// deps 는 여기서 셸 함수(invoke/config/adk-store/opener)를 주입 — core 는 @tauri-apps 미의존(직교, substrate-agnostic).
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
	makeShellOnboarding,
	toNaiaConfig,
} from "@nextain/naia-os-core/shell-compat";
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

/**
 * 온보딩 완료를 새 core 로 영속(UC12 graft). flat = old localStorage 형태(OnboardingWizard 가 빌드).
 * core 가 toNaiaConfig 로 categorize(secret/ui/agent) → completeWith 로 동일 persist 경로(secret=키체인 전담,
 * stale-credential fix 불변) + markOnboardingComplete. UC1 makeShellChatService 와 동일 seam.
 */
export async function completeOnboardingNewCore(
	flat: FlatConfig,
): Promise<void> {
	const ctrl = makeShellOnboarding({
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
	});
	await ctrl.completeWith(toNaiaConfig(flat));
}

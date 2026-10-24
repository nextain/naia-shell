import { getStartableAgentBridge } from "./agent-bridge";
import { installWebRuntime } from "./install";
import { startWebModel } from "./model-start";
import { checkWebAdkStartup } from "./web-adk";
import {
	consumeWebAuthCallbackFromLocation,
	isWebAuthenticated,
	isWebLoginRequired,
} from "./web-auth";
import { getWebFs } from "./web-fs";
import { readNavigatorGpu } from "./webgpu-check";

export interface BootWebRuntimeDeps {
	installRuntime?: () => void;
	consumeAuthCallback?: () => Promise<unknown>;
	checkAdkStartup?: () => Promise<unknown>;
	isLoginRequired?: () => boolean;
	isAuthenticated?: () => boolean;
	startModel?: () => Promise<void>;
	subscribeAuthChanged?: (onAuthChanged: () => void) => () => void;
}

/**
 * 웹판 부팅 순서:
 * 1) 웹 런타임 설치 → 2) `/auth/callback` 콜백 먼저 소비 → 3) OPFS ADK 시드 확인
 * 4) 로그인 문이 켜져 있고 아직 미로그인이면 모델 시작을 보류하고, 로그인 완료 이벤트 뒤에 시작한다.
 *    로그인 문이 꺼진 빌드(`VITE_NAIA_WEB_LOGIN_REQUIRED=0`)이거나 이미 로그인 상태면 즉시 시작한다.
 */
export async function bootWebRuntimeAndModel(
	deps?: BootWebRuntimeDeps,
): Promise<{ startedImmediately: boolean }> {
	const install = deps?.installRuntime ?? installWebRuntime;
	const consumeCallback =
		deps?.consumeAuthCallback ?? (() => consumeWebAuthCallbackFromLocation());
	const checkAdk =
		deps?.checkAdkStartup ??
		(() =>
			checkWebAdkStartup({
				fs: getWebFs(),
			}));
	const loginRequired = deps?.isLoginRequired ?? (() => isWebLoginRequired());
	const authenticated = deps?.isAuthenticated ?? (() => isWebAuthenticated());
	const launchModel =
		deps?.startModel ??
		(() => {
			let storage: Storage | null = null;
			try {
				storage = window.localStorage;
			} catch {
				storage = null;
			}
			return startWebModel({
				gpu: readNavigatorGpu(),
				storage,
				engineKind: import.meta.env.VITE_NAIA_WEB_LLM,
				buildModel: import.meta.env.VITE_NAIA_WEB_LLM_MODEL,
				bridge: getStartableAgentBridge(),
			});
		});
	const subscribeAuth =
		deps?.subscribeAuthChanged ??
		((cb: () => void) => {
			if (typeof window === "undefined") return () => {};
			window.addEventListener("naia-web-auth-changed", cb);
			return () => window.removeEventListener("naia-web-auth-changed", cb);
		});

	install();
	await consumeCallback();
	void checkAdk();

	let modelLaunched = false;
	const tryStartModel = (): boolean => {
		if (modelLaunched) return false;
		if (!loginRequired() || authenticated()) {
			modelLaunched = true;
			void launchModel();
			return true;
		}
		return false;
	};

	if (tryStartModel()) {
		return { startedImmediately: true };
	}

	const unsubscribe = subscribeAuth(() => {
		if (tryStartModel()) {
			unsubscribe();
		}
	});
	return { startedImmediately: false };
}

if (import.meta.env.MODE === "web") {
	void bootWebRuntimeAndModel();
}

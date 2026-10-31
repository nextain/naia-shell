import { loadConfig } from "../config";
import { getStartableAgentBridge } from "./agent-bridge";
import { installWebRuntime } from "./install";
import { startWebModel } from "./model-start";
import { checkWebAdkStartup } from "./web-adk";
import {
	consumeWebAuthCallbackFromLocation,
	isWebAuthenticated,
	isWebLoginRequired,
} from "./web-auth";
import { getWebFs, type WebFs } from "./web-fs";
import { setWebAdkStatus } from "./web-adk-status";
import { Logger } from "../logger";
import { webAdkOpfsPath } from "./web-adk-path";
import { isWebLlmModelId, WEB_LLM_MODEL_PREF_KEY } from "./webllm-model";
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

/** Workspace config is authoritative after cache loss or an interrupted hydration. */
export async function readWebBootSelection(fs: Pick<WebFs, "readText">): Promise<{ provider?: string; model?: string } | null> {
		const raw = await fs.readText(webAdkOpfsPath("naia-settings/config.json"));
		if (!raw) return null;
		const cfg = JSON.parse(raw) as { provider?: unknown; model?: unknown; llmRoles?: { main?: { provider?: unknown; model?: unknown } } };
		const role = cfg.llmRoles?.main;
		const provider = role?.provider ?? cfg.provider;
		const model = role?.model ?? cfg.model;
		if (typeof provider !== "string" || !provider.trim()) throw new Error("workspace provider missing");
		return { provider, model: typeof model === "string" ? model : undefined };
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
		(async () => {
			const selection = await readWebBootSelection(getWebFs());
			let storage: Storage | null = null;
			try {
				storage = window.localStorage;
			} catch {
				storage = null;
			}
			if ((selection?.provider ?? loadConfig()?.provider) !== "webllm") {
				getStartableAgentBridge().start({ model: null });
				return Promise.resolve();
			}
			const savedModel = selection?.provider === "webllm" && isWebLlmModelId(selection.model) ? selection.model : undefined;
			return startWebModel({
				gpu: readNavigatorGpu(),
				storage: savedModel ? { getItem: (key) => key === WEB_LLM_MODEL_PREF_KEY ? savedModel : storage?.getItem(key) ?? null } : storage,
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
	const adkCheck = checkAdk();

	let modelLaunched = false;
	const tryStartModel = (): boolean => {
		if (modelLaunched) return false;
		if (!loginRequired() || authenticated()) {
			modelLaunched = true;
			void adkCheck.then(launchModel).catch((error: unknown) => {
				Logger.error("WebRuntime", "Unable to read workspace configuration", { error: String(error) });
				setWebAdkStatus({ phase: "error", reason: "workspace_config_unavailable" });
			});
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

import {
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import {
	getAdkPath,
	isNaiaConfigHydrationPending,
	writeNaiaConfig,
} from "../lib/adk-store";
import { LAB_GATEWAY_URL, getNaiaKey, loadConfig, saveConfig } from "../lib/config";
import { t } from "../lib/i18n";
import {
	fetchLabBalancePayload,
	isLabBalanceUnauthorized,
	onWebCreditRefresh,
	parseLabCredits,
} from "../lib/lab-balance";
import { getDefaultLlmModel } from "../lib/llm/registry";
import { writeConfiguredLlmRole } from "../lib/llm/roles";
import { Logger } from "../lib/logger";
import { effectiveMainRole } from "../lib/slots/model";
import { getStartableAgentBridge } from "../lib/web-runtime/agent-bridge";
import {
	isValidWebAuthKey,
	isWebAuthenticated,
	startWebLoginRedirect,
} from "../lib/web-runtime/web-auth";
import {
	fallbackModelFor,
	getWebModelStatus,
	subscribeWebModelStatus,
	type WebModelStatus,
} from "../lib/web-runtime/web-model-status";
import {
	WEB_LLM_MODEL_ID,
	WEB_LLM_MODEL_PREF_KEY,
	formatWebLlmModelLabel,
	type WebLlmModelId,
} from "../lib/web-runtime/webllm-model";

// 데스크톱 번들에 모델 이름을 넣지 않기 위해 형 단언 사용
const DESKTOP_MODEL_STATUS = { phase: "ready", progress: 1 } as unknown as WebModelStatus;

export const useWebModelStatus: () => WebModelStatus =
	import.meta.env.MODE === "web" || import.meta.env.MODE === "test"
		? () => useSyncExternalStore(subscribeWebModelStatus, getWebModelStatus)
		: () => DESKTOP_MODEL_STATUS;

const READY_NOTICE_MS = 4000;
const NO_LOCAL_MODEL_STATUS: WebModelStatus = {
	phase: "error",
	model: WEB_LLM_MODEL_ID,
	progress: 0,
	errorKind: "no-webgpu",
};

type CloudCreditsStatus = "login" | "checking" | "available" | "empty" | "unavailable" | "expired";

function WebCloudChatRecovery({ provider }: { provider: "webllm" | "nextain" }) {
	const [credits, setCredits] = useState<CloudCreditsStatus>(
		() => isWebAuthenticated() ? "checking" : "login",
	);
	const [revision, setRevision] = useState(0);
	const [switching, setSwitching] = useState(false);
	const [switchFailed, setSwitchFailed] = useState(false);
	const [loginFailed, setLoginFailed] = useState(false);
	const confirmedKey = useRef<string | undefined>(undefined);
	const switchingRef = useRef(false);
	const recheckCredits = useCallback(() => {
		confirmedKey.current = undefined;
		setRevision((value) => value + 1);
	}, []);

	useEffect(() => {
		window.addEventListener("naia-web-auth-changed", recheckCredits);
		window.addEventListener("focus", recheckCredits);
		const offRefresh = onWebCreditRefresh(recheckCredits);
		return () => {
			window.removeEventListener("naia-web-auth-changed", recheckCredits);
			window.removeEventListener("focus", recheckCredits);
			offRefresh();
		};
	}, [recheckCredits]);

	useEffect(() => {
		const key = getNaiaKey();
		if (!key || !isValidWebAuthKey(key)) {
			setCredits("login");
			return;
		}
		setCredits("checking");
		const controller = new AbortController();
		const timeout = window.setTimeout(() => controller.abort(), 8_000);
		let ignore = false;
		Logger.debug("WebModelStatusBar", "checking credits for cloud chat recovery");
		void fetchLabBalancePayload(LAB_GATEWAY_URL, key, controller.signal)
			.then((payload) => {
				if (ignore) return;
				const value = parseLabCredits(payload);
				if (value !== null && value > 0) confirmedKey.current = key;
				setCredits(value === null ? "unavailable" : value > 0 ? "available" : "empty");
			})
			.catch((error: unknown) => {
				if (ignore) return;
				const expired = isLabBalanceUnauthorized(error);
				Logger.debug("WebModelStatusBar", "cloud chat credit check failed", { expired });
				setCredits(expired ? "expired" : "unavailable");
			})
			.finally(() => window.clearTimeout(timeout));
		return () => {
			ignore = true;
			window.clearTimeout(timeout);
			controller.abort();
		};
	}, [revision]);

	function handleLogin() {
		setLoginFailed(false);
		try {
			startWebLoginRedirect({ keepLocalModel: true });
		} catch {
			Logger.warn("WebModelStatusBar", "could not start sign-in for cloud chat recovery");
			setLoginFailed(true);
		}
	}

	async function handleCloudSwitch() {
		if (switchingRef.current) return;
		const key = confirmedKey.current;
		if (!key || getNaiaKey() !== key) {
			recheckCredits();
			return;
		}
		switchingRef.current = true;
		setSwitching(true);
		setSwitchFailed(false);
		const model = getDefaultLlmModel("nextain");
		Logger.debug("WebModelStatusBar", "switching to cloud chat", { model });
		try {
			const current = loadConfig();
			const path = getAdkPath();
			if (
				!current || !path || !model ||
				isNaiaConfigHydrationPending() ||
				effectiveMainRole(current).provider !== provider
			) {
				throw new Error("Cloud chat selection is unavailable");
			}
			const selection = { provider: "nextain", model };
			const next = {
				...writeConfiguredLlmRole(current, "main", selection),
				webAutoDefaultModel: false,
			};
			await writeNaiaConfig(next);
			const latest = loadConfig();
			if (getAdkPath() === path && latest && effectiveMainRole(latest).provider === provider) {
				getStartableAgentBridge().start({ model: null });
				saveConfig({
					...writeConfiguredLlmRole(latest, "main", selection),
					webAutoDefaultModel: false,
				});
			}
		} catch {
			Logger.warn("WebModelStatusBar", "could not switch to cloud chat");
			setSwitchFailed(true);
		} finally {
			switchingRef.current = false;
			setSwitching(false);
		}
	}

	return (
		<div className="web-model-recovery">
			{(credits === "login" || credits === "expired") && (
				<button
					type="button"
					className="web-model-recovery__button"
					onClick={handleLogin}
				>
					{t(credits === "login" ? "webModel.loginForCloud" : "webModel.loginAgainForCloud")}
				</button>
			)}
			{(credits === "available" || switching) && (
				<button
					type="button"
					className="web-model-recovery__button"
					onClick={handleCloudSwitch}
					disabled={switching}
				>
					{t(switching ? "webModel.switchingToCloud" : "webModel.useCloud")}
				</button>
			)}
			{!switching && credits === "checking" && (
				<p role="status">{t("webModel.checkingCredits")}</p>
			)}
			{!switching && credits === "empty" && <p>{t("webModel.noCloudCredits")}</p>}
			{!switching && credits === "unavailable" && (
				<>
					<p>{t("webModel.cloudCreditsUnavailable")}</p>
					<button type="button" className="chat-error-notice__retry" onClick={recheckCredits}>
						{t("webModel.retryCredits")}
					</button>
				</>
			)}
			{switchFailed && <p>{t("webModel.cloudSwitchFailed")}</p>}
			{loginFailed && <p>{t("webAuth.startFailed")}</p>}
		</div>
	);
}

export function WebModelStatusBar(props: {
	scrollDuringSetup?: boolean;
	offerCloudRecovery?: boolean;
	localModelUnavailable?: boolean;
	cloudRecoveryOnly?: boolean;
	onSwitchModel?: (model: WebLlmModelId) => void;
	onRetry?: () => void;
}) {
	const runtimeStatus = useWebModelStatus();
	const status = props.localModelUnavailable ? NO_LOCAL_MODEL_STATUS : runtimeStatus;
	const [detailsOpen, setDetailsOpen] = useState(false);
	useEffect(() => {
		setDetailsOpen(false);
	}, [status.phase]);
	// The default model's "ready" line sits right above the composer and eats
	// scarce chat height; show it briefly, then get out of the way. Fallback
	// notices and workspace setup stay visible because they need action.
	const quietReady =
		status.phase === "ready" &&
		status.model === WEB_LLM_MODEL_ID &&
		!props.scrollDuringSetup;
	const [readyHidden, setReadyHidden] = useState(false);
	useEffect(() => {
		setReadyHidden(false);
		if (!quietReady) return;
		const timer = window.setTimeout(() => setReadyHidden(true), READY_NOTICE_MS);
		return () => window.clearTimeout(timer);
	}, [quietReady]);

	const handleSwitchModel = (model: WebLlmModelId) => {
		if (props.onSwitchModel) {
			props.onSwitchModel(model);
			return;
		}
		try {
			localStorage.setItem(WEB_LLM_MODEL_PREF_KEY, model);
		} catch {
			// ignore storage errors
		}
		window.location.reload();
	};

	const handleRetry = () => {
		if (props.onRetry) {
			props.onRetry();
			return;
		}
		window.location.reload();
	};

	const modelLabel = formatWebLlmModelLabel(status.model);
	const usingCompatibleModel = status.model !== WEB_LLM_MODEL_ID;
	const showBackToDefault =
		status.phase === "ready" && usingCompatibleModel && !props.scrollDuringSetup;

	const formatAdapterLine = () => {
		if (!status.adapter) return null;
		const parts = [
			status.adapter.vendor,
			status.adapter.architecture,
			status.adapter.description,
		].filter((p) => p && p.trim().length > 0);
		const adapterName =
			parts.length > 0 ? parts.join(" · ") : t("webModel.adapterUnknown");
		const f16Text = status.shaderF16
			? t("webModel.f16Yes")
			: t("webModel.f16No");
		return t("webModel.adapter", { adapter: adapterName, f16: f16Text });
	};

	const adapterLine = formatAdapterLine();
	if (props.cloudRecoveryOnly) {
		return (
			<div
				id="web-model-status"
				data-testid="web-model-status"
				data-phase="cloud-recovery"
				className="chat-compaction-notice"
				role="status"
			>
				<WebCloudChatRecovery provider="nextain" />
			</div>
		);
	}

	if (status.phase === "error") {
		const fallbackModel = fallbackModelFor(status);

		return (
			<div
				id="web-model-status"
				data-testid="web-model-status"
				tabIndex={0}
				data-phase={status.phase}
				data-model={status.model}
				data-error-kind={status.errorKind}
				data-cloud-recovery={props.offerCloudRecovery || undefined}
				className="chat-error-notice"
				role="alert"
			>
				<p className="chat-error-notice__lead">{t("webModel.localChatUnavailable")}</p>
				{props.offerCloudRecovery && !props.scrollDuringSetup ? (
					<WebCloudChatRecovery provider={props.localModelUnavailable ? "nextain" : "webllm"} />
				) : (
					<p className="web-model-recovery">{t(props.scrollDuringSetup
						? "webModel.workspacePreparing"
						: "webModel.localChatRetryHint")}</p>
				)}
				<div className="update-banner-actions">
					{fallbackModel && (
						<button
							type="button"
							className="chat-error-notice__retry"
							data-testid="web-model-fallback"
							onClick={() => handleSwitchModel(fallbackModel)}
						>
							{t("webModel.tryCompatibleModel")}
						</button>
					)}
					<button
						type="button"
						className="chat-error-notice__retry"
						data-testid="web-model-retry"
						onClick={handleRetry}
					>
						{t("webModel.retry")}
					</button>
				</div>
				{(adapterLine || status.errorMessage) && (
					<details className="chat-error-notice__details">
						<summary>{t("webModel.details")}</summary>
						{adapterLine && <div>{adapterLine}</div>}
						{status.errorMessage && (
							<pre className="chat-error-notice__detail-text">{status.errorMessage}</pre>
						)}
					</details>
				)}
			</div>
		);
	}

	return (
		<div
			id="web-model-status"
			data-testid="web-model-status"
			tabIndex={props.scrollDuringSetup || detailsOpen ? 0 : undefined}
			data-phase={status.phase}
			data-model={status.model}
			className="chat-compaction-notice"
			role="status"
			hidden={quietReady && readyHidden && !detailsOpen}
		>
			{status.phase === "checking" && (
				<div>{t("webModel.checking")}</div>
			)}
			{(status.phase === "loading" || status.phase === "ready") && (
				<details
					key={status.phase}
					className="web-model-details"
					data-testid={status.phase === "ready" ? "web-model-ready-details" : "web-model-loading-details"}
					onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
				>
					<summary className="web-model-details__summary" title={modelLabel}>
						{status.phase === "loading"
							? t("webModel.loading", { percent: Math.floor(status.progress * 100) })
							: t(usingCompatibleModel ? "webModel.fallbackActive" : "webModel.onDeviceReady")}
					</summary>
					<div>{status.phase === "ready" ? t("webModel.ready", { model: modelLabel }) : modelLabel}</div>
					{adapterLine && <div>{adapterLine}</div>}
					{showBackToDefault && (
						<button
							type="button"
							className="chat-error-notice__retry"
							data-testid="web-model-back-to-default"
							onClick={() => handleSwitchModel(WEB_LLM_MODEL_ID)}
						>
							{t("webModel.backToDefault", {
								model: formatWebLlmModelLabel(WEB_LLM_MODEL_ID),
							})}
						</button>
					)}
				</details>
			)}
		</div>
	);
}

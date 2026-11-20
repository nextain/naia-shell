import { useEffect, useState, useSyncExternalStore } from "react";
import { openWebWorkspaceFile } from "../apps/workspace/WebWorkspace";
import { loadInstalledApps } from "../lib/app-loader";
import { appRegistry } from "../lib/app-registry";
import { getPlatformAppStoreAdapter } from "../lib/app-store-adapter";
import { CHARCARD_APP_ID } from "../lib/charcard-chat-start";
import { loadConfig } from "../lib/config";
import { getLocale, t } from "../lib/i18n";
import { isKioskDemo } from "../lib/kiosk-demo/flag";
import { Logger } from "../lib/logger";
import { isWebMode } from "../lib/web-runtime/web-assets";
import { isWebAuthenticated } from "../lib/web-runtime/web-auth";
import { openWebLoginPrompt } from "../lib/web-runtime/web-login-prompt";
import {
	getWebModelStatus,
	subscribeWebModelStatus,
} from "../lib/web-runtime/web-model-status";
import { useAppStore } from "../stores/app";

const pillStyle = (active = false, accent = false): React.CSSProperties => ({
	display: "inline-flex",
	alignItems: "center",
	gap: 5,
	height: 26,
	padding: "0 9px",
	borderRadius: 999,
	border: accent
		? "1px solid rgba(129, 140, 248, 0.55)"
		: active
			? "1px solid rgba(56, 189, 248, 0.55)"
			: "1px solid rgba(148, 163, 184, 0.24)",
	background: accent
		? "linear-gradient(135deg, rgba(99, 102, 241, 0.28), rgba(79, 70, 229, 0.22))"
		: active
			? "rgba(14, 116, 144, 0.28)"
			: "rgba(15, 23, 42, 0.72)",
	color: "#e2e8f0",
	fontSize: 11.5,
	fontWeight: 600,
	whiteSpace: "nowrap",
	cursor: "pointer",
	lineHeight: 1,
});

export async function toggleWebCharacterCard(): Promise<void> {
	const { activeApp, setActiveApp } = useAppStore.getState();
	if (activeApp === CHARCARD_APP_ID) {
		setActiveApp(null);
		return;
	}
	try {
		if (!appRegistry.get(CHARCARD_APP_ID)) {
			await getPlatformAppStoreAdapter().installApp(CHARCARD_APP_ID);
			await loadInstalledApps();
		}
		setActiveApp(CHARCARD_APP_ID);
	} catch {
		Logger.warn("WebRuntimeHarnessBar", "could not open character cards");
		setActiveApp("settings");
	}
}

/**
 * Official Web Mode (`VITE_NAIA_KIOSK_DEMO="0"`) runtime status & Open Harness bar:
 * 1) Shows WebGPU On-Device Local Brain status (or Cloud Brain when signed in on Nextain)
 * 2) Provides 1-click entry to the In-Browser Open Harness (`AGENTS.md`, skills, OPFS memory)
 * 3) Provides 1-click SillyTavern Character Card launcher
 * 4) Shows `[로그인 · 무료 200⚡]` chip for unauthenticated visitors (`SP-00` / `SP-04`)
 */
export function WebRuntimeHarnessBar() {
	const enabled = isWebMode() && !isKioskDemo();
	const modelStatus = useSyncExternalStore(
		subscribeWebModelStatus,
		getWebModelStatus,
		getWebModelStatus,
	);
	const activeApp = useAppStore((s) => s.activeApp);
	const setActiveApp = useAppStore((s) => s.setActiveApp);
	const [authenticated, setAuthenticated] = useState(() =>
		enabled ? isWebAuthenticated() : false,
	);
	const [provider, setProvider] = useState<string>(() => {
		if (!enabled || typeof loadConfig !== "function") return "webllm";
		return loadConfig()?.provider || "webllm";
	});

	useEffect(() => {
		if (!enabled) return;
		const sync = () => {
			setAuthenticated(isWebAuthenticated());
			const cfg = typeof loadConfig === "function" ? loadConfig() : null;
			setProvider(cfg?.provider || (isWebAuthenticated() ? "nextain" : "webllm"));
		};
		sync();
		window.addEventListener("naia-config-changed", sync);
		window.addEventListener("naia-web-auth-changed", sync);
		return () => {
			window.removeEventListener("naia-config-changed", sync);
			window.removeEventListener("naia-web-auth-changed", sync);
		};
	}, [enabled]);

	if (!enabled) return null;

	const locale = getLocale();
	const isKo = locale === "ko";
	const usingCloudBrain = authenticated && provider === "nextain";

	let brainLabel = "";
	let brainTitle = "";
	if (usingCloudBrain) {
		brainLabel = isKo ? "☁ 클라우드 두뇌" : "☁ Cloud Brain";
		brainTitle = isKo
			? "Naia 클라우드 고성능 두뇌 연결됨 (대화·기억은 브라우저 OPFS 보관)"
			: "Connected to Naia Cloud Brain (memory stays in browser OPFS)";
	} else if (modelStatus.phase === "ready") {
		brainLabel = isKo ? "⚡ WebGPU 로컬 두뇌" : "⚡ WebGPU Local Brain";
		brainTitle = isKo
			? "브라우저 내장 WebGPU 로컬 LLM 가동 중 (서버 전송 0 · 무료)"
			: "On-device WebGPU Local LLM active (zero server upload · free)";
	} else if (modelStatus.phase === "error") {
		brainLabel = isKo ? "⚠ WebGPU 점검" : "⚠ WebGPU Check";
		brainTitle =
			modelStatus.errorMessage ||
			(isKo
				? "WebGPU 가속 점검 또는 클라우드 두뇌 전환이 필요합니다"
				: "Check WebGPU support or switch to Cloud Brain");
	} else {
		const pct = Math.max(0, Math.min(100, Math.round(modelStatus.progress * 100)));
		brainLabel =
			pct > 0
				? `⚡ WebGPU ${pct}%`
				: isKo
					? "⚡ WebGPU 준비중"
					: "⚡ WebGPU Init";
		brainTitle = isKo
			? "브라우저 WebGPU 로컬 두뇌 모델을 준비하고 있습니다"
			: "Preparing in-browser WebGPU local LLM";
	}

	const handleToggleHarness = () => {
		if (activeApp === "workspace") {
			setActiveApp(null);
			return;
		}
		openWebWorkspaceFile("AGENTS.md");
		setActiveApp("workspace");
	};

	return (
		<div
			className="web-runtime-harness-bar"
			data-testid="web-runtime-harness-bar"
			style={{
				display: "inline-flex",
				alignItems: "center",
				gap: 6,
				marginRight: 6,
				flexShrink: 0,
			}}
		>
			<button
				type="button"
				data-testid="web-brain-status-badge"
				style={pillStyle(modelStatus.phase === "ready" && !usingCloudBrain)}
				title={brainTitle}
				onClick={() => {
					if (modelStatus.phase === "error" && !authenticated) {
						openWebLoginPrompt("cloud-llm");
						return;
					}
					setActiveApp(activeApp === "settings" ? null : "settings");
				}}
			>
				{brainLabel}
			</button>

			<button
				type="button"
				data-testid="web-open-harness-btn"
				style={pillStyle(activeApp === "workspace")}
				title={
					isKo
						? "브라우저 내 공개 하네스 열기 (AGENTS.md · 스킬 · OPFS 기억 폴더)"
						: "Inspect In-Browser Open Harness (AGENTS.md · Skills · OPFS Memory)"
				}
				onClick={handleToggleHarness}
			>
				{isKo ? "📂 공개 하네스" : "📂 Open Harness"}
			</button>

			<button
				type="button"
				data-testid="web-character-card-quick-btn"
				style={pillStyle(activeApp === CHARCARD_APP_ID)}
				title={
					isKo
						? "실리태번 호환 캐릭터 카드 (.png / .json) 불러오기·적용"
						: "Import SillyTavern Character Card (.png / .json)"
				}
				onClick={() => void toggleWebCharacterCard()}
			>
				{isKo ? "🃏 캐릭터 카드" : "🃏 Character Card"}
			</button>

			{!authenticated && (
				<span
					className="web-login-free-credits-wrap"
					style={{
						position: "relative",
						display: "inline-flex",
						alignItems: "center",
					}}
				>
					<button
						type="button"
						data-testid="web-login-free-credits-btn"
						style={pillStyle(false, true)}
						title={t("webCredit.signupHint")}
						aria-describedby={
							activeApp === null ? "web-login-credit-hint" : undefined
						}
						onClick={() => openWebLoginPrompt("account")}
					>
						{isKo ? "로그인 · 무료 200 Cr" : "Sign in · 200 Cr"}
					</button>
					{activeApp === null && (
						<span
							id="web-login-credit-hint"
							className="web-login-credit-hint"
							data-testid="web-login-credit-hint"
						>
							{t("webCredit.signupHint")}
						</span>
					)}
				</span>
			)}
		</div>
	);
}

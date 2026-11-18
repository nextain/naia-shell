import { useEffect, useState } from "react";
import { loadConfig, saveConfig } from "../lib/config";
import { getLocale } from "../lib/i18n";
import { isKioskDemo } from "../lib/kiosk-demo/flag";
import { getStartableAgentBridge } from "../lib/web-runtime/agent-bridge";
import { startWebModel } from "../lib/web-runtime/model-start";
import { isWebMode } from "../lib/web-runtime/web-assets";
import {
	isWebAuthenticated,
	startWebLoginRedirect,
} from "../lib/web-runtime/web-auth";
import {
	type WebLoginPromptReason,
	markWebLoginPromptDismissedToday,
	onWebLoginPrompt,
} from "../lib/web-runtime/web-login-prompt";
import { readNavigatorGpu } from "../lib/web-runtime/webgpu-check";
import { WEB_LLM_MODEL_ID } from "../lib/web-runtime/webllm-model";

interface PromptCopy {
	badge: string;
	title: string;
	body: string;
	reasonHint: Record<WebLoginPromptReason, string>;
	loginCta: string;
	continueLocal: string;
	later: string;
}

function getPromptCopy(locale: string): PromptCopy {
	if (locale === "ko") {
		return {
			badge: "무료 200 크레딧 지급 · SP-04",
			title: "로그인하면 무료 200크레딧을 드려요",
			body: "클라우드 고성능 두뇌·드래곤 14개국어 감정 음성·나이아 스튜디오를 바로 쓸 수 있어요. 대화와 기억은 지금처럼 이 브라우저에만 남습니다.",
			reasonHint: {
				"cloud-llm": "클라우드 고성능 LLM 두뇌는 로그인 후 크레딧으로 이용할 수 있어요.",
				"dragon-voice": "Naia Cloud 드래곤 14개국어 HD 음성은 로그인 후 이용할 수 있어요.",
				studio: "나이아 스튜디오 캐릭터·목소리 제작은 로그인 후 이용할 수 있어요.",
				"app-store": "유료 미니앱 구매·권한 동기화는 로그인 후 이용할 수 있어요.",
				account: "Google 또는 Discord 계정으로 5초 만에 시작할 수 있어요.",
			},
			loginCta: "Naia 로그인 (Google / Discord)",
			continueLocal: "로컬 WebGPU 무료 두뇌로 계속하기",
			later: "나중에",
		};
	}
	return {
		badge: "Free 200 Credits · SP-04",
		title: "Sign in and get 200 free credits",
		body: "Unlock cloud frontier LLMs, 14-language Dragon HD emotional voices, and Naia Studio. Your chats and memory stay right inside this browser.",
		reasonHint: {
			"cloud-llm": "Cloud LLM models require a Naia account with credits.",
			"dragon-voice": "Naia Cloud Dragon 14-language HD voices require sign-in.",
			studio: "Naia Studio character & NVA creation requires sign-in.",
			"app-store": "App Store purchases & entitlements require sign-in.",
			account: "Sign in with Google or Discord in seconds.",
		},
		loginCta: "Sign in to Naia (Google / Discord)",
		continueLocal: "Continue free with local WebGPU",
		later: "Later",
	};
}

export function WebLoginPromptModal() {
	const [reason, setReason] = useState<WebLoginPromptReason | null>(null);
	const enabled = isWebMode() && !isKioskDemo();

	useEffect(() => {
		if (!enabled) return;
		const offPrompt = onWebLoginPrompt((detail) => {
			if (isWebAuthenticated()) return;
			setReason(detail.reason);
		});
		const onAuthChanged = () => {
			if (isWebAuthenticated()) setReason(null);
		};
		window.addEventListener("naia-web-auth-changed", onAuthChanged);
		return () => {
			offPrompt();
			window.removeEventListener("naia-web-auth-changed", onAuthChanged);
		};
	}, [enabled]);

	if (!enabled || !reason || isWebAuthenticated()) return null;

	const locale = getLocale();
	const copy = getPromptCopy(locale);
	const gpuAvailable = Boolean(readNavigatorGpu());

	const handleLogin = () => {
		startWebLoginRedirect({ lang: locale });
	};

	const handleDismiss = (switchToLocal: boolean) => {
		markWebLoginPromptDismissedToday();
		if (switchToLocal && gpuAvailable) {
			const existing = loadConfig();
			saveConfig({
				...(existing ?? { apiKey: "" }),
				provider: "webllm",
				model: WEB_LLM_MODEL_ID,
				ttsProvider: "browser",
				ttsEnabled: existing?.ttsEnabled ?? true,
				llmRoles: {
					...(existing?.llmRoles ?? {}),
					main: { provider: "webllm", model: WEB_LLM_MODEL_ID },
				},
			});
			window.dispatchEvent(new CustomEvent("naia-config-changed"));
			void startWebModel({
				gpu: readNavigatorGpu(),
				storage: typeof localStorage !== "undefined" ? localStorage : null,
				engineKind: import.meta.env.VITE_NAIA_WEB_LLM,
				buildModel: import.meta.env.VITE_NAIA_WEB_LLM_MODEL,
				bridge: getStartableAgentBridge(),
			}).catch(() => {});
		}
		setReason(null);
	};

	return (
		<div
			className="sync-dialog-overlay"
			data-testid="web-login-prompt-overlay"
			onClick={() => handleDismiss(false)}
			style={{ zIndex: 99990 }}
		>
			<section
				className="sync-dialog-card"
				role="dialog"
				aria-modal="true"
				aria-labelledby="web-login-prompt-title"
				data-testid="web-login-prompt-card"
				onClick={(e) => e.stopPropagation()}
				style={{
					maxWidth: 420,
					padding: "22px 24px",
					borderRadius: 16,
					border: "1px solid rgba(124, 160, 255, 0.35)",
					background: "rgba(11, 17, 30, 0.96)",
					boxShadow: "0 20px 50px rgba(0, 0, 0, 0.6)",
				}}
			>
				<div
					style={{
						display: "inline-block",
						padding: "3px 10px",
						borderRadius: 999,
						fontSize: 12,
						fontWeight: 600,
						background: "rgba(99, 102, 241, 0.2)",
						color: "#a5b4fc",
						marginBottom: 10,
					}}
				>
					⚡ {copy.badge}
				</div>
				<h2
					id="web-login-prompt-title"
					style={{
						margin: "0 0 8px",
						fontSize: 19,
						fontWeight: 700,
						color: "#f8fafc",
					}}
				>
					{copy.title}
				</h2>
				<p
					style={{
						margin: "0 0 10px",
						fontSize: 13.5,
						lineHeight: 1.55,
						color: "#cbd5e1",
					}}
				>
					{copy.reasonHint[reason]}
				</p>
				<p
					style={{
						margin: "0 0 18px",
						fontSize: 13,
						lineHeight: 1.55,
						color: "#94a3b8",
					}}
				>
					{copy.body}
				</p>
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						gap: 8,
					}}
				>
					<button
						type="button"
						data-testid="web-login-prompt-submit"
						onClick={handleLogin}
						style={{
							width: "100%",
							padding: "11px 16px",
							borderRadius: 10,
							border: "none",
							background: "linear-gradient(135deg, #6366f1, #4f46e5)",
							color: "#ffffff",
							fontWeight: 700,
							fontSize: 14,
							cursor: "pointer",
						}}
					>
						{copy.loginCta}
					</button>
					{gpuAvailable && (
						<button
							type="button"
							data-testid="web-login-prompt-continue-local"
							onClick={() => handleDismiss(true)}
							style={{
								width: "100%",
								padding: "9px 14px",
								borderRadius: 10,
								border: "1px solid rgba(148, 163, 184, 0.28)",
								background: "rgba(30, 41, 59, 0.7)",
								color: "#e2e8f0",
								fontWeight: 600,
								fontSize: 13,
								cursor: "pointer",
							}}
						>
							{copy.continueLocal}
						</button>
					)}
					<button
						type="button"
						data-testid="web-login-prompt-later"
						onClick={() => handleDismiss(false)}
						style={{
							width: "100%",
							padding: "7px 12px",
							borderRadius: 8,
							border: "none",
							background: "transparent",
							color: "#94a3b8",
							fontSize: 13,
							cursor: "pointer",
						}}
					>
						{copy.later}
					</button>
				</div>
			</section>
		</div>
	);
}

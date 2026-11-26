import { useEffect, useState } from "react";
import { loadConfig, saveConfig } from "../lib/config";
import { getLocale, t } from "../lib/i18n";
import { isKioskDemo } from "../lib/kiosk-demo/flag";
import { getStartableAgentBridge } from "../lib/web-runtime/agent-bridge";
import { startWebModel } from "../lib/web-runtime/model-start";
import { isWebMode } from "../lib/web-runtime/web-assets";
import {
	isWebAuthenticated,
	startWebLoginRedirect,
} from "../lib/web-runtime/web-auth";
import {
	type WebLoginPromptDetail,
	markWebLoginPromptDismissedToday,
	onWebLoginPrompt,
} from "../lib/web-runtime/web-login-prompt";
import { readNavigatorGpu } from "../lib/web-runtime/webgpu-check";
import { WEB_LLM_MODEL_ID } from "../lib/web-runtime/webllm-model";

export function WebLoginPromptModal() {
	const [prompt, setPrompt] = useState<WebLoginPromptDetail | null>(null);
	const enabled = isWebMode() && !isKioskDemo();

	useEffect(() => {
		if (!enabled) return;
		const offPrompt = onWebLoginPrompt((detail) => {
			if (isWebAuthenticated() && !detail.reauthenticate) return;
			setPrompt(detail);
		});
		const onAuthChanged = () => {
			if (isWebAuthenticated()) setPrompt(null);
		};
		window.addEventListener("naia-web-auth-changed", onAuthChanged);
		return () => {
			offPrompt();
			window.removeEventListener("naia-web-auth-changed", onAuthChanged);
		};
	}, [enabled]);

	if (!enabled || !prompt || (isWebAuthenticated() && !prompt.reauthenticate)) return null;

	const { reason } = prompt;
	const locale = getLocale();
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
		setPrompt(null);
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
					⚡ {t("webLoginPrompt.badge")}
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
					{t("webLoginPrompt.title")}
				</h2>
				<p
					style={{
						margin: "0 0 10px",
						fontSize: 13.5,
						lineHeight: 1.55,
						color: "#cbd5e1",
					}}
				>
					{t(`webLoginPrompt.reason.${reason}`)}
				</p>
				<p
					style={{
						margin: "0 0 12px",
						fontSize: 13,
						lineHeight: 1.55,
						color: "#94a3b8",
					}}
				>
					{t("webLoginPrompt.body")}
				</p>
				<p
					data-testid="web-login-prompt-credit-hint"
					style={{
						margin: "0 0 14px",
						padding: "7px 10px",
						borderRadius: 8,
						background: "rgba(99, 102, 241, 0.12)",
						border: "1px solid rgba(129, 140, 248, 0.28)",
						fontSize: 12,
						lineHeight: 1.45,
						color: "#c7d2fe",
					}}
				>
					{t("webCredit.signupHint")}
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
						{t("webLoginPrompt.loginCta")}
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
							{t("webLoginPrompt.continueLocal")}
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
						{t("webLoginPrompt.later")}
					</button>
				</div>
			</section>
		</div>
	);
}

import { useState } from "react";
import { t } from "../lib/i18n";
import {
	getWebLoginBaseUrl,
	startWebLoginRedirect,
} from "../lib/web-runtime/web-auth";

export interface WebLoginScreenProps {
	authError?: string | null;
	onLoginClick?: () => void;
}

export function WebLoginScreen({
	authError,
	onLoginClick,
}: WebLoginScreenProps) {
	const [redirecting, setRedirecting] = useState(false);
	const [localError, setLocalError] = useState<string | null>(null);

	const handleLogin = () => {
		setLocalError(null);
		setRedirecting(true);
		try {
			if (onLoginClick) {
				onLoginClick();
				return;
			}
			startWebLoginRedirect();
		} catch (err) {
			setRedirecting(false);
			setLocalError(
				err instanceof Error && err.message
					? err.message
					: "로그인을 시작하지 못했습니다.",
			);
		}
	};

	const displayedError = localError || authError;

	return (
		<div
			className="adk-setup-overlay"
			data-testid="web-login-screen"
			style={{
				position: "fixed",
				inset: 0,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				background: "var(--bg-primary, #0f1117)",
				color: "var(--text-primary, #f5f7fa)",
				zIndex: 9999,
				padding: "24px",
			}}
		>
			<div
				className="adk-setup-card"
				style={{
					maxWidth: "420px",
					width: "100%",
					padding: "32px 28px",
					borderRadius: "16px",
					background: "var(--bg-secondary, rgba(24, 28, 38, 0.94))",
					border: "1px solid var(--border-subtle, rgba(255,255,255,0.1))",
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					textAlign: "center",
					gap: "16px",
				}}
			>
				<h1
					style={{
						margin: 0,
						fontSize: "1.4rem",
						fontWeight: 700,
					}}
				>
					Naia OS Web
				</h1>
				<p
					style={{
						margin: 0,
						fontSize: "0.95rem",
						color: "var(--text-secondary, #a0aec0)",
						lineHeight: 1.5,
					}}
				>
					{t("settings.labDisconnected")}
				</p>
				{displayedError && (
					<div
						role="alert"
						data-testid="web-login-error"
						style={{
							fontSize: "0.85rem",
							color: "var(--color-error, #fc8181)",
						}}
					>
						{displayedError}
					</div>
				)}
				<button
					type="button"
					data-testid="web-login-submit"
					className="voice-preview-btn"
					disabled={redirecting}
					onClick={handleLogin}
					style={{
						width: "100%",
						padding: "12px 20px",
						fontSize: "0.95rem",
						fontWeight: 600,
						cursor: redirecting ? "wait" : "pointer",
					}}
				>
					{t("settings.labConnect")}
				</button>
				<div
					data-testid="web-login-base-url"
					style={{
						fontSize: "0.75rem",
						color: "var(--text-muted, #718096)",
					}}
				>
					{getWebLoginBaseUrl()}
				</div>
			</div>
		</div>
	);
}

import { useSyncExternalStore } from "react";
import { t } from "../lib/i18n";
import { installDefaultWebAdk } from "../lib/web-runtime/web-adk";
import {
	getWebAdkStatus,
	subscribeWebAdkStatus,
	type WebAdkStatus,
} from "../lib/web-runtime/web-adk-status";
import { getWebFs } from "../lib/web-runtime/web-fs";

const DESKTOP_ADK_STATUS: WebAdkStatus = { phase: "ready" };

export const useWebAdkStatus: () => WebAdkStatus =
	import.meta.env.MODE === "web"
		? () => useSyncExternalStore(subscribeWebAdkStatus, getWebAdkStatus)
		: () => DESKTOP_ADK_STATUS;


export interface WebWorkspaceSetupProps {
	compact?: boolean;
	status?: WebAdkStatus;
	onStartDefault?: () => void;
	onRetry?: () => void;
}

export function WebWorkspaceSetup(props: WebWorkspaceSetupProps) {
	const currentStatus = useWebAdkStatus();
	const status = props.status ?? currentStatus;

	const handleStartDefault = () => {
		if (props.onStartDefault) {
			props.onStartDefault();
			return;
		}
		void installDefaultWebAdk({ fs: getWebFs() });
	};

	const handleRetry = () => {
		if (props.onRetry) {
			props.onRetry();
			return;
		}
		void installDefaultWebAdk({ fs: getWebFs() });
	};

	return (
		<div
			className="web-workspace-setup"
			data-testid="web-workspace-setup"
			data-phase={status.phase}
			aria-busy={status.phase === "checking" || status.phase === "installing"}
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				justifyContent: props.compact ? "flex-start" : "center",
				padding: props.compact ? "4px 12px" : "2rem",
				textAlign: "center",
				gap: props.compact ? "0.25rem" : "1.25rem",
				flex: props.compact ? "none" : 1,
				width: "100%",
				minHeight: props.compact ? 0 : "200px",
				maxHeight: props.compact ? "min(40%, 10rem)" : undefined,
				overflowY: props.compact ? "auto" : undefined,
			}}
		>
			{status.phase === "needs-setup" && (
				<div
					className="web-workspace-setup-body"
					style={{
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						gap: props.compact ? "0.25rem" : "1rem",
					}}
				>
					<p
						className="web-workspace-description"
						style={{ fontSize: props.compact ? "0.75rem" : "0.95rem", color: "var(--color-text-secondary, #888)", margin: 0, overflowWrap: "anywhere" }}
					>
						{t("webWorkspace.description")}
					</p>
					<div className="web-workspace-actions">
						<ul
							className="web-workspace-actions-list"
							style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}
						>
							<li>
								<button
									type="button"
									className="web-workspace-btn"
									data-testid="web-workspace-start-default"
									onClick={handleStartDefault}
									style={{
										padding: "0.5rem 1.25rem",
										fontSize: "0.9rem",
										fontWeight: 500,
										borderRadius: "6px",
										cursor: "pointer",
									}}
								>
									{t("webWorkspace.startDefault")}
								</button>
							</li>
						</ul>
					</div>
				</div>
			)}

			{status.phase === "installing" && (
				<div
					className="web-workspace-setup-body"
					style={{
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						gap: "0.75rem",
					}}
				>
					<p className="web-workspace-installing" role="status" aria-live="polite" style={{ fontSize: "0.95rem", margin: 0 }}>
						{t("webWorkspace.installing", {
							done: status.done ?? 0,
							total: status.total ?? 0,
						})}
					</p>
				</div>
			)}

			{status.phase === "error" && (
				<div
					className="web-workspace-setup-body"
					style={{
						display: "flex",
						flexDirection: props.compact ? "row" : "column",
						alignItems: "center",
						gap: props.compact ? "0.5rem" : "1rem",
					}}
				>
					<p
						className="web-workspace-error-reason"
						role="alert"
						style={{ fontSize: "0.9rem", color: "var(--color-error, #e53e3e)", margin: 0, overflowWrap: "anywhere", maxHeight: props.compact ? "3em" : undefined, overflowY: props.compact ? "auto" : undefined }}
					>
						{status.reason}
					</p>
					<div className="web-workspace-actions">
						<ul
							className="web-workspace-actions-list"
							style={{ listStyle: "none", padding: 0, margin: 0 }}
						>
							<li>
								<button
									type="button"
									className="web-workspace-btn"
									data-testid="web-workspace-retry"
									onClick={handleRetry}
									style={{
										padding: "0.5rem 1.25rem",
										fontSize: "0.9rem",
										fontWeight: 500,
										borderRadius: "6px",
										cursor: "pointer",
									}}
								>
									{t("webWorkspace.retry")}
								</button>
							</li>
						</ul>
					</div>
				</div>
			)}
		</div>
	);
}

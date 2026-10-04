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
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				justifyContent: "center",
				padding: "2rem",
				textAlign: "center",
				gap: "1.25rem",
				flex: 1,
				width: "100%",
				minHeight: "200px",
			}}
		>
			{status.phase === "needs-setup" && (
				<div
					className="web-workspace-setup-body"
					style={{
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						gap: "1rem",
					}}
				>
					<p
						className="web-workspace-description"
						style={{ fontSize: "0.95rem", color: "var(--color-text-secondary, #888)", margin: 0 }}
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
					<p className="web-workspace-installing" style={{ fontSize: "0.95rem", margin: 0 }}>
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
						flexDirection: "column",
						alignItems: "center",
						gap: "1rem",
					}}
				>
					<p
						className="web-workspace-error-reason"
						style={{ fontSize: "0.9rem", color: "var(--color-error, #e53e3e)", margin: 0 }}
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

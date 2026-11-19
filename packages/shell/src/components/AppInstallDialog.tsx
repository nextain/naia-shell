import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { Logger } from "../lib/logger";
import {
	loadInstalledApps,
	refreshInstalledAppsIfChanged,
} from "../lib/app-loader";
import {
	getStoreGatewayUrl,
	getStoreProductName,
	hasStoreEntitlement,
	type AppInstallRequest,
} from "../lib/app-store-client";
import { t } from "../lib/i18n";
import { useAppStore } from "../stores/app";

interface AppInstallDialogProps {
	onClose: () => void;
	request?: AppInstallRequest;
}

type Mode = "git" | "file";

interface InstallResult {
	success: boolean;
	message: string;
}

interface AppInstallResult {
	id: string;
	name: string;
	path: string;
}

export function AppInstallDialog({ onClose, request }: AppInstallDialogProps) {
	const [mode, setMode] = useState<Mode>("git");
	const [gitUrl, setGitUrl] = useState("");
	const [loading, setLoading] = useState(false);
	const [result, setResult] = useState<InstallResult | null>(null);
	const [displayName, setDisplayName] = useState(request?.name || request?.appId || "");
	const [permissionExpansion, setPermissionExpansion] = useState<string[] | null>(null);
	const pushModal = useAppStore((s) => s.pushModal);
	const popModal = useAppStore((s) => s.popModal);

	// Hide Chrome X11 embed while dialog is open
	useEffect(() => {
		pushModal();
		return () => popModal();
	}, [pushModal, popModal]);

	useEffect(() => {
		if (!request || request.name) return;
		void getStoreProductName(request.appId)
			.then((name) => name && setDisplayName(name))
			.catch(() => {});
	}, [request]);

	async function handleInstall(allowPermissionExpansion = false) {
		if (request) {
			setLoading(true);
			setResult(null);
			setPermissionExpansion(null);
			try {
				if (!(await hasStoreEntitlement(request.appId))) {
					throw new Error(t("apps.loginRequired"));
				}
				const res = await invoke<AppInstallResult>("app_install_store", {
					appId: request.appId,
					gatewayUrl: getStoreGatewayUrl(),
					allowPermissionExpansion,
				});
				await refreshInstalledAppsIfChanged();
				setResult({
					success: true,
					message: t("apps.installed").replace("{name}", res.name),
				});
				// Match the git-install path: surface success briefly, launch the
				// freshly installed app, then close the dialog (previously the store
				// path left the popup open — "설치되면 팝업 닫혀야지", 2026-08-31).
				useAppStore.getState().setActiveApp(res.id);
				await new Promise((r) => setTimeout(r, 650));
				onClose();
			} catch (err) {
				const message = String(err);
				const prefix = "PERMISSION_EXPANSION:";
				if (message.includes(prefix)) {
					const encoded = message.slice(message.indexOf(prefix) + prefix.length).split(/[\r\n]/u)[0];
					try { setPermissionExpansion(JSON.parse(encoded) as string[]); }
					catch { setResult({ success: false, message }); }
				} else setResult({ success: false, message });
			} finally {
				setLoading(false);
			}
			return;
		}
		// Zip install is gated (#359) — only Git URL is wired today.
		if (mode !== "git") return;
		const source = gitUrl.trim();
		if (!source) return;

		setLoading(true);
		setResult(null);
		Logger.info("AppInstallDialog", `Installing app from ${mode}: ${source}`);
		try {
			// Direct shell-side install (HTTPS-only git clone). Ported from the
			// legacy agent skill (#89 / #257) into a Tauri command — install is a
			// filesystem operation, not an AI task.
			const res = await invoke<AppInstallResult>("app_install", { source });
			setResult({
				success: true,
				message: `설치 완료: ${res.name} (${res.id}) → ${res.path}`,
			});
			// Refresh the installed-app list so the new tab appears, then close.
			await loadInstalledApps().catch(() => {});
			await new Promise((r) => setTimeout(r, 650));
			onClose();
		} catch (err) {
			setResult({ success: false, message: String(err) });
		} finally {
			setLoading(false);
		}
	}

	return (
		<div
			className="app-install-overlay"
			onClick={onClose}
			onKeyDown={() => {}}
		>
			<div
				className="app-install-dialog"
				onClick={(e) => e.stopPropagation()}
				onKeyDown={() => {}}
			>
				<div className="app-install-header">
					<span className="app-install-title">{request ? "Naia Apps" : "앱 추가"}</span>
					<button
						type="button"
						className="app-install-close"
						onClick={onClose}
					>
						✕
					</button>
				</div>

				{request ? (
					<div className="app-install-body">
						<div className="app-install-notice" data-testid="app-install-product">
							<strong>{displayName}</strong>
							<p>{t("apps.defaultDescription")}</p>
						</div>
					</div>
				) : mode === "git" ? (
					<div className="app-install-body">
						<label className="app-install-label" htmlFor="git-url-input">
							Git URL
						</label>
						<input
							id="git-url-input"
							type="text"
							className="app-install-input"
							placeholder="https://github.com/user/my-app.git"
							value={gitUrl}
							onChange={(e) => setGitUrl(e.target.value)}
							onKeyDown={(e) => e.key === "Enter" && handleInstall()}
							disabled={loading}
						/>
						<p className="app-install-hint">
							비공개 저장소: URL에 토큰 포함 (https://TOKEN@github.com/...)
						</p>
					</div>
				) : (
					<div className="app-install-body">
						<div className="app-install-notice">
							🚧 Zip 파일 설치는 보안 강화 작업 중입니다 (#359). 현재는 Git URL
							설치만 지원합니다.
						</div>
					</div>
				)}

				{result && (
					<div
						className={`app-install-result ${result.success ? "success" : "error"}`}
					>
						{result.message}
					</div>
				)}
				{permissionExpansion && (
					<div className="app-install-result error" role="alert" data-testid="permission-expansion">
						<strong>{t("apps.permissionExpansionTitle")}</strong>
						<ul>{permissionExpansion.map((item) => <li key={item}>{item}</li>)}</ul>
						<p>{t("apps.permissionExpansionDescription")}</p>
						<button type="button" className="app-install-confirm-btn" disabled={loading} onClick={() => void handleInstall(true)}>
							{t("apps.permissionExpansionConfirm")}
						</button>
					</div>
				)}

				<div className="app-install-footer">
					{!request && <div className="app-install-tabs">
						<button
							type="button"
							className={`app-install-tab${mode === "git" ? " active" : ""}`}
							onClick={() => setMode("git")}
						>
							Git URL
						</button>
						<button
							type="button"
							className={`app-install-tab${mode === "file" ? " active" : ""}`}
							onClick={() => setMode("file")}
						>
							파일 (Zip · 준비 중)
						</button>
					</div>}
					<button
						type="button"
						className="app-install-cancel-btn"
						onClick={onClose}
						disabled={loading}
					>
						취소
					</button>
					<button
						type="button"
						className="app-install-confirm-btn"
						onClick={() => void handleInstall()}
						disabled={loading || (!request && (mode !== "git" || !gitUrl.trim()))}
					>
						{loading ? "설치 중..." : request ? "설치" : "추가"}
					</button>
				</div>
			</div>
		</div>
	);
}

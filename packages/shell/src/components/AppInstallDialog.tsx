import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { Logger } from "../lib/logger";
import { loadInstalledApps } from "../lib/app-loader";
import { useAppStore } from "../stores/app";

interface AppInstallDialogProps {
	onClose: () => void;
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

export function AppInstallDialog({ onClose }: AppInstallDialogProps) {
	const [mode, setMode] = useState<Mode>("git");
	const [gitUrl, setGitUrl] = useState("");
	const [loading, setLoading] = useState(false);
	const [result, setResult] = useState<InstallResult | null>(null);
	const pushModal = useAppStore((s) => s.pushModal);
	const popModal = useAppStore((s) => s.popModal);

	// Hide Chrome X11 embed while dialog is open
	useEffect(() => {
		pushModal();
		return () => popModal();
	}, [pushModal, popModal]);

	async function handleInstall() {
		// Zip install is gated (#359) — only Git URL is wired today.
		if (mode !== "git") return;
		const source = gitUrl.trim();
		if (!source) return;

		setLoading(true);
		setResult(null);
		Logger.info("AppInstallDialog", `Installing panel from ${mode}: ${source}`);
		try {
			// Direct shell-side install (HTTPS-only git clone). Ported from the
			// legacy agent skill (#89 / #257) into a Tauri command — install is a
			// filesystem operation, not an AI task.
			const res = await invoke<AppInstallResult>("app_install", { source });
			setResult({
				success: true,
				message: `설치 완료: ${res.name} (${res.id}) → ${res.path}`,
			});
			// Refresh the installed-panel list so the new tab appears, then close.
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
			className="panel-install-overlay"
			onClick={onClose}
			onKeyDown={() => {}}
		>
			<div
				className="panel-install-dialog"
				onClick={(e) => e.stopPropagation()}
				onKeyDown={() => {}}
			>
				<div className="panel-install-header">
					<span className="panel-install-title">앱 추가</span>
					<button
						type="button"
						className="panel-install-close"
						onClick={onClose}
					>
						✕
					</button>
				</div>

				{mode === "git" ? (
					<div className="panel-install-body">
						<label className="panel-install-label" htmlFor="git-url-input">
							Git URL
						</label>
						<input
							id="git-url-input"
							type="text"
							className="panel-install-input"
							placeholder="https://github.com/user/my-panel.git"
							value={gitUrl}
							onChange={(e) => setGitUrl(e.target.value)}
							onKeyDown={(e) => e.key === "Enter" && handleInstall()}
							disabled={loading}
						/>
						<p className="panel-install-hint">
							비공개 저장소: URL에 토큰 포함 (https://TOKEN@github.com/...)
						</p>
					</div>
				) : (
					<div className="panel-install-body">
						<div className="panel-install-notice">
							🚧 Zip 파일 설치는 보안 강화 작업 중입니다 (#359). 현재는 Git URL
							설치만 지원합니다.
						</div>
					</div>
				)}

				{result && (
					<div
						className={`panel-install-result ${result.success ? "success" : "error"}`}
					>
						{result.message}
					</div>
				)}

				<div className="panel-install-footer">
					<div className="panel-install-tabs">
						<button
							type="button"
							className={`panel-install-tab${mode === "git" ? " active" : ""}`}
							onClick={() => setMode("git")}
						>
							Git URL
						</button>
						<button
							type="button"
							className={`panel-install-tab${mode === "file" ? " active" : ""}`}
							onClick={() => setMode("file")}
						>
							파일 (Zip · 준비 중)
						</button>
					</div>
					<button
						type="button"
						className="panel-install-cancel-btn"
						onClick={onClose}
						disabled={loading}
					>
						취소
					</button>
					<button
						type="button"
						className="panel-install-confirm-btn"
						onClick={handleInstall}
						disabled={loading || mode !== "git" || !gitUrl.trim()}
					>
						{loading ? "설치 중..." : "추가"}
					</button>
				</div>
			</div>
		</div>
	);
}

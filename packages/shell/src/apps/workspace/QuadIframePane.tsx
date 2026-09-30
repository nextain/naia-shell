import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { t } from "../../lib/i18n";

export interface QuadIframePaneProps {
	title: string;
	url: string;
	paneId: "docs" | "dashboard";
	checkUrl?: string;
}

/**
 * 3142 서버 응답 여부를 no-cors fetch로 신속 확인한다 (FR-WORKSPACE-QUAD.4).
 * 포트가 닫혀 있으면 TCP 레벨에서 즉시 실패(TypeError: Failed to fetch)한다.
 */
export async function probeServerHealth(
	targetUrl = "http://localhost:3142",
	timeoutMs = 2500,
): Promise<boolean> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			await fetch(targetUrl, {
				method: "GET",
				mode: "no-cors",
				signal: controller.signal,
			});
			return true;
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return false;
	}
}

export function QuadIframePane({
	title,
	url,
	paneId,
	checkUrl = "http://localhost:3142",
}: QuadIframePaneProps) {
	const [online, setOnline] = useState<boolean | null>(null);
	const [probeAttempt, setProbeAttempt] = useState(0);
	const [reloadKey, setReloadKey] = useState(0);

	useEffect(() => {
		let cancelled = false;
		probeServerHealth(checkUrl).then((isUp) => {
			if (!cancelled) setOnline(isUp);
		});
		return () => {
			cancelled = true;
		};
	}, [checkUrl, probeAttempt]);

	const handleRetry = useCallback(() => {
		setOnline(null);
		setProbeAttempt((count) => count + 1);
		setReloadKey((key) => key + 1);
	}, []);

	const handleOpenExternal = useCallback(() => {
		invoke("open_url", { url }).catch(() => {
			if (typeof window !== "undefined") window.open(url, "_blank");
		});
	}, [url]);

	return (
		<div
			className={`workspace-quad__pane workspace-quad__pane--${paneId}`}
			data-testid={`quad-pane-${paneId}`}
		>
			<header className="workspace-quad__pane-header">
				<div className="workspace-quad__pane-title-group">
					<span className="workspace-quad__pane-title">{title}</span>
					<span className="workspace-quad__pane-url" title={url}>
						{url.replace(/^https?:\/\//, "")}
					</span>
				</div>
				<div className="workspace-quad__pane-actions">
					<button
						type="button"
						className="workspace-quad__pane-btn"
						onClick={handleRetry}
						title="새로고침"
						data-testid={`quad-${paneId}-reload`}
					>
						↻
					</button>
					<button
						type="button"
						className="workspace-quad__pane-btn"
						onClick={handleOpenExternal}
						title="외부 브라우저에서 열기"
						data-testid={`quad-${paneId}-external`}
					>
						↗
					</button>
				</div>
			</header>

			<div className="workspace-quad__pane-content">
				{online === false ? (
					<div
						className="workspace-quad__state workspace-quad__offline"
						role="alert"
						data-testid={`quad-${paneId}-offline`}
					>
						<span className="workspace-quad__offline-icon" aria-hidden="true">
							🔌
						</span>
						<h4 className="workspace-quad__offline-title">
							{paneId === "docs"
								? "문서 서버가 꺼져 있습니다"
								: "대시보드가 꺼져 있습니다"}
						</h4>
						<p className="workspace-quad__offline-url">{url}</p>
						<p className="workspace-quad__offline-desc">
							{paneId === "docs"
								? "3142 포트에서 문서 서버를 기동한 후 다시 시도해 주세요."
								: "3142 포트에서 ADK 서버를 기동한 후 다시 시도해 주세요."}
						</p>
						<button
							type="button"
							className="workspace-quad__retry-btn"
							data-testid={`quad-${paneId}-retry`}
							onClick={handleRetry}
						>
							{t("common.retry")}
						</button>
					</div>
				) : (
					<div className="workspace-quad__iframe-host">
						<iframe
							key={reloadKey}
							src={url}
							title={title}
							className="workspace-quad__iframe"
							data-testid={`quad-${paneId}-iframe`}
							sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
							onError={() => setOnline(false)}
						/>
					</div>
				)}
			</div>
		</div>
	);
}

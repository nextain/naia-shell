import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../lib/i18n";
import {
	UI_PREFERENCE_KEYS,
	type UiPreferenceKey,
	patchUiPreferences,
	useUiPreference,
} from "../../lib/ui-preferences";

export interface QuadIframePaneProps {
	title: string;
	paneId: "docs" | "dashboard";
	url?: string;
	checkUrl?: string;
	defaultUrl?: string;
	prefKey?: UiPreferenceKey;
}

/**
 * 이 컴퓨터의 http·https 루프백 주소만 허용하는 URL 정규화/검증 순수 함수.
 * hostname은 127.0.0.1, localhost, [::1] 중 하나여야 하며 사용자명/비밀번호는 허용하지 않는다.
 */
export function normalizeQuadPaneUrl(raw: unknown): { ok: true; url: string } | { ok: false } {
	if (typeof raw !== "string") return { ok: false };
	let trimmed = raw.trim();
	if (!trimmed) return { ok: false };
	trimmed = trimmed.replace(/^https?:\/\/::1(?=[:/]|$)/, (m) => m.replace("::1", "[::1]"));
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return { ok: false };
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { ok: false };
	}
	if (parsed.username !== "" || parsed.password !== "") {
		return { ok: false };
	}
	const hostname = parsed.hostname;
	if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]") {
		return { ok: false };
	}
	return { ok: true, url: parsed.href };
}

/**
 * 대상 서버 응답 여부를 no-cors fetch로 신속 확인한다 (FR-WORKSPACE-QUAD.4).
 * 포트가 닫혀 있으면 TCP 레벨에서 즉시 실패(TypeError: Failed to fetch)한다.
 */
export async function probeServerHealth(
	targetUrl: string,
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
	paneId,
	url,
	checkUrl,
	defaultUrl: customDefaultUrl,
	prefKey: customPrefKey,
}: QuadIframePaneProps) {
	const defaultUrl =
		customDefaultUrl ??
		(paneId === "docs"
			? "http://localhost:3142/docs"
			: "http://127.0.0.1:8896/");
	const prefKey =
		customPrefKey ??
		(paneId === "docs"
			? UI_PREFERENCE_KEYS.workspaceQuadDocsUrl
			: UI_PREFERENCE_KEYS.workspaceQuadBoardUrl);

	const rawPref = useUiPreference<unknown>(prefKey, undefined);

	let activeUrl: string;
	let hasInvalidPref = false;

	if (rawPref !== undefined && rawPref !== null && rawPref !== "") {
		const norm = normalizeQuadPaneUrl(rawPref);
		if (norm.ok) {
			activeUrl = norm.url;
		} else {
			activeUrl = url ?? defaultUrl;
			hasInvalidPref = true;
		}
	} else {
		activeUrl = url ?? defaultUrl;
	}

	const [online, setOnline] = useState<boolean | null>(null);
	const [probeAttempt, setProbeAttempt] = useState(0);
	const [reloadKey, setReloadKey] = useState(0);
	const observationSeqRef = useRef(0);

	useEffect(() => {
		const currentSeq = ++observationSeqRef.current;
		setOnline(null);
		let cancelled = false;
		probeServerHealth(checkUrl ?? activeUrl).then((isUp) => {
			if (!cancelled && observationSeqRef.current === currentSeq) {
				setOnline(isUp);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [activeUrl, checkUrl, probeAttempt]);

	const handleRetry = useCallback(() => {
		setProbeAttempt((count) => count + 1);
		setReloadKey((key) => key + 1);
	}, []);

	const handleOpenExternal = useCallback(() => {
		openUrl(activeUrl).catch(() => {
			if (typeof window !== "undefined") window.open(activeUrl, "_blank");
		});
	}, [activeUrl]);

	const handleIframeError = useCallback(() => {
		observationSeqRef.current += 1;
		setOnline(false);
	}, []);

	/**
	 * iframe 로드 완료 시 빈 문서(오류 페이지 등) 여부를 감지한다.
	 * 한계: 정상 교차 출처 로드와 X-Frame-Options·CSP frame-ancestors로 막힌 로드는
	 * 부모 프레임에서 둘 다 contentDocument === null 이고 contentWindow.document 접근이
	 * 보안 예외를 던지므로 부모에서 둘을 구분할 수 없다.
	 * 따라서 부모가 문서를 읽을 수 있을 때(같은 출처)만 빈 문서를 감지하여 오프라인으로 전환하며,
	 * contentDocument === null 이거나 contentWindow.document 접근이 예외를 던지면 상태를 바꾸지 않는다(온라인 유지).
	 */
	const handleIframeLoad = useCallback(
		(event: React.SyntheticEvent<HTMLIFrameElement>) => {
			const iframe = event.currentTarget;
			let doc: Document | null | undefined = null;
			try {
				doc = iframe.contentDocument || iframe.contentWindow?.document;
			} catch {
				// 교차 출처 차단 및 정상 교차 출처 로드 시 보안 예외는 구분 불가하므로 상태를 바꾸지 않음(온라인 유지)
				return;
			}
			if (!doc) {
				// 부모가 문서를 읽을 수 없는 경우(contentDocument === null 등) 상태를 바꾸지 않음(온라인 유지)
				return;
			}
			const isBlank =
				doc.location?.href === "about:blank" ||
				!doc.body ||
				(doc.body.children.length === 0 && !doc.body.textContent?.trim());
			if (isBlank) {
				observationSeqRef.current += 1;
				setOnline(false);
			}
		},
		[],
	);

	const [isEditingUrl, setIsEditingUrl] = useState(false);
	const [editUrlInput, setEditUrlInput] = useState("");
	const [urlError, setUrlError] = useState<string | null>(null);

	const startEditUrl = useCallback(() => {
		setEditUrlInput(typeof rawPref === "string" ? rawPref : activeUrl);
		setUrlError(null);
		setIsEditingUrl(true);
	}, [rawPref, activeUrl]);

	const cancelEditUrl = useCallback(() => {
		setIsEditingUrl(false);
		setUrlError(null);
	}, []);

	const saveUrl = useCallback(() => {
		const trimmed = editUrlInput.trim();
		if (trimmed === "") {
			void patchUiPreferences({ [prefKey]: undefined });
			setIsEditingUrl(false);
			setUrlError(null);
			return;
		}
		const norm = normalizeQuadPaneUrl(trimmed);
		if (!norm.ok) {
			setUrlError(t("workspace.quadInvalidUrlAlert"));
			return;
		}
		void patchUiPreferences({ [prefKey]: norm.url });
		setIsEditingUrl(false);
		setUrlError(null);
	}, [editUrlInput, prefKey]);

	return (
		<div
			className={`workspace-quad__pane workspace-quad__pane--${paneId}`}
			data-testid={`quad-pane-${paneId}`}
		>
			<header className="workspace-quad__pane-header">
				{isEditingUrl ? (
					<div className="workspace-quad__url-edit-group">
						<input
							type="text"
							className="workspace-quad__url-input"
							value={editUrlInput}
							onChange={(e) => {
								setEditUrlInput(e.target.value);
								setUrlError(null);
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									saveUrl();
								} else if (e.key === "Escape") {
									e.preventDefault();
									cancelEditUrl();
								}
							}}
							aria-label={t("workspace.quadUrlInputLabel", { name: title })}
							data-testid={`quad-${paneId}-url-input`}
							autoFocus
						/>
						<button
							type="button"
							className="workspace-quad__url-save-btn"
							onClick={saveUrl}
							data-testid={`quad-${paneId}-url-save`}
						>
							{t("workspace.quadSave")}
						</button>
						<button
							type="button"
							className="workspace-quad__url-cancel-btn"
							onClick={cancelEditUrl}
							data-testid={`quad-${paneId}-url-cancel`}
						>
							{t("workspace.quadCancel")}
						</button>
						{urlError && (
							<div
								role="alert"
								className="workspace-quad__url-error"
								data-testid={`quad-${paneId}-url-error`}
							>
								{urlError}
							</div>
						)}
					</div>
				) : (
					<div className="workspace-quad__pane-title-group">
						<span className="workspace-quad__pane-title">{title}</span>
						<span className="workspace-quad__pane-url" title={activeUrl}>
							{activeUrl.replace(/^https?:\/\//, "")}
						</span>
						<button
							type="button"
							className="workspace-quad__change-url-btn"
							onClick={startEditUrl}
							title={t("workspace.quadChangeUrl")}
							data-testid={`quad-${paneId}-change-url`}
						>
							{t("workspace.quadChangeUrl")}
						</button>
					</div>
				)}
				<div className="workspace-quad__pane-actions">
					<button
						type="button"
						className="workspace-quad__pane-btn"
						onClick={handleRetry}
						title={t("workspace.quadReload")}
						data-testid={`quad-${paneId}-reload`}
					>
						↻
					</button>
					<button
						type="button"
						className="workspace-quad__pane-btn"
						onClick={handleOpenExternal}
						title={t("workspace.quadOpenExternal")}
						data-testid={`quad-${paneId}-external`}
					>
						↗
					</button>
				</div>
			</header>

			{hasInvalidPref && (
				<div
					className="workspace-quad__pref-fallback-notice"
					role="note"
					data-testid={`quad-${paneId}-fallback-notice`}
				>
					{t("workspace.quadFallbackDefaultNotice")}
				</div>
			)}

			<div className="workspace-quad__pane-content">
				{online === null && (
					<div
						className="workspace-quad__state workspace-quad__checking"
						role="status"
						data-testid={`quad-${paneId}-checking`}
					>
						<span>{t("workspace.quadChecking")}</span>
					</div>
				)}
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
							{t("workspace.quadOfflineTitle", { name: title })}
						</h4>
						<p className="workspace-quad__offline-url">{activeUrl}</p>
						<p className="workspace-quad__offline-desc">
							{t("workspace.quadOfflineDesc", { url: activeUrl })}
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
							src={activeUrl}
							title={title}
							className="workspace-quad__iframe"
							data-testid={`quad-${paneId}-iframe`}
							sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
							onLoad={handleIframeLoad}
							onError={handleIframeError}
						/>
					</div>
				)}
			</div>

			<div className="workspace-quad__pane-footer">
				<span className="workspace-quad__pane-footer-text">
					{t("workspace.quadOpenBrowserNotice")}
				</span>
				<button
					type="button"
					className="workspace-quad__open-browser-btn"
					onClick={handleOpenExternal}
					data-testid={`quad-${paneId}-open-browser`}
				>
					{t("workspace.quadOpenBrowserBtn")}
				</button>
			</div>
		</div>
	);
}

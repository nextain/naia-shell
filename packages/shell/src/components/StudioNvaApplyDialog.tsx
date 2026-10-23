import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { getAdkPath, writeNaiaConfig } from "../lib/adk-store";
import { loadConfigWithSecrets, saveConfig } from "../lib/config";
import { t } from "../lib/i18n";
import { isPrebakedNvaManifest, parseNvaManifest } from "../lib/nva";
import { runStudioNvaApplyFlow } from "../lib/studio-nva-apply";
import type { StudioNvaApplyRequest } from "../lib/studio-nva-apply-request";
import { useAppStore } from "../stores/app";

interface AvatarPreview {
	name: string;
	thumbnailDataUrl: string;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isLoginRequiredError(error: unknown): boolean {
	return errorText(error).includes("naia_login_required");
}

function messageForError(error: unknown): string {
	const reason = errorText(error);
	if (reason.includes("naia_login_required")) {
		return t("studioNvaApply.loginRequired");
	}
	if (
		reason.includes("invalid_manifest") ||
		reason.includes("nva_manifest") ||
		reason.includes("nva_archive")
	) {
		return t("studioNvaApply.inspectFailed", { reason });
	}
	return t("studioNvaApply.applyFailed", { reason });
}

interface StudioNvaApplyDialogProps {
	/** Current request at the head of the host's queue. */
	request: StudioNvaApplyRequest;
	/** Removes the current request from the host's queue. */
	onClose: () => void;
}

export function StudioNvaApplyDialog({
	request,
	onClose,
}: StudioNvaApplyDialogProps) {
	const [preview, setPreview] = useState<AvatarPreview | null>(null);
	const [loadingPreview, setLoadingPreview] = useState(false);
	const [applying, setApplying] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [loginRequired, setLoginRequired] = useState(false);
	const [result, setResult] = useState<string | null>(null);
	const previewRequestIdRef = useRef<string | null>(null);

	const loadPreview = useCallback((target: StudioNvaApplyRequest) => {
		previewRequestIdRef.current = target.requestId;
		setPreview(null);
		setMessage(null);
		setLoginRequired(false);
		setResult(null);
		setLoadingPreview(true);
		void invoke<AvatarPreview>("studio_nva_apply_preview", {
			avatarId: target.avatarId,
			environment: target.environment,
		})
			.then((value) => {
				if (previewRequestIdRef.current === target.requestId) setPreview(value);
			})
			.catch((error: unknown) => {
				if (previewRequestIdRef.current === target.requestId) {
					setLoginRequired(isLoginRequiredError(error));
					setMessage(messageForError(error));
				}
			})
			.finally(() => {
				if (previewRequestIdRef.current === target.requestId) {
					setLoadingPreview(false);
				}
			});
	}, []);

	useEffect(() => {
		loadPreview(request);
	}, [request, loadPreview]);

	const ackAndClose = useCallback(() => {
		void invoke("studio_nva_apply_ack", { requestId: request.requestId }).catch(
			() => {},
		);
		if (previewRequestIdRef.current === request.requestId) {
			previewRequestIdRef.current = null;
		}
		setPreview(null);
		setMessage(null);
		setLoginRequired(false);
		setResult(null);
		onClose();
	}, [request, onClose]);

	const openLoginSettings = useCallback(() => {
		useAppStore.getState().setActiveApp("settings");
	}, []);

	const confirmApply = useCallback(async () => {
		if (!preview || applying) return;
		const adkPath = getAdkPath();
		if (!adkPath) {
			setLoginRequired(false);
			setMessage(t("studioNvaApply.workspaceRequired"));
			return;
		}
		setApplying(true);
		setLoginRequired(false);
		setMessage(null);
		try {
			const result = await runStudioNvaApplyFlow({
				confirmed: true,
				download: () =>
					invoke("studio_nva_apply_download", {
						avatarId: request.avatarId,
						environment: request.environment,
					}),
				inspectManifest: (manifestJson) => {
					const manifest = parseNvaManifest(manifestJson);
					if (!isPrebakedNvaManifest(manifest))
						throw new Error("nva_manifest_not_playable");
				},
				importAsset: (path) =>
					invoke<string>("import_naia_asset", {
						adkPath,
						subdir: "nva-files",
						sourcePath: path,
					}),
				applyModel: async (modelName) => {
					const config = await loadConfigWithSecrets();
					if (!config?.naiaKey) throw new Error("naia_login_required");
					const nextConfig = {
						...config,
						avatarProvider: "naia-video-avatar" as const,
						nvaModel: modelName,
					};
					await writeNaiaConfig(
						nextConfig as unknown as Record<string, unknown>,
					);
					saveConfig(nextConfig);
					window.dispatchEvent(new CustomEvent("naia-config-changed"));
				},
				cleanup: (path) => invoke("studio_nva_apply_cleanup", { path }),
			});
			if (result.status === "applied") {
				setResult(t("studioNvaApply.applied", { name: preview.name }));
			}
		} catch (error) {
			setLoginRequired(isLoginRequiredError(error));
			setMessage(messageForError(error));
		} finally {
			setApplying(false);
		}
	}, [request, preview, applying]);

	const dialogTitle = t("studioNvaApply.title");

	return (
		<div
			data-testid="studio-nva-apply-dialog-backdrop"
			style={{
				position: "fixed",
				inset: 0,
				zIndex: 100000,
				background: "rgba(0,0,0,.58)",
				display: "grid",
				placeItems: "center",
				padding: 20,
			}}
		>
			<dialog
				open
				aria-modal="true"
				aria-labelledby="studio-nva-apply-title"
				data-testid="studio-nva-apply-dialog"
				style={{
					width: "min(100%, 440px)",
					maxHeight: "90vh",
					overflow: "auto",
					margin: 0,
					border: 0,
					borderRadius: 16,
					background: "var(--background, #fff)",
					color: "var(--foreground, #111)",
					boxShadow: "0 24px 80px rgba(0,0,0,.3)",
					padding: 24,
				}}
			>
				<h2 id="studio-nva-apply-title">{dialogTitle}</h2>
				{loadingPreview && (
					<output aria-live="polite">
						{t("studioNvaApply.loadingPreview")}
					</output>
				)}
				{preview && (
					<div className="studio-nva-apply-preview">
						<img
							src={preview.thumbnailDataUrl}
							alt={t("studioNvaApply.previewAlt", { name: preview.name })}
							style={{
								display: "block",
								width: 128,
								height: 128,
								objectFit: "cover",
								borderRadius: 12,
							}}
						/>
						<strong>{preview.name}</strong>
					</div>
				)}
				{message && (
					<p role="alert" data-testid="studio-nva-apply-error">
						{message}
					</p>
				)}
				{result && (
					<output aria-live="polite" data-testid="studio-nva-apply-result">
						{result}
					</output>
				)}
				<div
					style={{
						display: "flex",
						justifyContent: "flex-end",
						gap: 8,
						marginTop: 20,
					}}
				>
					{message && loginRequired && (
						<button type="button" onClick={openLoginSettings}>
							{t("studioNvaApply.openLoginSettings")}
						</button>
					)}
					{message && !loadingPreview && !result && (
						<button type="button" onClick={() => loadPreview(request)}>
							{t("studioNvaApply.retryPreview")}
						</button>
					)}
					<button type="button" disabled={applying} onClick={ackAndClose}>
						{result ? t("studioNvaApply.close") : t("studioNvaApply.cancel")}
					</button>
					{!result && (
						<button
							type="button"
							data-testid="studio-nva-apply-confirm"
							disabled={!preview || loadingPreview || applying}
							onClick={() => void confirmApply()}
						>
							{applying
								? t("studioNvaApply.applying")
								: t("studioNvaApply.confirm")}
						</button>
					)}
				</div>
			</dialog>
		</div>
	);
}

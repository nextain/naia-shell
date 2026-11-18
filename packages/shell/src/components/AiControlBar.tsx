import { useEffect, useRef, useState } from "react";
import { writeNaiaUiConfig } from "../lib/adk-store";
import { getCameraActions } from "../lib/avatar/camera-actions";
import {
	isBroadcastActive,
	setBroadcastBridgeSnapshot,
	useBroadcastBridge,
} from "../lib/broadcast-audio-bridge";
import {
	type BroadcastConfirmationPreview,
	getBroadcastConfirmationPreview,
	requiresBroadcastConfirmation,
	startBroadcast,
	stopBroadcast,
} from "../lib/broadcast-client";
import {
	type AppConfig,
	loadConfig,
	loadConfigWithSecrets,
	saveConfig,
} from "../lib/config";
import { t } from "../lib/i18n";
import { isKioskDemo } from "../lib/kiosk-demo/flag";
import {
	UI_PREFERENCE_KEYS,
	getStoredLayoutOrientation,
	patchUiPreferences,
	toggleLayoutOrientation,
	useEffectiveLayoutOrientation,
	useUiPreference,
} from "../lib/ui-preferences";
import { useAppStore } from "../stores/app";

function formatElapsedShort(seconds: number): string {
	const safe = Math.max(0, Math.floor(seconds));
	const mm = String(Math.floor(safe / 60)).padStart(2, "0");
	const ss = String(safe % 60).padStart(2, "0");
	return `${mm}:${ss}`;
}

/**
 * AiControlBar — fixed overlay on the avatar area (top-left of naia column).
 * Rendered inside `.naia-overlay` so it stays within the avatar column.
 * Contains: AI interference toggle, TTS toggle, avatar joystick / pan / reset.
 */
export function AiControlBar({
	showCameraControls = true,
	isNva = false,
}: {
	showCameraControls?: boolean;
	isNva?: boolean;
} = {}) {
	const controlsExpanded =
		useUiPreference<boolean>(
			UI_PREFERENCE_KEYS.avatarControlsExpanded,
			false,
		) === true;
	const {
		aiInterferenceEnabled,
		toggleAiInterferenceEnabled,
		ttsEnabled,
		toggleTtsEnabled,
	} = useAppStore();
	const [joystickActive, setJoystickActive] = useState(false);
	const joystickActiveRef = useRef(false);
	const [panActive, setPanActive] = useState(false);
	const panActiveRef = useRef(false);
	const [proactive, setProactive] = useState({
		profile: "disabled" as NonNullable<AppConfig["proactiveSpeechProfile"]>,
		permitted: false,
		activityActive: false,
	});
	const broadcastBridge = useBroadcastBridge();
	const broadcastActive = isBroadcastActive(broadcastBridge.state);
	const [confirmPreview, setConfirmPreview] =
		useState<BroadcastConfirmationPreview | null>(null);
	const layoutOrientation = useEffectiveLayoutOrientation();
	const manualOrientation = getStoredLayoutOrientation();

	useEffect(() => {
		let disposed = false;
		const refresh = () => {
			void loadConfigWithSecrets().then((config) => {
				if (!config || disposed) return;
				const profile = config.proactiveSpeechProfile ?? "disabled";
				setProactive((current) => ({
					...current,
					profile,
					permitted: config.proactiveSpeechPermitted === true,
				}));
				setBroadcastBridgeSnapshot({
					hasStreamKey: Boolean(config.broadcastStreamKey?.trim()),
				});
			});
		};
		const onActivity = (event: Event) => {
			const active =
				(event as CustomEvent<{ active?: boolean }>).detail?.active === true;
			setProactive((current) => ({ ...current, activityActive: active }));
		};
		refresh();
		window.addEventListener("naia-config-changed", refresh);
		window.addEventListener("naia-proactive-activity-state", onActivity);
		return () => {
			disposed = true;
			window.removeEventListener("naia-config-changed", refresh);
			window.removeEventListener("naia-proactive-activity-state", onActivity);
		};
	}, []);

	// #510 — 능동발화는 TTS와 독립: TTS 꺼짐이면 발화만 생략되고 텍스트로 도착한다
	//        (canSpeakProactiveText가 발화 여부를 판정). 버튼은 프로필 유무만 본다.
	const proactiveBlocked = proactive.profile === "disabled";
	const proactiveActive = proactive.permitted && proactive.activityActive;
	const proactiveTitle = proactiveBlocked
		? t("ai.proactiveBlocked")
		: proactive.permitted
			? t("ai.proactiveStop")
			: t("ai.proactiveStart");

	const toggleProactive = () => {
		if (proactiveBlocked) return;
		void (async () => {
			const config = await loadConfigWithSecrets();
			if (!config) return;
			const permitted = !proactive.permitted;
			const next = { ...config, proactiveSpeechPermitted: permitted };
			const persisted = await writeNaiaUiConfig(
				next as unknown as Record<string, unknown>,
			);
			if (!persisted) return;
			saveConfig(next);
			window.dispatchEvent(
				new CustomEvent("naia-proactive-permission-change", {
					detail: { permitted },
				}),
			);
		})();
	};

	const aiLabel = aiInterferenceEnabled
		? t("ai.interferenceOn")
		: t("ai.interferenceOff");
	const ttsLabel = ttsEnabled ? t("ai.ttsOn") : t("ai.ttsOff");
	const broadcastLabel =
		!broadcastBridge.hasStreamKey && !broadcastActive
			? t("broadcast.keyRequiredHint")
			: broadcastBridge.state === "live"
				? `${t("broadcast.btnLabel")} ${formatElapsedShort(broadcastBridge.elapsedSeconds)}`
				: broadcastBridge.state === "disconnected"
					? `${t("broadcast.btnLabel")} · ${t("broadcast.disconnectedLabel")}`
					: t("broadcast.btnLabel");
	const kioskDemo = isKioskDemo();

	const zoomControls = (
		<>
			<button
				type="button"
				className="bgm-ai-toggle ai-control-bar__zoom"
				aria-label={t("ai.avatarZoomIn")}
				data-usage-event="ai-control-bar.button-4.click"
				title={t("ai.avatarZoomIn")}
				onClick={() => {
					const camera = getCameraActions();
					camera.zoom(0.1);
					camera.save();
				}}
			>
				<span className="bgm-ai-toggle__dot" />+
			</button>

			<button
				type="button"
				className="bgm-ai-toggle ai-control-bar__zoom"
				aria-label={t("ai.avatarZoomOut")}
				data-usage-event="ai-control-bar.button-5.click"
				title={t("ai.avatarZoomOut")}
				onClick={() => {
					const camera = getCameraActions();
					camera.zoom(-0.1);
					camera.save();
				}}
			>
				<span className="bgm-ai-toggle__dot" />−
			</button>
		</>
	);

	return (
		<div className="ai-control-bar">
			{!kioskDemo && (
				<button
					type="button"
					data-testid="ai-bar-interference-btn"
					data-control-state={aiInterferenceEnabled ? "on" : "off"}
					className={`bgm-ai-toggle bgm-ai-toggle--icon${aiInterferenceEnabled ? " bgm-ai-toggle--active" : " bgm-ai-toggle--off"}`}
					data-usage-event="ai-control-bar.toggle-ai-interference-enabled-1.click"
					onClick={toggleAiInterferenceEnabled}
					aria-pressed={aiInterferenceEnabled}
					aria-label={aiLabel}
					title={aiLabel}
				>
					<span className="bgm-ai-toggle__dot" />
					{aiInterferenceEnabled ? (
						<svg
							className="bgm-ai-toggle__icon"
							viewBox="0 0 24 24"
							aria-hidden="true"
						>
							<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
							<circle cx="19" cy="5" r="1.2" />
						</svg>
					) : (
						<svg
							className="bgm-ai-toggle__icon"
							viewBox="0 0 24 24"
							aria-hidden="true"
						>
							<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
							<line data-off-slash="true" x1="4" y1="4" x2="20" y2="20" />
						</svg>
					)}
				</button>
			)}

			<button
				type="button"
				data-testid="ai-bar-tts-btn"
				data-control-state={ttsEnabled ? "on" : "off"}
				className={`bgm-ai-toggle bgm-ai-toggle--icon${ttsEnabled ? " bgm-ai-toggle--active" : " bgm-ai-toggle--off"}`}
				data-usage-event="ai-control-bar.toggle-tts-enabled-2.click"
				onClick={() => {
					const enabled = !ttsEnabled;
					toggleTtsEnabled();
					const cfg = loadConfig();
					if (cfg) saveConfig({ ...cfg, ttsEnabled: enabled });
					window.dispatchEvent(
						new CustomEvent("naia:tts-enabled-change", {
							detail: { enabled },
						}),
					);
				}}
				aria-pressed={ttsEnabled}
				aria-label={ttsLabel}
				title={ttsLabel}
			>
				<span className="bgm-ai-toggle__dot" />
				{ttsEnabled ? (
					<svg
						className="bgm-ai-toggle__icon"
						viewBox="0 0 24 24"
						aria-hidden="true"
					>
						<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
						<path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
						<path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
					</svg>
				) : (
					<svg
						className="bgm-ai-toggle__icon"
						viewBox="0 0 24 24"
						aria-hidden="true"
					>
						<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
						<line data-off-slash="true" x1="23" y1="9" x2="17" y2="15" />
						<line x1="17" y1="9" x2="23" y2="15" />
					</svg>
				)}
			</button>

			<button
				type="button"
				data-testid="layout-orientation-toggle"
				data-layout-orientation={layoutOrientation}
				className={`bgm-ai-toggle bgm-ai-toggle--icon${manualOrientation !== null ? " bgm-ai-toggle--active" : ""}`}
				aria-pressed={manualOrientation !== null}
				aria-label={
					layoutOrientation === "portrait"
						? t("ui.switchToLandscape")
						: t("ui.switchToPortrait")
				}
				title={
					layoutOrientation === "portrait"
						? t("ui.switchToLandscape")
						: t("ui.switchToPortrait")
				}
				data-usage-event="ai-control-bar.v026-add-1.click"
				onClick={() => {
					const next = toggleLayoutOrientation(layoutOrientation);
					if (isKioskDemo()) {
						const store = useAppStore.getState();
						if (next === "landscape" && store.activeApp === null) {
							store.setActiveApp("workspace");
						} else if (next === "portrait" && store.activeApp === "workspace") {
							store.setActiveApp(null);
						}
					}
				}}
			>
				<span className="bgm-ai-toggle__dot" />
				{layoutOrientation === "portrait" ? (
					<svg
						className="bgm-ai-toggle__icon"
						viewBox="0 0 24 24"
						aria-hidden="true"
					>
						<rect x="3" y="6" width="18" height="12" rx="2" />
						<path d="M10 6v12" />
					</svg>
				) : (
					<svg
						className="bgm-ai-toggle__icon"
						viewBox="0 0 24 24"
						aria-hidden="true"
					>
						<rect x="6" y="3" width="12" height="18" rx="2" />
						<path d="M6 14h12" />
					</svg>
				)}
			</button>

			{!kioskDemo && (
				<button
					type="button"
					data-testid="ai-bar-proactive-btn"
					className={`bgm-ai-toggle bgm-ai-toggle--icon${proactive.permitted ? " bgm-ai-toggle--active" : ""}${proactiveBlocked ? " bgm-ai-toggle--blocked" : ""}`}
					data-usage-event="ai-control-bar.toggle-proactive-3.click"
					onClick={toggleProactive}
					aria-pressed={proactive.permitted}
					aria-label={proactiveTitle}
					aria-describedby="proactive-control-tooltip"
					title={proactiveTitle}
					data-proactive-state={
						proactiveBlocked
							? "blocked"
							: proactiveActive
								? "active"
								: proactive.permitted
									? "ready"
									: "off"
					}
				>
					<span className="bgm-ai-toggle__dot" />
					<svg
						className="bgm-ai-toggle__icon"
						viewBox="0 0 24 24"
						aria-hidden="true"
					>
						<path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.64 5.64l2.12 2.12m8.48 8.48 2.12 2.12m0-12.72-2.12 2.12M7.76 16.24l-2.12 2.12" />
						<circle cx="12" cy="12" r="3.25" />
					</svg>
					<span
						id="proactive-control-tooltip"
						className="ai-control-tooltip"
						role="tooltip"
					>
						{proactiveTitle}
					</span>
				</button>
			)}

			{!kioskDemo && (
				<button
					type="button"
					data-testid="ai-bar-broadcast-btn"
					data-broadcast-state={broadcastBridge.state}
					data-control-state={broadcastActive ? "on" : "off"}
					className={`bgm-ai-toggle bgm-ai-toggle--icon${broadcastActive ? " bgm-ai-toggle--active" : " bgm-ai-toggle--off"}${!broadcastBridge.hasStreamKey && !broadcastActive ? " bgm-ai-toggle--blocked" : ""}`}
					disabled={!broadcastBridge.hasStreamKey && !broadcastActive}
					aria-pressed={broadcastActive}
					aria-label={broadcastLabel}
					title={broadcastLabel}
					data-usage-event="ai-control-bar.main-merge-1.click"
					onClick={() => {
						if (broadcastActive) {
							void stopBroadcast().catch(() => {});
							return;
						}
						if (requiresBroadcastConfirmation()) {
							setConfirmPreview(
								getBroadcastConfirmationPreview(loadConfig()),
							);
							void loadConfigWithSecrets()
								.then((cfg) => {
									if (cfg) {
										setConfirmPreview((prev) =>
											prev
												? getBroadcastConfirmationPreview(cfg)
												: null,
										);
									}
								})
								.catch(() => {});
							return;
						}
						void startBroadcast().catch(() => {});
					}}
				>
					<span
						className="bgm-ai-toggle__dot"
						style={
							broadcastBridge.state === "live"
								? { background: "#ef4444" }
								: broadcastBridge.state === "disconnected"
									? { background: "#f59e0b" }
									: undefined
						}
					/>
					{broadcastActive ? (
						<svg
							className="bgm-ai-toggle__icon"
							viewBox="0 0 24 24"
							aria-hidden="true"
						>
							<circle cx="12" cy="12" r="2" />
							<path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14" />
						</svg>
					) : (
						<svg
							className="bgm-ai-toggle__icon"
							viewBox="0 0 24 24"
							aria-hidden="true"
						>
							<circle cx="12" cy="12" r="2" />
							<path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49" />
							<line x1="4" y1="4" x2="20" y2="20" />
						</svg>
					)}
				</button>
			)}

			{showCameraControls && (
				<>
					<div className="ai-control-bar__sep" />

					<button
						type="button"
						className="bgm-ai-toggle"
						aria-label={t("ai.avatarControls")}
						title={t("ai.avatarControls")}
						aria-expanded={controlsExpanded}
						aria-controls="avatar-camera-controls"
						data-usage-event="ai-control-bar.main-merge-2.click"
						onClick={() =>
							void patchUiPreferences({
								[UI_PREFERENCE_KEYS.avatarControlsExpanded]: !controlsExpanded,
							})
						}
					>
						⚙
					</button>
					{controlsExpanded && (
						<div
							id="avatar-camera-controls"
							className={`ai-control-bar__camera${isNva ? " ai-control-bar__camera--nva" : ""}`}
						>
							{isNva && zoomControls}

							{!isNva && (
								<button
									type="button"
									className={`bgm-ai-toggle${joystickActive ? " bgm-ai-toggle--active" : ""}`}
									aria-label={t("ai.avatarRotate")}
									title={t("ai.avatarRotate")}
									style={{
										cursor: joystickActive ? "grabbing" : "grab",
										touchAction: "none",
									}}
									onPointerDown={(e) => {
										e.currentTarget.setPointerCapture(e.pointerId);
										joystickActiveRef.current = true;
										setJoystickActive(true);
									}}
									onPointerMove={(e) => {
										if (!joystickActiveRef.current) return;
										getCameraActions().rotate(e.movementX, e.movementY);
									}}
									onPointerUp={(e) => {
										e.currentTarget.releasePointerCapture(e.pointerId);
										joystickActiveRef.current = false;
										setJoystickActive(false);
										getCameraActions().save();
									}}
									onPointerCancel={(e) => {
										e.currentTarget.releasePointerCapture(e.pointerId);
										joystickActiveRef.current = false;
										setJoystickActive(false);
									}}
								>
									<span className="bgm-ai-toggle__dot" />⊕
								</button>
							)}
							<button
								type="button"
								className={`bgm-ai-toggle${panActive ? " bgm-ai-toggle--active" : ""}`}
								aria-label={t("ai.avatarPan")}
								title={t("ai.avatarPan")}
								style={{
									cursor: panActive ? "grabbing" : "grab",
									touchAction: "none",
								}}
								onPointerDown={(e) => {
									e.currentTarget.setPointerCapture(e.pointerId);
									panActiveRef.current = true;
									setPanActive(true);
								}}
								onPointerMove={(e) => {
									if (!panActiveRef.current) return;
									getCameraActions().pan(e.movementX, e.movementY);
								}}
								onPointerUp={(e) => {
									e.currentTarget.releasePointerCapture(e.pointerId);
									panActiveRef.current = false;
									setPanActive(false);
									getCameraActions().save();
								}}
								onPointerCancel={(e) => {
									e.currentTarget.releasePointerCapture(e.pointerId);
									panActiveRef.current = false;
									setPanActive(false);
								}}
							>
								<span className="bgm-ai-toggle__dot" />✥
							</button>

							{!isNva && zoomControls}
							<button
								type="button"
								className="bgm-ai-toggle"
								aria-label={t("ai.avatarReset")}
								data-usage-event="ai-control-bar.button-6.click"
								title={t("ai.avatarReset")}
								onClick={() => getCameraActions().reset()}
							>
								<span className="bgm-ai-toggle__dot" />⌂
							</button>
						</div>
					)}
				</>
			)}

			{broadcastBridge.lastError && (
				<div
					role="alert"
					data-testid="broadcast-error-alert"
					className="ai-control-bar__broadcast-error"
					style={{
						display: "flex",
						alignItems: "center",
						gap: 6,
						padding: "4px 8px",
						borderRadius: 6,
						background: "rgba(127, 29, 29, 0.92)",
						color: "#fecaca",
						fontSize: 12,
						maxWidth: 360,
					}}
				>
					<span>{broadcastBridge.lastError}</span>
					<button
						type="button"
						data-testid="broadcast-error-dismiss-btn"
						aria-label={t("studioNvaApply.close")}
						style={{
							background: "transparent",
							border: "none",
							color: "inherit",
							cursor: "pointer",
							padding: "0 2px",
						}}
						data-usage-event="ai-control-bar.v026-add-2.click"
						onClick={() => setBroadcastBridgeSnapshot({ lastError: null })}
					>
						×
					</button>
				</div>
			)}

			{confirmPreview && (
				<div
					role="dialog"
					aria-modal="true"
					aria-label={t("broadcast.confirmTitle")}
					data-testid="broadcast-confirm-dialog"
					className="ai-control-bar__broadcast-confirm"
					style={{
						display: "flex",
						flexDirection: "column",
						gap: 6,
						padding: "10px 12px",
						borderRadius: 8,
						background: "rgba(15, 23, 42, 0.95)",
						color: "#f8fafc",
						fontSize: 12,
						maxWidth: 360,
						border: "1px solid rgba(148, 163, 184, 0.35)",
					}}
				>
					<div style={{ fontWeight: 600 }}>
						{t("broadcast.confirmTitle")}
					</div>
					<div>{t("broadcast.confirmDesc")}</div>
					<div>
						<strong>{t("broadcast.confirmDestination")}:</strong>{" "}
						<span data-testid="broadcast-confirm-destination">
							{confirmPreview.destinationDisplay}
						</span>
					</div>
					<div>
						<strong>{t("broadcast.confirmTarget")}:</strong>{" "}
						<span data-testid="broadcast-confirm-target">
							{confirmPreview.captureTarget}
						</span>
					</div>
					<div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
						<button
							type="button"
							data-testid="broadcast-confirm-cancel-btn"
							className="bgm-ai-toggle"
							data-usage-event="ai-control-bar.v026-add-3.click"
							onClick={() => setConfirmPreview(null)}
						>
							{t("broadcast.confirmCancelBtn")}
						</button>
						<button
							type="button"
							data-testid="broadcast-confirm-start-btn"
							className="bgm-ai-toggle bgm-ai-toggle--active"
							data-usage-event="ai-control-bar.v026-add-4.click"
							onClick={() => {
								setConfirmPreview(null);
								void startBroadcast().catch(() => {});
							}}
						>
							{t("broadcast.confirmStartBtn")}
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

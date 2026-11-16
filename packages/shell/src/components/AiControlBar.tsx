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
export function AiControlBar() {
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

	return (
		<div className="ai-control-bar">
			<button
				type="button"
				className={`bgm-ai-toggle${aiInterferenceEnabled ? " bgm-ai-toggle--active" : ""}`}
				onClick={toggleAiInterferenceEnabled}
				aria-pressed={aiInterferenceEnabled}
				title={
					aiInterferenceEnabled
						? t("ai.interferenceOn")
						: t("ai.interferenceOff")
				}
			>
				<span className="bgm-ai-toggle__dot" />
				AI
			</button>

			<button
				type="button"
				className={`bgm-ai-toggle${ttsEnabled ? " bgm-ai-toggle--active" : ""}`}
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
				title={ttsEnabled ? t("ai.ttsOn") : t("ai.ttsOff")}
			>
				<span className="bgm-ai-toggle__dot" />
				TTS
			</button>

			<button
				type="button"
				className={`bgm-ai-toggle bgm-ai-toggle--icon${proactive.permitted ? " bgm-ai-toggle--active" : ""}${proactiveBlocked ? " bgm-ai-toggle--blocked" : ""}`}
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

			<button
				type="button"
				data-testid="ai-bar-broadcast-btn"
				data-broadcast-state={broadcastBridge.state}
				className={`bgm-ai-toggle${broadcastActive ? " bgm-ai-toggle--active" : ""}${!broadcastBridge.hasStreamKey && !broadcastActive ? " bgm-ai-toggle--blocked" : ""}`}
				disabled={!broadcastBridge.hasStreamKey && !broadcastActive}
				aria-pressed={broadcastActive}
				title={
					!broadcastBridge.hasStreamKey && !broadcastActive
						? t("broadcast.keyRequiredHint")
						: t("broadcast.btnLabel")
				}
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
				{t("broadcast.btnLabel")}
				{broadcastBridge.state === "live"
					? ` ${formatElapsedShort(broadcastBridge.elapsedSeconds)}`
					: broadcastBridge.state === "disconnected"
						? ` · ${t("broadcast.disconnectedLabel")}`
						: ""}
			</button>

			<div className="ai-control-bar__sep" />

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

			<button
				type="button"
				className={`bgm-ai-toggle${panActive ? " bgm-ai-toggle--active" : ""}`}
				aria-label={t("ai.avatarPan")}
				title={t("ai.avatarPan")}
				style={{ cursor: panActive ? "grabbing" : "grab", touchAction: "none" }}
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

			<button
				type="button"
				className="bgm-ai-toggle"
				aria-label={t("ai.avatarZoomIn")}
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
				className="bgm-ai-toggle"
				aria-label={t("ai.avatarZoomOut")}
				title={t("ai.avatarZoomOut")}
				onClick={() => {
					const camera = getCameraActions();
					camera.zoom(-0.1);
					camera.save();
				}}
			>
				<span className="bgm-ai-toggle__dot" />−
			</button>

			<button
				type="button"
				className="bgm-ai-toggle"
				aria-label={t("ai.avatarReset")}
				title={t("ai.avatarReset")}
				onClick={() => getCameraActions().reset()}
			>
				<span className="bgm-ai-toggle__dot" />⌂
			</button>

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
							onClick={() => setConfirmPreview(null)}
						>
							{t("broadcast.confirmCancelBtn")}
						</button>
						<button
							type="button"
							data-testid="broadcast-confirm-start-btn"
							className="bgm-ai-toggle bgm-ai-toggle--active"
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

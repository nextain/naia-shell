import { useEffect, useRef, useState } from "react";
import { writeNaiaUiConfig } from "../lib/adk-store";
import { getCameraActions } from "../lib/avatar/camera-actions";
import {
	isBroadcastActive,
	setBroadcastBridgeSnapshot,
	useBroadcastBridge,
} from "../lib/broadcast-audio-bridge";
import {
	type AppConfig,
	loadConfig,
	loadConfigWithSecrets,
	saveConfig,
} from "../lib/config";
import { t } from "../lib/i18n";
import { isKioskDemo } from "../lib/kiosk-demo/flag";
import {
	getStoredLayoutOrientation,
	toggleLayoutOrientation,
	useEffectiveLayoutOrientation,
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
}: {
	showCameraControls?: boolean;
} = {}) {
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

	return (
		<div className="ai-control-bar">
			{!kioskDemo && (
				<button
					type="button"
					data-testid="ai-bar-interference-btn"
					data-control-state={aiInterferenceEnabled ? "on" : "off"}
					className={`bgm-ai-toggle bgm-ai-toggle--icon${aiInterferenceEnabled ? " bgm-ai-toggle--active" : " bgm-ai-toggle--off"}`}
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
							<line x1="4" y1="4" x2="20" y2="20" />
						</svg>
					)}
				</button>
			)}

			<button
				type="button"
				data-testid="ai-bar-tts-btn"
				data-control-state={ttsEnabled ? "on" : "off"}
				className={`bgm-ai-toggle bgm-ai-toggle--icon${ttsEnabled ? " bgm-ai-toggle--active" : " bgm-ai-toggle--off"}`}
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
						<line x1="23" y1="9" x2="17" y2="15" />
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
						? "가로 배치로 전환"
						: "세로 배치로 전환"
				}
				title={
					layoutOrientation === "portrait"
						? "가로 배치로 전환"
						: "세로 배치로 전환"
				}
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
					onClick={() => {
						void import("../lib/broadcast-client").then(({ toggleBroadcast }) =>
							toggleBroadcast().catch(() => {}),
						);
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
				</>
			)}
		</div>
	);
}

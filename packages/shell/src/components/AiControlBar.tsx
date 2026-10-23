import { useEffect, useRef, useState } from "react";
import { writeNaiaUiConfig } from "../lib/adk-store";
import { getCameraActions } from "../lib/avatar/camera-actions";
import {
	type AppConfig,
	loadConfig,
	loadConfigWithSecrets,
	saveConfig,
} from "../lib/config";
import { t } from "../lib/i18n";
import { useAppStore } from "../stores/app";
import { useCascadeAvatarStore } from "../stores/cascade-avatar";

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
	const activeAvatarRenderer = useCascadeAvatarStore((state) => state.renderer);
	const gestureActions = activeAvatarRenderer
		? getCameraActions().getGestureActions()
		: [];

	const [joystickActive, setJoystickActive] = useState(false);
	const joystickActiveRef = useRef(false);
	const [panActive, setPanActive] = useState(false);
	const panActiveRef = useRef(false);
	const [proactive, setProactive] = useState({
		profile: "disabled" as NonNullable<AppConfig["proactiveSpeechProfile"]>,
		permitted: false,
		activityActive: false,
	});

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

			{gestureActions.length > 0 && (
				<div
					className="ai-control-bar__gestures"
					role="group"
					aria-label={t("ai.avatarGestures")}
				>
					{gestureActions.map((action) => (
						<button
							key={action.key}
							type="button"
							className="bgm-ai-toggle"
							aria-label={action.label}
							title={action.label}
							data-nva-gesture-key={action.key}
							onClick={() => {
								void getCameraActions().playAction(action.key);
							}}
						>
							<span className="bgm-ai-toggle__dot" />{action.label}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

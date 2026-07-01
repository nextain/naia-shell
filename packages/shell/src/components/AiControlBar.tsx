import { useRef, useState } from "react";
import { loadConfig, saveConfig } from "../lib/config";
import { t } from "../lib/i18n";
import { getCameraActions } from "../lib/avatar/camera-actions";
import { useAppStore } from "../stores/app";

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

	return (
		<div className="ai-control-bar">
			<button
				type="button"
				className={`bgm-ai-toggle${aiInterferenceEnabled ? " bgm-ai-toggle--active" : ""}`}
				onClick={toggleAiInterferenceEnabled}
				aria-pressed={aiInterferenceEnabled}
				title={aiInterferenceEnabled ? t("ai.interferenceOn") : t("ai.interferenceOff")}
			>
				<span className="bgm-ai-toggle__dot" />
				AI
			</button>

			<button
				type="button"
				className={`bgm-ai-toggle${ttsEnabled ? " bgm-ai-toggle--active" : ""}`}
				onClick={() => {
					toggleTtsEnabled();
					const cfg = loadConfig();
					if (cfg) saveConfig({ ...cfg, ttsEnabled: !ttsEnabled });
				}}
				aria-pressed={ttsEnabled}
				title={ttsEnabled ? t("ai.ttsOn") : t("ai.ttsOff")}
			>
				<span className="bgm-ai-toggle__dot" />
				TTS
			</button>

			<div className="ai-control-bar__sep" />

			<button
				type="button"
				className={`bgm-ai-toggle${joystickActive ? " bgm-ai-toggle--active" : ""}`}
				title={t("ai.avatarRotate")}
				style={{ cursor: joystickActive ? "grabbing" : "grab", touchAction: "none" }}
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
				<span className="bgm-ai-toggle__dot" />
				⊕
			</button>

			<button
				type="button"
				className={`bgm-ai-toggle${panActive ? " bgm-ai-toggle--active" : ""}`}
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
				<span className="bgm-ai-toggle__dot" />
				✥
			</button>

			<button
				type="button"
				className="bgm-ai-toggle"
				title={t("ai.avatarReset")}
				onClick={() => getCameraActions().reset()}
			>
				<span className="bgm-ai-toggle__dot" />
				⌂
			</button>
		</div>
	);
}

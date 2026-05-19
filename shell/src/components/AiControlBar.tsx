import { useRef, useState } from "react";
import { loadConfig, saveConfig } from "../lib/config";
import { usePanelStore } from "../stores/panel";
import { getCameraActions } from "./AvatarCanvas";

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
	} = usePanelStore();

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
				title={aiInterferenceEnabled ? "AI 참견 끄기 (Ctrl+Alt+A)" : "AI 참견 켜기 (Ctrl+Alt+A)"}
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
				title={ttsEnabled ? "말하기 끄기" : "말하기 켜기"}
			>
				<span className="bgm-ai-toggle__dot" />
				TTS
			</button>

			<div className="ai-control-bar__sep" />

			<button
				type="button"
				className={`bgm-ai-toggle${joystickActive ? " bgm-ai-toggle--active" : ""}`}
				title="드래그해서 아바타 회전"
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
				title="드래그해서 아바타 이동"
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
				title="아바타 뷰 초기화"
				onClick={() => getCameraActions().reset()}
			>
				<span className="bgm-ai-toggle__dot" />
				⌂
			</button>
		</div>
	);
}

import { t } from "../lib/i18n";
import { useEffect, useState } from "react";
import {
	KIOSK_VOICE_STATE_EVENT,
	type KioskVoiceState,
} from "../lib/tts/kiosk-voice-gate";

/** 바쁨·대체 알림이 '정상' 소식 없이 남아 있는 최대 시간. */
export const KIOSK_VOICE_NOTICE_MS = 8_000;

/** 시연판: 지나 목소리가 붐비거나 다른 목소리로 바뀔 때 대화창 위에 한 줄 알린다. */
export function KioskVoiceNotice() {
	const [state, setState] = useState<KioskVoiceState>("ok");
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const onState = (event: Event) => {
			const next = (event as CustomEvent<{ state?: KioskVoiceState }>).detail
				?.state;
			if (!next) return;
			clearTimeout(timer);
			setState(next);
			if (next !== "ok") {
				timer = setTimeout(() => setState("ok"), KIOSK_VOICE_NOTICE_MS);
			}
		};
		window.addEventListener(KIOSK_VOICE_STATE_EVENT, onState);
		return () => {
			clearTimeout(timer);
			window.removeEventListener(KIOSK_VOICE_STATE_EVENT, onState);
		};
	}, []);
	if (state === "ok") return null;
	return (
		<div
			className="kiosk-voice-notice"
			data-testid="kiosk-voice-notice"
			data-voice-state={state}
			role="status"
		>
			{t(`kioskVoice.${state}`)}
		</div>
	);
}

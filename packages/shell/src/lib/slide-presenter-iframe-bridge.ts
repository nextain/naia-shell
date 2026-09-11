import { Logger } from "./logger";
import {
	SLIDE_PRESENTER_CANCEL_EVENT,
	SLIDE_PRESENTER_SPEAK_EVENT,
	SLIDE_PRESENTER_SPEECH_RESULT_EVENT,
	type SlidePresenterSpeechRequest,
	type SlidePresenterSpeechResult,
} from "./slide-presenter-events";

// Installed apps run in an asset-protocol iframe; only that origin may drive TTS.
// Linux(WebKitGTK)의 convertFileSrc 는 `asset://localhost` origin 을 준다 (2026-09-11 실측).
const ALLOWED_ORIGINS = new Set([
	"http://asset.localhost",
	"https://asset.localhost",
	"asset://localhost",
]);
const ALLOWED_ORIGIN = "http://asset.localhost";

/**
 * Bridge slide-presenter speech between an installed Slides app (asset.localhost
 * iframe) and the Shell's TTS pipeline in ChatArea.
 *
 * The built-in Slides app dispatches `SLIDE_PRESENTER_SPEAK_EVENT` as a window
 * CustomEvent that ChatArea already handles. An installed Slides app runs in an
 * iframe, so `requestSlidePresenterSpeech` posts `naia-slides:speak` to the
 * parent instead — but nothing re-dispatched it as the window event, so
 * narration never entered TTS, no `speech-finished` came back, and presenting
 * stalled on the first slide (2026-09-01 rehearsal: installed deck stuck at
 * 1/63 in real WebView2). This forwards speak/cancel from the iframe into the
 * window events ChatArea listens for, and forwards the resulting
 * `SLIDE_PRESENTER_SPEECH_RESULT_EVENT` back to the requesting iframe as
 * `naia-slides:speech-result`, closing the loop so the deck auto-advances.
 *
 * Call once from App.tsx. Returns a cleanup function.
 */
export function startSlidePresenterIframeBridge(): () => void {
	let slidesFrame: Window | null = null;
	let slidesFrameOrigin: string | null = null;

	const onMessage = (event: MessageEvent) => {
		if (!ALLOWED_ORIGINS.has(event.origin)) return;
		const data = event.data as
			| { type?: string; detail?: unknown }
			| null
			| undefined;
		if (!data || typeof data !== "object") return;
		if (data.type === "naia-slides:speak") {
			// Remember the requesting frame so results route back to it only.
			slidesFrame = event.source as Window | null;
			slidesFrameOrigin = event.origin;
			window.dispatchEvent(
				new CustomEvent<SlidePresenterSpeechRequest>(
					SLIDE_PRESENTER_SPEAK_EVENT,
					{ detail: data.detail as SlidePresenterSpeechRequest },
				),
			);
		} else if (data.type === "naia-slides:cancel") {
			window.dispatchEvent(
				new CustomEvent(SLIDE_PRESENTER_CANCEL_EVENT, {
					detail: data.detail ?? {},
				}),
			);
		}
	};

	const onResult = (event: Event) => {
		if (!slidesFrame) return;
		const detail = (event as CustomEvent<SlidePresenterSpeechResult>).detail;
		slidesFrame.postMessage(
			{ type: "naia-slides:speech-result", detail },
			slidesFrameOrigin ?? ALLOWED_ORIGIN,
		);
	};

	// DEV-ONLY (2026-09-11 영상 제작 임시): 로컬 프록시에서 슬라이드 제어 명령을 폴링해
	// 설치 앱 iframe 에 skill_slide_presenter 도구 호출로 전달한다. 키보드 포커스가
	// iframe 밖에 있을 때 발표를 재개·이동하기 위한 우회로. 릴리스 빌드에는 포함되지 않는다.
	let devPoll: ReturnType<typeof setInterval> | null = null;
	if (import.meta.env.DEV) {
		devPoll = setInterval(() => {
			fetch("http://127.0.0.1:8919/slides-cmd")
				.then((r) => r.json())
				.then((cmd: { action?: string; page?: number }) => {
					if (!cmd?.action) return;
					const frame =
						slidesFrame ??
						(
							document.querySelector(
								".generic-installed-app__iframe",
							) as HTMLIFrameElement | null
						)?.contentWindow ??
						null;
					if (!frame) {
						Logger.warn(
							"slides-bridge",
							"dev slides-cmd dropped — no slides frame yet",
							cmd,
						);
						return;
					}
					frame.postMessage(
						{
							type: "naia-tool-call",
							id: `dev-${Date.now()}`,
							tool: "skill_slide_presenter",
							args: cmd,
						},
						slidesFrameOrigin ?? "*",
					);
					Logger.info("slides-bridge", "dev slides-cmd forwarded", cmd);
				})
				.catch(() => {});
		}, 2000);
	}
	window.addEventListener("message", onMessage);
	window.addEventListener(SLIDE_PRESENTER_SPEECH_RESULT_EVENT, onResult);
	return () => {
		if (devPoll) clearInterval(devPoll);
		window.removeEventListener("message", onMessage);
		window.removeEventListener(SLIDE_PRESENTER_SPEECH_RESULT_EVENT, onResult);
	};
}

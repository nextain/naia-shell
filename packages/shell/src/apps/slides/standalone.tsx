import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
	AppContext,
	NaiaContextBridge,
	ToolHandler,
} from "../../lib/app-registry";
import { type Locale, getLocale, initializeI18n, setLocale } from "../../lib/i18n";
import { Logger } from "../../lib/logger";
import {
	SLIDE_PRESENTER_SPEECH_RESULT_EVENT,
	type SlidePresenterSpeechRequest,
	type SlidePresenterSpeechResult,
	isSlidePresenterConsumerActive,
	setSlidePresenterSpeechTransport,
} from "../../lib/slide-presenter-events";
import {
	SLIDES_HOST_ENVIRONMENT_EVENT,
	startSlidesHostClientBridge,
} from "../../lib/slides-host";
import { SlidesCenterArea } from "./SlidesCenterArea";
import "./standalone.css";

const APP_ID = "land.naia.slides";
const TAG = "SlidesStandalone";
const handlers = new Map<string, ToolHandler>();

let appHostBridgeActive = false;
let activeInstalledSpeech: {
	originalRequestId: string;
	bridgeId: string;
	generation: number;
	page: number;
} | null = null;
let activeStandaloneUtteranceId: string | null = null;

const bridge: NaiaContextBridge = {
	pushContext(context: AppContext) {
		if (window.parent !== window) {
			window.parent.postMessage({ type: "naia-app:context", context }, "*");
		}
	},
	onToolCall(name, handler) {
		handlers.set(name, handler);
		return () => handlers.delete(name);
	},
	async logBehavior() {},
	async queryBehavior() {
		return [];
	},
	async getSecret() {
		return null;
	},
	async setSecret() {},
	async readFile() {
		throw new Error("Use the Slides file picker");
	},
	async runShell() {
		throw new Error("Shell access is not required by Naia Slides");
	},
};

function isAssetProtocolLocation(): boolean {
	if (typeof window === "undefined") return false;
	const { protocol, host } = window.location;
	return (
		protocol === "asset:" ||
		host === "asset.localhost" ||
		host.startsWith("asset.localhost:")
	);
}

function dispatchSpeechResult(detail: SlidePresenterSpeechResult): void {
	window.dispatchEvent(
		new CustomEvent<SlidePresenterSpeechResult>(
			SLIDE_PRESENTER_SPEECH_RESULT_EVENT,
			{ detail },
		),
	);
}

function installWebAndStandaloneSpeechFallback(): void {
	setSlidePresenterSpeechTransport({
		speak(detail) {
			// 1) Web App Store host bridge (`naia-app:speak` when `naia-app:locale` was received on non-asset origin)
			if (
				window.parent !== window &&
				appHostBridgeActive &&
				!isAssetProtocolLocation()
			) {
				const safeId = detail.requestId.replace(/[^\w-]/g, "-").slice(0, 96);
				activeInstalledSpeech = {
					originalRequestId: detail.requestId,
					bridgeId: safeId,
					generation: detail.generation,
					page: detail.page,
				};
				window.parent.postMessage(
					{
						type: "naia-app:speak",
						appId: APP_ID,
						id: safeId,
						text: detail.text.slice(0, 2000),
					},
					"*",
				);
				return;
			}

			// 2) Desktop Tauri / Slides host iframe (`naia-slides:speak`)
			if (window.parent !== window) {
				window.parent.postMessage({ type: "naia-slides:speak", detail }, "*");
				return;
			}

			// 3) Top-level window with Tauri or Shell consumer active
			if ("__TAURI_INTERNALS__" in window || isSlidePresenterConsumerActive()) {
				window.dispatchEvent(
					new CustomEvent<SlidePresenterSpeechRequest>(
						"naia:slide-presenter-speak",
						{ detail },
					),
				);
				return;
			}

			// 4) Pure standalone browser tab fallback via Web Speech API
			if (
				typeof window.speechSynthesis !== "undefined" &&
				typeof SpeechSynthesisUtterance !== "undefined"
			) {
				activeStandaloneUtteranceId = detail.requestId;
				const utterance = new SpeechSynthesisUtterance(detail.text);
				utterance.lang = getLocale();
				utterance.onend = () => {
					if (activeStandaloneUtteranceId !== detail.requestId) return;
					activeStandaloneUtteranceId = null;
					dispatchSpeechResult({
						requestId: detail.requestId,
						generation: detail.generation,
						page: detail.page,
						status: "finished",
					});
				};
				utterance.onerror = () => {
					if (activeStandaloneUtteranceId !== detail.requestId) return;
					activeStandaloneUtteranceId = null;
					dispatchSpeechResult({
						requestId: detail.requestId,
						generation: detail.generation,
						page: detail.page,
						status: "failed",
						error: "speech_synthesis_failed",
					});
				};
				window.speechSynthesis.speak(utterance);
				return;
			}

			dispatchSpeechResult({
				requestId: detail.requestId,
				generation: detail.generation,
				page: detail.page,
				status: "failed",
				error: "speech_unavailable",
			});
		},
		cancel(detail) {
			if (
				window.parent !== window &&
				appHostBridgeActive &&
				!isAssetProtocolLocation()
			) {
				if (activeInstalledSpeech) {
					const id = activeInstalledSpeech.bridgeId;
					activeInstalledSpeech = null;
					window.parent.postMessage(
						{
							type: "naia-app:speak-cancel",
							appId: APP_ID,
							id,
						},
						"*",
					);
				}
				return;
			}
			if (window.parent !== window) {
				window.parent.postMessage({ type: "naia-slides:cancel", detail }, "*");
				return;
			}
			if ("__TAURI_INTERNALS__" in window || isSlidePresenterConsumerActive()) {
				window.dispatchEvent(
					new CustomEvent("naia:slide-presenter-cancel", { detail }),
				);
				return;
			}
			if (activeStandaloneUtteranceId) {
				activeStandaloneUtteranceId = null;
				window.speechSynthesis?.cancel();
			}
		},
	});
}

window.addEventListener("message", async (event) => {
	const message = event.data;
	if (!message || typeof message !== "object") return;

	if (event.source === window.parent && message.type === "naia-app:locale") {
		appHostBridgeActive = true;
		if (typeof message.locale === "string" && message.locale) {
			Logger.debug(TAG, "applying host locale", { locale: message.locale });
			await setLocale(message.locale as Locale);
			window.dispatchEvent(new CustomEvent(SLIDES_HOST_ENVIRONMENT_EVENT));
		}
		return;
	}

	if (
		event.source === window.parent &&
		message.type === "naia-app:speech-result" &&
		activeInstalledSpeech &&
		message.id === activeInstalledSpeech.bridgeId
	) {
		const settled = activeInstalledSpeech;
		activeInstalledSpeech = null;
		const status =
			message.status === "finished" ||
			message.status === "cancelled" ||
			message.status === "failed"
				? message.status
				: "failed";
		dispatchSpeechResult({
			requestId: settled.originalRequestId,
			generation: settled.generation,
			page: settled.page,
			status,
			error: typeof message.error === "string" ? message.error : undefined,
		});
		return;
	}

	if (event.source !== window.parent || message.type !== "naia-tool-call") {
		return;
	}
	const handler = handlers.get(message.tool);
	try {
		const result = handler
			? await handler(message.args ?? {})
			: `No handler registered for tool: ${message.tool}`;
		window.parent.postMessage(
			{ type: "naia-tool-result", id: message.id, result },
			"*",
		);
	} catch (error) {
		window.parent.postMessage(
			{
				type: "naia-tool-result",
				id: message.id,
				error: error instanceof Error ? error.message : String(error),
			},
			"*",
		);
	}
});

function StandaloneSlides() {
	const [, forceRender] = useState(0);
	useEffect(() => {
		const onEnvironment = () => forceRender((value) => value + 1);
		window.addEventListener(SLIDES_HOST_ENVIRONMENT_EVENT, onEnvironment);
		return () =>
			window.removeEventListener(SLIDES_HOST_ENVIRONMENT_EVENT, onEnvironment);
	}, []);
	// Re-rendering this stable component applies translated labels and CSS
	// variables without remounting SlidesCenterArea or losing the current deck.
	return (
		<SlidesCenterArea
			naia={bridge}
			sampleDeck={{
				pdfUrl: "./sample/naia-team-intro.pdf",
				scriptUrl: "./sample/naia-team-intro.md",
			}}
		/>
	);
}

async function bootstrap() {
	Logger.debug(TAG, "bootstrapping standalone slides app");
	await initializeI18n();
	installWebAndStandaloneSpeechFallback();
	const host = startSlidesHostClientBridge();
	await host.ready;
	const root = document.getElementById("root");
	if (!root) return;
	createRoot(root).render(
		<React.StrictMode>
			<StandaloneSlides />
		</React.StrictMode>,
	);
}

void bootstrap();

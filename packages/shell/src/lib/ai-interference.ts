import { useAppStore } from "../stores/app";
import { Logger } from "./logger";

export interface AiInterferenceEvent {
	source: "browser" | "app" | "workspace" | "system" | "bgm";
	action: string;
	title?: string;
	url?: string;
	appId?: string | null;
	summary?: string;
}

const EVENT_NAME = "naia:interference-event";
const MIN_INTERVAL_MS = 15_000;
const lastSentAt = new Map<string, number>();

function eventKey(event: AiInterferenceEvent): string {
	return [
		event.source,
		event.action,
		event.url ?? event.appId ?? event.summary ?? "",
	].join("|");
}

export function emitAiInterferenceEvent(event: AiInterferenceEvent): void {
	if (!useAppStore.getState().aiInterferenceEnabled) return;
	const key = eventKey(event);
	const now = Date.now();
	const last = lastSentAt.get(key) ?? 0;
	if (now - last < MIN_INTERVAL_MS) return;
	lastSentAt.set(key, now);
	Logger.info("AiInterference", "event emitted", {
		source: event.source,
		action: event.action,
		url: event.url,
		appId: event.appId,
	});
	window.dispatchEvent(
		new CustomEvent<AiInterferenceEvent>(EVENT_NAME, { detail: event }),
	);
}

export function onAiInterferenceEvent(
	handler: (event: AiInterferenceEvent) => void,
): () => void {
	const listener = (event: Event) => {
		handler((event as CustomEvent<AiInterferenceEvent>).detail);
	};
	window.addEventListener(EVENT_NAME, listener);
	return () => window.removeEventListener(EVENT_NAME, listener);
}

export function formatAiInterferencePrompt(event: AiInterferenceEvent): string {
	const lines = [
		"AI interference mode is enabled and an app event was received.",
		`source: ${event.source}`,
		`action: ${event.action}`,
	];
	if (event.appId) lines.push(`app: ${event.appId}`);
	if (event.title) lines.push(`title: ${event.title}`);
	if (event.url) lines.push(`url: ${event.url}`);
	if (event.summary) lines.push(`summary: ${event.summary}`);
	lines.push(
		"If help is useful, make a brief suggestion. If nothing is needed, say so in one quiet sentence.",
	);
	return lines.join("\n");
}

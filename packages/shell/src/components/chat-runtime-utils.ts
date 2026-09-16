import { loadConfig } from "../lib/config";
import { environmentSession } from "../lib/environment-skill";
import { getLocale } from "../lib/i18n";
import { Logger } from "../lib/logger";
import type { MemoryContext } from "../lib/persona";
import type { EnvironmentSegment } from "../lib/types";
import { selectPromptAppContexts, useAppStore } from "../stores/app";
import { useAvatarStore } from "../stores/avatar";

export async function buildMemoryContext(): Promise<MemoryContext> {
	const ctx: MemoryContext = {};
	try {
		const cfg = loadConfig();
		ctx.userName = cfg?.userName;
		ctx.agentName = cfg?.agentName;
		ctx.locale = cfg?.locale || getLocale();
		ctx.honorific = cfg?.honorific;
		ctx.speechStyle = cfg?.speechStyle;
		const appContexts = selectPromptAppContexts(useAppStore.getState());
		if (appContexts.length > 0) ctx.appContexts = appContexts;
	} catch (error) {
		Logger.warn("ChatArea", "Failed to build memory context", {
			error: String(error),
		});
	}
	return ctx;
}

/**
 * Build only shell-owned environment context for agent text turns. Persona and
 * locale remain core-owned; live voice paths consume the full memory context
 * separately when they assemble their own system instruction.
 */
export function buildEnvironmentSegments(
	memoryContext: MemoryContext,
	responseStyle: "brief" | "normal" = "normal",
	toolReady = true,
): EnvironmentSegment[] {
	const segments: EnvironmentSegment[] = [{ kind: "avatarEmotion" }];
	if (memoryContext.appContexts?.length) {
		segments.push({
			kind: "app",
			entries: memoryContext.appContexts.map(({ type, data }) => ({
				type,
				data,
			})),
		});
	}
	const awareness = loadConfig()?.environmentAwareness ?? "auto";
	// `always` is an explicit user policy and remains useful without the tool.
	// In auto mode, omit the segment when the environment tool is unavailable so
	// the model is never instructed to call a tool that was not registered.
	const surfaces =
		awareness === "always" || toolReady
			? environmentSession.segment(awareness)
			: null;
	if (surfaces) segments.push(surfaces);
	if (responseStyle === "brief") {
		segments.push({ kind: "responseStyle", style: "brief" });
	}
	return segments;
}

let voiceSessionSequence = 0;

/** Return a process-unique owner key so stale voice cleanup cannot stop a newer watcher. */
export function nextVoiceSessionKey(): string {
	voiceSessionSequence += 1;
	return `voice-${voiceSessionSequence}`;
}

let currentAudio: HTMLAudioElement | null = null;

/** Play base64 MP3 through HTMLAudio, retaining it for WebKitGTK playback. */
export function playBase64Audio(base64: string): void {
	Logger.info("ChatArea", "Audio chunk received", { length: base64.length });
	const avatarStore = useAvatarStore.getState();
	avatarStore.setSpeaking(true);
	avatarStore.setPendingAudio(base64);
	if (currentAudio) {
		currentAudio.pause();
		currentAudio = null;
	}

	const audio = new Audio(`data:audio/mp3;base64,${base64}`);
	currentAudio = audio;
	audio.onended = () => {
		Logger.info("ChatArea", "Audio playback ended");
		currentAudio = null;
		avatarStore.setSpeaking(false);
	};
	audio.onerror = (error) => {
		Logger.warn("ChatArea", "Audio playback error", { error: String(error) });
		currentAudio = null;
		avatarStore.setSpeaking(false);
	};
	audio.play().then(
		() => Logger.info("ChatArea", "Audio play() started"),
		(error) => {
			Logger.warn("ChatArea", "Audio play() rejected", {
				error: String(error),
			});
			currentAudio = null;
			avatarStore.setSpeaking(false);
		},
	);
}

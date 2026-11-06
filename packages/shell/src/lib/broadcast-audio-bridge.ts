import { useSyncExternalStore } from "react";

export type BroadcastUiState =
	| "idle"
	| "starting"
	| "live"
	| "disconnected"
	| "stopping";

export interface BroadcastBridgeSnapshot {
	state: BroadcastUiState;
	elapsedSeconds: number;
	hasStreamKey: boolean;
	lastError: string | null;
}

let bridgeSnapshot: BroadcastBridgeSnapshot = {
	state: "idle",
	elapsedSeconds: 0,
	hasStreamKey: false,
	lastError: null,
};

const listeners = new Set<() => void>();

export function getBroadcastBridgeSnapshot(): BroadcastBridgeSnapshot {
	return bridgeSnapshot;
}

export function setBroadcastBridgeSnapshot(
	patch: Partial<BroadcastBridgeSnapshot>,
): void {
	const next: BroadcastBridgeSnapshot = { ...bridgeSnapshot, ...patch };
	if (
		next.state === bridgeSnapshot.state &&
		next.elapsedSeconds === bridgeSnapshot.elapsedSeconds &&
		next.hasStreamKey === bridgeSnapshot.hasStreamKey &&
		next.lastError === bridgeSnapshot.lastError
	) {
		return;
	}
	bridgeSnapshot = next;
	for (const listener of listeners) {
		listener();
	}
}

export function subscribeBroadcastBridge(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function useBroadcastBridge(): BroadcastBridgeSnapshot {
	return useSyncExternalStore(
		subscribeBroadcastBridge,
		getBroadcastBridgeSnapshot,
		getBroadcastBridgeSnapshot,
	);
}

export function isBroadcastActive(
	state: BroadcastUiState = bridgeSnapshot.state,
): boolean {
	return (
		state === "starting" || state === "live" || state === "disconnected"
	);
}

let sharedAudioContext: AudioContext | null = null;
let broadcastTapNode: AudioNode | null = null;
const attachedMediaElements = new WeakMap<HTMLMediaElement, AudioNode>();
const activeMediaNodes = new Set<AudioNode>();

/**
 * Return the shared 48kHz Web Audio context used by both TTS and local BGM.
 */
export function getSharedAudioContext(outputDeviceId?: string): AudioContext {
	if (
		!sharedAudioContext ||
		(typeof AudioContext === "function" &&
			!(sharedAudioContext instanceof AudioContext))
	) {
		sharedAudioContext = new AudioContext({ sampleRate: 48000 });
	}
	const ctx = sharedAudioContext;
	if (ctx.state === "suspended") {
		ctx.resume().catch(() => {});
	}
	const setSinkId = (
		ctx as unknown as { setSinkId?: (id: string) => Promise<void> }
	).setSinkId;
	if (outputDeviceId && setSinkId) {
		setSinkId.call(ctx, outputDeviceId).catch(() => {});
	}
	return ctx;
}

/**
 * Connect a Web Audio source node (such as streaming PCM TTS) to both
 * speaker output (`ctx.destination`) and the active broadcast AudioWorklet tap.
 */
export function connectSourceNodeToSharedContext(
	sourceNode: AudioNode,
	ctx: AudioContext,
): void {
	sourceNode.connect(ctx.destination);
	if (broadcastTapNode) {
		try {
			sourceNode.connect(broadcastTapNode);
		} catch {
			/* ignore cross-context or mock node errors */
		}
	}
}

/**
 * Route an HTMLMediaElement (TTS `<audio>` or local BGM `<audio>`) through
 * the shared Web Audio context so its audio reaches both speakers and the
 * broadcast AudioWorklet tap when broadcasting is active.
 */
export function attachMediaElementToSharedContext(
	audio: HTMLMediaElement,
	options: { transient?: boolean } = {},
): void {
	if (typeof AudioContext !== "function") return;
	const existing = attachedMediaElements.get(audio);
	if (existing) {
		if (sharedAudioContext?.state === "suspended") {
			sharedAudioContext.resume().catch(() => {});
		}
		return;
	}
	try {
		const ctx = getSharedAudioContext();
		if (typeof ctx.createMediaElementSource !== "function") return;
		const mediaNode = ctx.createMediaElementSource(audio);
		attachedMediaElements.set(audio, mediaNode);
		mediaNode.connect(ctx.destination);
		activeMediaNodes.add(mediaNode);
		if (broadcastTapNode) {
			try {
				mediaNode.connect(broadcastTapNode);
			} catch {
				/* ignore */
			}
		}
		if (options.transient && typeof audio.addEventListener === "function") {
			const cleanup = () => {
				activeMediaNodes.delete(mediaNode);
				try {
					mediaNode.disconnect();
				} catch {
					/* ignore */
				}
			};
			audio.addEventListener("ended", cleanup, { once: true });
			audio.addEventListener("error", cleanup, { once: true });
		}
	} catch {
		/* ignore in test/non-WebAudio environments */
	}
}

/**
 * Attach or detach the broadcast AudioWorklet tap node.
 * Active only while broadcasting so there is zero worklet overhead when idle.
 */
export function setBroadcastAudioTapNode(tapNode: AudioNode | null): void {
	if (broadcastTapNode && broadcastTapNode !== tapNode) {
		for (const mediaNode of activeMediaNodes) {
			try {
				mediaNode.disconnect(broadcastTapNode);
			} catch {
				/* ignore */
			}
		}
	}
	broadcastTapNode = tapNode;
	if (tapNode) {
		for (const mediaNode of activeMediaNodes) {
			try {
				mediaNode.connect(tapNode);
			} catch {
				/* ignore */
			}
		}
	}
}

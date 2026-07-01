/**
 * Panel-context → Live-session bridge (#313 L3).
 *
 * Live audio sessions hold a persistent WebSocket and freeze their
 * `systemInstruction` at connect time. When a panel pushes new context
 * mid-session (e.g. the browser navigates, the workspace selects a different
 * issue), `buildSystemPrompt()` is only re-invoked for request-response
 * models — Live sessions miss the update entirely.
 *
 * This bridge closes that gap:
 *   1. Subscribes to a `AppContext` source (typically `useAppStore`).
 *   2. Debounces rapid changes (default 500ms) so URL-bar typing or repeat
 *      pushContext() calls do not flood the open WS.
 *   3. Calls `session.sendContextUpdate(ctx)` when present — silently drops
 *      otherwise, so providers without mid-session inject (vllm-omni etc.)
 *      degrade gracefully back to the next-turn `systemInstruction` path.
 *
 * Strict scope:
 *   - This module owns NO state about the live session lifecycle. The caller
 *     (ChatArea) attaches the bridge after `voiceSessionRef.current = session`
 *     and detaches on disconnect. We do not introspect `session.isConnected`
 *     here — that is the provider's job inside `sendContextUpdate`.
 *   - We do not retain a queue. If a provider drops the update (paused, not
 *     connected, no `sendContextUpdate` method), it is lost; the next change
 *     re-arrives via the same subscriber. This matches the spec's
 *     "drop silently when Live session is paused/closed".
 *
 * Out of scope (#313 L4+):
 *   - Replay-on-resume after a Live reconnect.
 *   - Diffing — every update is sent in full. Panel data payloads are
 *     already minimal (browser: {url,title}, workspace: {selectedIssue}).
 */

import { Logger } from "../logger";
import type { AppContextUpdate, VoiceSession } from "./types";

/** Default debounce window — see codex cross-review for rationale. */
export const DEFAULT_DEBOUNCE_MS = 500;

/** Source of panel-context updates. Modeled on `Zustand.subscribe`. */
export interface AppContextSource {
	/**
	 * Subscribe to context changes. The listener fires each time the source's
	 * active context changes. Returns an unsubscribe function.
	 *
	 * NOTE: the listener fires for ANY change in the source state — we filter
	 * to only the panel-context field internally.
	 */
	subscribe(listener: () => void): () => void;
	/** Current panel context snapshot. `null` when no panel is active. */
	getContext(): AppContextUpdate | null;
}

export interface AppContextBridgeOptions {
	/** Override the debounce window (ms). Default 500. */
	debounceMs?: number;
	/**
	 * Replay the last-known context immediately on attach.
	 *
	 * Default `false` — only forward NEW changes after attach. This matches
	 * the L2 frozen-tools rationale: at session open, ChatArea already passes
	 * the current `activeAppContext` into `buildMemoryContext()` →
	 * `systemInstruction`, so an on-mount replay would just duplicate that.
	 * Set to `true` only if a future code path bypasses the system-prompt
	 * baking step (e.g. reconnect-without-replay scenarios).
	 */
	replayOnAttach?: boolean;
	/** Test-only injection point for setTimeout. */
	scheduler?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	/** Test-only injection point for clearTimeout. */
	cancel?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface AppContextBridge {
	/** Detach the subscription and cancel any pending debounced send. */
	detach(): void;
	/**
	 * Force-flush the pending debounced update synchronously.
	 *
	 * Intended for tests and for the unmount/disconnect path so an in-flight
	 * "navigation just happened" payload is not lost when the user voice-ends
	 * within the debounce window.
	 */
	flushPending(): void;
}

/**
 * Attach a debounced bridge from a `AppContextSource` to a `VoiceSession`.
 *
 * The bridge:
 *   - skips when `session.sendContextUpdate` is undefined (provider has no
 *     mid-session inject API → silent fallback to next-turn system prompt).
 *   - skips when the new context is structurally identical to the last
 *     dispatched payload (cheap JSON.stringify equality — fine because the
 *     payloads are < 1 KB).
 *
 * @returns a `AppContextBridge` handle. ALWAYS call `detach()` from the
 *   caller's cleanup path; the bridge does not auto-unsubscribe on session
 *   disconnect (the session never told it about disconnect).
 */
export function attachAppContextBridge(
	session: VoiceSession,
	source: AppContextSource,
	options: AppContextBridgeOptions = {},
): AppContextBridge {
	const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	const schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> =
		options.scheduler ??
		((fn, ms) => setTimeout(fn, ms) as ReturnType<typeof setTimeout>);
	const cancel: (handle: ReturnType<typeof setTimeout>) => void =
		options.cancel ?? ((handle) => clearTimeout(handle));

	let pending: AppContextUpdate | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let lastDispatchedJSON: string | null = null;
	let detached = false;

	if (typeof session.sendContextUpdate !== "function") {
		Logger.info(
			"AppContextBridge",
			"session has no sendContextUpdate — bridge is a no-op (likely vllm-omni or naia-omni; mid-session inject not supported)",
		);
		// Still return a real bridge handle so callers do not branch on null.
		return {
			detach: () => {
				detached = true;
			},
			flushPending: () => undefined,
		};
	}

	function dispatch() {
		timer = null;
		if (detached) return;
		const ctx = pending;
		pending = null;
		if (!ctx) return;
		let serialized: string;
		try {
			serialized = JSON.stringify(ctx);
		} catch {
			return;
		}
		if (serialized === lastDispatchedJSON) return;
		lastDispatchedJSON = serialized;
		try {
			session.sendContextUpdate?.(ctx);
		} catch (err) {
			// Provider promised silent drop on close — if it threw anyway,
			// log and move on rather than crash the React render.
			Logger.warn("AppContextBridge", "sendContextUpdate threw", {
				error: String(err),
				type: ctx.type,
			});
		}
	}

	function schedulePending(ctx: AppContextUpdate) {
		pending = ctx;
		if (timer !== null) cancel(timer);
		timer = schedule(dispatch, debounceMs);
	}

	function onChange() {
		if (detached) return;
		const ctx = source.getContext();
		if (!ctx) return;
		schedulePending(ctx);
	}

	const unsubscribe = source.subscribe(onChange);

	if (options.replayOnAttach) {
		// Use the debounce path so on-mount replay still respects the
		// rate-limit promise made to callers.
		onChange();
	}

	return {
		detach() {
			if (detached) return;
			detached = true;
			unsubscribe();
			if (timer !== null) {
				cancel(timer);
				timer = null;
			}
			pending = null;
		},
		flushPending() {
			if (detached) return;
			if (timer === null) return;
			cancel(timer);
			dispatch();
		},
	};
}

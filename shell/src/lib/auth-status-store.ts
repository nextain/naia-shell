// #337 Phase 6a — tri-state auth status sourced from naia-agent IPC.
//
// Per design doc §2.10 ("UI tri-state auth status"), shell renders three
// explicit states: "checking" (boot in progress), "logged_in" (agent
// confirmed naiaKey loaded + non-expired), and "logged_out" (no file, refresh
// failed, or user logged out). No optimistic "assume logged-in" with rollback
// — that flicker briefly enables gated UI which is unsafe.
//
// Source of truth = the agent. Shell never reads secure-keys.dat to derive
// this; it asks `agentAuthQuery(mode)` and subscribes to `onAgentAuthChanged`.
// Legacy `naiaKey`-derived UI gating in SettingsTab is retained additively
// during Phase 6a — it will be removed entirely in Phase 6c.
//
// Boot SLA target: settle within 200ms p95 (design doc §2.10). This module
// logs a warning if `agentAuthQuery` exceeds 500ms but never gates on it —
// any IPC failure falls back to "logged_out" defensively to avoid a stuck
// "checking" badge.

import { createContext, useContext } from "react";

import {
	agentAuthQuery,
	onAgentAuthChanged,
	resolveAuthMode,
	type AuthMode,
} from "./agent-ipc.js";
import { Logger } from "./logger.js";

export type AuthStatus = "checking" | "logged_in" | "logged_out";

export interface AuthStatusSnapshot {
	status: AuthStatus;
	mode: AuthMode;
	userId?: string;
	expiresAt?: number;
}

/**
 * Resolve current mode from Vite-time env (mirrors agent's NAIA_AGENT_MODE).
 * Thin re-export so call sites can use one module rather than two.
 */
export function getMode(): AuthMode {
	return resolveAuthMode();
}

/** SLA threshold (ms): warn if agentAuthQuery takes longer than this. */
const QUERY_WARN_MS = 500;

/**
 * Initialize tri-state auth tracking. Returns an unsubscribe function.
 *
 * Behaviour:
 *  1. Emits `{status: "checking", mode}` synchronously before returning.
 *  2. Fires `agentAuthQuery(mode)` — on resolution emits "logged_in" or
 *     "logged_out" with userId/expiresAt copied through.
 *  3. Subscribes to `onAgentAuthChanged` — every event for the same `mode`
 *     flips status. Events for OTHER modes are ignored (each mode has its
 *     own auth file per design doc §2.1).
 *  4. If `agentAuthQuery` throws (agent not running, IPC timeout), logs a
 *     warning and emits `{status: "logged_out", mode}` defensively. This
 *     avoids a stuck "checking" badge if the agent is slow to boot.
 *  5. Logs a warning if `agentAuthQuery` exceeds QUERY_WARN_MS.
 */
export function startAuthStatusTracking(
	onUpdate: (snapshot: AuthStatusSnapshot) => void,
): () => void {
	const mode = getMode();
	let cancelled = false;

	// (1) Synchronous "checking" emit. Must fire before any await so React
	// renders the spinner from the very first paint after mount.
	onUpdate({ status: "checking", mode });

	// (3) Subscribe BEFORE the initial query — if the agent emits
	// `auth_changed` during boot, we don't want to miss it.
	const unsubscribeChanged = onAgentAuthChanged((event) => {
		if (cancelled) return;
		// Events for the other mode are ignored. The current mode is fixed at
		// the lifetime of this tracker; mode swap requires app restart, which
		// re-mounts the tracker (and re-resolves getMode()).
		if (event.mode !== mode) return;
		onUpdate({
			status: event.loggedIn ? "logged_in" : "logged_out",
			mode,
		});
	});

	// (2) Kick off the initial query. Defensive: any throw → logged_out.
	const startedAt = Date.now();
	agentAuthQuery(mode)
		.then((result) => {
			if (cancelled) return;
			const elapsed = Date.now() - startedAt;
			if (elapsed > QUERY_WARN_MS) {
				Logger.warn(
					"auth-status-store",
					"agentAuthQuery exceeded SLA threshold",
					{ elapsedMs: elapsed, mode },
				);
			}
			const snapshot: AuthStatusSnapshot = {
				status: result.loggedIn ? "logged_in" : "logged_out",
				mode,
			};
			if (result.userId !== undefined) snapshot.userId = result.userId;
			if (result.expiresAt !== undefined) snapshot.expiresAt = result.expiresAt;
			onUpdate(snapshot);
		})
		.catch((err: unknown) => {
			if (cancelled) return;
			Logger.warn(
				"auth-status-store",
				"agentAuthQuery failed — defaulting to logged_out",
				{ error: String(err), mode },
			);
			onUpdate({ status: "logged_out", mode });
		});

	return () => {
		cancelled = true;
		unsubscribeChanged();
	};
}

// ---------------------------------------------------------------------------
// React context — lets deeply-nested consumers (e.g. SettingsTab, mounted via
// panelRegistry without prop drilling) subscribe to the snapshot maintained
// by App.tsx. Default is "checking" so any read before the provider mounts
// degrades gracefully rather than throwing.

const DEFAULT_SNAPSHOT: AuthStatusSnapshot = {
	status: "checking",
	mode: "prod",
};

export const AuthStatusContext =
	createContext<AuthStatusSnapshot>(DEFAULT_SNAPSHOT);

/** Read the current tri-state auth snapshot from React context. */
export function useAuthStatus(): AuthStatusSnapshot {
	return useContext(AuthStatusContext);
}


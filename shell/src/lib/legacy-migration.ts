// #337 Phase 8 — one-shot legacy auth migration trigger.
//
// Reads the legacy `secure-keys.dat:naiaKey` slot and pushes it to the
// agent's encrypted `<ADK>/naia-settings/auth/{mode}.json.enc` file via the
// `auth_legacy_migrate` IPC. Designed to run exactly once per process from
// `App.tsx` after the initial auth status query settles (see §3 of the
// design doc, `.agents/plans/issue-337-adk-auth-persistence.md`).
//
// Policy (design doc §3):
//   1. no legacy key in secure store      → return early ("nothing to migrate")
//   2. legacy key + agent already logged in → trust the agent. Silently purge
//      the secure-keys.dat slot (and the stale `apiKey` D3 garbage entry).
//   3. legacy key + agent NOT logged in   → invoke `auth_legacy_migrate`.
//      Hard-fail on timeout (5 s) or `ok: false`. NO fallback-to-shell —
//      the whole point of #337 is removing dual-SoT. On failure the legacy
//      slot is left intact so the user can retry, and a UI toast event is
//      emitted via `onLegacyMigrationFailed` listeners.
//
// Idempotency: the in-process `migrationPromise` cache makes concurrent calls
// safe — the second caller awaits the first call's result. After a successful
// migration the legacy key is gone, so a subsequent call hits branch (1).
//
// This module intentionally consumes the `@deprecated getNaiaKeySecure`
// import from `config.ts` — that's the ONLY remaining shell-side caller and
// will be removed in the Phase 8 wrap-up once telemetry confirms migration
// completion in the field.

import {
	agentAuthLegacyMigrate,
	agentAuthQuery,
	resolveAuthMode,
	type AuthMode,
} from "./agent-ipc.js";
import { loadConfig } from "./config.js";
// eslint-disable-next-line @typescript-eslint/no-deprecated -- Phase 8 only consumer
import { getNaiaKeySecure } from "./config.js";
import { Logger } from "./logger.js";
import { deleteSecretKey } from "./secure-store.js";

/** Result discriminant — surfaced for telemetry + UI toast routing. */
export type LegacyMigrationResult =
	| { kind: "no_legacy_key" }
	| { kind: "agent_already_logged_in"; purged: true }
	| { kind: "migrated"; mode: AuthMode }
	| { kind: "failed"; reason: string };

/** Hard cap on `agentAuthLegacyMigrate` round-trip. Per design §3, on timeout
 *  the legacy slot is left intact and a UI toast surfaces so the user can
 *  re-login. */
const MIGRATE_TIMEOUT_MS = 5_000;

const failureListeners = new Set<(reason: string) => void>();
let migrationPromise: Promise<LegacyMigrationResult> | null = null;

/**
 * Subscribe to migration-failed UI surface events. Returns an unsubscribe
 * function. SettingsTab renders a toast via this listener.
 */
export function onLegacyMigrationFailed(
	listener: (reason: string) => void,
): () => void {
	failureListeners.add(listener);
	return () => {
		failureListeners.delete(listener);
	};
}

function emitFailure(reason: string): void {
	for (const listener of failureListeners) {
		try {
			listener(reason);
		} catch (err) {
			Logger.warn("legacy-migration", "failure listener threw", {
				error: String(err),
			});
		}
	}
}

/** Wrap a promise with a timeout that rejects with the given message. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);
		p.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

/**
 * Run the one-shot legacy migration. Idempotent — repeated calls return the
 * cached result of the first call. App.tsx invokes this once on mount after
 * the initial auth status query settles.
 */
export function runLegacyMigration(): Promise<LegacyMigrationResult> {
	if (!migrationPromise) {
		migrationPromise = runMigrationOnce();
	}
	return migrationPromise;
}

async function runMigrationOnce(): Promise<LegacyMigrationResult> {
	// (1) Pull the legacy key (and userId hint) BEFORE checking the agent so
	// we don't race a freshly-completed OAuth flow.
	let legacyKey: string | undefined;
	try {
		legacyKey = await getNaiaKeySecure();
	} catch (err) {
		Logger.warn("legacy-migration", "getNaiaKeySecure threw", {
			error: String(err),
		});
		legacyKey = undefined;
	}

	if (!legacyKey) {
		return { kind: "no_legacy_key" };
	}

	const localConfig = loadConfig();
	const legacyUserId =
		typeof localConfig?.naiaUserId === "string" && localConfig.naiaUserId
			? localConfig.naiaUserId
			: undefined;
	const mode: AuthMode = resolveAuthMode();

	// (2) Check the agent. If it already has the auth file, the legacy slot is
	// stale — purge it silently. (Also purge the D3 stale-garbage `apiKey`
	// slot observed after #329 (B) — `apiKey: len=7`.)
	let agentLoggedIn = false;
	try {
		const agentState = await agentAuthQuery(mode);
		agentLoggedIn = agentState.loggedIn;
	} catch (err) {
		// Treat IPC failure as "not logged in" defensively — the migration
		// attempt will surface a clearer failure path with hard-fail semantics.
		Logger.warn("legacy-migration", "agentAuthQuery failed", {
			error: String(err),
			mode,
		});
		agentLoggedIn = false;
	}

	if (agentLoggedIn) {
		await deleteSecretKey("naiaKey").catch(() => {});
		await deleteSecretKey("apiKey").catch(() => {});
		Logger.info(
			"legacy-migration",
			"agent already logged in — purged legacy slot",
			{ mode },
		);
		return { kind: "agent_already_logged_in", purged: true };
	}

	// (3) Agent has no auth file — push the legacy key over. Hard-fail on
	// timeout or `ok: false` per design doc §3.
	const migrateOpts: Parameters<typeof agentAuthLegacyMigrate>[0] = {
		mode,
		naiaKey: legacyKey,
	};
	if (legacyUserId !== undefined) migrateOpts.userId = legacyUserId;

	let result: Awaited<ReturnType<typeof agentAuthLegacyMigrate>>;
	try {
		result = await withTimeout(
			agentAuthLegacyMigrate(migrateOpts),
			MIGRATE_TIMEOUT_MS,
			`legacy-migration timeout after ${MIGRATE_TIMEOUT_MS}ms`,
		);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		Logger.warn("legacy-migration", "agentAuthLegacyMigrate threw", {
			error: reason,
			mode,
		});
		emitFailure(reason);
		return { kind: "failed", reason };
	}

	if (!result.ok) {
		const reason = result.reason ?? "agent_returned_not_ok";
		Logger.warn("legacy-migration", "agent returned ok:false", {
			reason,
			mode,
		});
		emitFailure(reason);
		return { kind: "failed", reason };
	}

	// Migration ack OK — purge the legacy slot + stale-garbage `apiKey` (D3).
	// The agent's `auth_changed` event has already been emitted on the bin
	// dispatcher side; the auth-status-store subscriber will flip the badge.
	await deleteSecretKey("naiaKey").catch(() => {});
	await deleteSecretKey("apiKey").catch(() => {});
	Logger.info("legacy-migration", "migrated legacy slot to agent", { mode });
	return { kind: "migrated", mode };
}

// --- test seam --------------------------------------------------------------

/** Reset in-process state for isolated tests. NOT for production use. */
export function __resetLegacyMigrationForTest(): void {
	migrationPromise = null;
	failureListeners.clear();
}

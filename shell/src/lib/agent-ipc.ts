// Typed wrappers around the naia-agent stdio IPC handlers introduced in
// Phase 5a of #337. Each request/response is correlated via an `id` field on
// the wire; the response arrives as a Tauri `agent_response` event because the
// agent's stdout is forwarded verbatim by src-tauri/src/lib.rs:1189
// (`handle.emit("agent_response", trimmed)`).
//
// Pattern choice (per Phase 5b spec): (B) fire-and-listen — register a
// `listen("agent_response", ...)` filter on `id`, then `invoke(
// "send_to_agent_command", ...)` to write the request. Matches every existing
// IPC consumer in shell/src/lib (chat-service.ts, panel-loader.ts, etc.) and
// keeps the Rust side untouched apart from a separate single-field addition
// to the `naia_auth_complete` payload (deepLinkUrl).
//
// Event subscribers (`onAgentAuthChanged`, `onAgentAuthExpired`) handle the
// agent → shell push events (`auth_changed`, `auth_expired`) that flow without
// a prior request.
//
// All wrappers throw on transport failure (invoke rejection or response
// timeout). Callers are expected to catch and surface UI-level errors.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { Logger } from "./logger";

export type AuthMode = "dev" | "prod";

export interface AgentAuthStartResult {
	authUrl: string;
	state: string;
}

export interface AgentAuthReceivedResult {
	ok: boolean;
	reason?: string;
	userId?: string;
	mode?: AuthMode;
}

export interface AgentAuthQueryResult {
	loggedIn: boolean;
	expiresAt?: number;
	userId?: string;
	scope?: string[];
}

export interface AgentAuthLegacyMigrateOpts {
	mode: AuthMode;
	naiaKey: string;
	userId?: string;
}

export interface AgentAuthLegacyMigrateResult {
	ok: boolean;
	reason?: string;
}

export interface AgentLabProxyRequestOpts {
	mode: AuthMode;
	method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
	path: string;
	body?: unknown;
	headers?: Record<string, string>;
}

export interface AgentLabProxyResult {
	ok: boolean;
	status: number;
	body: unknown;
	error?: string;
}

export interface AgentAuthChangedEvent {
	mode: AuthMode;
	loggedIn: boolean;
}

export interface AgentAuthExpiredEvent {
	mode: AuthMode;
	reason: string;
}

/** Default timeout for an agent request/response round-trip (ms). */
const REQUEST_TIMEOUT_MS = 15_000;

let nextRequestSeq = 0;

function newRequestId(prefix: string): string {
	nextRequestSeq += 1;
	return `${prefix}-${Date.now()}-${nextRequestSeq.toString(36)}`;
}

interface AgentResponseLike {
	type?: string;
	id?: string;
	[k: string]: unknown;
}

function parseAgentResponse(payload: unknown): AgentResponseLike | null {
	try {
		const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as AgentResponseLike;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Send a JSON-encoded request to the agent and await the matching response by
 * (`responseType`, `id`). The listener is unregistered as soon as the response
 * arrives or the timeout fires — never leaks across requests.
 */
async function requestAgent<T>(opts: {
	request: Record<string, unknown>;
	responseType: string;
	id: string;
	timeoutMs?: number;
}): Promise<T> {
	const timeout = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;

	let unlistenFn: (() => void) | null = null;
	let timerId: ReturnType<typeof setTimeout> | null = null;
	let settled = false;

	const result = new Promise<T>((resolve, reject) => {
		const settleOk = (value: T) => {
			if (settled) return;
			settled = true;
			if (timerId) clearTimeout(timerId);
			if (unlistenFn) unlistenFn();
			resolve(value);
		};
		const settleErr = (err: unknown) => {
			if (settled) return;
			settled = true;
			if (timerId) clearTimeout(timerId);
			if (unlistenFn) unlistenFn();
			reject(err instanceof Error ? err : new Error(String(err)));
		};

		timerId = setTimeout(
			() =>
				settleErr(
					new Error(`agent-ipc timeout: ${opts.responseType} id=${opts.id}`),
				),
			timeout,
		);

		// Register listener BEFORE invoking — same ordering as chat-service.ts:142
		// to avoid a race where the agent answers faster than the JS event loop.
		listen<string>("agent_response", (event) => {
			const parsed = parseAgentResponse(event.payload);
			if (!parsed) return;
			if (parsed.type !== opts.responseType) return;
			if (parsed.id !== opts.id) return;
			settleOk(parsed as unknown as T);
		})
			.then((fn) => {
				unlistenFn = fn;
				if (settled) {
					// Race: response/timeout arrived before listen resolved.
					fn();
					return;
				}
				invoke("send_to_agent_command", {
					message: JSON.stringify(opts.request),
				}).catch((err) => settleErr(err));
			})
			.catch((err) => settleErr(err));
	});

	return result;
}

export async function agentAuthStart(opts: {
	mode: AuthMode;
	scope?: string[];
	locale?: string;
}): Promise<AgentAuthStartResult> {
	const id = newRequestId("auth-start");
	const request: Record<string, unknown> = {
		type: "auth_start",
		id,
		mode: opts.mode,
	};
	if (opts.scope !== undefined) request.scope = opts.scope;
	if (opts.locale !== undefined) request.locale = opts.locale;

	type Wire = AgentAuthStartResult & { error?: string };
	const resp = await requestAgent<Wire>({
		request,
		responseType: "auth_start_response",
		id,
	});
	if (resp.error) {
		throw new Error(`auth_start failed: ${resp.error}`);
	}
	if (typeof resp.authUrl !== "string" || typeof resp.state !== "string") {
		throw new Error("auth_start_response missing authUrl/state");
	}
	return { authUrl: resp.authUrl, state: resp.state };
}

export async function agentAuthReceived(
	deepLinkUrl: string,
): Promise<AgentAuthReceivedResult> {
	const id = newRequestId("auth-received");
	const request: Record<string, unknown> = {
		type: "auth_received",
		id,
		deepLinkUrl,
	};
	type Wire = AgentAuthReceivedResult & { error?: string };
	const resp = await requestAgent<Wire>({
		request,
		responseType: "auth_received_response",
		id,
	});
	// `error` is a transport/parser-level fault from the agent dispatcher.
	// `reason` is a structured rejection (state mismatch, expired, etc.).
	// Both flatten into the same `ok: false` shape for callers.
	const out: AgentAuthReceivedResult = { ok: resp.ok === true };
	if (!out.ok) {
		if (typeof resp.reason === "string") out.reason = resp.reason;
		else if (typeof resp.error === "string") out.reason = resp.error;
	}
	if (typeof resp.userId === "string") out.userId = resp.userId;
	if (resp.mode === "dev" || resp.mode === "prod") out.mode = resp.mode;
	return out;
}

export async function agentAuthLogout(mode: AuthMode): Promise<void> {
	const id = newRequestId("auth-logout");
	const request = { type: "auth_logout", id, mode };
	await requestAgent<{ ok: true }>({
		request,
		responseType: "auth_logout_response",
		id,
	});
}

export async function agentAuthQuery(
	mode: AuthMode,
): Promise<AgentAuthQueryResult> {
	const id = newRequestId("auth-query");
	const request = { type: "auth_query", id, mode };
	type Wire = AgentAuthQueryResult & { error?: string };
	const resp = await requestAgent<Wire>({
		request,
		responseType: "auth_query_response",
		id,
	});
	const out: AgentAuthQueryResult = { loggedIn: resp.loggedIn === true };
	if (typeof resp.expiresAt === "number") out.expiresAt = resp.expiresAt;
	if (typeof resp.userId === "string") out.userId = resp.userId;
	if (Array.isArray(resp.scope)) {
		out.scope = resp.scope.filter(
			(s: unknown): s is string => typeof s === "string",
		);
	}
	return out;
}

/**
 * #337 Phase 8 — one-shot migration trigger. Pushes the legacy
 * `secure-keys.dat:naiaKey` slot into the agent's encrypted ADK auth file.
 * Caller MUST NOT delete the legacy slot on `ok: false` — the user can retry.
 */
export async function agentAuthLegacyMigrate(
	opts: AgentAuthLegacyMigrateOpts,
): Promise<AgentAuthLegacyMigrateResult> {
	const id = newRequestId("auth-legacy-migrate");
	const request: Record<string, unknown> = {
		type: "auth_legacy_migrate",
		id,
		mode: opts.mode,
		naiaKey: opts.naiaKey,
	};
	if (opts.userId !== undefined) request.userId = opts.userId;
	type Wire = AgentAuthLegacyMigrateResult & { error?: string };
	const resp = await requestAgent<Wire>({
		request,
		responseType: "auth_legacy_migrate_response",
		id,
	});
	const out: AgentAuthLegacyMigrateResult = { ok: resp.ok === true };
	if (!out.ok) {
		if (typeof resp.reason === "string") out.reason = resp.reason;
		else if (typeof resp.error === "string") out.reason = resp.error;
	}
	return out;
}

export async function agentLabProxyRequest(
	opts: AgentLabProxyRequestOpts,
): Promise<AgentLabProxyResult> {
	const id = newRequestId("lab-proxy");
	const request: Record<string, unknown> = {
		type: "lab_proxy_request",
		id,
		mode: opts.mode,
		method: opts.method,
		path: opts.path,
	};
	if (opts.body !== undefined) request.body = opts.body;
	if (opts.headers !== undefined) request.headers = opts.headers;
	type Wire = AgentLabProxyResult;
	const resp = await requestAgent<Wire>({
		request,
		responseType: "lab_proxy_response",
		id,
	});
	const out: AgentLabProxyResult = {
		ok: resp.ok === true,
		status: typeof resp.status === "number" ? resp.status : 0,
		body: resp.body ?? null,
	};
	if (typeof resp.error === "string") out.error = resp.error;
	return out;
}

/**
 * Subscribe to agent → shell `auth_changed` push events. Returns an
 * unsubscribe function. Caller is responsible for invoking it on unmount.
 */
export function onAgentAuthChanged(
	listener: (e: AgentAuthChangedEvent) => void,
): () => void {
	let unlistenFn: (() => void) | null = null;
	let cancelled = false;

	listen<string>("agent_response", (event) => {
		const parsed = parseAgentResponse(event.payload);
		if (!parsed || parsed.type !== "auth_changed") return;
		const mode = parsed.mode === "dev" ? "dev" : "prod";
		const loggedIn = parsed.loggedIn === true;
		try {
			listener({ mode, loggedIn });
		} catch (err) {
			Logger.warn("agent-ipc", "onAgentAuthChanged listener threw", {
				error: String(err),
			});
		}
	})
		.then((fn) => {
			if (cancelled) {
				fn();
				return;
			}
			unlistenFn = fn;
		})
		.catch((err) => {
			Logger.warn("agent-ipc", "onAgentAuthChanged listen() failed", {
				error: String(err),
			});
		});

	return () => {
		cancelled = true;
		if (unlistenFn) {
			unlistenFn();
			unlistenFn = null;
		}
	};
}

/**
 * Subscribe to agent → shell `auth_expired` push events. Same lifecycle as
 * `onAgentAuthChanged`.
 */
export function onAgentAuthExpired(
	listener: (e: AgentAuthExpiredEvent) => void,
): () => void {
	let unlistenFn: (() => void) | null = null;
	let cancelled = false;

	listen<string>("agent_response", (event) => {
		const parsed = parseAgentResponse(event.payload);
		if (!parsed || parsed.type !== "auth_expired") return;
		const mode = parsed.mode === "dev" ? "dev" : "prod";
		const reason = typeof parsed.reason === "string" ? parsed.reason : "";
		try {
			listener({ mode, reason });
		} catch (err) {
			Logger.warn("agent-ipc", "onAgentAuthExpired listener threw", {
				error: String(err),
			});
		}
	})
		.then((fn) => {
			if (cancelled) {
				fn();
				return;
			}
			unlistenFn = fn;
		})
		.catch((err) => {
			Logger.warn("agent-ipc", "onAgentAuthExpired listen() failed", {
				error: String(err),
			});
		});

	return () => {
		cancelled = true;
		if (unlistenFn) {
			unlistenFn();
			unlistenFn = null;
		}
	};
}

/** Resolve the current auth mode from the Vite build-time gateway flag. */
export function resolveAuthMode(): AuthMode {
	return import.meta.env.VITE_NAIA_USE_DEV_GATEWAY === "1" ? "dev" : "prod";
}

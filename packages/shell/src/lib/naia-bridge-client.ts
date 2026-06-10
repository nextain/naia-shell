/**
 * Naia Bridge Client — runs inside an iframe panel.
 *
 * Copy this file into your panel project. It does NOT import any Tauri or
 * Shell internals — pure postMessage communication only.
 *
 * Usage (inside your panel's index.html / JS):
 *   import { NaiaBridgeClient } from "./naia-bridge-client";
 *   const naia = new NaiaBridgeClient();
 *   await naia.logBehavior("file-opened", { path: "/etc/hosts" });
 *   const entries = await naia.queryBehavior({ limit: 20 });
 *   const key = await naia.getSecret("myApiKey");
 */

export interface BehaviorEntry {
	id?: number;
	panelId: string;
	event: string;
	data?: Record<string, unknown>;
	createdAt: string;
}

export interface BehaviorFilter {
	panelId?: string;
	event?: string;
	since?: string;
	limit?: number;
}

export interface ShellResult {
	stdout: string;
	stderr: string;
	code: number;
}

// ── Internal message types ────────────────────────────────────────────────────

type BridgeRequest =
	| {
			type: "naia-bridge:logBehavior";
			id: string;
			event: string;
			data?: Record<string, unknown>;
	  }
	| { type: "naia-bridge:queryBehavior"; id: string; filter?: BehaviorFilter }
	| { type: "naia-bridge:getSecret"; id: string; key: string }
	| { type: "naia-bridge:setSecret"; id: string; key: string; value: string }
	| { type: "naia-bridge:readFile"; id: string; path: string }
	| { type: "naia-bridge:runShell"; id: string; cmd: string; args?: string[] };

interface BridgeResponse {
	id: string;
	result?: unknown;
	error?: string;
}

// ── Client ────────────────────────────────────────────────────────────────────

export class NaiaBridgeClient {
	private static readonly TIMEOUT_MS = 30_000;

	private pending = new Map<
		string,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void }
	>();
	private cleanup: (() => void) | null = null;

	constructor() {
		const handler = (event: MessageEvent) => {
			// Only accept messages from the Shell host.
			// source check is sufficient in Tauri (no arbitrary cross-frame navigation).
			if (event.source !== window.parent) return;
			const msg = event.data as BridgeResponse;
			if (!msg?.id || !("result" in msg || "error" in msg)) return;
			const pending = this.pending.get(msg.id);
			if (!pending) return;
			this.pending.delete(msg.id);
			if (msg.error != null && msg.error !== "") {
				pending.reject(new Error(msg.error));
			} else {
				pending.resolve(msg.result);
			}
		};
		window.addEventListener("message", handler);
		this.cleanup = () => window.removeEventListener("message", handler);
	}

	/**
	 * Remove the message listener and reject all in-flight requests.
	 * Call this when the panel is unmounted.
	 */
	destroy(): void {
		this.cleanup?.();
		this.cleanup = null;
		for (const { reject } of this.pending.values()) {
			reject(new Error("Bridge destroyed"));
		}
		this.pending.clear();
	}

	private send<T>(req: BridgeRequest): Promise<T> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(req.id);
				reject(new Error(`Bridge request timed out: ${req.type}`));
			}, NaiaBridgeClient.TIMEOUT_MS);
			this.pending.set(req.id, {
				resolve: (v) => {
					clearTimeout(timer);
					resolve(v as T);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
			// Use "*" targetOrigin: window.parent.origin throws SecurityError across
			// origins (http://asset.localhost → tauri://localhost). Safe because the
			// Shell validates event.origin === "http://asset.localhost" on receipt.
			window.parent.postMessage(req, "*");
		});
	}

	private nextId(): string {
		return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	}

	// ── API ────────────────────────────────────────────────────────────────────

	/** Log a behavior event. Stored in Shell WebView IndexedDB (30-day retention). */
	logBehavior(event: string, data?: Record<string, unknown>): Promise<void> {
		return this.send({
			type: "naia-bridge:logBehavior",
			id: this.nextId(),
			event,
			data,
		});
	}

	/** Query behavior log. Returns newest-first. */
	queryBehavior(filter?: BehaviorFilter): Promise<BehaviorEntry[]> {
		return this.send({
			type: "naia-bridge:queryBehavior",
			id: this.nextId(),
			filter,
		});
	}

	/**
	 * Get a secret value by key.
	 * Keys are namespaced per panel: `panel:{panelId}:{key}`.
	 */
	getSecret(key: string): Promise<string | null> {
		return this.send({ type: "naia-bridge:getSecret", id: this.nextId(), key });
	}

	/**
	 * Set a secret value by key.
	 * Keys are namespaced per panel: `panel:{panelId}:{key}`.
	 */
	setSecret(key: string, value: string): Promise<void> {
		return this.send({
			type: "naia-bridge:setSecret",
			id: this.nextId(),
			key,
			value,
		});
	}

	/**
	 * Read a file. Restricted to the user's HOME directory.
	 * Returns file contents as a UTF-8 string.
	 */
	readFile(path: string): Promise<string> {
		return this.send({ type: "naia-bridge:readFile", id: this.nextId(), path });
	}

	/**
	 * Run an allowlisted shell command.
	 * The Shell enforces an allowlist — unauthorized commands are rejected.
	 */
	runShell(cmd: string, args?: string[]): Promise<ShellResult> {
		return this.send({
			type: "naia-bridge:runShell",
			id: this.nextId(),
			cmd,
			args,
		});
	}
}

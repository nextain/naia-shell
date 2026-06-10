/**
 * Iframe Bridge — Shell-side postMessage server.
 *
 * Listens for messages from installed iframe panels (asset.localhost origin)
 * and routes them to the appropriate Shell service:
 *   - logBehavior / queryBehavior → behavior-log.ts (IndexedDB)
 *   - getSecret / setSecret       → secure-store.ts (Tauri Store plugin)
 *   - readFile                    → Tauri invoke("panel_read_file")
 *   - runShell                    → Tauri invoke("panel_run_shell")
 *
 * Call startIframeBridge() once from App.tsx. Returns a cleanup function.
 *
 * Security:
 *   - Only messages from http://asset.localhost are processed.
 *   - getSecret/setSecret keys are namespaced per source panel: `panel:{panelId}:{key}`
 *   - panel_read_file and panel_run_shell enforce restrictions on the Rust side.
 */

import { invoke } from "@tauri-apps/api/core";
import { logBehavior, queryBehavior } from "./behavior-log";
import type { BehaviorFilter } from "./behavior-log";
import { Logger } from "./logger";
import { getSecretKey, saveSecretKey } from "./secure-store";

// Only allow messages from Tauri asset protocol
const ALLOWED_ORIGIN = "http://asset.localhost";

interface BridgeMessage {
	type: string;
	id: string;
	[key: string]: unknown;
}

interface ShellResult {
	stdout: string;
	stderr: string;
	code: number;
}

/**
 * Derive a stable panelId from the iframe's src URL.
 * e.g. "http://asset.localhost/home/user/.naia/panels/my-panel/index.html"
 *      → "my-panel"
 */
function panelIdFromSource(source: MessageEventSource | null): string {
	// We derive panelId from the frame's location via the referrer in the message.
	// Since we cannot read the iframe's src directly from the event, we use a
	// best-effort approach: look up the iframe element whose src origin matches.
	if (!source) return "__unknown__";
	const iframes = document.querySelectorAll<HTMLIFrameElement>("iframe");
	for (const iframe of iframes) {
		if (iframe.contentWindow === source) {
			// Extract last path segment immediately before /index.html (allow query/hash)
			const match = iframe.src.match(/\/([^/]+)\/index\.html(?:[?#].*)?$/);
			return match ? match[1] : "__unknown__";
		}
	}
	return "__unknown__";
}

async function handleMessage(event: MessageEvent): Promise<void> {
	if (event.origin !== ALLOWED_ORIGIN) return;
	const msg = event.data as BridgeMessage;
	if (!msg?.type?.startsWith("naia-bridge:") || !msg.id) return;

	const respond = (result?: unknown, error?: string) => {
		(event.source as Window)?.postMessage(
			{ id: msg.id, result, error },
			ALLOWED_ORIGIN,
		);
	};

	const panelId = panelIdFromSource(event.source);

	// Reject all privileged operations when panel identity is unresolvable.
	// Prevents namespace collision, cross-panel data leakage, and unattributed
	// file/shell access.
	if (panelId === "__unknown__") {
		respond(undefined, "Panel identity could not be resolved — access denied");
		return;
	}

	try {
		switch (msg.type) {
			case "naia-bridge:logBehavior": {
				await logBehavior(
					panelId,
					msg.event as string,
					msg.data as Record<string, unknown> | undefined,
				);
				respond();
				break;
			}
			case "naia-bridge:queryBehavior": {
				// Scope queries to the requesting panel's own logs
				const filter = (msg.filter as BehaviorFilter | undefined) ?? {};
				filter.panelId = panelId;
				const entries = await queryBehavior(filter);
				respond(entries);
				break;
			}
			case "naia-bridge:getSecret": {
				const key = msg.key;
				if (typeof key !== "string" || !key) {
					respond(undefined, "key must be a non-empty string");
					break;
				}
				const value = await getSecretKey(`panel:${panelId}:${key}`);
				respond(value);
				break;
			}
			case "naia-bridge:setSecret": {
				const key = msg.key;
				const value = msg.value;
				if (typeof key !== "string" || !key) {
					respond(undefined, "key must be a non-empty string");
					break;
				}
				if (typeof value !== "string") {
					respond(undefined, "value must be a string");
					break;
				}
				await saveSecretKey(`panel:${panelId}:${key}`, value);
				respond();
				break;
			}
			case "naia-bridge:readFile": {
				const path = msg.path;
				if (typeof path !== "string" || !path) {
					respond(undefined, "path must be a non-empty string");
					break;
				}
				const content = await invoke<string>("panel_read_file", { path });
				respond(content);
				break;
			}
			case "naia-bridge:runShell": {
				const cmd = msg.cmd;
				if (typeof cmd !== "string" || !cmd) {
					respond(undefined, "cmd must be a non-empty string");
					break;
				}
				const result = await invoke<ShellResult>("panel_run_shell", {
					cmd,
					args: (msg.args as string[] | undefined) ?? [],
				});
				respond(result);
				break;
			}
			default:
				respond(undefined, `Unknown bridge message type: ${msg.type}`);
		}
	} catch (err) {
		respond(undefined, err instanceof Error ? err.message : String(err));
	}
}

/**
 * Start the iframe bridge. Call once from App.tsx on mount.
 * Returns a cleanup function that removes the event listener.
 */
export function startIframeBridge(): () => void {
	const listener = (event: MessageEvent) => {
		handleMessage(event).catch((err) => {
			Logger.error("IframeBridge", "Unhandled error in handleMessage", { err });
		});
	};
	window.addEventListener("message", listener);
	return () => window.removeEventListener("message", listener);
}

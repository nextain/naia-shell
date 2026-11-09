import { listen } from "@tauri-apps/api/event";
import { loadDistributionChannel } from "./distribution";
import { usageControlAliases } from "./usage-control-aliases";
import {
	USAGE_CONSENT_KEY,
	UsageEvents,
	parseUsageConnection,
	usageEnvelope,
} from "./usage-events";
import type { UsageEvent } from "./usage-events";
import { usageControls } from "./usage-inventory";

const connection = parseUsageConnection(
	import.meta.env.VITE_APPLICATIONINSIGHTS_CONNECTION_STRING,
);
function platform(): UsageEvent["platform"] {
	const agent = navigator.userAgent;
	return /Windows/i.test(agent)
		? "windows"
		: /Macintosh|Mac OS/i.test(agent)
			? "macos"
			: /Linux/i.test(agent)
				? "linux"
				: "unknown";
}
const consentChannel =
	typeof window !== "undefined" && "BroadcastChannel" in window
		? new BroadcastChannel("naia-usage-consent-v1")
		: null;
export const usageAvailable =
	connection !== null &&
	consentChannel !== null &&
	typeof navigator.locks?.request === "function";
export const usage = new UsageEvents({
	storage: {
		getItem: (key) => localStorage.getItem(key),
		setItem: (key, value) => localStorage.setItem(key, value),
	},
	lock: async (fn) => {
		if (!navigator.locks)
			return Promise.reject(new Error("Atomic usage storage unavailable"));
		return await navigator.locks.request("naia-usage-v1", fn);
	},
	uuid: () => crypto.randomUUID(),
	now: () => Date.now(),
	online: () => navigator.onLine,
	onDisable: () => consentChannel?.postMessage("off"),
	configured: usageAvailable,
	version: __USAGE_VERSION__,
	platform: platform(),
	channel: "unknown",
	send: async (events, signal) => {
		if (!connection) return;
		const channel = await loadDistributionChannel();
		if (signal.aborted || usage.choice()?.enabled !== true) return;
		const response = await fetch(connection.url, {
			method: "POST",
			body: JSON.stringify(
				events.map((event) =>
					usageEnvelope({ ...event, channel }, connection.key),
				),
			),
			headers: { "Content-Type": "application/json" },
			credentials: "omit",
			referrerPolicy: "no-referrer",
			redirect: "error",
			signal,
		});
		// Partial acceptance may be retried with the same immutable event IDs;
		// the receiver/report must deduplicate, including HTTP 206 responses.
		if (!response.ok || response.status === 206)
			throw new Error("Usage delivery failed");
	},
});

let installed = false;
export function installUsageListeners(): void {
	if (installed) return;
	installed = true;
	if (consentChannel)
		consentChannel.onmessage = (event) => {
			if (event.data === "off") {
				cancelAttempts();
				usage.suspend();
			}
		};
	if ("__TAURI_INTERNALS__" in window) {
		void listen("naia_auth_rejected", () => {
			finishUsageLogin("intro", "validation");
			finishUsageLogin("settings", "validation");
		}).catch(() => {});
	}
	window.addEventListener("storage", (event) => {
		if (event.key === USAGE_CONSENT_KEY || event.key === null) {
			cancelAttempts();
			void usage.refreshConsent();
		}
	});
	window.addEventListener("pagehide", () => {
		cancelAttempts();
		usage.stop();
	});
	window.addEventListener("pageshow", () => {
		void usage.sync();
	});
	window.addEventListener("offline", () => {
		void usage.flush();
	});
	for (const trigger of ["click", "change", "submit", "contextmenu"]) {
		document.addEventListener(
			trigger,
			(event) => {
				if (!usage.choice()?.enabled) return;
				const element =
					event.target instanceof Element
						? event.target.closest<HTMLElement>("[data-usage-event]")
						: null;
				const name = element?.dataset.usageEvent;
				if (!name || element?.matches(":disabled,[aria-disabled=true]")) return;
				const control = usageControls[name as keyof typeof usageControls];
				if (control?.trigger === event.type) {
					usage.record(name, control.screen);
					const alias = usageControlAliases[name];
					if (alias)
						usage.record(
							alias.name,
							alias.screen,
							alias.choice ? { choice: alias.choice } : {},
						);
				}
			},
			true,
		);
	}
}

// Login IDs are random per attempt, unrelated to credentials or native OAuth state.
type Source = "intro" | "settings";
const attempts = new Map<
	Source,
	{ id: string; timer: ReturnType<typeof setTimeout> }
>();
function cancelAttempts() {
	for (const attempt of attempts.values()) clearTimeout(attempt.timer);
	attempts.clear();
}
export function beginUsageLogin(source: Source): void {
	if (!usage.choice()?.enabled) return;
	finishUsageLogin(source, "cancel");
	const id = crypto.randomUUID();
	attempts.set(source, {
		id,
		timer: setTimeout(() => finishUsageLogin(source, "timeout"), 300000),
	});
	usage.record("login.browser.start", source, { attempt_id: id });
}
export function finishUsageLogin(
	source: Source,
	failure?: "cancel" | "browser_open" | "timeout" | "validation" | "storage",
): void {
	const attempt = attempts.get(source);
	if (!attempt) return;
	clearTimeout(attempt.timer);
	attempts.delete(source);
	usage.record(
		failure ? "login.attempt.fail" : "login.credentials.saved",
		source,
		{ attempt_id: attempt.id, ...(failure ? { failure } : {}) },
	);
}
export function usageAppScreen(id: string | null): string {
	return id === null
		? "home"
		: [
					"browser",
					"workspace",
					"app-store",
					"settings",
					"projects",
					"sample-note",
				].includes(id)
			? id
			: "other";
}

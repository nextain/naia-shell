import { Logger } from "../logger";
import {
	registerCallback,
	unregisterCallback,
	unregisterEventListener,
} from "./event-bus";
import { registerWebLlmProvider } from "./llm-provider";
import { routeCommand } from "./router";
import { normalizeRetiredWebBackgroundInRecord } from "./web-assets";
import { requestWebPersistentStorage } from "./web-storage-persist";
import { WEB_LLM_MODEL_ID } from "./webllm-model";

export const WEB_RUNTIME_MARKER = "naia-web-runtime";

declare global {
	interface Window {
		__TAURI_INTERNALS__?: {
			invoke: (
				cmd: string,
				args?: unknown,
				options?: unknown,
			) => Promise<unknown>;
			transformCallback: (
				callback: (response: unknown) => void,
				once?: boolean,
			) => number;
			unregisterCallback: (id: number) => void;
			convertFileSrc: (filePath: string, protocol?: string) => string;
			metadata: {
				currentWindow: { label: string };
				currentWebview: { label: string };
			};
		};
		__TAURI_EVENT_PLUGIN_INTERNALS__: {
			unregisterListener: (event: string, eventId: number) => void;
		};
	}
}

export function installWebRuntime(): void {
	Logger.info("WebRuntime", WEB_RUNTIME_MARKER);

	if (typeof window !== "undefined") {
		window.__TAURI_INTERNALS__ = {
			invoke: (cmd: string, args?: unknown, options?: unknown) =>
				routeCommand(cmd, args, options),
			transformCallback: (
				callback: (response: unknown) => void,
				once = false,
			) => registerCallback(callback, once),
			unregisterCallback: (id: number) => unregisterCallback(id),
			convertFileSrc: (filePath: string, _protocol = "asset") => filePath,
			metadata: {
				currentWindow: { label: "main" },
				currentWebview: { label: "main" },
			},
		};

		window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
			unregisterListener: (event: string, eventId: number) =>
				unregisterEventListener(event, eventId),
		};
	}

	if (
		typeof localStorage !== "undefined" &&
		!localStorage.getItem("naia-adk-path")
	) {
		localStorage.setItem("naia-adk-path", "opfs://naia-adk");
	}

	registerWebLlmProvider();

	if (typeof localStorage !== "undefined") {
		const rawConfig = localStorage.getItem("naia-config");
		if (!rawConfig) {
			localStorage.setItem(
				"naia-config",
				JSON.stringify({ provider: "webllm", model: WEB_LLM_MODEL_ID }),
			);
		} else {
			try {
				const parsed: unknown = JSON.parse(rawConfig);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					const record = parsed as Record<string, unknown>;
					if (normalizeRetiredWebBackgroundInRecord(record)) {
						localStorage.setItem("naia-config", JSON.stringify(record));
					}
				}
			} catch {
				// ignore malformed localStorage config
			}
		}
	}

	void requestWebPersistentStorage();
}

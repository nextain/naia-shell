import { isKioskDemo } from "../kiosk-demo/flag";
import { getDefaultLlmModel, unregisterLlmProvider } from "../llm/registry";
import { fallbackNaiaMainModel } from "../llm/small-model";
import { Logger } from "../logger";
import {
	registerCallback,
	unregisterCallback,
	unregisterEventListener,
} from "./event-bus";
import { registerWebLlmProvider } from "./llm-provider";
// router(명령 표·에이전트 브리지·BGM 묶음)는 첫 invoke 때 로드해 첫 번들을 줄인다.
// installWebRuntime 자체는 동기 그대로라 부팅 순서·시험이 그대로다.
type RouteCommand = (
	cmd: string,
	args?: unknown,
	options?: unknown,
) => Promise<unknown>;
let routeCommandPromise: Promise<RouteCommand> | null = null;
function getRouteCommand(): Promise<RouteCommand> {
	routeCommandPromise ??= import("./router").then((m) => m.routeCommand);
	return routeCommandPromise;
}
import {
	normalizeRetiredWebBackgroundInRecord,
	syncWebModeRootAttribute,
} from "./web-assets";
import { requestWebPersistentStorage } from "./web-storage-persist";

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
	syncWebModeRootAttribute();

	if (typeof window !== "undefined") {
		window.__TAURI_INTERNALS__ = {
			invoke: (cmd: string, args?: unknown, options?: unknown) =>
				getRouteCommand().then((route) => route(cmd, args, options)),
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

	if (isKioskDemo()) {
		unregisterLlmProvider("webllm");
	} else {
		registerWebLlmProvider();
	}

	if (typeof localStorage !== "undefined") {
		const rawConfig = localStorage.getItem("naia-config");
		if (!rawConfig) {
			localStorage.setItem(
				"naia-config",
				JSON.stringify({
					...(isKioskDemo()
						? { provider: "nextain", model: getDefaultLlmModel("nextain") }
						: { ...fallbackNaiaMainModel(), webAutoDefaultModel: true }),
				}),
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

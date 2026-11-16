import { loadConfig } from "../../lib/config";
import {
	buildFallbackNaiaPreset,
	detectIeumOfficeStatus,
	registerIeumOfficeCodingAgents,
	setIeumOfficeMcpEnabled,
} from "../../lib/ieumoffice-mcp";
import { Logger } from "../../lib/logger";

export const IEUMOFFICE_APP_ID = "land.naia.ieumoffice";

const REQ_STATUS = "naia-ieumoffice:get-status";
const REQ_SET_MCP = "naia-ieumoffice:set-mcp-enabled";
const REQ_REGISTER_AGENTS = "naia-ieumoffice:register-coding-agents";
const REQ_PRESET = "naia-ieumoffice:get-naia-preset";
const RES_RESULT = "naia-ieumoffice:result";

const TAG = "IeumOfficeHostBridge";

function validRequestId(value: unknown): value is string {
	return typeof value === "string" && /^[\w-]{1,100}$/.test(value);
}

export function installIeumOfficeHostBridge(
	frame: HTMLIFrameElement,
	frameSrc: string,
	appId: string,
): () => void {
	if (appId !== IEUMOFFICE_APP_ID) {
		return () => {};
	}
	const target = frame.contentWindow;
	if (!target) {
		return () => {};
	}
	let origin: string;
	try {
		origin = new URL(frameSrc).origin;
		if (!origin || origin === "null") {
			return () => {};
		}
	} catch {
		return () => {};
	}

	Logger.debug(TAG, "installing host bridge", { appId, origin });
	let disposed = false;

	const reply = (id: string, payload: Record<string, unknown>) => {
		if (disposed || !frame.contentWindow) return;
		frame.contentWindow.postMessage(
			{ type: RES_RESULT, id, ...payload },
			origin,
		);
	};

	const onMessage = (event: MessageEvent) => {
		if (
			disposed ||
			event.source !== frame.contentWindow ||
			event.origin !== origin
		) {
			return;
		}
		const data = event.data;
		if (!data || typeof data !== "object") return;
		const id = (data as Record<string, unknown>).id;
		if (!validRequestId(id)) return;

		const type = (data as Record<string, unknown>).type;
		if (type === REQ_STATUS) {
			Logger.debug(TAG, "handling status request", { id });
			void detectIeumOfficeStatus()
				.then((status) => reply(id, { ok: true, status }))
				.catch((err) =>
					reply(id, {
						ok: false,
						error: err instanceof Error ? err.message : String(err),
						fallbackPreset: buildFallbackNaiaPreset(
							loadConfig()?.gatewayUrl,
							loadConfig()?.model,
						),
					}),
				);
			return;
		}

		if (type === REQ_SET_MCP) {
			const enabled = Boolean((data as Record<string, unknown>).enabled);
			Logger.info(TAG, "handling set-mcp-enabled", { id, enabled });
			void setIeumOfficeMcpEnabled(enabled)
				.then((status) => reply(id, { ok: true, status }))
				.catch((err) =>
					reply(id, {
						ok: false,
						error: err instanceof Error ? err.message : String(err),
					}),
				);
			return;
		}

		if (type === REQ_REGISTER_AGENTS) {
			Logger.info(TAG, "handling register-coding-agents", { id });
			void registerIeumOfficeCodingAgents()
				.then((result) => reply(id, { ok: true, result }))
				.catch((err) =>
					reply(id, {
						ok: false,
						error: err instanceof Error ? err.message : String(err),
					}),
				);
			return;
		}

		if (type === REQ_PRESET) {
			const cfg = loadConfig();
			reply(id, {
				ok: true,
				preset: buildFallbackNaiaPreset(cfg?.gatewayUrl, cfg?.model),
			});
		}
	};

	window.addEventListener("message", onMessage);
	return () => {
		disposed = true;
		window.removeEventListener("message", onMessage);
	};
}

import { Logger } from "../logger";
import { getStartableAgentBridge } from "./agent-bridge";
import { installWebRuntime } from "./install";
import { startWebModel } from "./model-start";
import { DEFAULT_WEB_ADK_BASE, provisionWebAdk } from "./web-adk";
import { getWebFs } from "./web-fs";
import { readNavigatorGpu } from "./webgpu-check";

if (import.meta.env.MODE === "web") {
	installWebRuntime();
	void provisionWebAdk({
		fs: getWebFs(),
		fetch: (u) => fetch(u),
		base: import.meta.env.VITE_NAIA_WEB_ADK_BASE || DEFAULT_WEB_ADK_BASE,
	}).then((r) => {
		if (!r.ok) Logger.error("WebAdk", "provision failed", { failed: r.failed });
		else Logger.info("WebAdk", "provision ok", { written: r.written });
	});
	let storage: Storage | null = null;
	try {
		storage = window.localStorage;
	} catch {
		storage = null;
	}
	void startWebModel({
		gpu: readNavigatorGpu(),
		storage,
		engineKind: import.meta.env.VITE_NAIA_WEB_LLM,
		buildModel: import.meta.env.VITE_NAIA_WEB_LLM_MODEL,
		bridge: getStartableAgentBridge(),
	});
}

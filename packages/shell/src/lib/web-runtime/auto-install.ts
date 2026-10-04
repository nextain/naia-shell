import { getStartableAgentBridge } from "./agent-bridge";
import { installWebRuntime } from "./install";
import { startWebModel } from "./model-start";
import { checkWebAdkStartup } from "./web-adk";
import { getWebFs } from "./web-fs";
import { readNavigatorGpu } from "./webgpu-check";

if (import.meta.env.MODE === "web") {
	installWebRuntime();
	void checkWebAdkStartup({
		fs: getWebFs(),
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

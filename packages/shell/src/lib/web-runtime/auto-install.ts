import { getStartableAgentBridge } from "./agent-bridge";
import { installWebRuntime } from "./install";
import { startWebModel } from "./model-start";
import { readNavigatorGpu } from "./webgpu-check";

if (import.meta.env.MODE === "web") {
	installWebRuntime();
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

import { Logger } from "../logger";
import { checkWebGpu, type GpuLike } from "./webgpu-check";
import {
	isWebLlmModelId,
	modelNeedsShaderF16,
	readWebLlmModelChoice,
	WEB_LLM_FALLBACK_F32,
	type WebLlmModelId,
} from "./webllm-model";
import { setWebModelStatus } from "./web-model-status";

export async function startWebModel(deps: {
	gpu: GpuLike | undefined;
	storage: { getItem(key: string): string | null } | null;
	engineKind: string | undefined;
	buildModel?: string;
	bridge: { start(opts: { model: WebLlmModelId | null }): void };
}): Promise<void> {
	try {
		if (deps.buildModel !== undefined && !isWebLlmModelId(deps.buildModel)) {
			Logger.warn("WebModel", "ignored VITE_NAIA_WEB_LLM_MODEL", {
				value: deps.buildModel,
			});
		}
		const choice = readWebLlmModelChoice(deps.storage, deps.buildModel);
		let model = choice.model;
		setWebModelStatus({ phase: "checking", model, progress: 0 });

		if (deps.engineKind === "fake") {
			setWebModelStatus({ phase: "loading", progress: 0 });
			deps.bridge.start({ model });
			return;
		}

		const result = await checkWebGpu(deps.gpu);
		if (!result.ok) {
			setWebModelStatus({
				phase: "error",
				errorKind: "no-webgpu",
				errorMessage: result.message,
			});
			deps.bridge.start({ model: null });
			return;
		}

		if (modelNeedsShaderF16(model) && !result.shaderF16) {
			if (!choice.explicit) {
				const from = model;
				const to = WEB_LLM_FALLBACK_F32;
				model = to;
				Logger.info("WebModel", "auto-selected f32 model", { from, to });
			} else {
				setWebModelStatus({
					phase: "error",
					errorKind: "no-shader-f16",
					adapter: result.adapter,
					shaderF16: result.shaderF16,
				});
				deps.bridge.start({ model: null });
				return;
			}
		}

		setWebModelStatus({
			phase: "loading",
			model,
			progress: 0,
			adapter: result.adapter,
			shaderF16: result.shaderF16,
		});
		deps.bridge.start({ model });
	} catch (err: unknown) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		Logger.error("WebModel", "unexpected error during startWebModel", {
			message: errorMessage,
		});
		setWebModelStatus({
			phase: "error",
			errorKind: "load-failed",
			errorMessage,
		});
		deps.bridge.start({ model: null });
	}
}

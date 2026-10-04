import { useSyncExternalStore } from "react";
import { t } from "../lib/i18n";
import {
	fallbackModelFor,
	getWebModelStatus,
	subscribeWebModelStatus,
	type WebModelStatus,
} from "../lib/web-runtime/web-model-status";
import {
	WEB_LLM_MODEL_ID,
	WEB_LLM_MODEL_LABELS,
	WEB_LLM_MODEL_PREF_KEY,
	type WebLlmModelId,
} from "../lib/web-runtime/webllm-model";

export function useWebModelStatus(): WebModelStatus {
	return useSyncExternalStore(subscribeWebModelStatus, getWebModelStatus);
}

export function WebModelStatusBar(props: {
	onSwitchModel?: (model: WebLlmModelId) => void;
	onRetry?: () => void;
}) {
	const status = useWebModelStatus();

	const handleSwitchModel = (model: WebLlmModelId) => {
		if (props.onSwitchModel) {
			props.onSwitchModel(model);
			return;
		}
		try {
			localStorage.setItem(WEB_LLM_MODEL_PREF_KEY, model);
		} catch {
			// ignore storage errors
		}
		window.location.reload();
	};

	const handleRetry = () => {
		if (props.onRetry) {
			props.onRetry();
			return;
		}
		window.location.reload();
	};

	const modelLabel = WEB_LLM_MODEL_LABELS[status.model] ?? status.model;

	const formatAdapterLine = () => {
		if (!status.adapter) return null;
		const parts = [
			status.adapter.vendor,
			status.adapter.architecture,
			status.adapter.description,
		].filter((p) => p && p.trim().length > 0);
		const adapterName =
			parts.length > 0 ? parts.join(" · ") : t("webModel.adapterUnknown");
		const f16Text = status.shaderF16
			? t("webModel.f16Yes")
			: t("webModel.f16No");
		return t("webModel.adapter", { adapter: adapterName, f16: f16Text });
	};

	const adapterLine = formatAdapterLine();

	if (status.phase === "error") {
		const fallbackModel = fallbackModelFor(status);
		let leadMessage = "";
		if (status.errorKind === "no-webgpu") {
			leadMessage = t("webModel.errorNoWebgpu");
		} else if (status.errorKind === "no-shader-f16") {
			leadMessage = t("webModel.errorNoShaderF16", { model: modelLabel });
		} else if (status.errorKind === "device-lost") {
			leadMessage = t("webModel.errorDeviceLost", { model: modelLabel });
		} else {
			leadMessage = t("webModel.errorLoadFailed", { model: modelLabel });
		}

		return (
			<div
				id="web-model-status"
				data-testid="web-model-status"
				data-phase={status.phase}
				data-model={status.model}
				data-error-kind={status.errorKind}
				className="chat-error-notice"
				role="alert"
			>
				<p className="chat-error-notice__lead">{leadMessage}</p>
				{adapterLine && <p className="chat-error-notice__adapter">{adapterLine}</p>}
				<div className="update-banner-actions">
					{fallbackModel && (
						<button
							type="button"
							className="chat-error-notice__retry"
							data-testid="web-model-fallback"
							onClick={() => handleSwitchModel(fallbackModel)}
						>
							{t("webModel.useFallback", {
								model: WEB_LLM_MODEL_LABELS[fallbackModel] ?? fallbackModel,
							})}
						</button>
					)}
					<button
						type="button"
						className="chat-error-notice__retry"
						data-testid="web-model-retry"
						onClick={handleRetry}
					>
						{t("webModel.retry")}
					</button>
				</div>
				{status.errorMessage && (
					<details className="chat-error-notice__details">
						<summary>{t("webModel.details")}</summary>
						<pre className="chat-error-notice__detail-text">
							{status.errorMessage}
						</pre>
					</details>
				)}
			</div>
		);
	}

	return (
		<div
			id="web-model-status"
			data-testid="web-model-status"
			data-phase={status.phase}
			data-model={status.model}
			className="chat-compaction-notice"
			role="status"
		>
			{status.phase === "checking" && (
				<div>{t("webModel.checking")}</div>
			)}
			{status.phase === "loading" && (
				<>
					<div>
						{t("webModel.loading", {
							model: modelLabel,
							percent: Math.floor(status.progress * 100),
						})}
					</div>
					{adapterLine && <div>{adapterLine}</div>}
				</>
			)}
			{status.phase === "ready" && (
				<>
					<div>{t("webModel.ready", { model: modelLabel })}</div>
					{adapterLine && <div>{adapterLine}</div>}
					{status.model !== WEB_LLM_MODEL_ID && (
						<div>
							<span>{t("webModel.fallbackActive")}</span>{" "}
							<button
								type="button"
								className="chat-error-notice__retry"
								data-testid="web-model-back-to-default"
								onClick={() => handleSwitchModel(WEB_LLM_MODEL_ID)}
							>
								{t("webModel.backToDefault", {
									model: WEB_LLM_MODEL_LABELS[WEB_LLM_MODEL_ID],
								})}
							</button>
						</div>
					)}
				</>
			)}
		</div>
	);
}

import { formatCreditsFromUsd } from "../credits.js";
import type { LlmModelMeta } from "./types";

// Kept out of `registry.ts` so the credit formatter is only bundled with the
// settings screen that shows model prices, not with the always-loaded registry.

/** Format model label with pricing and capability hints. */
export function formatModelLabel(model: LlmModelMeta): string {
	const tFn =
		typeof (globalThis as any).t === "function"
			? ((globalThis as any).t as (k: string) => string)
			: null;
	const isAsr = model.capabilities.includes("asr");
	let label = isAsr ? `${model.label} (ASR)` : model.label;
	if (model.id === "gpt-5.6-luna" || model.id === "solar-mini") {
		label += ` (${tFn ? tFn("settings.modelCostSaving") : "Cost saving"})`;
	}
	const id = model.id.toLowerCase();
	if (id.includes("qwen") && /(?:^|[^0-9])4b/.test(id)) {
		label += ` (${tFn ? tFn("settings.modelLocal8gb") : "8 GB or more PC"})`;
	} else if (id.includes("qwen") && /(?:^|[^0-9])27b/.test(id)) {
		label += ` (${tFn ? tFn("settings.modelLocal24gb") : "24 GB or more PC"})`;
	}
	if (model.pricing) {
		const [input, output] = model.pricing;
		const pricingLabel = tFn
			? tFn("settings.pricingPerMillionTokens")
			: "Price per 1M tokens";
		const inputLabel = tFn ? tFn("settings.priceInput") : "Input";
		const outputLabel = tFn ? tFn("settings.priceOutput") : "Output";
		const unit = tFn ? tFn("cost.labCredits") : "credits";
		// Prices come from the gateway `/v1/pricing` (the only place a markup
		// lives); the shell only converts USD to credits (#727).
		label = `${label} (${pricingLabel}: ${inputLabel} ${formatCreditsFromUsd(input)} ${unit} / ${outputLabel} ${formatCreditsFromUsd(output)} ${unit})`;
	}
	if (model.comingSoon) {
		label = `${label} (${tFn ? tFn("settings.comingSoonTag") : "준비중"})`;
	}
	return label;
}

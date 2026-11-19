import { t } from "../i18n";
import { formatCreditsFromUsd } from "../credits.js";
import type { LlmModelMeta } from "./types";

// Kept out of `registry.ts` so the credit formatter is only bundled with the
// settings screen that shows model prices, not with the always-loaded registry.

/** Format model label with pricing and capability hints. */
export function formatModelLabel(model: LlmModelMeta): string {
	const isAsr = model.capabilities.includes("asr");
	let label = isAsr ? `${model.label} (ASR)` : model.label;
	if (model.pricing) {
		const [input, output] = model.pricing;
		const pricingLabel = t("settings.pricingPerMillionTokens");
		const inputLabel = t("settings.priceInput");
		const outputLabel = t("settings.priceOutput");
		const unit = t("cost.labCredits");
		// Prices come from the gateway `/v1/pricing` (the only place a markup
		// lives); the shell only converts USD to credits (#727).
		label = `${label} (${pricingLabel}: ${inputLabel} ${formatCreditsFromUsd(input)} ${unit} / ${outputLabel} ${formatCreditsFromUsd(output)} ${unit})`;
	}
	if (model.comingSoon) {
		label = `${label} (${t("settings.comingSoonTag")})`;
	}
	return label;
}

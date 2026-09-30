import { formatCreditsFromUsd, isNaiaAccountProvider } from "./credits";
import { t } from "./i18n";

// Localized usage-cost text (#727). Kept apart from `credits.ts` (pure number
// formatting, reached from the always-loaded entry bundle) so the entry bundle
// only pays for what it uses; screens that show usage costs import from here.

/** USD estimate text used for provider-priced (bring-your-own-key) usage. */
export function formatUsdEstimate(cost: number): string {
	if (cost < 0.001) return `$${cost.toFixed(6)}`;
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	return `$${cost.toFixed(3)}`;
}

/** "약 N 크레딧" — estimated Naia-account usage, from an agent USD estimate. */
export function formatApproxCredits(usd: number): string {
	return t("cost.approxCredits", { amount: formatCreditsFromUsd(usd) });
}

/** "$0.012 (제공사 요금 추정)" — the user pays the provider directly. */
export function formatProviderEstimate(usd: number): string {
	return t("cost.providerEstimate", { amount: formatUsdEstimate(usd) });
}

/** Usage cost for one provider: credits for a Naia account, else a USD estimate. */
export function formatUsageCost(
	usd: number,
	provider: string | null | undefined,
): string {
	return isNaiaAccountProvider(provider)
		? formatApproxCredits(usd)
		: formatProviderEstimate(usd);
}

/**
 * Total over mixed providers. Naia-account and provider-priced amounts are
 * different currencies, so both are shown when both exist.
 */
export function formatUsageTotal(naiaUsd: number, otherUsd: number): string {
	const parts: string[] = [];
	if (naiaUsd > 0) parts.push(formatApproxCredits(naiaUsd));
	if (otherUsd > 0 || parts.length === 0) {
		parts.push(formatProviderEstimate(otherUsd));
	}
	return parts.join(" + ");
}

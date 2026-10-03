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

/** Raw number formatting for unconfirmed records (no currency/unit). */
export function formatRawCost(cost: number): string {
	if (cost < 0.001) return cost.toFixed(6);
	if (cost < 0.01) return cost.toFixed(4);
	return cost.toFixed(3);
}

/** Formats a single provider's cumulative cost stat. */
export function formatProviderCostStat(
	provider: string,
	cost: number,
): string {
	if (provider === "legacy") {
		return `${formatProviderEstimate(cost)} (${t("cost.earlierRecords")})`;
	}
	if (provider === "unconfirmed") {
		return `${formatRawCost(cost)} (${t("cost.unconfirmedProvider")})`;
	}
	if (isNaiaAccountProvider(provider)) {
		return formatApproxCredits(cost);
	}
	return formatProviderEstimate(cost);
}

/**
 * Format cumulative stats split by provider (#727).
 * Each provider is formatted using its own currency/unit.
 */
export function formatByProviderStats(
	byProvider: { provider: string; cost: number }[] | undefined,
	fallbackTotalCost: number,
	currentProvider?: string | null,
): string {
	if (!byProvider || byProvider.length === 0) {
		return formatUsageCost(fallbackTotalCost, currentProvider);
	}
	const nonZero = byProvider.filter((s) => s.cost > 0);
	const target = nonZero.length > 0 ? nonZero : byProvider;
	return target
		.map((s) => formatProviderCostStat(s.provider, s.cost))
		.join(" + ");
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



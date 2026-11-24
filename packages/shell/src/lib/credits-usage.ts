import {
	formatCredits,
	formatCreditsExact,
	formatCreditsFromUsd,
	formatWebCredits,
	formatWebCreditsFromUsd,
	isNaiaAccountProvider,
} from "./credits";
import { t } from "./i18n";
import { isWebMode } from "./web-runtime/web-assets";

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
	return isWebMode()
		? formatWebCreditsFromUsd(usd)
		: t("cost.approxCredits", { amount: formatCreditsFromUsd(usd) });
}

export function formatCreditBalance(balance: number, exact = false): string {
	if (isWebMode()) return formatWebCredits(balance, 2);
	const amount = exact ? formatCreditsExact(balance, 2) : formatCredits(balance, 2);
	return `${amount} ${t("cost.labCredits")}`;
}

/** Display the recorded charge with today's unit when opening an older voice session. */
export function formatSavedVoiceCostSummary(content: string, usd: number): string {
	if (!isWebMode()) return content;
	return content.replace(
		/^(🎙️ (?:\d+m )?\d+s · )(?:약|≈) [\d.,K]+ (?:크레딧|credits)(?= \()/,
		(_, prefix: string) => prefix + formatWebCreditsFromUsd(usd),
	);
}

/** Provider id for in-browser free WebLLM execution. */
export function isLocalFreeProvider(
	provider: string | null | undefined,
): boolean {
	return provider === "webllm";
}

function formatLocalFreeCost(): string {
	const label = t("webAppStore.free");
	return label === "webAppStore.free" ? "Free" : label;
}

/** "$0.012 (제공사 요금 추정)" — the user pays the provider directly. */
export function formatProviderEstimate(usd: number): string {
	return t("cost.providerEstimate", { amount: formatUsdEstimate(usd) });
}

/** Usage cost for one provider: free for local WebLLM, credits for Naia, else USD. */
export function formatUsageCost(
	usd: number,
	provider: string | null | undefined,
): string {
	if (isLocalFreeProvider(provider)) return formatLocalFreeCost();
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
	if (isLocalFreeProvider(provider)) {
		return formatLocalFreeCost();
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
	if (
		nonZero.length === 0 &&
		byProvider.every((s) => isLocalFreeProvider(s.provider))
	) {
		return formatLocalFreeCost();
	}
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



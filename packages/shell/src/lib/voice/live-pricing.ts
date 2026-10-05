/**
 * Hourly rate of a Naia realtime voice model, read from the gateway
 * `GET /v1/pricing` (#727). The shell holds no rate of its own: the gateway is
 * the only place a multiplier lives, so an unavailable rate means "no amount".
 */
interface PricingRow {
	model_key?: string;
	pricing_unit?: string;
	price_per_hour?: number | null;
}

const PROVIDER_KEY_PATTERN: Record<string, RegExp> = {
	"naia-omni": /omni/i,
	"azure-voice-live": /voice-live|realtime/i,
};

/** USD per hour for the provider's hourly row, or null when the gateway has none. */
export async function fetchLiveVoiceHourlyRate(
	gatewayUrl: string,
	provider: string,
): Promise<number | null> {
	const pattern = PROVIDER_KEY_PATTERN[provider];
	if (!pattern) return null;
	try {
		const resp = await fetch(`${gatewayUrl}/v1/pricing`, {
			signal: AbortSignal.timeout(5000),
		});
		if (!resp.ok) return null;
		const rows = (await resp.json()) as PricingRow[];
		if (!Array.isArray(rows)) return null;
		const row = rows.find(
			(r) =>
				r.pricing_unit === "hourly" &&
				typeof r.price_per_hour === "number" &&
				r.price_per_hour > 0 &&
				pattern.test(r.model_key ?? ""),
		);
		return row?.price_per_hour ?? null;
	} catch {
		return null;
	}
}

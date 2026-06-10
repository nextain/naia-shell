export function parseLabCredits(payload: unknown): number | null {
	if (!payload || typeof payload !== "object") return null;
	const record = payload as Record<string, unknown>;

	const direct = record.balance;
	if (typeof direct === "number" && Number.isFinite(direct)) {
		return direct / 100_000;
	}

	const data = record.data;
	if (data && typeof data === "object") {
		const nested = (data as Record<string, unknown>).balance;
		if (typeof nested === "number" && Number.isFinite(nested)) {
			return nested / 100_000;
		}
	}

	return null;
}

/**
 * Credit amount formatting utility.
 *
 * Rules:
 * - Absolute value < 1,000: Keep existing display format.
 * - Value >= 1,000: Divide by 1,000 and floor to 2 decimal places (so balance is never overstated).
 *   Remove trailing zeros and trailing decimal point, append 'K', maintain thousands comma grouping.
 *   e.g. 1000 -> 1K, 2550 -> 2.55K, 12345 -> 12.34K, 1500000 -> 1,500K, 999.9 -> 999.9
 * - Negative numbers, null, undefined, NaN maintain existing behavior.
 */

export function formatCredits(
	val: number | string | null | undefined,
	exactDecimals?: number,
): string {
	if (val === null || val === undefined || val === "") return "";
	const num = typeof val === "number" ? val : Number(val);
	if (Number.isNaN(num)) return String(val);
	if (num < 1000) {
		if (exactDecimals !== undefined) {
			return num.toFixed(exactDecimals);
		}
		return num.toLocaleString("en-US", { maximumFractionDigits: 4 });
	}

	const kVal = num / 1000;
	// Format with grouping up to 10 decimal digits, then truncate to 2 decimal digits
	const parts = kVal
		.toLocaleString("en-US", { useGrouping: true, maximumFractionDigits: 10 })
		.split(".");
	const intPart = parts[0];
	const decPart = (parts[1] || "").slice(0, 2);
	const trimmedDec = decPart.replace(/0+$/, "");
	return trimmedDec ? `${intPart}.${trimmedDec}K` : `${intPart}K`;
}

/**
 * Returns exact credit amount formatting (without K abbreviation),
 * suitable for title attributes / tooltips.
 */
export function formatCreditsExact(
	val: number | string | null | undefined,
	exactDecimals?: number,
): string {
	if (val === null || val === undefined || val === "") return "";
	const num = typeof val === "number" ? val : Number(val);
	if (Number.isNaN(num)) return String(val);
	if (exactDecimals !== undefined) {
		return num.toLocaleString("en-US", {
			minimumFractionDigits: exactDecimals,
			maximumFractionDigits: exactDecimals,
		});
	}
	return num.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

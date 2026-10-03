import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

/**
 * Distribution channel of this build (#727). The Steam depot is the same
 * executable as the NSIS installer, so the native side tells them apart with a
 * marker file written by `prepare-steam-depot.mjs` (fallback: the `SteamAppId`
 * environment variable Steam sets on launch). Steam forbids sending users to
 * an external payment page from inside the app, so payment links are hidden
 * there.
 */
/** "unknown" = the native lookup failed or gave an unexpected answer; treated like Steam (fail closed). */
export type DistributionChannel = "steam" | "standard" | "unknown";

let cachedChannel: DistributionChannel | null = null;
let inflight: Promise<DistributionChannel> | null = null;

export function loadDistributionChannel(): Promise<DistributionChannel> {
	if (cachedChannel) return Promise.resolve(cachedChannel);
	if (!inflight) {
		inflight = Promise.resolve()
			.then(() => invoke<string>("get_distribution_channel"))
			.then(
				(value): DistributionChannel =>
					value === "steam" || value === "standard" ? value : "unknown",
			)
			.catch((): DistributionChannel => "unknown")
			.then((channel) => {
				cachedChannel = channel;
				return channel;
			});
	}
	return inflight;
}

/** Test hook: forget the cached channel. */
export function resetDistributionChannelForTests(): void {
	cachedChannel = null;
	inflight = null;
}

/** Non-hook form for event handlers and message builders; true until known. */
export function paymentLinksHiddenNow(): boolean {
	return cachedChannel !== "standard";
}

/**
 * True when payment / top-up entry points must not be shown. Stays true until
 * the native side has answered, so a Steam build never flashes a payment button.
 */
export function usePaymentLinksHidden(): boolean {
	const [channel, setChannel] = useState<DistributionChannel | null>(
		cachedChannel,
	);
	useEffect(() => {
		let alive = true;
		void loadDistributionChannel().then((value) => {
			if (alive) setChannel(value);
		});
		return () => {
			alive = false;
		};
	}, []);
	return channel !== "standard";
}

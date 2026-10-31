/** The host chooses the instance. Never silently route a missing URL to production. */
export function webGatewayBaseUrl(value: string | undefined): string {
	const gateway = value?.trim().replace(/\/+$/, "");
	if (!gateway) throw new Error("Naia gateway URL is required");
	return /\/v\d+$/.test(gateway) ? gateway : `${gateway}/v1`;
}

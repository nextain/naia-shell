/** Native Tauri always shows Connections. Browser preview needs ?naiaPreview=discord-connections. */
export function isConnectionsTabEnabled(opts: {
	isTauri: boolean;
	search: string;
	isDev: boolean;
}): boolean {
	if (opts.isTauri) return true;
	if (!opts.isDev) return false;
	return (
		new URLSearchParams(opts.search).get("naiaPreview") ===
		"discord-connections"
	);
}

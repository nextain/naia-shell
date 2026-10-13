/** Normalize Tauri asset URLs to the host permitted by the Shell CSP. */
export function normalizeTauriAssetUrl(source: string): string {
	return source
		.replace(/^asset:\/\/localhost(?=\/|$)\/?/, "http://asset.localhost/")
		.replace(/^http:\/\/localhost(?=\/|$)\/?/, "http://asset.localhost/");
}

const DEFAULT_BACKGROUND = "naia-sunrise-river.webp";
const FALLBACK_BACKGROUND = "naia-dawn-city-uhd.webp";

export function selectBackground(paths: readonly string[], saved: string | undefined): string | undefined {
	if (saved?.trim()) return paths.find((path) => path.endsWith(saved));
	return paths.find((path) => path.endsWith(DEFAULT_BACKGROUND)) ??
		paths.find((path) => path.endsWith(FALLBACK_BACKGROUND));
}

export function selectOnboardingBackground(paths: readonly string[]): string | undefined {
	return selectBackground(paths, undefined) ?? paths[0];
}

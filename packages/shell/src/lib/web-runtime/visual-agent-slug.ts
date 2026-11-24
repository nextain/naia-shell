export const DEFAULT_VISUAL_AGENT_SLUG = "naia";

export function isVisualAgentSlug(value: unknown): value is string {
	return typeof value === "string" &&
		value.length >= 3 && value.length <= 32 && !/[^a-z0-9-]/.test(value);
}

export function buildVisualAgentPublicUrl(slug: string): string {
	return `https://naia.land/visual-agent/${encodeURIComponent(slug)}`;
}

export function readVisualAgentSlugFromSearch(search: string): string | null {
	const slug = new URLSearchParams(search).get("visualAgent");
	return isVisualAgentSlug(slug) ? slug : null;
}

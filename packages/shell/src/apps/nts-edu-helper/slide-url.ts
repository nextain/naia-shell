import { TOTAL_SLIDES } from "./locales/messages";

export function deriveSlideBaseFromDocument(doc?: Document): string {
	const targetDoc =
		doc ?? (typeof document !== "undefined" ? document : undefined);
	if (!targetDoc) return "";
	const anchor = targetDoc.getElementById(
		"naia-asset-anchor",
	) as HTMLImageElement | null;
	const rawSrc = anchor?.getAttribute("src") || anchor?.src || "";
	if (!rawSrc) return "";
	return rawSrc.replace(/s01\.webp([?#].*)?$/, "");
}

export function resolveSlideImageUrl(slideNumber: number, doc?: Document): string {
	const clamped = Math.max(1, Math.min(TOTAL_SLIDES, Math.trunc(slideNumber)));
	const padded = String(clamped).padStart(2, "0");
	const base = deriveSlideBaseFromDocument(doc);
	return `${base}s${padded}.webp`;
}

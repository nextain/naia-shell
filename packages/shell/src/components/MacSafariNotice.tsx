import { t } from "../lib/i18n";
import { isKioskDemo } from "../lib/kiosk-demo/flag";
import { isWebMode } from "../lib/web-runtime/web-assets";

/** iPadOS desktop mode reports MacIntel, but also reports multiple touch points. */
export function isMacSafari(
	info: Pick<Navigator, "userAgent" | "platform" | "maxTouchPoints">,
): boolean {
	return (
		/Macintosh/.test(info.userAgent) &&
		/Mac/i.test(info.platform) &&
		(info.maxTouchPoints ?? 0) <= 1 &&
		/Version\/[\d.]+.*Safari\//.test(info.userAgent) &&
		!/Chrome|Chromium|CriOS|Edg|OPR|Opera|FxiOS|Firefox|Vivaldi|Brave|DuckDuckGo/i.test(
			info.userAgent,
		)
	);
}

export function MacSafariNotice({
	reserveMenuSpace = false,
}: { reserveMenuSpace?: boolean }) {
	if (
		!isWebMode() ||
		isKioskDemo() ||
		typeof navigator === "undefined" ||
		!isMacSafari(navigator)
	) {
		return null;
	}
	const copy = (
		key: "macSafari.title" | "macSafari.existingChrome" | "macSafari.download",
	) => t(key);
	return (
		<aside
			data-testid="mac-safari-notice"
			style={{
				position: "relative",
				zIndex: 20,
				flexShrink: 0,
				boxSizing: "border-box",
				width: "100%",
				padding: reserveMenuSpace ? "10px 60px 10px 16px" : "10px 16px",
				background: "#eaf3ff",
				color: "#14263e",
				fontSize: "0.9rem",
				lineHeight: 1.45,
				textAlign: "center",
			}}
		>
			<strong>{copy("macSafari.title")}</strong>{" "}
			<span>{copy("macSafari.existingChrome")}</span>{" "}
			<a
				href="https://www.google.com/chrome/"
				target="_blank"
				rel="noopener noreferrer"
				style={{
					color: "#064caa",
					textDecoration: "underline",
					whiteSpace: "nowrap",
				}}
			>
				{copy("macSafari.download")}
			</a>
		</aside>
	);
}

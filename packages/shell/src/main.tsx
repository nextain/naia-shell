import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { probeNvaCapabilities } from "./lib/avatar/nva-capability";
import { Logger } from "./lib/logger";
import "./styles/global.css";

if (
	import.meta.env.DEV &&
	new URLSearchParams(window.location.search).has("reset")
) {
	localStorage.clear();
}

// NVA 레이어드 플레이어 capability 진단 — 부팅 1회. 실 런타임(WebView2)에서 레이어드 합성 능력을
// 로깅해 fallback 원인을 가시화(codex R3)하고, WebView2 능력을 실검증(codex P0 C1)한다.
try {
	const nvaCaps = probeNvaCapabilities();
	Logger.info("NvaCapability", "레이어드 플레이어 능력 프로브", {
		...nvaCaps,
		reasons: nvaCaps.reasons.join(",") || "-",
	});
} catch (e) {
	Logger.warn("NvaCapability", "능력 프로브 실패", { error: String(e) });
}

// biome-ignore lint/style/noNonNullAssertion: root element always exists
createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);

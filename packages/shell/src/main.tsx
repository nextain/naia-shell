import "./lib/web-runtime/auto-install";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { setCodingWorkersAdapterFactory } from "./apps/workspace/coding-workers-adapter";
import { tauriCodingWorkersAdapter } from "./apps/workspace/coding-workers-tauri";
import { bootstrapShell } from "./lib/bootstrap-shell";
import { initializeI18n } from "./lib/i18n";
import { Logger } from "./lib/logger";
import { syncWebModeRootAttribute } from "./lib/web-runtime/web-assets";
import "./styles/global.css";
import "./styles/web-mode.css";

syncWebModeRootAttribute();

if (
	import.meta.env.DEV &&
	new URLSearchParams(window.location.search).has("reset")
) {
	localStorage.clear();
}

// The browser test surface deliberately keeps the unavailable adapter. Only a
// real Tauri window may call the paired Agent coding-job RPCs.
if ("__TAURI_INTERNALS__" in window) {
	setCodingWorkersAdapterFactory(() => tauriCodingWorkersAdapter);
}

async function bootstrap() {
	await bootstrapShell({
		initializeI18n,
		renderApp: () => {
			// biome-ignore lint/style/noNonNullAssertion: root element always exists
			createRoot(document.getElementById("root")!).render(
				<StrictMode>
					<App />
				</StrictMode>,
			);
		},
		afterRender: () => {
			void import("./studio-nva-apply-root");
			// UI를 먼저 그린 뒤 부팅 진단을 실행해 capability probe가 첫 화면을 막지 않게 한다.
			requestAnimationFrame(() => {
				void import("./lib/avatar/nva-capability")
					.then(({ probeNvaCapabilities }) => {
						const nvaCaps = probeNvaCapabilities();
						Logger.info("NvaCapability", "레이어드 플레이어 능력 프로브", {
							...nvaCaps,
							reasons: nvaCaps.reasons.join(",") || "-",
						});
					})
					.catch((error: unknown) =>
						Logger.warn("NvaCapability", "능력 프로브 실패", {
							error: String(error),
						}),
					);
			});
		},
		registerProjectApp: () => import("./apps/projects/index"),
		onProjectRegistrationFailure: (error) => {
			Logger.error("Main", "Built-in app registration failed", {
				error: String(error),
			});
		},
	});
}

void bootstrap();

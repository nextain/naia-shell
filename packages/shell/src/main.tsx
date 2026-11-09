import { KioskDemoGate } from "./components/KioskDemoGate";
import "./lib/web-runtime/auto-install";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { setCodingWorkersAdapterFactory } from "./apps/workspace/coding-workers-adapter";
import { tauriCodingWorkersAdapter } from "./apps/workspace/coding-workers-tauri";
import { bootstrapAdkPath } from "./lib/adk-store";
import { bootstrapShell } from "./lib/bootstrap-shell";
import { initializeI18n } from "./lib/i18n";
import { isKioskDemo } from "./lib/kiosk-demo/flag";
import { Logger } from "./lib/logger";
import { syncWebModeRootAttribute } from "./lib/web-runtime/web-assets";
import "./styles/global.css";
import "./styles/web-mode.css";

syncWebModeRootAttribute();

if (import.meta.env.MODE === "web" && "serviceWorker" in navigator) {
	void navigator.serviceWorker.register("/sw.js").then(async () => {
		const registration = await navigator.serviceWorker.ready;
		const cacheAssets = (entries: PerformanceEntry[]) => {
			registration.active?.postMessage({ type: "CACHE_PUBLIC_ASSETS", urls: entries.map((entry) => entry.name) });
		};
		cacheAssets(performance.getEntriesByType("resource"));
		if (typeof PerformanceObserver !== "undefined") {
			new PerformanceObserver((list) => cacheAssets(list.getEntries())).observe({ type: "resource" });
		}
	}).catch((error: unknown) => {
		Logger.warn("PWA", "Service worker registration failed", { error: String(error) });
	});
}

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
	if ("__TAURI_INTERNALS__" in window) await bootstrapAdkPath();
	const { App } = await import("./App");
	await bootstrapShell({
		initializeI18n,
		renderApp: () => {
			// biome-ignore lint/style/noNonNullAssertion: root element always exists
			createRoot(document.getElementById("root")!).render(
				<StrictMode>
					<KioskDemoGate>
						<App />
					</KioskDemoGate>
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
		registerProjectApp: () =>
			isKioskDemo() ? Promise.resolve(null) : import("./apps/projects/index"),
		onProjectRegistrationFailure: (error) => {
			Logger.error("Main", "Built-in app registration failed", {
				error: String(error),
			});
		},
	});
}

void bootstrap().catch((error: unknown) => {
	Logger.error("Main", "Workspace bootstrap failed", { error: String(error) });
	const root = document.getElementById("root");
	if (!root) return;
	const alert = document.createElement("p");
	alert.setAttribute("role", "alert");
	alert.textContent =
		"Cannot read workspace selection. Check data home permissions and restart. / 작업 경로를 읽을 수 없습니다. 데이터 홈 권한을 확인하고 다시 시작하세요.";
	root.replaceChildren(alert);
});

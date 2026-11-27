import { installInstalledAppContextBridge } from "./installed-app-context-bridge";
import { installInstalledAppHostBridge } from "./installed-app-host-bridge";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useLayoutEffect, useRef } from "react";
import { t } from "../../lib/i18n";
import {
	resolveAppToolTargetOrigin,
	validateAppToolParameters,
} from "../../lib/app-registry";
import type { AppCenterProps, NaiaTool } from "../../lib/app-registry";
import { getPlatformAppStoreAdapter } from "../../lib/app-store-adapter";
import { normalizeTauriAssetUrl } from "../../lib/asset-url";
import { installSlidesFilesBridge } from "../../lib/slides-files-bridge";
import { isTrustedSlidesEntry } from "../../lib/slides-host";
import { installSlidesHostBridge } from "../../lib/slides-host-bridge";
import { isWebMode } from "../../lib/web-runtime/web-assets";

/**
 * Tool-call protocol between the Shell and an installed iframe app.
 *
 * Shell → iframe:  { type: "naia-tool-call", id, tool, args }
 * iframe → Shell:  { type: "naia-tool-result", id, result? , error? }
 *
 * This is distinct from iframe-bridge.ts (`naia-bridge:*`), which carries
 * iframe → Shell service requests (readFile, secrets, …). Tool calls flow
 * host → app: the Agent invokes a app tool, the Shell routes it to the
 * app that owns it, the app computes the result in its own JS.
 */
const TOOL_CALL = "naia-tool-call";
const TOOL_RESULT = "naia-tool-result";
const TOOL_TIMEOUT_MS = 15_000;

/**
 * Factory: creates a center component for an installed app.
 *
 * If the app directory contains index.html, the component renders it via the
 * Tauri asset protocol (`convertFileSrc` — manual URL building breaks on
 * Windows drive letters). Any `tools` declared in app.json are registered
 * with the app's Naia bridge and routed to the iframe via postMessage, so an
 * installed app can expose AI tools the same way a built-in app does.
 */

/**
 * Linux(WebKitGTK)에서 `convertFileSrc` 는 `asset://localhost/…` 를 돌려주는데,
 * 셸 CSP `frame-src` 와 슬라이드 브리지(`slide-presenter-iframe-bridge.ts`)는
 * `http://asset.localhost` 만 허용한다 → 설치 앱 iframe 이 빈 화면으로 남는다
 * (2026-09-11 Linux 실측). AvatarCanvas 와 같은 정규화를 적용한다.
 */
export function installedAppFrameSrc(htmlEntry: string): string {
	if (isWebMode()) {
		return getPlatformAppStoreAdapter().resolveFrameSrc(htmlEntry);
	}
	return normalizeTauriAssetUrl(convertFileSrc(htmlEntry));
}

/**
 * Resolve `<iframe sandbox>` policy for installed mini-apps.
 *
 * Security boundary (Stage-1 Web App Store): any web mini-app or `/hosted-apps/*`
 * entry MUST omit `allow-same-origin` so the browser places the iframe into an
 * opaque `null` origin — physically blocking cookie, `localStorage`, and OPFS
 * access on `naia.land` / `dev.naia.land`.
 */
export function resolveInstalledAppSandboxAttr(
	frameSrc: string,
	trustedSlides: boolean,
): string {
	if (isWebMode() || /\/hosted-apps\//.test(frameSrc)) {
		return "allow-scripts allow-forms allow-downloads allow-popups";
	}
	return trustedSlides
		? "allow-scripts allow-same-origin allow-downloads allow-modals"
		: "allow-scripts allow-same-origin";
}

export function createGenericInstalledApp(
	htmlEntry?: string,
	tools: NaiaTool[] = [],
	appId = "",
	permissions: string[] = [],
) {
	return function GenericInstalledApp({ naia }: AppCenterProps) {
		const iframeRef = useRef<HTMLIFrameElement>(null);
		const frameSrc = htmlEntry ? installedAppFrameSrc(htmlEntry) : "";
		const trustedSlides = htmlEntry ? isTrustedSlidesEntry(htmlEntry) : false;
		const sandboxAttr = frameSrc
			? resolveInstalledAppSandboxAttr(frameSrc, trustedSlides)
			: "allow-scripts";
		const isOpaqueSandbox = !/\ballow-same-origin\b/i.test(sandboxAttr);

		useLayoutEffect(() => {
			if (!iframeRef.current || !htmlEntry || !frameSrc) return;
			const frame = iframeRef.current;
			const disposeContextBridge = installInstalledAppContextBridge(frame, appId, htmlEntry);
			const disposeAppBridge = installInstalledAppHostBridge(frame, frameSrc, appId, permissions);
			const disposeFilesBridge = installSlidesFilesBridge(frame, htmlEntry);
			const disposeHostBridge = installSlidesHostBridge(frame, htmlEntry, {
				expectedFrameSrc: frameSrc,
			});
			return () => {
				disposeContextBridge();
				disposeAppBridge();
				disposeHostBridge();
				disposeFilesBridge();
			};
		}, [htmlEntry, frameSrc, appId, permissions]);

		// Register a postMessage bridge for each declared tool.
		useEffect(() => {
			if (!htmlEntry || tools.length === 0) return;

			const unsubs = tools.map((tool) =>
				naia.onToolCall(tool.name, async (args) => {
					const invalidArgs = validateAppToolParameters(tool, args);
					if (invalidArgs) throw new Error(invalidArgs);
					const iframe = iframeRef.current;
					const contentWindow = iframe?.contentWindow;
					if (!iframe || !contentWindow) {
						return "(app not loaded yet)";
					}
					const targetOrigin = isOpaqueSandbox
						? "*"
						: resolveAppToolTargetOrigin(iframe.src);
					if (!targetOrigin) {
						throw new Error("Cannot send app tool call: invalid target origin");
					}
					const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
					const target = contentWindow;
					return new Promise<string>((resolve) => {
						const onResult = (e: MessageEvent) => {
							const d = e.data;
							if (
								e.source !== target ||
								!d ||
								typeof d !== "object" ||
								d.type !== TOOL_RESULT ||
								d.id !== id
							) {
								return;
							}
							window.removeEventListener("message", onResult);
							clearTimeout(timer);
							if (d.error) {
								resolve(String(d.error));
								return;
							}
							const r = d.result;
							resolve(
								typeof r === "string"
									? r
									: r == null
										? "ok"
										: JSON.stringify(r),
							);
						};
						const timer = setTimeout(() => {
							window.removeEventListener("message", onResult);
							resolve("(app tool timeout)");
						}, TOOL_TIMEOUT_MS);
						window.addEventListener("message", onResult);
						contentWindow.postMessage(
							{ type: TOOL_CALL, id, tool: tool.name, args },
							targetOrigin,
						);
					});
				}),
			);

			return () => {
				for (const u of unsubs) u();
			};
		}, [naia, htmlEntry, tools]);

		if (htmlEntry) {
			return (
				<iframe
					ref={iframeRef}
					className="generic-installed-app__iframe"
					src={frameSrc}
					title="App"
					allow={permissions.includes("clipboard.write") ? "clipboard-write" : undefined}
					sandbox={sandboxAttr}
					allowFullScreen={trustedSlides || isWebMode()}
				/>
			);
		}

		return (
			<div className="generic-installed-app">
				<div className="generic-installed-app__icon">📦</div>
				<p className="generic-installed-app__msg">
					{t("g1b.genericNotLoaded")}
				</p>
				<p className="generic-installed-app__hint">
					{t("g1b.genericAddIndex")}
				</p>
			</div>
		);
	};
}

/** Static placeholder — used before htmlEntry is known (e.g. import-time fallback). */
export function GenericInstalledApp(_props: AppCenterProps) {
	return createGenericInstalledApp()(_props);
}

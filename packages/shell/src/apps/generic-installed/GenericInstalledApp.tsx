import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import type { AppCenterProps, NaiaTool } from "../../lib/app-registry";

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
function installedAppFrameSrc(htmlEntry: string): string {
	return convertFileSrc(htmlEntry);
}

export function createGenericInstalledApp(
	htmlEntry?: string,
	tools: NaiaTool[] = [],
) {
	return function GenericInstalledApp({ naia }: AppCenterProps) {
		const iframeRef = useRef<HTMLIFrameElement>(null);

		// Register a postMessage bridge for each declared tool.
		useEffect(() => {
			if (!htmlEntry || tools.length === 0) return;

			const unsubs = tools.map((tool) =>
				naia.onToolCall(tool.name, async (args) => {
					const iframe = iframeRef.current;
					const contentWindow = iframe?.contentWindow;
					if (!iframe || !contentWindow) {
						return "(app not loaded yet)";
					}
					let targetOrigin = "*";
					try {
						targetOrigin = new URL(iframe.src).origin;
					} catch {
						// fall back to "*" — the app replies to its own loader origin
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

			return () => unsubs.forEach((u) => u());
		}, [naia, htmlEntry, tools]);

		if (htmlEntry) {
			return (
				<iframe
					ref={iframeRef}
					className="generic-installed-app__iframe"
					src={installedAppFrameSrc(htmlEntry)}
					title="App"
					sandbox="allow-scripts allow-same-origin"
				/>
			);
		}

		return (
			<div className="generic-installed-app">
				<div className="generic-installed-app__icon">📦</div>
				<p className="generic-installed-app__msg">
					이 앱은 설치됐지만 아직 로드되지 않았습니다.
				</p>
				<p className="generic-installed-app__hint">
					앱 디렉터리에 index.html을 추가하면 즉시 표시됩니다.
				</p>
			</div>
		);
	};
}

/** Static placeholder — used before htmlEntry is known (e.g. import-time fallback). */
export function GenericInstalledApp(_props: AppCenterProps) {
	return createGenericInstalledApp()(_props);
}

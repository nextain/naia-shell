import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import type { NaiaTool, PanelCenterProps } from "../../lib/panel-registry";

/**
 * Tool-call protocol between the Shell and an installed iframe panel.
 *
 * Shell → iframe:  { type: "naia-tool-call", id, tool, args }
 * iframe → Shell:  { type: "naia-tool-result", id, result? , error? }
 *
 * This is distinct from iframe-bridge.ts (`naia-bridge:*`), which carries
 * iframe → Shell service requests (readFile, secrets, …). Tool calls flow
 * host → panel: the Agent invokes a panel tool, the Shell routes it to the
 * panel that owns it, the panel computes the result in its own JS.
 */
const TOOL_CALL = "naia-tool-call";
const TOOL_RESULT = "naia-tool-result";
const TOOL_TIMEOUT_MS = 15_000;

/**
 * Factory: creates a center component for an installed panel.
 *
 * If the panel directory contains index.html, the component renders it via the
 * Tauri asset protocol (`convertFileSrc` — manual URL building breaks on
 * Windows drive letters). Any `tools` declared in panel.json are registered
 * with the panel's Naia bridge and routed to the iframe via postMessage, so an
 * installed panel can expose AI tools the same way a built-in panel does.
 */
export function createGenericInstalledPanel(
	htmlEntry?: string,
	tools: NaiaTool[] = [],
) {
	return function GenericInstalledPanel({ naia }: PanelCenterProps) {
		const iframeRef = useRef<HTMLIFrameElement>(null);

		// Register a postMessage bridge for each declared tool.
		useEffect(() => {
			if (!htmlEntry || tools.length === 0) return;

			const unsubs = tools.map((tool) =>
				naia.onToolCall(tool.name, async (args) => {
					const iframe = iframeRef.current;
					const contentWindow = iframe?.contentWindow;
					if (!iframe || !contentWindow) {
						return "(panel not loaded yet)";
					}
					let targetOrigin = "*";
					try {
						targetOrigin = new URL(iframe.src).origin;
					} catch {
						// fall back to "*" — the panel replies to its own loader origin
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
							resolve("(panel tool timeout)");
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
					className="generic-installed-panel__iframe"
					src={convertFileSrc(htmlEntry)}
					title="Panel"
					sandbox="allow-scripts allow-same-origin"
				/>
			);
		}

		return (
			<div className="generic-installed-panel">
				<div className="generic-installed-panel__icon">📦</div>
				<p className="generic-installed-panel__msg">
					이 앱은 설치됐지만 아직 로드되지 않았습니다.
				</p>
				<p className="generic-installed-panel__hint">
					앱 디렉터리에 index.html을 추가하면 즉시 표시됩니다.
				</p>
			</div>
		);
	};
}

/** Static placeholder — used before htmlEntry is known (e.g. import-time fallback). */
export function GenericInstalledPanel(_props: PanelCenterProps) {
	return createGenericInstalledPanel()(_props);
}

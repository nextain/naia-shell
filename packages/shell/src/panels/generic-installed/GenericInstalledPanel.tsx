import type { PanelCenterProps } from "../../lib/panel-registry";

/**
 * Factory: creates a center component for an installed panel.
 *
 * If the panel directory contains index.html, the component renders it
 * via iframe using Tauri asset protocol (http://asset.localhost/{abs_path}).
 * Otherwise shows a placeholder.
 */
export function createGenericInstalledPanel(htmlEntry?: string) {
	return function GenericInstalledPanel(_props: PanelCenterProps) {
		if (htmlEntry) {
			// Convert absolute path to Tauri asset protocol URL
			// /home/user/... → http://asset.localhost/home/user/...
			const assetUrl = `http://asset.localhost${htmlEntry}`;
			return (
				<iframe
					className="generic-installed-panel__iframe"
					src={assetUrl}
					title="Panel"
					sandbox="allow-scripts allow-same-origin"
				/>
			);
		}

		return (
			<div className="generic-installed-panel">
				<div className="generic-installed-panel__icon">📦</div>
				<p className="generic-installed-panel__msg">
					이 패널은 설치됐지만 아직 로드되지 않았습니다.
				</p>
				<p className="generic-installed-panel__hint">
					패널 디렉터리에 index.html을 추가하면 즉시 표시됩니다.
				</p>
			</div>
		);
	};
}

/** Static placeholder — used before htmlEntry is known (e.g. import-time fallback). */
export function GenericInstalledPanel(_props: PanelCenterProps) {
	return createGenericInstalledPanel()(_props);
}

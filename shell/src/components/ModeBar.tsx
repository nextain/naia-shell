import { type MouseEvent, useEffect, useMemo, useState } from "react";
import {
	type BrowserLink,
	loadBrowserShortcuts,
	onBrowserPrefsChanged,
	removeBrowserShortcut,
} from "../lib/browser-prefs";
import { loadConfig, saveConfig } from "../lib/config";
import { getLocale } from "../lib/i18n";
import { Logger } from "../lib/logger";
import { removeInstalledPanel } from "../lib/panel-loader";
import { panelRegistry } from "../lib/panel-registry";
import { usePanelStore } from "../stores/panel";

interface ModeBarProps {
	/** Called when user clicks the + button. Hook up panel marketplace or file picker. */
	onAddMode?: () => void;
}

export function ModeBar({ onAddMode }: ModeBarProps) {
	const {
		activePanel,
		setActivePanel,
		panelListVersion,
		bumpPanelListVersion,
	} = usePanelStore();
	const [browserShortcuts, setBrowserShortcuts] = useState<BrowserLink[]>([]);

	// Rebuild panel list whenever panelListVersion changes (runtime install/remove)
	// Exclude avatar panel (shown as fixed "바탕화면" tab separately)
	const modes = useMemo(
		() =>
			panelRegistry
				.list()
				.filter((p) => p.id !== "avatar" && p.id !== "settings"),
		// panelListVersion is the reactive dependency — registry is not observable directly
		[panelListVersion],
	);

	useEffect(() => {
		let alive = true;
		const load = () => {
			loadBrowserShortcuts()
				.then((items) => {
					if (alive) setBrowserShortcuts(items);
				})
				.catch((err) => {
					Logger.warn("ModeBar", "Failed to load browser shortcuts", {
						error: String(err),
					});
				});
		};
		load();
		const off = onBrowserPrefsChanged(load);
		return () => {
			alive = false;
			off();
		};
	}, []);

	async function handleRemovePanel(
		e: MouseEvent<HTMLButtonElement>,
		panelId: string,
	) {
		e.stopPropagation();
		const descriptor = panelRegistry.get(panelId);
		Logger.info("ModeBar", `Removing panel: ${panelId}`, {
			source: descriptor?.source,
		});

		if (descriptor?.source === "installed") {
			// Unregisters + deletes from disk + bumps panelListVersion
			await removeInstalledPanel(panelId);
		} else {
			// Build-time panel: unregister in memory + persist deletion in config
			panelRegistry.unregister(panelId);
			const cfg = loadConfig();
			if (cfg) {
				const prev = cfg.deletedPanels ?? [];
				if (!prev.includes(panelId)) {
					saveConfig({ ...cfg, deletedPanels: [...prev, panelId] });
				}
			}
			bumpPanelListVersion();
		}

		if (activePanel === panelId) {
			setActivePanel(null);
		}

		Logger.debug("ModeBar", `Panel removed: ${panelId}`);
	}

	function openBrowserShortcut(url: string) {
		setActivePanel("browser");
		const navigate = () => {
			panelRegistry
				.getApi<{ navigate: (url: string) => void }>("browser")
				?.navigate(url);
		};
		navigate();
		window.setTimeout(navigate, 50);
	}

	function handleRemoveBrowserShortcut(
		e: MouseEvent<HTMLButtonElement>,
		url: string,
	) {
		e.stopPropagation();
		removeBrowserShortcut(url)
			.then(setBrowserShortcuts)
			.catch((err) => {
				Logger.warn("ModeBar", "Failed to remove browser shortcut", {
					url,
					error: String(err),
				});
			});
	}

	return (
		<div className="mode-bar">
			<div className="mode-bar-tabs">
				{/* 바탕화면 — no panel active */}
				<button
					type="button"
					className={`mode-bar-tab${activePanel === null ? " mode-bar-tab--active" : ""}`}
					onClick={() => setActivePanel(null)}
					title="바탕화면"
				>
					<span className="mode-bar-tab-icon">🖥️</span>
				</button>
				{modes.map((mode) => (
					<div
						key={mode.id}
						className="mode-bar-tab-wrapper"
						data-panel-id={mode.id}
					>
						<button
							type="button"
							className={`mode-bar-tab${activePanel === mode.id ? " mode-bar-tab--active" : ""}`}
							data-panel-id={mode.id}
							title={mode.names?.[getLocale()] ?? mode.name}
							onClick={() =>
								setActivePanel(activePanel === mode.id ? null : mode.id)
							}
						>
							{mode.iconSvg ? (
								<span
									className="mode-bar-tab-icon mode-bar-tab-icon--svg"
									// biome-ignore lint/security/noDangerouslySetInnerHtml: trusted panel SVG
									dangerouslySetInnerHTML={{ __html: mode.iconSvg }}
								/>
							) : mode.icon ? (
								<span className="mode-bar-tab-icon">{mode.icon}</span>
							) : null}
						</button>
						{!mode.builtIn && (
							<button
								type="button"
								className="mode-bar-tab-remove"
								title={`Remove ${mode.name}`}
								onClick={(e) => handleRemovePanel(e, mode.id)}
							>
								🗑
							</button>
						)}
					</div>
				))}
				{browserShortcuts.map((shortcut) => (
					<div
						key={shortcut.url}
						className="mode-bar-tab-wrapper"
						data-browser-shortcut={shortcut.url}
					>
						<button
							type="button"
							className="mode-bar-tab mode-bar-tab--shortcut"
							title={shortcut.title || shortcut.url}
							onClick={() => openBrowserShortcut(shortcut.url)}
						>
							{shortcut.iconUrl ? (
								<img
									className="mode-bar-tab-favicon"
									src={shortcut.iconUrl}
									alt=""
								/>
							) : (
								<span className="mode-bar-tab-icon">Go</span>
							)}
						</button>
						<button
							type="button"
							className="mode-bar-tab-remove"
							title={`Remove ${shortcut.title || shortcut.url}`}
							onClick={(e) => handleRemoveBrowserShortcut(e, shortcut.url)}
						>
							x
						</button>
					</div>
				))}
			</div>
			<button
				type="button"
				className="mode-bar-add"
				onClick={onAddMode}
				title="패널 추가"
			>
				+
			</button>
			<button
				type="button"
				className={`mode-bar-settings${activePanel === "settings" ? " mode-bar-settings--active" : ""}`}
				onClick={() =>
					setActivePanel(activePanel === "settings" ? null : "settings")
				}
				title="설정"
			>
				<svg
					viewBox="0 0 20 20"
					fill="currentColor"
					width="16"
					height="16"
					aria-hidden="true"
				>
					<path
						fillRule="evenodd"
						d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z"
						clipRule="evenodd"
					/>
				</svg>
			</button>
		</div>
	);
}

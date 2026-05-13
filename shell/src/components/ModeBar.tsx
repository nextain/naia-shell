import { type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type BrowserLink,
	addBrowserShortcut,
	loadBrowserShortcuts,
	onBrowserPrefsChanged,
	removeBrowserShortcut,
} from "../lib/browser-prefs";
import { loadConfig, saveConfig } from "../lib/config";
import { getLocale, t } from "../lib/i18n";
import { Logger } from "../lib/logger";
import { removeInstalledPanel } from "../lib/panel-loader";
import { panelRegistry } from "../lib/panel-registry";
import { usePanelStore } from "../stores/panel";

interface ModeBarProps {
	onAddMode?: () => void;
}

function extractInitial(shortcut: BrowserLink): string {
	const source = shortcut.title || shortcut.url;
	const m = source.match(/([a-zA-Z0-9\uAC00-\uD7AF])/);
	return m ? m[1].toUpperCase() : "?";
}

export function ModeBar({ onAddMode }: ModeBarProps) {
	const {
		activePanel,
		setActivePanel,
		panelListVersion,
		bumpPanelListVersion,
		pushModal,
		popModal,
	} = usePanelStore();
	const [browserShortcuts, setBrowserShortcuts] = useState<BrowserLink[]>([]);
	const [ctxMenu, setCtxMenu] = useState<{
		x: number;
		y: number;
		shortcutUrl?: string;
		panelId?: string;
	} | null>(null);
	const ctxMenuRef = useRef<HTMLDivElement>(null);
	const [addUrlDialog, setAddUrlDialog] = useState(false);
	const [urlInputDialog, setUrlInputDialog] = useState(false);
	const [addUrlInput, setAddUrlInput] = useState("");

	// Hide browser native webview while any dialog is open (webview renders above HTML z-index)
	useEffect(() => {
		if (!addUrlDialog && !urlInputDialog) return;
		pushModal();
		return () => popModal();
	}, [addUrlDialog, urlInputDialog, pushModal, popModal]);

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

	function handleCtxRemoveShortcut() {
		if (!ctxMenu?.shortcutUrl) return;
		removeBrowserShortcut(ctxMenu.shortcutUrl)
			.then(setBrowserShortcuts)
			.catch((err) => {
				Logger.warn("ModeBar", "Failed to remove browser shortcut", {
					url: ctxMenu.shortcutUrl,
					error: String(err),
				});
			});
		setCtxMenu(null);
	}

	function handleCtxRemovePanel() {
		if (!ctxMenu?.panelId) return;
		const panelId = ctxMenu.panelId;
		const descriptor = panelRegistry.get(panelId);
		if (descriptor?.source === "installed") {
			removeInstalledPanel(panelId);
		} else {
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
		if (activePanel === panelId) setActivePanel(null);
		setCtxMenu(null);
	}

	const handleTabBarContextMenu = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			const target = e.target as HTMLElement;
			const shortcutEl = target.closest("[data-browser-shortcut]");
			if (shortcutEl) {
				const url = shortcutEl.getAttribute("data-browser-shortcut") ?? "";
				setCtxMenu({ x: e.clientX, y: e.clientY, shortcutUrl: url });
				return;
			}
			const panelEl = target.closest("[data-panel-id]");
			if (panelEl) {
				const id = panelEl.getAttribute("data-panel-id") ?? "";
				const descriptor = panelRegistry.get(id);
				if (descriptor && !descriptor.builtIn) {
					setCtxMenu({ x: e.clientX, y: e.clientY, panelId: id });
					return;
				}
			}
			setCtxMenu({ x: e.clientX, y: e.clientY });
		},
		[activePanel],
	);

	useEffect(() => {
		if (!ctxMenu) return;
		const close = () => setCtxMenu(null);
		window.addEventListener("click", close);
		window.addEventListener("contextmenu", close);
		const timer = setTimeout(close, 5000);
		return () => {
			window.removeEventListener("click", close);
			window.removeEventListener("contextmenu", close);
			clearTimeout(timer);
		};
	}, [ctxMenu]);

	async function handleAddUrlSubmit() {
		let url = addUrlInput.trim();
		if (!url) return;
		if (!url.includes("://")) url = `https://${url}`;
		try {
			const u = new URL(url);
			const iconUrl = `${u.origin}/favicon.ico`;
			const title = u.hostname;
			const result = await addBrowserShortcut(title, url, iconUrl);
			setBrowserShortcuts(result);
		} catch {
			try {
				const result = await addBrowserShortcut(url, url);
				setBrowserShortcuts(result);
			} catch (err) {
				Logger.warn("ModeBar", "Failed to add shortcut", {
					error: String(err),
				});
			}
		}
		setAddUrlInput("");
		setUrlInputDialog(false);
	}

	return (
		<div className="mode-bar">
			<div
				className="mode-bar-tabs"
				onContextMenu={handleTabBarContextMenu}
			>
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
									onError={(e) => {
										const img = e.currentTarget;
										const fallback = extractInitial(shortcut);
										img.replaceWith(
											Object.assign(document.createElement("span"), {
												className:
													"mode-bar-tab-icon mode-bar-tab-icon--initial",
												textContent: fallback,
											}),
										);
									}}
								/>
							) : (
								<span className="mode-bar-tab-icon mode-bar-tab-icon--initial">
									{extractInitial(shortcut)}
								</span>
							)}
						</button>
					</div>
				))}
			</div>
			{ctxMenu && (
				<div
					ref={ctxMenuRef}
					className="mode-bar-ctx-menu"
					style={{ left: ctxMenu.x, top: ctxMenu.y }}
				>
					{ctxMenu.shortcutUrl && (
						<button
							type="button"
							className="mode-bar-ctx-menu__item mode-bar-ctx-menu__item--danger"
							onClick={handleCtxRemoveShortcut}
						>
							{t("modebar.removeShortcut")}
						</button>
					)}
					{ctxMenu.panelId && (
						<button
							type="button"
							className="mode-bar-ctx-menu__item mode-bar-ctx-menu__item--danger"
							onClick={handleCtxRemovePanel}
						>
							{t("modebar.removePanel")}
						</button>
					)}
				</div>
			)}
			{addUrlDialog && (
				<div
					className="mode-bar-url-dialog-overlay"
					onClick={() => setAddUrlDialog(false)}
				>
					<div
						className="mode-bar-url-dialog"
						onClick={(e) => e.stopPropagation()}
					>
						<button
							type="button"
							className="mode-bar-url-dialog__section"
							onClick={() => {
								setAddUrlDialog(false);
								setUrlInputDialog(true);
							}}
						>
							<span className="mode-bar-url-dialog__section-icon">🌐</span>
							<div className="mode-bar-url-dialog__section-text">
								<strong>{t("modebar.addShortcut")}</strong>
								<span>{t("modebar.addShortcutDesc")}</span>
							</div>
						</button>
						<button
							type="button"
							className="mode-bar-url-dialog__section"
							onClick={() => {
								setAddUrlDialog(false);
								onAddMode?.();
							}}
						>
							<span className="mode-bar-url-dialog__section-icon">📱</span>
							<div className="mode-bar-url-dialog__section-text">
								<strong>{t("modebar.addPanel")}</strong>
								<span>{t("modebar.addPanelDesc")}</span>
							</div>
						</button>
					</div>
				</div>
			)}
			{urlInputDialog && (
				<div
					className="mode-bar-url-dialog-overlay"
					onClick={() => setUrlInputDialog(false)}
				>
					<form
						className="mode-bar-url-dialog"
						onClick={(e) => e.stopPropagation()}
						onSubmit={(e) => {
							e.preventDefault();
							handleAddUrlSubmit();
						}}
					>
						<input
							type="text"
							className="mode-bar-url-dialog__input"
							value={addUrlInput}
							onChange={(e) => setAddUrlInput(e.target.value)}
							placeholder={t("modebar.enterUrl")}
							autoFocus
						/>
						<div className="mode-bar-url-dialog__btns">
							<button
								type="button"
								className="mode-bar-url-dialog__btn"
								onClick={() => setUrlInputDialog(false)}
							>
								{t("settings.cancel")}
							</button>
							<button
								type="submit"
								className="mode-bar-url-dialog__btn mode-bar-url-dialog__btn--primary"
							>
								{t("settings.save")}
							</button>
						</div>
					</form>
				</div>
			)}
			<button
				type="button"
				className="mode-bar-add"
				onClick={() => setAddUrlDialog(true)}
				title={t("modebar.addItem")}
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

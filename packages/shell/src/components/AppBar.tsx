import { type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
	type BrowserLink,
	addBrowserShortcut,
	loadBrowserShortcuts,
	onBrowserPrefsChanged,
	reorderBrowserShortcuts,
	removeBrowserShortcut,
	updateBrowserShortcutIcon,
} from "../lib/browser-prefs";
import { loadConfig, saveConfig } from "../lib/config";
import { getLocale, t } from "../lib/i18n";
import { Logger } from "../lib/logger";
import { getBridgeForPanel } from "../lib/active-bridge";
import { removeInstalledApp } from "../lib/app-loader";
import { appRegistry } from "../lib/app-registry";
import { useAppStore } from "../stores/app";
import { BgmPlayer } from "./BgmPlayer";

// BGM player lives in the always-on app-bar (not a switchable panel), so it
// needs its own persistent bridge to push BGM context (favorites, current
// track) into Naia's system prompt. Without a bridge the push is dead code
// (`if (!naia) return` in BgmPlayer) and the AI never sees favoritesList.
const bgmBridge = getBridgeForPanel("bgm");

interface AppBarProps {
	onAddMode?: () => void;
}

function extractInitial(shortcut: BrowserLink): string {
	const source = shortcut.title || shortcut.url;
	const m = source.match(/([a-zA-Z0-9\uAC00-\uD7AF])/);
	return m ? m[1].toUpperCase() : "?";
}

export function AppBar({ onAddMode }: AppBarProps) {
	const {
		activeApp,
		setActiveApp,
		appListVersion,
		bumpAppListVersion,
		pushModal,
		popModal,
	} = useAppStore();

	const [browserShortcuts, setBrowserShortcuts] = useState<BrowserLink[]>([]);
	const [ctxMenu, setCtxMenu] = useState<{
		x: number;
		y: number;
		shortcutUrl?: string;
		appId?: string;
	} | null>(null);
	const ctxMenuRef = useRef<HTMLDivElement>(null);
	const [addUrlDialog, setAddUrlDialog] = useState(false);
	const [urlInputDialog, setUrlInputDialog] = useState(false);
	const [addUrlInput, setAddUrlInput] = useState("");
	// Edit mode — shows delete overlays and enables drag-to-reorder + icon editor
	const [editMode, setEditMode] = useState(false);
	const [dragOverUrl, setDragOverUrl] = useState<string | null>(null);
	const dragSrcUrlRef = useRef<string | null>(null);
	// Icon editor dialog
	const [iconEditing, setIconEditing] = useState<BrowserLink | null>(null);
	const [iconInput, setIconInput] = useState("");

	// Hide browser native webview while any dialog is open (webview renders above HTML z-index).
	// Use a single boolean so transitioning between dialogs (addUrlDialog→urlInputDialog)
	// does NOT trigger cleanup+re-run, which would fire browser_wv_show then browser_wv_hide
	// in rapid succession causing a white-screen flash.
	const isAnyDialogOpen = addUrlDialog || urlInputDialog || !!iconEditing;
	useEffect(() => {
		if (!isAnyDialogOpen) return;
		pushModal();
		return () => popModal();
	}, [isAnyDialogOpen, pushModal, popModal]);

	// Rebuild panel list whenever appListVersion changes (runtime install/remove)
	// Exclude avatar panel (shown as fixed "바탕화면" tab separately)
	const modes = useMemo(
		() =>
			appRegistry
				.list()
				.filter((p) => p.id !== "avatar" && p.id !== "settings"),
		// appListVersion is the reactive dependency — registry is not observable directly
		[appListVersion],
	);

	useEffect(() => {
		let alive = true;
		const load = () => {
			loadBrowserShortcuts()
				.then((items) => {
					if (alive) setBrowserShortcuts(items);
				})
				.catch((err) => {
					Logger.warn("AppBar", "Failed to load browser shortcuts", {
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
		appId: string,
	) {
		e.stopPropagation();
		const descriptor = appRegistry.get(appId);
		Logger.info("AppBar", `Removing app: ${appId}`, {
			source: descriptor?.source,
		});

		if (descriptor?.source === "installed") {
			// Unregisters + deletes from disk + bumps appListVersion
			await removeInstalledApp(appId);
		} else {
			// Build-time app: unregister in memory + persist deletion in config
			appRegistry.unregister(appId);
			const cfg = loadConfig();
			if (cfg) {
				const prev = cfg.deletedPanels ?? [];
				if (!prev.includes(appId)) {
					saveConfig({ ...cfg, deletedPanels: [...prev, appId] });
				}
			}
			bumpAppListVersion();
		}

		if (activeApp === appId) {
			setActiveApp(null);
		}

		Logger.debug("AppBar", `Panel removed: ${appId}`);
	}

	function openBrowserShortcut(url: string) {
		setActiveApp("browser");
		const navigate = () => {
			appRegistry
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
				Logger.warn("AppBar", "Failed to remove browser shortcut", {
					url: ctxMenu.shortcutUrl,
					error: String(err),
				});
			});
		setCtxMenu(null);
	}

	function handleCtxRemovePanel() {
		if (!ctxMenu?.appId) return;
		const appId = ctxMenu.appId;
		const descriptor = appRegistry.get(appId);
		if (descriptor?.source === "installed") {
			removeInstalledApp(appId);
		} else {
			appRegistry.unregister(appId);
			const cfg = loadConfig();
			if (cfg) {
				const prev = cfg.deletedPanels ?? [];
				if (!prev.includes(appId)) {
					saveConfig({ ...cfg, deletedPanels: [...prev, appId] });
				}
			}
			bumpAppListVersion();
		}
		if (activeApp === appId) setActiveApp(null);
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
				const descriptor = appRegistry.get(id);
				if (descriptor && !descriptor.builtIn) {
					setCtxMenu({ x: e.clientX, y: e.clientY, appId: id });
					return;
				}
			}
			setCtxMenu({ x: e.clientX, y: e.clientY });
		},
		[activeApp],
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

	// Drag-to-reorder handlers
	function handleDragStart(url: string) {
		dragSrcUrlRef.current = url;
	}
	function handleDragOver(e: React.DragEvent, url: string) {
		e.preventDefault();
		setDragOverUrl(url);
	}
	function handleDrop(targetUrl: string) {
		const srcUrl = dragSrcUrlRef.current;
		if (!srcUrl || srcUrl === targetUrl) {
			setDragOverUrl(null);
			return;
		}
		const list = [...browserShortcuts];
		const srcIdx = list.findIndex((s) => s.url === srcUrl);
		const tgtIdx = list.findIndex((s) => s.url === targetUrl);
		if (srcIdx === -1 || tgtIdx === -1) { setDragOverUrl(null); return; }
		const [moved] = list.splice(srcIdx, 1);
		list.splice(tgtIdx, 0, moved);
		setBrowserShortcuts(list);
		reorderBrowserShortcuts(list).catch(() => {});
		setDragOverUrl(null);
		dragSrcUrlRef.current = null;
	}
	function handleDragEnd() {
		setDragOverUrl(null);
		dragSrcUrlRef.current = null;
	}

	// Icon editor
	function openIconEditor(shortcut: BrowserLink) {
		setIconEditing(shortcut);
		setIconInput(shortcut.iconUrl ?? "");
	}
	async function handleIconSave() {
		if (!iconEditing) return;
		const updated = await updateBrowserShortcutIcon(iconEditing.url, iconInput.trim() || undefined);
		setBrowserShortcuts(updated);
		setIconEditing(null);
	}

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
				Logger.warn("AppBar", "Failed to add shortcut", {
					error: String(err),
				});
			}
		}
		setAddUrlInput("");
		setUrlInputDialog(false);
	}

	return (
		<div className="app-bar">
			<div
				className="app-bar-tabs"
				onContextMenu={handleTabBarContextMenu}
			>
				{/* 바탕화면 — no panel active */}
				<button
					type="button"
					className={`app-bar-tab${activeApp === null ? " app-bar-tab--active" : ""}`}
					onClick={() => setActiveApp(null)}
					title="바탕화면"
				>
					<span className="app-bar-tab-icon">🖥️</span>
				</button>
				{modes.map((mode) => (
					<div
						key={mode.id}
						className="app-bar-tab-wrapper"
						data-panel-id={mode.id}
					>
						<button
							type="button"
							className={`app-bar-tab${activeApp === mode.id ? " app-bar-tab--active" : ""}`}
							data-panel-id={mode.id}
							title={mode.names?.[getLocale()] ?? mode.name}
							onClick={() =>
								setActiveApp(activeApp === mode.id ? null : mode.id)
							}
						>
							{mode.iconSvg ? (
								<span
									className="app-bar-tab-icon app-bar-tab-icon--svg"
									// biome-ignore lint/security/noDangerouslySetInnerHtml: trusted panel SVG
									dangerouslySetInnerHTML={{ __html: mode.iconSvg }}
								/>
							) : mode.icon ? (
								<span className="app-bar-tab-icon">{mode.icon}</span>
							) : null}
						</button>
						{!mode.builtIn && (
							<button
								type="button"
								className="app-bar-tab-remove"
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
						className={`app-bar-tab-wrapper${dragOverUrl === shortcut.url ? " app-bar-tab-wrapper--drag-over" : ""}`}
						data-browser-shortcut={shortcut.url}
						draggable={editMode}
						onDragStart={editMode ? () => handleDragStart(shortcut.url) : undefined}
						onDragOver={editMode ? (e) => handleDragOver(e, shortcut.url) : undefined}
						onDrop={editMode ? () => handleDrop(shortcut.url) : undefined}
						onDragEnd={editMode ? handleDragEnd : undefined}
					>
						<button
							type="button"
							className={`app-bar-tab app-bar-tab--shortcut${editMode ? " app-bar-tab--edit" : ""}`}
							title={editMode ? `아이콘 변경: ${shortcut.title || shortcut.url}` : (shortcut.title || shortcut.url)}
							onClick={() => {
								if (editMode) { openIconEditor(shortcut); } else { openBrowserShortcut(shortcut.url); }
							}}
						>
							{shortcut.iconUrl ? (
								<img
									className="app-bar-tab-favicon"
									src={shortcut.iconUrl}
									alt=""
									onError={(e) => {
										const img = e.currentTarget;
										const fallback = extractInitial(shortcut);
										img.replaceWith(
											Object.assign(document.createElement("span"), {
												className:
													"app-bar-tab-icon app-bar-tab-icon--initial",
												textContent: fallback,
											}),
										);
									}}
								/>
							) : (
								<span className="app-bar-tab-icon app-bar-tab-icon--initial">
									{extractInitial(shortcut)}
								</span>
							)}
						</button>
						{editMode && (
							<button
								type="button"
								className="app-bar-tab-remove app-bar-tab-remove--shortcut"
								title="바로가기 삭제"
								onClick={(e) => {
									e.stopPropagation();
									removeBrowserShortcut(shortcut.url)
										.then(setBrowserShortcuts)
										.catch(() => {});
								}}
							>
								✕
							</button>
						)}
					</div>
				))}
			</div>
			{ctxMenu && (
				<div
					ref={ctxMenuRef}
					className="app-bar-ctx-menu"
					style={{ left: ctxMenu.x, top: ctxMenu.y }}
				>
					{ctxMenu.shortcutUrl && (
						<button
							type="button"
							className="app-bar-ctx-menu__item app-bar-ctx-menu__item--danger"
							onClick={handleCtxRemoveShortcut}
						>
							{t("appbar.removeShortcut")}
						</button>
					)}
					{ctxMenu.appId && (
						<button
							type="button"
							className="app-bar-ctx-menu__item app-bar-ctx-menu__item--danger"
							onClick={handleCtxRemovePanel}
						>
							{t("appbar.removePanel")}
						</button>
					)}
				</div>
			)}
			{addUrlDialog && createPortal(
				<div
					className="app-bar-url-dialog-overlay"
					onClick={() => setAddUrlDialog(false)}
				>
					<div
						className="app-bar-url-dialog"
						onClick={(e) => e.stopPropagation()}
					>
						<button
							type="button"
							className="app-bar-url-dialog__section"
							onClick={() => {
								setAddUrlDialog(false);
								setUrlInputDialog(true);
							}}
						>
							<span className="app-bar-url-dialog__section-icon">🌐</span>
							<div className="app-bar-url-dialog__section-text">
								<strong>{t("appbar.addShortcut")}</strong>
								<span>{t("appbar.addShortcutDesc")}</span>
							</div>
						</button>
						<button
							type="button"
							className="app-bar-url-dialog__section"
							onClick={() => {
								setAddUrlDialog(false);
								onAddMode?.();
							}}
						>
							<span className="app-bar-url-dialog__section-icon">📱</span>
							<div className="app-bar-url-dialog__section-text">
								<strong>{t("appbar.addPanel")}</strong>
								<span>{t("appbar.addPanelDesc")}</span>
							</div>
						</button>
					</div>
				</div>
			, document.body,
			)}
			{urlInputDialog && createPortal(
				<div
					className="app-bar-url-dialog-overlay"
					onClick={() => setUrlInputDialog(false)}
				>
					<form
						className="app-bar-url-dialog"
						onClick={(e) => e.stopPropagation()}
						onSubmit={(e) => {
							e.preventDefault();
							handleAddUrlSubmit();
						}}
					>
						<input
							type="text"
							className="app-bar-url-dialog__input"
							value={addUrlInput}
							onChange={(e) => setAddUrlInput(e.target.value)}
							placeholder={t("appbar.enterUrl")}
							autoFocus
						/>
						<div className="app-bar-url-dialog__btns">
							<button
								type="button"
								className="app-bar-url-dialog__btn"
								onClick={() => setUrlInputDialog(false)}
							>
								{t("settings.cancel")}
							</button>
							<button
								type="submit"
								className="app-bar-url-dialog__btn app-bar-url-dialog__btn--primary"
							>
								{t("settings.save")}
							</button>
						</div>
					</form>
				</div>
			, document.body,
			)}
			<button
				type="button"
				className="app-bar-add"
				onClick={() => setAddUrlDialog(true)}
				title={t("appbar.addItem")}
			>
				+
			</button>
			{browserShortcuts.length > 0 && (
				<button
					type="button"
					className={`app-bar-edit${editMode ? " app-bar-edit--active" : ""}`}
					onClick={() => { setEditMode((v) => !v); setIconEditing(null); }}
					title={editMode ? "편집 완료" : "바로가기 편집"}
				>
					✏
				</button>
			)}
			{iconEditing && createPortal(
				<div
					className="app-bar-url-dialog-overlay"
					onClick={() => setIconEditing(null)}
				>
					<form
						className="app-bar-url-dialog"
						onClick={(e) => e.stopPropagation()}
						onSubmit={(e) => { e.preventDefault(); void handleIconSave(); }}
					>
						<div className="app-bar-url-dialog__section-text" style={{ padding: "0 0 8px" }}>
							<strong>{iconEditing.title || iconEditing.url}</strong>
						</div>
						<input
							type="text"
							className="app-bar-url-dialog__input"
							value={iconInput}
							onChange={(e) => setIconInput(e.target.value)}
							placeholder="이모지 또는 이미지 URL (비우면 기본값)"
							autoFocus
						/>
						<div className="app-bar-url-dialog__btns">
							<button
								type="button"
								className="app-bar-url-dialog__btn"
								onClick={() => setIconEditing(null)}
							>
								{t("settings.cancel")}
							</button>
							<button
								type="submit"
								className="app-bar-url-dialog__btn app-bar-url-dialog__btn--primary"
							>
								{t("settings.save")}
							</button>
						</div>
					</form>
				</div>
			, document.body)}
			{/* ── BGM (right side of app-bar) ─── */}
			<BgmPlayer naia={bgmBridge} />
			<button
				type="button"
				className={`app-bar-settings${activeApp === "settings" ? " app-bar-settings--active" : ""}`}
				onClick={() =>
					setActiveApp(activeApp === "settings" ? null : "settings")
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

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
import { removeInstalledPanel } from "../lib/panel-loader";
import { panelRegistry } from "../lib/panel-registry";
import { usePanelStore } from "../stores/panel";
import { BgmPlayer } from "./BgmPlayer";

// BGM player lives in the always-on mode-bar (not a switchable panel), so it
// needs its own persistent bridge to push BGM context (favorites, current
// track) into Naia's system prompt. Without a bridge the push is dead code
// (`if (!naia) return` in BgmPlayer) and the AI never sees favoritesList.
const bgmBridge = getBridgeForPanel("bgm");

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
						className={`mode-bar-tab-wrapper${dragOverUrl === shortcut.url ? " mode-bar-tab-wrapper--drag-over" : ""}`}
						data-browser-shortcut={shortcut.url}
						draggable={editMode}
						onDragStart={editMode ? () => handleDragStart(shortcut.url) : undefined}
						onDragOver={editMode ? (e) => handleDragOver(e, shortcut.url) : undefined}
						onDrop={editMode ? () => handleDrop(shortcut.url) : undefined}
						onDragEnd={editMode ? handleDragEnd : undefined}
					>
						<button
							type="button"
							className={`mode-bar-tab mode-bar-tab--shortcut${editMode ? " mode-bar-tab--edit" : ""}`}
							title={editMode ? `아이콘 변경: ${shortcut.title || shortcut.url}` : (shortcut.title || shortcut.url)}
							onClick={() => {
								if (editMode) { openIconEditor(shortcut); } else { openBrowserShortcut(shortcut.url); }
							}}
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
						{editMode && (
							<button
								type="button"
								className="mode-bar-tab-remove mode-bar-tab-remove--shortcut"
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
			{addUrlDialog && createPortal(
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
			, document.body,
			)}
			{urlInputDialog && createPortal(
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
			, document.body,
			)}
			<button
				type="button"
				className="mode-bar-add"
				onClick={() => setAddUrlDialog(true)}
				title={t("modebar.addItem")}
			>
				+
			</button>
			{browserShortcuts.length > 0 && (
				<button
					type="button"
					className={`mode-bar-edit${editMode ? " mode-bar-edit--active" : ""}`}
					onClick={() => { setEditMode((v) => !v); setIconEditing(null); }}
					title={editMode ? "편집 완료" : "바로가기 편집"}
				>
					✏
				</button>
			)}
			{iconEditing && createPortal(
				<div
					className="mode-bar-url-dialog-overlay"
					onClick={() => setIconEditing(null)}
				>
					<form
						className="mode-bar-url-dialog"
						onClick={(e) => e.stopPropagation()}
						onSubmit={(e) => { e.preventDefault(); void handleIconSave(); }}
					>
						<div className="mode-bar-url-dialog__section-text" style={{ padding: "0 0 8px" }}>
							<strong>{iconEditing.title || iconEditing.url}</strong>
						</div>
						<input
							type="text"
							className="mode-bar-url-dialog__input"
							value={iconInput}
							onChange={(e) => setIconInput(e.target.value)}
							placeholder="이모지 또는 이미지 URL (비우면 기본값)"
							autoFocus
						/>
						<div className="mode-bar-url-dialog__btns">
							<button
								type="button"
								className="mode-bar-url-dialog__btn"
								onClick={() => setIconEditing(null)}
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
			, document.body)}
			{/* ── BGM (right side of mode-bar) ─── */}
			<BgmPlayer naia={bgmBridge} />
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

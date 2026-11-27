import { getCurrentWindow } from "@tauri-apps/api/window";
import { t } from "../lib/i18n";
import {
	formatPrimaryShortcut,
	shortcutPlatform,
} from "../lib/platform-shortcuts";

interface TitleBarProps {
	appVisible: boolean;
	onToggleApp: () => void;
	title?: string;
}

export function TitleBar({
	appVisible,
	onToggleApp,
	title = "Naia",
}: TitleBarProps) {
	const appWindow = getCurrentWindow();
	const platform = shortcutPlatform();
	const isMac = platform === "macos";
	const toggleShortcut = formatPrimaryShortcut("B", platform);
	const displayTitle = title.trim() || "Naia";

	function handleDragStart(e: React.MouseEvent) {
		if ((e.target as HTMLElement).closest(".titlebar-buttons")) return;
		// Double-click: toggle maximize/restore (same as OS native titlebar)
		if (e.detail === 2) {
			appWindow.isMaximized().then((maximized) => {
				maximized ? appWindow.unmaximize() : appWindow.maximize();
			});
			return;
		}
		e.preventDefault();
		appWindow.startDragging();
	}

	const brand = (
		<div className="titlebar-brand" aria-label={`Naia - ${displayTitle}`}>
			<img className="titlebar-logo" src="/brand/naia-logo.png" alt="" />
			<span className="titlebar-label">{displayTitle}</span>
		</div>
	);

	const toggleVerb = appVisible ? t("hardkoG1a.titleBar.hideChat") : t("hardkoG1a.titleBar.showChat");
	const toggleBtn = (
		<button
			type="button"
			className="titlebar-btn"
			data-usage-event="title-bar.on-toggle-app-1.click"
			onClick={onToggleApp}
			title={`${toggleVerb} (${toggleShortcut})`}
		>
			<svg
				aria-hidden="true"
				width="14"
				height="14"
				viewBox="0 0 14 14"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
			>
				<rect x="1" y="1" width="12" height="12" rx="1.5" />
				{appVisible ? (
					<line x1="6" y1="1" x2="6" y2="13" />
				) : (
					<line x1="6" y1="1" x2="6" y2="13" strokeDasharray="2 2" />
				)}
			</svg>
		</button>
	);

	const minimizeBtn = (
		<button
			type="button"
			className={
				isMac
					? "titlebar-btn titlebar-btn-traffic titlebar-btn-traffic--minimize"
					: "titlebar-btn"
			}
			data-macos-traffic={isMac ? "minimize" : undefined}
			data-usage-event="title-bar.button-2.click"
			onClick={() => appWindow.minimize()}
			title={t("hardkoG1a.titleBar.minimize")}
		>
			&#8211;
		</button>
	);

	const maximizeBtn = (
		<button
			type="button"
			className={
				isMac
					? "titlebar-btn titlebar-btn-traffic titlebar-btn-traffic--maximize"
					: "titlebar-btn"
			}
			data-macos-traffic={isMac ? "maximize" : undefined}
			data-usage-event="title-bar.button-3.click"
			onClick={async () => {
				if (await appWindow.isMaximized()) {
					appWindow.unmaximize();
				} else {
					appWindow.maximize();
				}
			}}
			title={t("hardkoG1a.titleBar.maximize")}
		>
			&#9633;
		</button>
	);

	const closeBtn = (
		<button
			type="button"
			className={
				isMac
					? "titlebar-btn titlebar-btn-traffic titlebar-btn-traffic--close"
					: "titlebar-btn titlebar-btn-close"
			}
			data-macos-traffic={isMac ? "close" : undefined}
			data-usage-event="title-bar.button-4.click"
			onClick={() => appWindow.close()}
			title={t("hardkoG1a.close")}
		>
			&#10005;
		</button>
	);

	return (
		<div
			className={isMac ? "titlebar titlebar--macos" : "titlebar"}
			data-titlebar-platform={platform}
			onMouseDown={handleDragStart}
		>
			{isMac ? (
				<>
					<div
						className="titlebar-buttons titlebar-traffic-lights"
						data-macos-window-controls="true"
					>
						{closeBtn}
						{minimizeBtn}
						{maximizeBtn}
					</div>
					{brand}
					<div className="titlebar-buttons">{toggleBtn}</div>
				</>
			) : (
				<>
					{brand}
					<div className="titlebar-buttons">
						{toggleBtn}
						{minimizeBtn}
						{maximizeBtn}
						{closeBtn}
					</div>
				</>
			)}
		</div>
	);
}
